// 自动触发回归：同签名 hits>=2 自动起草 skill，幂等不重复
// 运行：node test/auto-draft.mjs
import { strict as A } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeMemoryTools } from "../tool-glue.js";
import { listDrafts } from "../skill-drafts.js";

const root = mkdtempSync(join(tmpdir(), "dshmem-draft-"));
const db = new DatabaseSync(":memory:");
const defs = new Map();
const logs = [];
await mergeMemoryTools({
  register: (d) => defs.set(d.name, d),
  root,
  db: () => db,
  log: (...a) => logs.push(a.join(" ")),
});

const err = defs.get("memory_error");
A.ok(err, "memory_error 已注册");
const skill = defs.get("memory_skill");
A.ok(skill, "memory_skill 已注册");

const fields = {
  cmd: "cd 到不存在的路径",
  symptom: "ENOENT no such file or directory",
  root_cause: "按记忆里的旧路径直接动手，没先验证",
  lesson: "路径类操作先 ls/glob 验证存在再执行",
  where_solution: "docs/paths.md",
};

const r1 = await err.execute({ action: "report", ...fields });
A.match(String(r1), /已记 sig=/, "第 1 次只记台账");
A.equal(listDrafts({ root }).length, 0, "hits=1 不出草稿");

const r2 = await err.execute({ action: "report", ...fields });
A.match(String(r2), /hits=2/, "第 2 次累加 hits");
const drafts = listDrafts({ root });
A.equal(drafts.length, 1, "hits>=2 自动起草");
A.match(String(drafts[0].title), /台账教训/, "草稿标题带台账前缀");

const r3 = await err.execute({ action: "report", ...fields });
A.match(String(r3), /hits=3/, "第 3 次继续累加");
A.equal(listDrafts({ root }).length, 1, "同签名不重复起草");

for (let i = 0; i < 2; i += 1) {
  await err.execute({
    action: "report",
    cmd: "export default only",
    symptom: "面板不渲染",
    root_cause: "宿主按 CommonJS 读 module.exports",
    lesson: "export default 与 module.exports 双写",
  });
}
A.equal(listDrafts({ root }).length, 2, "不同签名各一份草稿");

// 三字段缺失时不硬造草稿
for (let i = 0; i < 2; i += 1) {
  await err.execute({ action: "report", cmd: "bare", root_cause: "x" });
}
A.equal(listDrafts({ root }).length, 2, "步骤不足 3 条不起草");

rmSync(root, { recursive: true, force: true });
console.log("auto-draft: ok");