// bench/test-errors.js — 错误台账验收（独立临时目录 + 独立 db，不碰线上库）
// 运行：node bench/test-errors.js
import { strict as A } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import registerErrorLedger, { createErrorLedger, signatureOf } from "../error-ledger.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-error-ledger-"));
const rmLater = [];
let pass = 0;
let fail = 0;

const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};
const okAsync = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};
const mkDb = (tag) => {
  const file = join(dir, `${tag}.db`);
  const db = new DatabaseSync(file);
  rmLater.push(file);
  return db;
};
const rows = (db, sql, params = []) => db.prepare(sql).all(...params);

try {
  // ---------- 注册与建表 ----------
  const db = mkDb("main");
  const tools = new Map();
  const api = {
    db,
    log: () => {},
    addTool: (def) => tools.set(def.name, def),
    dataDir: dir,
    factsDir: join(dir, "global", "facts"),
  };
  const L = registerErrorLedger(api);

  ok("注册 3 个工具", () => {
    A.equal(L.registered, 3);
    A.deepEqual([...tools.keys()], ["memory_error_report", "memory_error_search", "memory_error_writeback"]);
  });

  await okAsync("建表幂等（同实例两次 + 新实例一次均不抛）", async () => {
    await L.ensureTable();
    await L.ensureTable();
    const other = createErrorLedger(api);
    await other.ensureTable();
    A.equal(rows(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='error_ledger'")[0].n, 1);
  });

  ok("签名是规范化(cmd+root_cause) 的 sha1 前 12 位", () => {
    const a = signatureOf("Npm  run   build", "包别名 错的");
    A.equal(a.length, 12);
    A.equal(a, signatureOf("npm run build", "包别名 错的"));
    A.notEqual(a, signatureOf("npm run build", "别的根因"));
  });

  // ---------- dedupe ----------
  const err1 = {
    cmd: "pnpm run build",
    symptom: "ERR_PNPM_OUTDATED_LOCKFILE",
    root_cause: "手工改 package.json 导致 lockfile 漂移",
    lesson: "改依赖一律 pnpm add/remove",
    where_solution: "package.json:12",
  };
  await okAsync("同 signature 两次报 → hits=2 且只有 1 行", async () => {
    const r1 = await L.report(err1);
    const r2 = await L.report({ ...err1, lesson: "改依赖只用 pnpm 命令" });
    A.equal(r1.deduped, false);
    A.equal(r2.deduped, true);
    A.equal(r1.id, r2.id);
    A.equal(r2.hits, 2);
    A.equal(rows(db, "SELECT COUNT(*) AS n FROM error_ledger")[0].n, 1);
    A.equal(rows(db, "SELECT lesson FROM error_ledger")[0].lesson, "改依赖只用 pnpm 命令");
  });

  await okAsync("空输入被拒（ok:false，不写行）", async () => {
    const r = await L.report({ cmd: "", symptom: "" });
    A.equal(r.ok, false);
    A.equal(rows(db, "SELECT COUNT(*) AS n FROM error_ledger")[0].n, 1);
  });

  await L.report({
    cmd: "node test/regress.mjs",
    symptom: "MODULE_NOT_FOUND: ./p1.js",
    root_cause: "p1.js 被改名后 index.js 未同步",
    lesson: "改模块名先 grep 全部 import",
    where_solution: "index.js:53",
  });

  // ---------- search ----------
  await okAsync("search 命中、带 id、每条 ≤200 字符", async () => {
    const r = await L.search("pnpm lockfile", 3);
    A.ok(r.rows.length >= 1);
    A.ok(r.rows[0].id > 0);
    for (const line of r.text.split("\n")) A.ok([...line].length <= 200, `超长: ${line.length}`);
    A.match(r.text, /#\d+/);
  });

  await okAsync("search 查不到回「无记录」", async () => {
    const r = await L.search("zzz-不存在的关键词-zzz");
    A.equal(r.text, "无记录");
    A.equal(r.rows.length, 0);
  });

  await okAsync("limit 默认 1、上限 5", async () => {
    const one = await L.search("pnpm");
    A.equal(one.rows.length, 1);
    const many = await L.search("pnpm", 99);
    A.ok(many.rows.length <= 5);
    const zero = await L.search("pnpm", 0);
    A.equal(zero.rows.length, 1);
  });

  // ---------- 工具层输出 ----------
  await okAsync("工具 execute 返回短字符串且不抛", async () => {
    const rep = await tools.get("memory_error_report").execute({ ...err1 });
    A.match(rep, /error#\d+ 已存在 hits=3/);
    const s = await tools.get("memory_error_search").execute({ query: "pnpm" });
    A.equal(typeof s, "string");
    A.ok(s.length > 0 && s.length <= 5 * 201);
    for (const line of s.split("\n")) A.ok([...line].length <= 200);
    const w = await tools.get("memory_error_writeback").execute({ id: 1 });
    A.match(w, /writeback: 写入 1/);
  });

  await okAsync("无 db 时工具返回错误 JSON，不抛", async () => {
    const bad = registerErrorLedger({ addTool: () => {}, log: () => {}, dataDir: dir });
    const out = await bad.defs[0].execute({ cmd: "x" });
    A.match(out, /"ok":false/);
    A.match(out, /NO_DB|REPORT_FAILED/);
  });

  // ---------- writeback ----------
  await okAsync("writeback md 兜底：只入账一次，重复调用跳过", async () => {
    const target = rows(db, "SELECT id FROM error_ledger ORDER BY id LIMIT 1")[0].id;
    db.prepare("UPDATE error_ledger SET applied = 0, processed_at = NULL WHERE id = ?").run(target);
    const file = join(dir, "global", "facts", "errors-dsh.md");
    rmSync(file, { force: true });
    const first = await L.writeback({ id: target });
    A.equal(first.done, 1);
    A.equal(first.skipped, 0);
    const second = await L.writeback({ id: target });
    A.equal(second.done, 0);
    A.equal(second.skipped, 1);
    A.ok(existsSync(file));
    const body = readFileSync(file, "utf8");
    A.equal(body.split(`error_ledger:${target}`).length - 1, 1, "md 出现次数应为 1");
    const row = rows(db, "SELECT applied, processed_at FROM error_ledger WHERE id = ?", [target])[0];
    A.equal(row.applied, 1);
    A.ok(row.processed_at);
  });

  await okAsync("writeback all=1 批量处理未回写项", async () => {
    const r = await createErrorLedger(api).writeback({ all: 1 });
    A.equal(r.ok, true);
    A.equal(rows(db, "SELECT COUNT(*) AS n FROM error_ledger WHERE applied = 0")[0].n, 0);
  });

  await okAsync("writeback 走 addFact：predicate=error + source_ref", async () => {
    const db2 = mkDb("fact");
    const calls = [];
    const L2 = registerErrorLedger({
      db: db2,
      log: () => {},
      dataDir: dir,
      addFact: async (input) => {
        calls.push(input);
        return { ok: true, id: "abc123" };
      },
    });
    const r = await L2.report({ cmd: "cargo build", symptom: "E0554", root_cause: "#![feature] on stable", lesson: "换 nightly" });
    const w = await L2.writeback({ id: r.id });
    A.equal(w.done, 1);
    A.equal(calls.length, 1);
    A.equal(calls[0].predicate, "error");
    A.equal(calls[0].subject, "dsh");
    A.match(calls[0].source_ref, /error_ledger:\d+/);
    A.ok([...calls[0].value].length <= 150);
    const again = await L2.writeback({ id: r.id });
    A.equal(again.skipped, 1);
    A.equal(calls.length, 1, "不应重复入账");
  });

  await okAsync("writeback 走 store.insertRow：写 rec 且带 predicate=error", async () => {
    const db3 = mkDb("store");
    const recs = [];
    const L3 = registerErrorLedger({
      db: db3,
      log: () => {},
      dataDir: dir,
      store: { insertRow: (rec) => recs.push(rec), writeMarkdown: () => {} },
    });
    const r = await L3.report({ cmd: "git push", symptom: "non-fast-forward", root_cause: "远端有新提交", lesson: "先 pull --rebase" });
    const w = await L3.writeback({ id: r.id });
    A.equal(w.done, 1);
    A.equal(recs.length, 1);
    A.equal(recs[0].predicate, "error");
    A.equal(recs[0].scope, "global");
    A.equal(recs[0].tags.includes("error"), true);
  });

  // ---------- 日报 ----------
  await okAsync("summarizeErrors 返回 {count, top[]}", async () => {
    const s = await L.summarizeErrors(1);
    A.ok(s.count >= 2);
    A.ok(s.top.length >= 1);
    A.ok(s.top[0].signature && typeof s.top[0].hits === "number");
    A.equal(s.top[0].hits, Math.max(...s.top.map((t) => t.hits)));
    const s0 = await createErrorLedger({ log: () => {} }).summarizeErrors(1);
    A.deepEqual(s0, { count: 0, top: [] });
  });
} finally {
  for (const f of rmLater) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : "HAS FAIL"} — pass=${pass} fail=${fail}`);
}