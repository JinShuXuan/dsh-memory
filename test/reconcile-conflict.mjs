// 2026-11-07 事故回归：孤儿 md 不许毒化 reconcile / open
// 2026-11-10 设计变更：唯一索引改为「含 content_hash」→ 同谓词**不同值允许并存**，
//   覆盖只发生在「同一件事被改口」（语义判重命中并显式传入旧条）时。
// 运行：node test/reconcile-conflict.mjs
import { MemoryStore } from "../index.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as A } from "node:assert";

const LOG_FILE = process.env.DSH_MEMORY_ROOT ? join(process.env.DSH_MEMORY_ROOT, "memory.log") : "D:\\\\dsh-memory\\\\memory.log";

function orphanMd(dir, { id, subject, predicate, value }) {
  const facts = join(dir, "global", "facts");
  mkdirSync(facts, { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    "kind: fact",
    "scope: global",
    `subject: "${subject}"`,
    `predicate: "${predicate}"`,
    "status: active",
    "layer: atomic",
    "confidence: 1",
    "source_type: auto",
    "created_at: 2026-11-07T10:54:36.881Z",
    "updated_at: 2026-11-07T10:54:36.881Z",
    'tags: ["config"]',
    "---",
    "",
    value,
  ].join("\n");
  writeFileSync(join(facts, `${id}.md`), fm, "utf8");
}

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

// 1) 孤儿 md：同谓词不同值 → 新设计下允许并存，只要求不抛、不污染原条
{
  const dir = mkdtempSync(join(tmpdir(), "dshmem-orphan-"));
  const s = new MemoryStore(new DatabaseSync(join(dir, "m.db")), dir);
  s.migrate();
  s.resolveWrite({ scope: "global", subject: "user", predicate: "name", value: "Alice", source_type: "explicit" });
  orphanMd(dir, { id: "m_orphan_test", subject: "user", predicate: "name", value: "别的名字" });

  ok("reconcile 遇同主谓孤儿 md 不抛异常", () => {
    const r = s.reconcile();
    A.equal(r.checked, 2, "正常条 + 孤儿 md 都被扫到");
    A.equal(r.added, 1, "同谓词不同值按新设计补插（并存）");
  });
  ok("原 active 事实未被污染", () => {
    const row = s.db
      .prepare("SELECT value FROM memory WHERE id <> 'm_orphan_test' AND predicate='name' AND status='active'")
      .get();
    A.equal(row.value, "Alice");
  });
  try {
    s.db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

// 2) open()：盘上已有同谓词孤儿 md，初始化必须成功
{
  const dir = mkdtempSync(join(tmpdir(), "dshmem-open-"));
  const seed = new MemoryStore(new DatabaseSync(join(dir, "m.db")), dir);
  seed.migrate();
  seed.resolveWrite({ scope: "global", subject: "user", predicate: "name", value: "Alice", source_type: "explicit" });
  try {
    seed.db.close();
  } catch {
    /* ignore */
  }
  orphanMd(dir, { id: "m_orphan_open", subject: "user", predicate: "name", value: "重复的" });

  const opened = await MemoryStore.open({ root: dir, dbPath: join(dir, "m.db") });
  ok("open() 带着同主谓 md 也能初始化成功", () => {
    A.ok(opened && opened.db);
    const n = opened.db.prepare("SELECT COUNT(*) c FROM memory WHERE status='active'").get().c;
    A.equal(n, 2, "新设计：同谓词不同值并存，active 应为 2");
  });
  try {
    opened.db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

// 3) 语义判重契约：不传旧条 = 并存；传旧条 + force = 覆盖（先废后插）
{
  const dir = mkdtempSync(join(tmpdir(), "dshmem-samefact-"));
  const s = new MemoryStore(new DatabaseSync(join(dir, "m.db")), dir);
  s.migrate();
  const base = { scope: "global", subject: "user", predicate: "budget", source_type: "auto" };
  s.resolveWrite({ ...base, value: "预算 20 元" });

  ok("不同值不传旧条 → 并存（两条 active）", () => {
    s.resolveWrite({ ...base, value: "预算 30 元" });
    const n = s.db.prepare("SELECT COUNT(*) c FROM memory WHERE predicate='budget' AND status='active'").get().c;
    A.equal(n, 2);
  });

  ok("同值 → merge，不新增行", () => {
    const r = s.resolveWrite({ ...base, value: "预算 20 元" });
    A.equal(r.action, "merge");
    const n = s.db.prepare("SELECT COUNT(*) c FROM memory WHERE predicate='budget' AND status='active'").get().c;
    A.equal(n, 2);
  });

  ok("传旧条 + force → supersede，旧条退出 active", () => {
    const old = s.db.prepare("SELECT * FROM memory WHERE predicate='budget' AND value='预算 20 元'").get();
    const r = s.resolveWrite({ ...base, value: "预算 40 元", force: true }, old);
    A.equal(r.supersededId, old.id);
    A.equal(s.db.prepare("SELECT status FROM memory WHERE id = ?").get(old.id).status, "superseded");
  });

  try {
    s.db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

// 4) approve 疑点不算事实
{
  const dir = mkdtempSync(join(tmpdir(), "dshmem-pending-"));
  const s = new MemoryStore(new DatabaseSync(join(dir, "m.db")), dir);
  s.migrate();
  const pid = s.addPending({
    candidate: { scope: "global", subject: "user", predicate: "replay_suspicion", value: "重放疑点：测试", confidence: 0.6, source_type: "auto" },
    reason: "replay_suspicion",
  });
  ok("approve replay_suspicion → NOT_A_FACT，不写库", () => {
    const r = s.resolvePending({ id: pid, action: "approve" });
    A.equal(r.ok, false);
    A.equal(r.code, "NOT_A_FACT");
    const n = s.db.prepare("SELECT COUNT(*) c FROM memory WHERE predicate='replay_suspicion'").get().c;
    A.equal(n, 0);
  });
  try {
    s.db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${pass} passed, exitCode=${process.exitCode ?? 0}`);
process.exit(process.exitCode ?? 0);