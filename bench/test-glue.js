/**
 * bench/test-glue.js —— 验证 tool-glue 折叠：2 个合并工具、action 分派、参数并集。
 * 不碰真库：临时目录 + 假 register；db 永远不 resolve（合并阶段本就不该碰 db）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMemoryTools, foldToolDefs, GROUPS } from "../tool-glue.js";

const cases = [];
const check = async (name, fn) => {
  try {
    await fn();
    cases.push([name, true]);
    console.log("  ok  " + name);
  } catch (error) {
    cases.push([name, false, error]);
    console.log("FAIL  " + name + ": " + (error?.message ?? error));
  }
};

const fakeDef = (name, action, capture) => ({
  name,
  description: name,
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
      subject: { type: "string" },
    },
  },
  execute: async (args) => {
    capture.push({ name, action, args });
    return "RAN:" + action;
  },
});

const root = mkdtempSync(join(tmpdir(), "glue-"));

try {
  const registered = [];
  const api = {
    register: (def) => registered.push(def),
    root,
    log: () => {},
    db: () => {
      throw new Error("合并阶段不应触碰 db");
    },
  };
  const res = await mergeMemoryTools(api);

  await check("产出恰好 2 个合并工具，且注册 2 次（不是 6 次）", async () => {
    assert.equal(res.defs.length, 2);
    assert.deepEqual(res.defs.map((d) => d.name), ["memory_error", "memory_skill"]);
    assert.deepEqual(res.registered, ["memory_error", "memory_skill"]);
    assert.equal(registered.length, 2);
    assert.equal(res.collected.length, 6, "应收集到 6 个原 def 但没有注册出去");
  });

  await check("未知 action 返回字符串、不抛", async () => {
    for (const def of res.defs) {
      const out = await def.execute({ action: "bogus" });
      assert.equal(typeof out, "string");
      assert.match(out, /未知 action/);
      const empty = await def.execute({});
      assert.match(empty, /未知 action/);
    }
  });

  await check("已知 action 分派到对应 def，且 action 字段被剔除", async () => {
    const capture = [];
    const defs = [
      fakeDef("memory_error_report", "report", capture),
      fakeDef("memory_error_search", "search", capture),
      fakeDef("memory_error_writeback", "writeback", capture),
      fakeDef("memory_skill_draft", "draft", capture),
      fakeDef("memory_skill_list", "list", capture),
      fakeDef("memory_skill_suggest", "suggest", capture),
    ];
    const [errDef, skillDef] = foldToolDefs(defs);
    assert.equal(await errDef.execute({ action: "report", cmd: "npm test", limit: 3 }), "RAN:report");
    assert.equal(capture[0].name, "memory_error_report");
    assert.deepEqual(capture[0].args, { cmd: "npm test", limit: 3 });
    assert.equal("action" in capture[0].args, false);
    assert.equal(await skillDef.execute({ action: "suggest", subject: "user" }), "RAN:suggest");
    assert.equal(capture[1].name, "memory_skill_suggest");
    assert.deepEqual(capture[1].args, { subject: "user" });
  });

  await check("参数并集包含 limit/query/subject，且 required 只有 action", async () => {
    const props = (d) => Object.keys(d.parameters.properties);
    const errDef = res.defs[0];
    const skillDef = res.defs[1];
    for (const d of res.defs) {
      assert.deepEqual(d.parameters.required, ["action"]);
      assert.equal(d.parameters.properties.action.type, "string");
      assert.equal(d.parameters.properties.limit.type, "integer");
      assert.equal(d.output.schema.type, "string");
    }
    assert.deepEqual(props(errDef).sort(), ["action", "all", "cmd", "id", "lesson", "limit", "query", "root_cause", "symptom", "where_solution"].sort());
    assert.deepEqual(props(skillDef).sort(), ["action", "description", "evidence", "limit", "pitfalls", "steps", "subject", "title", "verification"].sort());
    assert.deepEqual(errDef.parameters.properties.action.enum, ["report", "search", "writeback"]);
    assert.deepEqual(skillDef.parameters.properties.action.enum, ["draft", "list", "suggest"]);
  });

  await check("错误消息里列出可用 action", async () => {
    const out = await res.defs[0].execute({ action: "nope" });
    for (const action of GROUPS[0].actions ? Object.keys(GROUPS[0].actions) : []) assert.ok(out.includes(action), action);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = cases.filter((c) => !c[1]);
console.log(`\n${failed.length ? "HAS FAIL" : "ALL PASS"} — pass=${cases.length - failed.length} fail=${failed.length}`);
if (failed.length) process.exitCode = 1;