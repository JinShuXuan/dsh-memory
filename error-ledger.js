// error-ledger.js — 错误台账（方案 v4 §B）
// 独立模块：不 import/修改 index.js，只通过 api 注入的 db / addTool / store 工作。
// 导出：default registerErrorLedger(api) → 注册 3 个工具并返回可复用 API
//       createErrorLedger(api) / toolDefs(api) / signatureOf(cmd, root_cause) / ERROR_TABLE_DDL
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_ledger_ts ON error_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_error_ledger_applied ON error_ledger(applied);
`;

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
      ready = true;
    }
    return db;
  };

  const query = async (sql, params = []) => escapeRows((await dbOf()).prepare(sql).all(...params));

  /** 写台账；同 signature 只累加 hits + 补 lesson，不新增行 */
  const report = async ({ cmd, symptom, root_cause, lesson, where_solution } = {}) => {
    const db = await dbOf();
    const command = clip(cmd, 300);
    const sym = clip(symptom, 300);
    if (!command && !sym) return { ok: false, code: "EMPTY", message: "cmd 或 symptom 至少一项" };
    const rootCause = clip(root_cause, 300);
    const sig = signatureOf(command, rootCause);
    const row = db.prepare("SELECT id, hits FROM error_ledger WHERE signature = ?").get(sig);
    if (row) {
      db.prepare(
        `UPDATE error_ledger SET hits = hits + 1,
           lesson = CASE WHEN ? <> '' THEN ? ELSE lesson END,
           where_solution = CASE WHEN ? <> '' THEN ? ELSE where_solution END
         WHERE id = ?`,
      ).run(String(lesson ?? ""), clip(lesson, 300), String(where_solution ?? ""), clip(where_solution, 300), row.id);
      const hits = Number(row.hits ?? 0) + 1;
      return { ok: true, deduped: true, id: Number(row.id), signature: sig, hits };
    }
    const info = db
      .prepare(
        `INSERT INTO error_ledger (signature, ts, cmd, symptom, root_cause, lesson, where_solution, applied, hits)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      )
      .run(sig, nowIso(), command, sym, rootCause, clip(lesson, 300), clip(where_solution, 300));
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
    const rows = await query(`SELECT * FROM error_ledger WHERE ${where.join(" OR ")}`, params);
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
      cmd: row.cmd ?? "",
      symptom: row.symptom ?? "",
      root_cause: row.root_cause ?? "",
      lesson: row.lesson ?? "",
      where_solution: row.where_solution ?? "",
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
      const line = `- ${nowIso()} ${clip(factValue, 150)} [${marker}]`;
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

  const writeback = async ({ id, all } = {}) => {
    const db = await dbOf();
    let rows;
    if (Number(all) === 1) {
      rows = db
        .prepare("SELECT * FROM error_ledger WHERE applied = 0 ORDER BY hits DESC, id ASC LIMIT 20")
        .all();
    } else {
      const n = Number(id);
      if (!Number.isFinite(n)) return { ok: false, code: "NO_ID", message: "需要 id 或 all=1", done: 0 };
      rows = db.prepare("SELECT * FROM error_ledger WHERE id = ?").all(n);
      if (!rows.length) return { ok: false, code: "NOT_FOUND", message: `无 #${n}`, done: 0 };
    }
    const out = [];
    for (const row of escapeRows(rows)) out.push(await writebackOne(row));
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
        db.prepare("SELECT COUNT(*) AS n FROM error_ledger WHERE ts >= ?").get(cutoff)?.n ?? 0,
      );
      const top = db
        .prepare("SELECT signature, cmd, lesson, hits FROM error_ledger ORDER BY hits DESC, id DESC LIMIT 5")
        .all()
        .map((r) => ({ signature: r.signature, cmd: r.cmd ?? "", lesson: r.lesson ?? "", hits: Number(r.hits ?? 0) }));
      return { count, top };
    } catch (error) {
      log("error-ledger summarize failed:", String(error?.message ?? error));
      return { count: 0, top: [] };
    }
  };

  return { ensureTable: dbOf, report, search, writeback, summarizeErrors, resolveDb };
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
    ensureTable: ledger.ensureTable,
  };
}