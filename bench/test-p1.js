/**
 * bench/test-p1.js — P1 验收：类型/阶段/摘要落库+md、检索 7 模式、台账 digest 极省输出。
 * 跑法：node bench/test-p1.js   （临时目录，不碰真库）
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "..", ".tmp-test", `p1-${Date.now()}`);
process.env.DSH_MEMORY_ROOT = TMP;
mkdirSync(join(TMP, "index"), { recursive: true });
mkdirSync(join(TMP, "global", "facts"), { recursive: true });

const { DatabaseSync } = await import("node:sqlite");
const { MemoryStore } = await import("../index.js");
const { createErrorLedger } = await import("../error-ledger.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`);
    if (process.env.DEBUG) console.log(error?.stack ?? error);
    process.exitCode = 1;
  }
}

function openStore(name) {
  const root = join(TMP, name);
  mkdirSync(join(root, "index"), { recursive: true });
  const db = new DatabaseSync(join(root, "index", "memory.db"));
  db.exec("PRAGMA journal_mode = WAL");
  const store = new MemoryStore(db, root);
  store.migrate();
  return { store, db, root };
}

const { store, db, root } = openStore("main");

// ---------- 1. schema ----------
await check("migrate 增列 mtype/stage/summary", () => {
  const cols = db.prepare("PRAGMA table_info(memory)").all().map((c) => String(c.name));
  for (const c of ["mtype", "stage", "summary"]) {
    if (!cols.includes(c)) throw new Error(`缺列 ${c}`);
  }
});

// ---------- 2. 写入类型/摘要 + md ----------
const r1 = store.store({
  value: "pnpm 安装后必须用 pnpm approve-builds 放行 esbuild 才不报错",
  subject: "dsh",
  predicate: "needs_approve_builds",
  tags: ["pin"],
  mtype: "lesson",
  summary: "pnpm 需放行构建脚本，否则 esbuild 装不上",
  sourceType: "user_explicit",
});
await check("显式来源直接 active，且带 mtype/summary", () => {
  const row = db.prepare("SELECT mtype, summary, stage FROM memory WHERE id = ?").get(r1.id);
  if (row.mtype !== "lesson") throw new Error(`mtype=${row.mtype}`);
  if (!String(row.summary ?? "").includes("esbuild")) throw new Error("summary 未落库");
  if (row.stage !== "active") throw new Error(`stage=${row.stage}`);
});

await check("md front matter 含 type/summary，不含 stage:active", () => {
  const dir = join(root, "global", "facts");
  const file = readdirSync(dir).find((f) => f.endsWith(".md"));
  const text = readFileSync(join(dir, file), "utf8");
  if (!/^type: /m.test(text)) throw new Error("md 缺 type:");
  if (!/^summary: /m.test(text)) throw new Error("md 缺 summary:");
  if (/^stage: /m.test(text)) throw new Error("active 不应写 stage:");
});

// ---------- 3. 自动来源 → 草稿态 ----------
const r2 = store.store({
  value: "用户可能会改用 vault 存密码",
  subject: "user",
  predicate: "may_use_vault",
  mtype: "fact",
  sourceType: "auto",
});
await check("auto 来源进 staged", () => {
  const row = db.prepare("SELECT stage FROM memory WHERE id = ?").get(r2.id);
  if (row.stage !== "staged") throw new Error(`stage=${row.stage}`);
});

// ---------- 4. facts 检索排除草稿；staged 模式可见 ----------
const factsHits = await store.search("vault", "global", 10);
await check("facts 默认检索排除 staged", () => {
  if (factsHits.some((h) => h.id === r2.id)) throw new Error("草稿出现在 facts 结果里");
});
const staged = await store.search("", "global", 10, "staged");
await check("mode=staged 能列出草稿", () => {
  if (!staged.some((h) => h.id === r2.id)) throw new Error("staged 未列草稿");
});

// ---------- 5. 类型过滤 ----------
store.store({
  value: "大改动前先写方案再动手",
  subject: "user",
  predicate: "prefers_plan_first",
  mtype: "decision",
  tags: ["pin"],
  sourceType: "user_explicit",
});
const lessons = await store.search("", "global", 10, "lesson");
await check("mode=lesson 只回 lesson 类", () => {
  if (!lessons.some((h) => h.id === r1.id)) throw new Error("漏了 lesson 条目");
  if (lessons.some((h) => h.mtype !== "lesson")) throw new Error("混入非 lesson");
});
const byQuery = await store.search("pnpm 构建", "global", 10, "lesson");
await check("mode=lesson 带 query 走检索+过滤", () => {
  if (!byQuery.every((h) => h.mtype === "lesson")) throw new Error("过滤失效");
});

// ---------- 6. timeline / archive ----------
const timeline = await store.search("", "global", 10, "timeline");
await check("mode=timeline 返回 active 列表", () => {
  if (!timeline.length) throw new Error("空列表");
  if (timeline.some((h) => h.status !== "active")) throw new Error("混入非 active");
});

// ---------- 7. 台账 digest：latest-1 + 标题列表 ----------
await check("digest 只回 latest-1 条 + 标题 ≤5", async () => {
  const edb = new DatabaseSync(join(TMP, "ledger.db"));
  const L = createErrorLedger({ db: edb, log: () => {}, dataDir: TMP, factsDir: join(TMP, "global", "facts") });
  for (let i = 0; i < 7; i += 1) {
    await L.report({ cmd: `pnpm build ${i}`, symptom: "Cannot find module esbuild", root_cause: "构建脚本未放行", lesson: "跑 pnpm approve-builds" });
  }
  const d = await L.digest("esbuild", 1);
  if (!d.ok) throw new Error("digest 失败");
  if (d.latest.length !== 1) throw new Error(`latest=${d.latest.length}`);
  if (d.titles.length > 5) throw new Error(`titles=${d.titles.length}`);
  if (d.total < 7) throw new Error(`total=${d.total}`);
  const one = d.latest[0];
  if (String(one.symptom ?? "").length > 120 || String(one.lesson ?? "").length > 160) throw new Error("clip 未生效");
  if (!d.titles[0]?.startsWith("#")) throw new Error("标题格式不对");
});

// ---------- 8. 重新打开：md 回灌即可恢复类型/阶段/摘要 ----------
await check("reconcile 从 md 回灌 mtype/stage/summary", () => {
  const db2 = new DatabaseSync(join(root, "index", "memory.db"));
  // 模拟库内字段丢失，只留 md 真源
  db2.prepare("UPDATE memory SET mtype = NULL, summary = NULL, stage = 'active'").run();
  const store2 = new MemoryStore(db2, root);
  store2.migrate();
  store2.reconcile();
  const row = db2.prepare("SELECT mtype, summary FROM memory WHERE id = ?").get(r1.id);
  if (row.mtype !== "lesson" || !String(row.summary ?? "")) throw new Error("md 回灌失败");
});

// ---------- 9. 工具描述 token 预算 ----------
await check("memory_search 描述 ≤260 字节", async () => {
  const text = readFileSync(join(HERE, "..", "index.js"), "utf8");
  const m = /name: "memory_search",\s*description:\s*\n?\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error("找不到描述");
  const bytes = Buffer.byteLength(m[1], "utf8");
  if (bytes > 260) throw new Error(`描述 ${bytes}B 超预算`);
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n合计 ${results.length - failed}/${results.length} 通过`);