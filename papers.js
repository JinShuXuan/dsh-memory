// P2 论文库：papers.db（SQLite）+ 原地 PDF + sha256 关联 + 450 字符分块
// 真源是 PDF 与 papers/manifest.jsonl，papers.db 可重建。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, basename } from "node:path";
import { cosine, rrf } from "./embed.js";

export const CHUNK_TARGET = 450;
const CHUNK_MAX = 520;
const HITS_TOKEN_BUDGET = 450; // ≈300 tokens

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function pid() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function cid() {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 中文按二元组、ASCII 按词（与记忆库一致的分词口径） */
function seg(text) {
  const out = [];
  const s = String(text ?? "").normalize("NFKC");
  for (const m of s.matchAll(/[A-Za-z0-9][A-Za-z0-9_.+\-]*/g)) out.push(m[0].toLowerCase());
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out.join(" ");
}

export class PaperStore {
  constructor(db, { base, embedder = null, log = () => {} }) {
    this.db = db;
    this.base = base;
    this.embedder = embedder;
    this.log = log;
    this.vec = new Map(); // chunkId -> Float32Array
    this.fts = false;
  }

  static async open({ base, dbPath, embedder = null, log = () => {} }) {
    mkdirSync(join(base, "papers"), { recursive: true });
    mkdirSync(join(base, "index"), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath ?? join(base, "index", "papers.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    const store = new PaperStore(db, { base, embedder, log });
    store.migrate();
    store.loadVectors();
    return store;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ingesting',
        pages INTEGER NOT NULL DEFAULT 0,
        chars INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        added_at INTEGER NOT NULL,
        ingest_started_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunk (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL,
        page INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        title_seg TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        text_seg TEXT NOT NULL,
        char_start INTEGER NOT NULL DEFAULT 0,
        char_end INTEGER NOT NULL DEFAULT 0,
        vec_state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS ix_chunk_paper ON chunk(paper_id, seq);
      CREATE TABLE IF NOT EXISTS chunk_vec (
        chunk_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
          chunk_id UNINDEXED, paper_id UNINDEXED, title_seg, text_seg,
          tokenize = 'unicode61 tokenchars ''-_.+'''
        );
      `);
      const cols = new Set(this.db.prepare("SELECT name FROM pragma_table_info('chunk_fts')").all().map((r) => r.name));
      if (cols.has("text_seg")) this.fts = true;
    } catch (error) {
      this.log("chunk_fts unavailable:", String(error?.message ?? error));
      this.fts = false;
    }
  }

  loadVectors() {
    this.vec.clear();
    const rows = this.db.prepare("SELECT chunk_id, vec FROM chunk_vec").all();
    for (const row of rows) {
      const buf = row.vec;
      if (!buf || buf.byteLength < 4 || buf.byteLength % 4 !== 0) continue;
      // 键必须是 chunk_id：写成 row.id 会让整库向量挂在 undefined 上，重启后语义检索恒空
      this.vec.set(row.chunk_id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
  }

  manifestPath() {
    return join(this.base, "papers", "manifest.jsonl");
  }

  appendManifest(event) {
    appendFileSync(this.manifestPath(), `${JSON.stringify(event)}\n`, "utf8");
  }

  /** 递归收集可入库文件 */
  collect(target) {
    const out = [];
    const walk = (p) => {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const entry of readdirSync(p, { withFileTypes: true })) walk(join(p, entry.name));
        return;
      }
      const ext = extname(p).toLowerCase();
      if ([".pdf", ".md", ".txt", ".markdown"].includes(ext)) out.push(p);
    };
    if (existsSync(target)) walk(target);
    return out;
  }

  /** pdfjs-dist 是可选依赖（optionalDependencies）：按需加载，两代入口都试一遍，缺失就不算错 */
  async loadPdfjs() {
    for (const load of [() => import("pdfjs-dist/legacy/build/pdf.mjs"), () => import("pdfjs-dist")]) {
      try {
        const mod = await load();
        if (mod?.getDocument) return mod;
      } catch {
        // 未安装或该入口不存在：换下一个入口
      }
    }
    return null;
  }

  async extractText(file) {
    const ext = extname(file).toLowerCase();
    if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
      return { ok: true, text: readFileSync(file, "utf8"), pages: 0 };
    }
    const pdfjs = await this.loadPdfjs();
    if (!pdfjs) {
      return { ok: false, code: "PDF_UNAVAILABLE", text: "", pages: 0, error: "pdfjs-dist not installed" };
    }
    let doc;
    try {
      const data = new Uint8Array(readFileSync(file));
      doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
      const parts = [];
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        parts.push(content.items.map((it) => it.str ?? "").join(" "));
      }
      return { ok: true, text: parts.join("\n\f\n"), pages: doc.numPages };
    } catch (error) {
      return { ok: false, code: "PDF_PARSE_FAILED", text: "", pages: 0, error: String(error?.message ?? error) };
    } finally {
      try {
        await doc?.destroy?.();
      } catch {
        // 释放失败不影响解析结果
      }
    }
  }

  /** 按段落/句子切块：目标 450 字符、块间重叠约 100 字符、超长片段硬切，页码按 \f 分页符推算 */
  chunkText(text) {
    const clean = String(text ?? "").replace(/\r/g, "");
    const pageStarts = [];
    for (let i = 0; i < clean.length; i += 1) if (clean[i] === "\f") pageStarts.push(i);
    const pageAt = (pos) => {
      let page = 1;
      for (const s of pageStarts) {
        if (pos < s) break;
        page += 1;
      }
      return page;
    };
    const chunks = [];
    let buffer = "";
    let start = 0;
    let fresh = 0; // 本次 buffer 里新增的字符数（只有重叠尾巴时为 0）
    const flush = (end) => {
      const body = buffer.trim();
      if (body.length >= 40) chunks.push({ text: body, charStart: start, charEnd: end, page: pageAt(start) });
      buffer = "";
      start = end;
      fresh = 0;
    };
    const pieces = clean.split(/(?<=[。！？!?；;\n\f])/u).filter(Boolean);
    let offset = 0;
    for (const pieceRaw of pieces) {
      let piece = pieceRaw;
      while (piece.length > CHUNK_MAX) {
        if (buffer.length > 0) flush(offset);
        const take = piece.slice(0, CHUNK_TARGET);
        chunks.push({ text: take.trim(), charStart: offset, charEnd: offset + take.length, page: pageAt(offset) });
        piece = piece.slice(CHUNK_TARGET);
        offset += CHUNK_TARGET;
        start = offset;
        fresh = 0;
      }
      const pieceLen = piece.length;
      if (buffer.length + pieceLen > CHUNK_MAX) {
        flush(offset);
        // 重叠：把上一块尾部带进来，避免跨块断句导致检索命中率下降
        const tail = chunks.length > 0 ? chunks[chunks.length - 1].text.slice(-100) : "";
        buffer = tail;
        start = Math.max(0, offset - tail.length);
      }
      buffer += piece;
      offset += pieceLen;
      fresh += pieceLen;
      if (buffer.length >= CHUNK_TARGET) {
        const tail = buffer.slice(-100);
        flush(offset);
        buffer = tail;
        start = Math.max(0, offset - tail.length);
      }
    }
    // 收尾：只有「新增内容」才值得再吐一块；若剩余纯粹是上一块的重叠尾巴就丢弃
    if (fresh > 0) flush(offset);
    return chunks;
  }

  async ingest(target, { log = () => {} } = {}) {
    const files = this.collect(target);
    const result = { added: [], skipped: [], failed: [], chunks: 0 };
    for (const file of files) {
      try {
        const buffer = readFileSync(file);
        const hash = sha256(buffer);
        const existing = this.db.prepare("SELECT id, status FROM paper WHERE sha256 = ?").get(hash);
        if (existing && existing.status === "ready") {
          result.skipped.push({ path: file, id: existing.id, reason: "duplicate" });
          continue;
        }
        const id = existing?.id ?? pid();
        const now = Date.now();
        if (!existing) {
          this.db
            .prepare(
              "INSERT INTO paper (id, sha256, path, title, status, pages, chars, added_at, ingest_started_at, updated_at) VALUES (?, ?, ?, ?, 'ingesting', 0, 0, ?, ?, ?)",
            )
            .run(id, hash, file, basename(file), now, now, now);
        } else {
          this.db.prepare("UPDATE paper SET status = 'ingesting', ingest_started_at = ?, path = ? WHERE id = ?").run(now, file, id);
          // 顺序要紧：先按子查询删向量、再删 chunk，反着写子查询查不到，留下孤儿向量
          this.db.prepare("DELETE FROM chunk_vec WHERE chunk_id IN (SELECT id FROM chunk WHERE paper_id = ?)").run(id);
          if (this.fts) this.db.prepare("DELETE FROM chunk_fts WHERE paper_id = ?").run(id);
          this.db.prepare("DELETE FROM chunk WHERE paper_id = ?").run(id);
        }
        const { text, pages, error } = await this.extractText(file);
        if (error || !text.trim()) {
          const status = error?.includes("not installed") ? "ocr_pending" : "failed";
          this.db.prepare("UPDATE paper SET status = ?, note = ?, updated_at = ? WHERE id = ?").run(status, error ?? "empty text", now, id);
          result.failed.push({ path: file, id, reason: error ?? "empty text" });
          continue;
        }
        const pieces = this.chunkText(text);
        const insertChunk = this.db.prepare(
          "INSERT INTO chunk (id, paper_id, page, seq, title, title_seg, text, text_seg, char_start, char_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const insertFts = this.fts
          ? this.db.prepare("INSERT INTO chunk_fts (chunk_id, paper_id, title_seg, text_seg) VALUES (?, ?, ?, ?)")
          : null;
        for (const [i, piece] of pieces.entries()) {
          const chunkId = cid();
          insertChunk.run(chunkId, id, piece.page ?? 1, i, basename(file), seg(basename(file)), piece.text, seg(piece.text), piece.charStart, piece.charEnd);
          insertFts?.run(chunkId, id, seg(basename(file)), seg(piece.text));
          await this.indexVector(chunkId, piece.text);
        }
        this.db
          .prepare("UPDATE paper SET status = 'ready', pages = ?, chars = ?, updated_at = ?, note = NULL WHERE id = ?")
          .run(pages, text.length, Date.now(), id);
        this.appendManifest({ event: "add", id, sha256: hash, path: file, title: basename(file), at: Date.now() });
        result.added.push({ id, path: file, chunks: pieces.length, chars: text.length });
        result.chunks += pieces.length;
        log("paper ready", { id, file, chunks: pieces.length });
      } catch (error) {
        result.failed.push({ path: file, reason: String(error?.message ?? error) });
      }
    }
    return result;
  }

  async indexVector(chunkId, text) {
    if (!this.embedder?.ready) return false;
    const vector = await this.embedder.embed(text);
    if (!vector) return false;
    this.db
      .prepare("INSERT OR REPLACE INTO chunk_vec (chunk_id, dim, vec) VALUES (?, ?, ?)")
      .run(chunkId, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
    this.vec.set(chunkId, vector);
    return true;
  }

  lexicalTop(query, limit) {
    const tokens = seg(query).split(" ").filter((t) => t.length >= 1).slice(0, 24);
    if (!tokens.length) return [];
    const expr = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      return this.db
        .prepare("SELECT chunk_id AS id, bm25(chunk_fts) AS score FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY score LIMIT ?")
        .all(expr, limit);
    } catch (error) {
      this.log("chunk fts query failed:", String(error?.message ?? error));
      return [];
    }
  }

  async vectorTop(query, limit) {
    if (!this.embedder?.ready || this.vec.size === 0) return [];
    const q = await this.embedder.embed(query);
    if (!q) return [];
    const scored = [];
    for (const [id, vec] of this.vec) scored.push({ id, score: cosine(vec, q) });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async search(query, limit = 8) {
    const lex = this.lexicalTop(query, 30).map((r) => ({ id: r.id, score: -r.score }));
    const vec = await this.vectorTop(query, 30);
    const merged = rrf([lex, vec], 60).slice(0, limit);
    const get = this.db.prepare("SELECT c.id, c.paper_id, c.text, c.title, c.seq, c.page, p.path, p.pages FROM chunk c JOIN paper p ON p.id = c.paper_id WHERE c.id = ?");
    const items = [];
    let budget = HITS_TOKEN_BUDGET;
    for (const hit of merged) {
      const row = get.get(hit.id);
      if (!row) continue;
      const body = String(row.text).slice(0, Math.max(80, Math.min(200, budget)));
      if (budget - body.length < 0) break;
      budget -= body.length;
      items.push({
        chunk_id: row.id,
        paper_id: row.paper_id,
        title: row.title,
        page: row.page || row.seq + 1,
        path: row.path,
        snippet: body,
      });
      if (budget <= 60) break;
    }
    return items;
  }

  getChunk(chunkId) {
    return this.db
      .prepare("SELECT c.*, p.path, p.title AS paper_title FROM chunk c JOIN paper p ON p.id = c.paper_id WHERE c.id = ? OR c.id LIKE ?")
      .get(chunkId, `%${String(chunkId).replace(/^c_/, "").slice(-6)}`);
  }

  delete(paperId) {
    const row = this.db.prepare("SELECT * FROM paper WHERE id = ?").get(paperId);
    if (!row) return { ok: false, code: "NOT_FOUND" };
    this.appendManifest({ event: "delete", id: row.id, sha256: row.sha256, at: Date.now() });
    const chunkRows = this.db.prepare("SELECT id FROM chunk WHERE paper_id = ?").all(row.id);
    if (this.fts) this.db.prepare("DELETE FROM chunk_fts WHERE paper_id = ?").run(row.id);
    for (const c of chunkRows) {
      this.vec.delete(c.id);
      this.db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?").run(c.id);
    }
    this.db.prepare("DELETE FROM chunk WHERE paper_id = ?").run(row.id);
    this.db.prepare("DELETE FROM paper WHERE id = ?").run(row.id);
    return { ok: true, deleted: row.id, chunks: chunkRows.length };
  }

  stats() {
    const paper = this.db.prepare("SELECT COUNT(*) AS n FROM paper WHERE status = 'ready'").get().n;
    const chunk = this.db.prepare("SELECT COUNT(*) AS n FROM chunk").get().n;
    return { papers: Number(paper), chunks: Number(chunk), vec: this.vec.size, fts: this.fts };
  }
}