// 开箱即用回归：全新数据根 → open() 建库 → 写入 → 检索 → 重开仍可检索。
// 覆盖发布门禁 A3（空库开箱）：不依赖本机 ~/.dsh-memory，也不下载向量模型。
import { strict as A } from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "dshmem-fresh-"));
process.env.DSH_MEMORY_ROOT = dir;
process.env.DSH_MEMORY_NO_DOWNLOAD = "1";

const { MemoryStore } = await import("../index.js");

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log("  ok", name);
}

const dbPath = join(dir, "index", "memory.db");
const count = (s) => Number(s.db.prepare("SELECT COUNT(*) AS n FROM memory").get().n);

try {
  const store = await MemoryStore.open({ root: dir, dbPath });

  await ok("首启建库，库为空", () => {
    A.equal(count(store), 0);
    A.ok(readdirSync(dir).length > 0, "数据根未创建");
  });

  await ok("写入一条显式事实", async () => {
    const r = await store.resolveWrite({
      scope: "global",
      subject: "user",
      predicate: "editor",
      value: "Neovim",
      source_type: "explicit",
    });
    A.equal(r.action, "insert");
    A.equal(count(store), 1);
  });

  await ok("FTS 检索命中", async () => {
    const hits = await store.search("Neovim", "global", 5);
    A.ok(hits.length > 0, "search 无结果");
    A.ok(JSON.stringify(hits).includes("Neovim"), "结果不含查询词");
  });

  await ok("关闭后重开仍可检索", async () => {
    store.db.close();
    const again = await MemoryStore.open({ root: dir, dbPath });
    A.equal(count(again), 1);
    const hits = await again.search("Neovim", "global", 5);
    A.ok(hits.length > 0, "重开后 search 无结果");
    again.db.close();
  });

  console.log(`${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}