// error-ledger.js — 错误台账（方案 v4 §B）
// 独立模块：不 import/修改 index.js，只通过 api 注入的 db / addTool / store 工作。
// 导出：default registerErrorLedger(api) → 注册 3 个工具并返回可复用 API
//       createErrorLedger(api) / toolDefs(api) / signatureOf(cmd, root_cause) / ERROR_TABLE_DDL
//       sanitize(text)  脱敏（幂等，可单独用）
//       ledgerAdmin(api) → (opts) => {ok,...}；ledgerAdmin(api, opts) 立即执行
//       admin 动作：list / delete（软删 status=deleted）/ purge（硬删）/ export（JSONL）
//
// api 形状（以 index.js 实况为准）：
//   db        required  DatabaseSync（store.db）；也接受 () => db | Promise<db>
//   addTool   required  (def) => void；或 tools: { register(def) }
//   log       optional  (...args) => void
//   store     optional  MemoryStore 实例（writeback 用 insertRow + writeMarkdown）
//   addFact   optional  async (input) => {ok,id,code,message}：memory_store 同款写入口，优先使用
//   dataDir   optional  默认 DSH_MEMORY_ROOT || "~/.dsh-memory"
//   factsDir  optional  默认 <dataDir>/global/facts
//   errorSubject optional 写回事实的 subject，默认 "dsh"

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_ROOT = process.env.DSH_MEMORY_ROOT || "~/.dsh-memory";
const TEXT_OUTPUT = { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: String(v) }] };
const COLS = ["cmd", "symptom", "lesson", "root_cause", "where_solution"];

export const ERROR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS error_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE,
  ts TEXT,
  cmd TEXT,
  symptom TEXT,
  root_cause TEXT,
  lesson TEXT,
  where_solution TEXT,
  applied INTEGER DEFAULT 0,
  hits INTEGER DEFAULT 0,
  processed_at TEXT,
  status TEXT DEFAULT 'active',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_ledger_ts ON error_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_error_ledger_applied ON error_ledger(applied);
`;

/** 台账脱敏：密钥 / Bearer / 口令键值 / Windows 用户目录；幂等（sanitize(sanitize(x)) === sanitize(x)） */
const RE_SK = /sk-[A-Za-z0-9_-]{6,}/g;
const RE_PAT = /(gh[pous]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const RE_BEARER = /Bearer\s+[A-Za-z0-9._\-]+/g;
const RE_KV = /(password|passwd|api[_-]?key|secret|token)\s*[=:]\s*\S+/gi;
const RE_WINHOME = /([A-Za-z]:\\Users\\)[^\\\s]+/g;

/** 把密钥/口令/用户名换成 ***；非字符串安全；对已脱敏文本再跑结果不变 */
export function sanitize(text) {
  let out = String(text ?? "");
  if (!out) return "";
  out = out.replace(RE_SK, "sk-***");
  out = out.replace(RE_PAT, "***");
  out = out.replace(RE_BEARER, "Bearer ***");
  out = out.replace(/Bearer\s+["'][^"']+["']/gi, "Bearer ***");
  out = out.replace(RE_KV, "$1=***");
  out = out.replace(RE_WINHOME, "$1***");
  return out;
}

/** 旧库补列（幂等）：status 软删标记 / updated_at 排序时间 */
function migrateLedger(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(error_ledger)").all().map((c) => String(c.name)));
  if (!cols.has("status")) db.exec("ALTER TABLE error_ledger ADD COLUMN status TEXT DEFAULT 'active'");
  if (!cols.has("updated_at")) db.exec("ALTER TABLE error_ledger ADD COLUMN updated_at TEXT");
}

/** 未软删过滤条件（老行 status 为 NULL 也视为有效） */
const LIVE = "(status IS NULL OR status <> 'deleted')";
const ADMIN_FIELDS = [
  "id",
  "signature",
  "ts",
  "cmd",
  "symptom",
  "root_cause",
  "lesson",
  "where_solution",
  "applied",
  "hits",
  "processed_at",
  "status",
  "updated_at",
];

/** 单行脱敏 + 只保留稳定字段（export / list 共用） */
function cleanEntry(row) {
  const out = {};
  for (const k of ADMIN_FIELDS) {
    const v = row?.[k];
    out[k] = ["id", "applied", "hits"].includes(k) ? Number(v ?? 0) : ["processed_at", "updated_at"].includes(k) ? (v ?? null) : sanitize(v ?? "");
  }
  return out;
}

const nowIso = () => new Date().toISOString();
const norm = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** 台账签名：规范化(cmd + root_cause) 的 sha1 前 12 位 */
export function signatureOf(cmd, rootCause) {
  return createHash("sha1").update(`${norm(cmd)}\u241f${norm(rootCause)}`).digest("hex").slice(0, 12);
}

/** 压成一行且 ≤ n 字符（按码点计，中文/emoji 不被截半） */
function clip(value, n = 200) {
  const one = String(value ?? "").replace(/\s+/g, " ").trim();
  const cp = Array.from(one);
  return cp.length <= n ? one : `${cp.slice(0, n - 1).join("")}…`;
}

function likeOf(token) {
  return `%${String(token).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function escapeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

export function createErrorLedger(api = {}) {
  const log =
    typeof api.log === "function"
      ? api.log
      : () => {
          /* 无 log 注入时静默 */
        };
  const dataDir = api.dataDir ?? DEFAULT_ROOT;
  const factsDir = api.factsDir ?? join(dataDir, "global", "facts");
  const subject = api.errorSubject ?? "dsh";
  let ready = false;

  const resolveDb = async () => {
    const src = api.db;
    if (typeof src === "function") {
      const out = await src();
      return out?.db ?? out;
    }
    if (src?.prepare) return src;
    if (api.store?.db) return api.store.db;
    if (typeof api.getStore === "function") {
      const store = await api.getStore();
      return store?.db ?? null;
    }
    return null;
  };

  const dbOf = async () => {
    const db = await resolveDb();
    if (!db) throw new Error("NO_DB");
    if (!ready) {
      db.exec(ERROR_TABLE_DDL);
      migrateLedger(db);
      ready = true;
    }
    return db;
  };

  const query = async (sql, params = []) => escapeRows((await dbOf()).prepare(sql).all(...params));

  /** 写台账；同 signature 只累加 hits + 补 lesson，不新增行 */
  const report = async ({ cmd, symptom, root_cause, lesson, where_solution } = {}) => {
    const db = await dbOf();
    const command = clip(sanitize(cmd), 300);
    const sym = clip(sanitize(symptom), 300);
    if (!command && !sym) return { ok: false, code: "EMPTY", message: "cmd 或 symptom 至少一项" };
    const rootCause = clip(sanitize(root_cause), 300);
    const les = clip(sanitize(lesson), 300);
    const where = clip(sanitize(where_solution), 300);
    const sig = signatureOf(command, rootCause);
    const row = db.prepare("SELECT id, hits FROM error_ledger WHERE signature = ?").get(sig);
    if (row) {
      db.prepare(
        `UPDATE error_ledger SET hits = hits + 1, updated_at = ?,
           lesson = CASE WHEN ? <> '' THEN ? ELSE lesson END,
           where_solution = CASE WHEN ? <> '' THEN ? ELSE where_solution END
         WHERE id = ?`,
      ).run(nowIso(), les, les, where, where, row.id);
      const hits = Number(row.hits ?? 0) + 1;
      return { ok: true, deduped: true, id: Number(row.id), signature: sig, hits };
    }
    const info = db
      .prepare(
        `INSERT INTO error_ledger (signature, ts, cmd, symptom, root_cause, lesson, where_solution, applied, hits, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      )
      .run(sig, nowIso(), command, sym, rootCause, les, where, nowIso());
    return { ok: true, deduped: false, id: Number(info.lastInsertRowid), signature: sig, hits: 1 };
  };

  /** 检索：LIKE 多字段打分（中文按子串，无需分词表），每条 ≤200 字符 */
  const search = async (rawQuery, rawLimit = 1) => {
    const q = norm(rawQuery);
    const limit = Math.max(1, Math.min(5, Number(rawLimit) || 1));
    if (!q) return { ok: true, rows: [], text: "无记录" };
    const tokens = [...new Set(q.split(/[\s,，;；/|]+/).filter(Boolean))].slice(0, 8);
    if (!tokens.length) tokens.push(q);
    const where = [];
    const params = [];
    for (const t of tokens) {
      for (const c of COLS) {
        where.push(`${c} LIKE ? ESCAPE '\\'`);
        params.push(likeOf(t));
      }
    }
    const rows = await query(`SELECT * FROM error_ledger WHERE ${LIVE} AND (${where.join(" OR ")})`, params);
    const scored = rows.map((r) => {
      let score = 0;
      for (const t of tokens) {
        for (const c of COLS) {
          if (String(r[c] ?? "").toLowerCase().includes(t)) score += c === "lesson" ? 3 : c === "cmd" ? 2 : 1;
        }
      }
      return { row: r, score };
    });
    scored.sort((a, b) => b.score - a.score || Number(b.row.hits) - Number(a.row.hits));
    const picked = scored.slice(0, limit).map(({ row }) => ({
      id: Number(row.id),
      hits: Number(row.hits ?? 0),
      applied: Number(row.applied ?? 0),
      cmd: sanitize(row.cmd ?? ""),
      symptom: sanitize(row.symptom ?? ""),
      root_cause: sanitize(row.root_cause ?? ""),
      lesson: sanitize(row.lesson ?? ""),
      where_solution: sanitize(row.where_solution ?? ""),
    }));
    if (!picked.length) return { ok: true, rows: [], text: "无记录" };
    const lines = picked.map((r) =>
      clip(
        `#${r.id}(hits=${r.hits}) ${r.cmd || r.symptom}` +
          `${r.lesson ? ` | 教训: ${r.lesson}` : ""}` +
          `${r.root_cause ? ` | 因: ${r.root_cause}` : ""}` +
          `${r.where_solution ? ` | 处: ${r.where_solution}` : ""}`,
        200,
      ),
    );
    return { ok: true, rows: picked, text: lines.join("\n") };
  };

  const appendFactMd = (id, factValue) => {
    try {
      mkdirSync(factsDir, { recursive: true });
      const file = join(factsDir, `errors-${subject}.md`);
      const marker = `error_ledger:${id}`;
      const old = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (old.includes(marker)) return { file, skipped: true };
      const line = `- ${nowIso()} ${clip(sanitize(factValue), 150)} [${marker}]`;
      appendFileSync(file, old.endsWith("\n") || !old ? line + "\n" : `\n${line}\n`, "utf8");
      return { file, skipped: false };
    } catch (error) {
      log("error-ledger md write failed:", String(error?.message ?? error));
      return { file: null, skipped: true };
    }
  };

  const factFor = (row) =>
    clip(
      `错误：${row.cmd || row.symptom} → ${row.lesson || row.root_cause || "见台账"}`,
      150,
    );

  /** 单条写回：addFact > store.insertRow > md 兜底；已 applied 的跳过 */
  const writebackOne = async (row) => {
    if (Number(row.applied) === 1) return { id: Number(row.id), skipped: true, reason: "already" };
    const value = factFor(row);
    const sourceRef = `error_ledger:${row.id}`;
    let via = "md";
    if (typeof api.addFact === "function") {
      const res = await api.addFact({
        value,
        subject,
        predicate: "error",
        tags: "error,ledger",
        scope: "global",
        source_ref: sourceRef,
      });
      if (res && res.ok === false && res.code) {
        log("error-ledger addFact rejected:", res.code, String(res.message ?? ""));
        return { id: Number(row.id), skipped: true, reason: String(res.code) };
      }
      via = "fact";
    } else if (api.store && typeof api.store.insertRow === "function") {
      try {
        const dup = await query("SELECT COUNT(*) AS n FROM memory WHERE source_ref = ?", [sourceRef]);
        if (Number(dup[0]?.n ?? 0) > 0) return { id: Number(row.id), skipped: true, reason: "already_fact" };
      } catch {
        /* memory 表缺失：忽略去重探测 */
      }
      const rec = {
        id: createHash("sha256").update(`${sourceRef}|${value}`).digest("hex").slice(0, 16),
        scope: "global",
        subject,
        predicate: "error",
        value,
        tags: ["error", "ledger"],
        source_type: "explicit",
        source_ref: sourceRef,
        confidence: 1,
        author: "assistant",
      };
      api.store.insertRow(rec);
      if (typeof api.store.writeMarkdown === "function") api.store.writeMarkdown(rec);
      via = "fact";
    }
    if (via === "md") {
      const res = appendFactMd(row.id, value);
      if (res.skipped) return { id: Number(row.id), skipped: true, reason: "already_md" };
    }
    const db = await dbOf();
    db.prepare("UPDATE error_ledger SET applied = 1, processed_at = ? WHERE id = ?").run(nowIso(), row.id);
    return { id: Number(row.id), skipped: false, via };
  };

  /** 读取路径脱敏：历史脏行在写回前再过滤一次 */
  const cleanRow = (row) => {
    const out = { ...row };
    for (const c of COLS) out[c] = sanitize(row[c] ?? "");
    return out;
  };

  const writeback = async ({ id, all } = {}) => {
    const db = await dbOf();
    let rows;
    if (Number(all) === 1) {
      rows = db
        .prepare(`SELECT * FROM error_ledger WHERE applied = 0 AND ${LIVE} ORDER BY hits DESC, id ASC LIMIT 20`)
        .all();
    } else {
      const n = Number(id);
      if (!Number.isFinite(n)) return { ok: false, code: "NO_ID", message: "需要 id 或 all=1", done: 0 };
      rows = db.prepare(`SELECT * FROM error_ledger WHERE id = ? AND ${LIVE}`).all(n);
      if (!rows.length) return { ok: false, code: "NOT_FOUND", message: `无 #${n}（或已删除）`, done: 0 };
    }
    const out = [];
    for (const row of escapeRows(rows)) out.push(await writebackOne(cleanRow(row)));
    const done = out.filter((r) => !r.skipped).length;
    const skip = out.length - done;
    return { ok: true, done, skipped: skip, results: out };
  };

  /** 日报：近 days 天新增条数 + top（按 hits） */
  const summarizeErrors = async (days = 1) => {
    try {
      const db = await dbOf();
      const cutoff = new Date(Date.now() - Math.max(0, Number(days) || 1) * 86400000).toISOString();
      const count = Number(
        db.prepare(`SELECT COUNT(*) AS n FROM error_ledger WHERE ts >= ? AND ${LIVE}`).get(cutoff)?.n ?? 0,
      );
      const top = db
        .prepare(`SELECT signature, cmd, lesson, hits FROM error_ledger WHERE ${LIVE} ORDER BY hits DESC, id DESC LIMIT 5`)
        .all()
        .map((r) => ({
          signature: r.signature,
          cmd: sanitize(r.cmd ?? ""),
          lesson: sanitize(r.lesson ?? ""),
          hits: Number(r.hits ?? 0),
        }));
      return { count, top };
    } catch (error) {
      log("error-ledger summarize failed:", String(error?.message ?? error));
      return { count: 0, top: [] };
    }
  };

  /**
   * 2026-11-11（P1 · 极省模式）：错误模式摘要 = 最近 1 条全文摘要 + 最多 5 条标题行。
   * 用户选「台帐默认 latest-1 + 标题式列表」：一次回顾成本 ~300 字符，需要详情再 memory_get。
   */
  const digest = async (rawQuery = "", rawLimit = 1) => {
    try {
      const db = await dbOf();
      const q = norm(rawQuery);
      const keep = Math.max(1, Math.min(3, Number(rawLimit) || 1));
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM error_ledger WHERE ${LIVE}`).get()?.n ?? 0);
      let rows = [];
      if (q) {
        const hit = await search(q, keep);
        rows = (hit.rows ?? []).map((r) => r);
      } else {
        rows = await query(`SELECT * FROM error_ledger WHERE ${LIVE} ORDER BY ts DESC LIMIT ?`, [keep]);
      }
      const latest = rows.map((row) => {
        const r = cleanRow(row);
        return {
          id: Number(r.id),
          hits: Number(r.hits ?? 0),
          cmd: clip(sanitize(r.cmd ?? ""), 120),
          symptom: clip(sanitize(r.symptom ?? ""), 120),
          root_cause: clip(sanitize(r.root_cause ?? ""), 160),
          lesson: clip(sanitize(r.lesson ?? ""), 160),
          where_solution: clip(sanitize(r.where_solution ?? ""), 120),
        };
      });
      const titles = (
        await query(
          `SELECT id, cmd, symptom, hits FROM error_ledger WHERE ${LIVE} ORDER BY hits DESC, id DESC LIMIT 5`,
        )
      ).map((r) => `#${Number(r.id)}(×${Number(r.hits ?? 0)}) ${clip(sanitize(r.cmd || r.symptom || ""), 80)}`);
      return { ok: true, total, latest, titles };
    } catch (error) {
      log("error-ledger digest failed:", String(error?.message ?? error));
      return { ok: false, code: "DIGEST_FAILED", message: String(error?.message ?? error) };
    }
  };

  /**
   * 台账管理：list / delete（软删 status=deleted）/ purge（硬删）/ export（JSONL）
   * 一律不抛：失败返回 { ok:false, code, message }
   */
  const admin = async ({ action, id, query: rawQuery, outFile, format } = {}) => {
    try {
      const db = await dbOf();
      const act = String(action ?? "list").toLowerCase();
      if (act === "list") {
        const needle = norm(rawQuery);
        let filter = LIVE;
        const params = [];
        if (needle) {
          filter += ` AND (${COLS.map((c) => `${c} LIKE ?`).join(" OR ")})`;
          for (let i = 0; i < COLS.length; i += 1) params.push(`%${needle}%`);
        }
        const list = escapeRows(
          db.prepare(`SELECT * FROM error_ledger WHERE ${filter} ORDER BY hits DESC, id DESC LIMIT 20`).all(...params),
        ).map(cleanEntry);
        const text = list.length
          ? list
              .map((r) => clip(`#${r.id}(hits=${r.hits}) ${r.cmd || r.symptom} @${String(r.updated_at ?? r.ts ?? "")}`, 200))
              .join("\n")
          : "无记录";
        return { ok: true, action: "list", rows: list, count: list.length, text };
      }
      if (act === "delete" || act === "purge") {
        const n = Number(id);
        if (!Number.isFinite(n)) return { ok: false, action: act, code: "NO_ID", message: "需要 id" };
        const info =
          act === "delete"
            ? db.prepare("UPDATE error_ledger SET status = 'deleted', updated_at = ? WHERE id = ?").run(nowIso(), n)
            : db.prepare("DELETE FROM error_ledger WHERE id = ?").run(n);
        const changed = Number(info?.changes ?? 0);
        if (!changed) return { ok: false, action: act, code: "NOT_FOUND", message: `无 #${n}` };
        return {
          ok: true,
          action: act,
          id: n,
          [act === "delete" ? "deleted" : "removed"]: changed,
          text: act === "delete" ? `error#${n} 已软删` : `error#${n} 已硬删`,
        };
      }
      if (act === "export") {
        const fmt = String(format ?? "jsonl").toLowerCase();
        if (fmt !== "jsonl") return { ok: false, action: "export", code: "BAD_FORMAT", message: "只支持 format=jsonl" };
        const all = escapeRows(db.prepare(`SELECT * FROM error_ledger WHERE ${LIVE} ORDER BY id ASC`).all()).map(cleanEntry);
        const jsonl = all.map((r) => JSON.stringify(r)).join("\n");
        let path = null;
        if (outFile) {
          path = String(outFile);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, jsonl ? `${jsonl}\n` : "", "utf8");
        }
        return { ok: true, action: "export", path, rows: all.length, text: jsonl };
      }
      return { ok: false, action: act, code: "BAD_ACTION", message: `未知动作 ${act}（list/delete/purge/export）` };
    } catch (error) {
      return { ok: false, code: "ADMIN_FAILED", message: clip(error?.message ?? error, 160) };
    }
  };

  return { ensureTable: dbOf, report, search, writeback, summarizeErrors, resolveDb, admin, digest };
}

const guard = (ledger, name, fn) => async (args = {}) => {
  try {
    return await fn(ledger, args);
  } catch (error) {
    return JSON.stringify({ ok: false, code: name, message: clip(error?.message ?? error, 160) });
  }
};

const buildDefs = (ledger) => [
  {
    name: "memory_error_report",
    description:
      "把刚发生的错误记进台账（同 signature 只累加 hits，不新增行）。命令失败、被纠正、踩坑后调用。",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "出错的命令或操作" },
        symptom: { type: "string", description: "现象/报错摘要" },
        root_cause: { type: "string", description: "根因（参与签名，尽量稳定写法）" },
        lesson: { type: "string", description: "下次怎么避免（一句话）" },
        where_solution: { type: "string", description: "解法位置：文件:行 / 命令 / URL" },
      },
      required: ["cmd"],
    },
    output: TEXT_OUTPUT,
    execute: guard(ledger, "REPORT_FAILED", async (ledger, a) => {
      const r = await ledger.report(a);
      if (!r.ok) return JSON.stringify(r);
      return r.deduped
        ? `error#${r.id} 已存在 hits=${r.hits}（只累加，未新增）`
        : `error#${r.id} 已记 sig=${r.signature}`;
    }),
  },
  {
    name: "memory_error_search",
    description:
      "执行命令失败或动手前先查错误台账：同一条坑优先复用教训。query 必填，limit 默认 1（最多 5），每条 ≤200 字符。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "命令/报错/关键词" },
        limit: { type: "number", description: "返回条数，默认 1，最大 5" },
      },
      required: ["query"],
    },
    output: TEXT_OUTPUT,
    execute: guard(ledger, "SEARCH_FAILED", async (ledger, a) => (await ledger.search(a.query, a.limit ?? 1)).text),
  },
  {
    name: "memory_error_writeback",
    description:
      "把台账条目写回长期记忆（predicate=error 事实 + md 兜底），并标记 applied。id 指定一条；all=1 批量处理未回写项。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "台账行 id" },
        all: { type: "number", description: "1 = 处理全部未回写项" },
      },
    },
    output: TEXT_OUTPUT,
    execute: guard(ledger, "WRITEBACK_FAILED", async (ledger, a) => {
      const r = await ledger.writeback(a);
      if (!r.ok) return JSON.stringify(r);
      return `writeback: 写入 ${r.done} / 跳过 ${r.skipped}`;
    }),
  },
];

/**
 * 台账管理入口（给 index.js 的 memory_admin 接线用）：
 *   const admin = ledgerAdmin({ db, log });  await admin({ action: "list" })
 *   await ledgerAdmin({ db, log }, { action: "delete", id: 3 })   // 立即执行
 * 两种调用都可用，返回值恒为 Promise<{ ok, ... }>，不抛。
 */
export function ledgerAdmin(api = {}, opts) {
  const ledger = createErrorLedger(api);
  const run = (o = {}) => ledger.admin(o);
  return opts === undefined ? run : run(opts);
}

/** 生成工具定义（不注册），便于胶水自行过滤/改名 */
export function toolDefs(api = {}) {
  const ledger = createErrorLedger(api);
  return { ledger, defs: buildDefs(ledger).map((d) => ({ ...d })) };
}

/** 主入口：注册 3 个工具，返回 { summarizeErrors, search, report, writeback, defs } */
export default function registerErrorLedger(api = {}) {
  const { ledger, defs } = toolDefs(api);
  const log = typeof api.log === "function" ? api.log : () => {};
  let registered = 0;
  for (const def of defs) {
    try {
      if (typeof api.addTool === "function") api.addTool(def);
      else if (api.tools && typeof api.tools.register === "function") api.tools.register(def);
      else {
        log("error-ledger: no addTool/tools.register, skip", def.name);
        continue;
      }
      registered += 1;
    } catch (error) {
      log("error-ledger tool register failed:", def.name, String(error?.message ?? error));
    }
  }
  return {
    registered,
    names: defs.map((d) => d.name),
    defs,
    report: ledger.report,
    search: ledger.search,
    writeback: ledger.writeback,
    summarizeErrors: ledger.summarizeErrors,
    digest: ledger.digest,
    ensureTable: ledger.ensureTable,
    admin: ledger.admin,
  };
}