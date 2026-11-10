// bench/test-errors.js — 错误台账验收（独立临时目录 + 独立 db，不碰线上库）
// 运行：node bench/test-errors.js
import { strict as A } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import registerErrorLedger, { createErrorLedger, ledgerAdmin, sanitize, signatureOf } from "../error-ledger.js";

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

  // ---------- 脱敏（P0-A） ----------
  ok("sanitize 命中 4 类：sk-/Bearer/口令键值/Windows 用户目录", () => {
    A.equal(
      sanitize("curl -H 'Authorization: Bearer abc123.def-456' -d sk-live0123456789"),
      "curl -H 'Authorization: Bearer ***' -d sk-***",
    );
    A.equal(sanitize("mysql password=hunter2 --api_key: k123"), "mysql password=*** --api_key=***");
    A.equal(
      sanitize("cat C:\\Users\\bob\\.dsh\\profiles\\desktop\\config.toml"),
      "cat C:\\Users\\***\\.dsh\\profiles\\desktop\\config.toml",
    );
    A.equal(sanitize("secret: abc token=xyz"), "secret=*** token=***");
  });

  ok("sanitize 幂等 + 空值安全", () => {
    const raw = "Bearer t-111.222 sk-abcdefghij password=px C:\\Users\\bob\\a.txt";
    const once = sanitize(raw);
    A.equal(sanitize(once), once);
    A.equal(sanitize(sanitize(sanitize(raw))), once);
    A.equal(sanitize(""), "");
    A.equal(sanitize(null), "");
  });

  await okAsync("写入路径脱敏：台账里不留明文密钥", async () => {
    const dbW = mkDb("sanitize-write");
    const LW = registerErrorLedger({ db: dbW, log: () => {}, dataDir: dir });
    const r = await LW.report({
      cmd: "export OPENAI_API_KEY=sk-proj-abcdefgh12345678",
      symptom: "401 Unauthorized: Bearer eyJhbGciOi.abc",
      root_cause: "token=abc123 过期",
      lesson: "别把 C:\\Users\\bob\\secret.txt 打进日志",
      where_solution: "password=zzz 见 .env",
    });
    const row = rows(dbW, "SELECT * FROM error_ledger WHERE id = ?", [r.id])[0];
    A.equal(row.cmd, "export OPENAI_API_KEY=***");
    A.equal(row.symptom, "401 Unauthorized: Bearer ***");
    A.equal(row.root_cause, "token=*** 过期");
    A.equal(row.lesson, "别把 C:\\Users\\***\\secret.txt 打进日志");
    A.equal(row.where_solution, "password=*** 见 .env");
    for (const v of [row.cmd, row.symptom, row.root_cause, row.lesson, row.where_solution]) {
      A.ok(!/sk-proj-|eyJhbGciOi|abc123|zzz/.test(v), `残留明文: ${v}`);
    }
  });

  await okAsync("读取路径脱敏：历史脏行 search 也不回明文", async () => {
    const target = rows(db, "SELECT id FROM error_ledger ORDER BY id LIMIT 1")[0].id;
    db.prepare("UPDATE error_ledger SET cmd = ?, symptom = ? WHERE id = ?").run(
      `psql -c "password=legacy123" --token=abcd1234`,
      "Bearer legacy.token.value",
      target,
    );
    const raw = rows(db, "SELECT cmd, symptom FROM error_ledger WHERE id = ?", [target])[0];
    A.ok(raw.cmd.includes("legacy123"), "库里确实是脏数据");
    const r = await L.search("psql password", 3);
    A.ok(r.rows.some((x) => x.id === target));
    A.ok(!r.text.includes("legacy123"), "text 未脱敏");
    A.ok(!JSON.stringify(r.rows).includes("legacy123"), "rows 未脱敏");
    A.ok(!JSON.stringify(r.rows).includes("abcd1234"));
    A.ok(!JSON.stringify(r.rows).includes("legacy.token.value"));
  });

  // ---------- 台账管理（P0-A） ----------
  await okAsync("delete 软删：status=deleted，search/list 不可见，行仍在", async () => {
    const target = rows(db, "SELECT id FROM error_ledger ORDER BY id LIMIT 1")[0].id;
    const before = rows(db, "SELECT COUNT(*) AS n FROM error_ledger")[0].n;
    const d = await L.admin({ action: "delete", id: target });
    A.equal(d.ok, true);
    A.equal(d.deleted, 1);
    A.equal(rows(db, "SELECT status FROM error_ledger WHERE id = ?", [target])[0].status, "deleted");
    A.equal(rows(db, "SELECT COUNT(*) AS n FROM error_ledger")[0].n, before, "软删不物理删行");
    const s = await L.search("psql password", 3);
    A.ok(!s.rows.some((x) => x.id === target));
    const list = await L.admin({ action: "list" });
    A.equal(list.ok, true);
    A.ok(!list.rows.some((x) => x.id === target));
    A.ok(list.rows.length <= 20);
    const again = await L.admin({ action: "delete", id: 999999 });
    A.equal(again.ok, false);
    A.equal(again.code, "NOT_FOUND");
  });

  await okAsync("purge 硬删一条：行数 -1", async () => {
    const dbP = mkDb("purge");
    const LP = registerErrorLedger({ db: dbP, log: () => {}, dataDir: dir });
    await LP.report({ cmd: "cmd-a", symptom: "s1" });
    const b = await LP.report({ cmd: "cmd-b", symptom: "s2" });
    const before = rows(dbP, "SELECT COUNT(*) AS n FROM error_ledger")[0].n;
    A.equal(before, 2);
    const p = await LP.admin({ action: "purge", id: b.id });
    A.equal(p.ok, true);
    A.equal(p.removed, 1);
    A.equal(rows(dbP, "SELECT COUNT(*) AS n FROM error_ledger")[0].n, before - 1);
    A.equal(rows(dbP, "SELECT COUNT(*) AS n FROM error_ledger WHERE id = ?", [b.id])[0].n, 0);
  });

  await okAsync("export JSONL：行数与库一致、可选写文件、敏感字段已脱敏", async () => {
    const dbE = mkDb("export");
    const LE = registerErrorLedger({ db: dbE, log: () => {}, dataDir: dir });
    await LE.report({ cmd: "curl --token=abc123456", symptom: "sk-abcdefghij" });
    await LE.report({ cmd: "npm test", symptom: "boom" });
    const outFile = join(dir, "out", "errors.jsonl");
    const exp = await LE.admin({ action: "export", format: "jsonl", outFile });
    A.equal(exp.ok, true);
    A.equal(exp.path, outFile);
    A.equal(exp.rows, rows(dbE, "SELECT COUNT(*) AS n FROM error_ledger")[0].n);
    const lines = exp.text.split("\n").filter(Boolean);
    A.equal(lines.length, exp.rows);
    A.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
    A.ok(!exp.text.includes("abc123456"));
    A.ok(!exp.text.includes("sk-abcdefghij"));
    A.ok(existsSync(outFile));
    A.equal(readFileSync(outFile, "utf8").split("\n").filter(Boolean).length, exp.rows);
    const bad = await LE.admin({ action: "export", format: "csv" });
    A.equal(bad.ok, false);
    A.equal(bad.code, "BAD_FORMAT");
    const nope = await LE.admin({ action: "nope" });
    A.equal(nope.ok, false);
    A.equal(nope.code, "BAD_ACTION");
  });

  await okAsync("ledgerAdmin(api) 工厂与 ledgerAdmin(api, opts) 直调均可用", async () => {
    const dbF = mkDb("factory");
    const apiF = { db: dbF, log: () => {}, dataDir: dir };
    const run = ledgerAdmin(apiF);
    const r = await createErrorLedger(apiF).report({ cmd: "factory-cmd", symptom: "x" });
    const list1 = await run({ action: "list" });
    A.equal(list1.ok, true);
    A.equal(list1.rows[0].id, r.id);
    const list2 = await ledgerAdmin(apiF, { action: "list" });
    A.equal(list2.ok, true);
    A.equal(list2.count, 1);
    const noDb = await ledgerAdmin({}, { action: "list" });
    A.equal(noDb.ok, false);
    A.equal(noDb.code, "ADMIN_FAILED");
  });

  await okAsync("旧库缺 status/updated_at 时自动补列，默认 active 且可 list", async () => {
    const dbO = mkDb("old");
    dbO.exec(
      "CREATE TABLE error_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT UNIQUE, ts TEXT, cmd TEXT, symptom TEXT, root_cause TEXT, lesson TEXT, where_solution TEXT, applied INTEGER DEFAULT 0, hits INTEGER DEFAULT 0, processed_at TEXT)",
    );
    dbO
      .prepare("INSERT INTO error_ledger (signature, ts, cmd, symptom, hits) VALUES ('s1', ?, 'legacy-cmd', 'legacy-sym', 1)")
      .run(new Date().toISOString());
    const LO = createErrorLedger({ db: dbO, log: () => {} });
    const list = await LO.admin({ action: "list" });
    A.equal(list.ok, true);
    A.equal(list.count, 1);
    A.equal(list.rows[0].status, "active");
    const cols = rows(dbO, "PRAGMA table_info(error_ledger)").map((c) => c.name);
    A.ok(cols.includes("status"));
    A.ok(cols.includes("updated_at"));
    const again = await createErrorLedger({ db: dbO, log: () => {} }).admin({ action: "list" });
    A.equal(again.ok, true);
    A.equal(again.count, 1);
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