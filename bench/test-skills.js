/**
 * bench/test-skills.js — skill-drafts.js 的独立回归（临时目录，不碰真实数据目录）
 * 跑法：node bench/test-skills.js
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerSkillDrafts,
  upsertDraft,
  promote,
  listDrafts,
  effectiveStatus,
  suggestDrafts,
  parseFrontmatter,
  draftFileName,
  skillsDir,
} from "../skill-drafts.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), "dsh-skill-drafts-"));
const dir = skillsDir(root);
const logs = [];
const registered = new Map();
const api = {
  root,
  log: (...a) => logs.push(a.join(" ")),
  register: (def) => registered.set(def.name, def),
};

// --- 0. 注册 ---------------------------------------------------------------
check("注册 3 个工具，且都是 string 输出", () => {
  const info = registerSkillDrafts(api);
  assert.deepEqual(info.tools.sort(), ["memory_skill_draft", "memory_skill_list", "memory_skill_suggest"]);
  assert.equal(registered.size, 3);
  for (const def of registered.values()) {
    assert.equal(def.output.schema.type, "string");
    assert.equal(typeof def.execute, "function");
    assert.equal(def.parameters.type, "object");
  }
});

const draft = registered.get("memory_skill_draft");

// --- 1. 生成草稿：frontmatter 齐全 ------------------------------------------
await checkAsync("草稿生成含完整 frontmatter", async () => {
  const out = JSON.parse(
    await draft.execute({
      title: "部署 DSH 插件",
      steps: ["先备份 facts 目录", "改 package.json 版本号", "重启 dsh 并检查 log"],
      pitfalls: "忘了备份就会丢 md 真源。",
      verification: "memory_health 三项全绿。",
      evidence: "mem_001,mem_002",
    })
  );
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(out.status, "shadow");
  assert.equal(out.file, draftFileName("部署 DSH 插件"));
  assert.ok(out.file.endsWith(".md"));

  const text = readFileSync(join(dir, out.file), "utf8");
  assert.ok(text.startsWith("---\n"), "必须有 frontmatter");
  const { data } = parseFrontmatter(text);
  assert.equal(data.status, "shadow");
  assert.equal(data.success_count, 0);
  assert.equal(data.fail_count, 0);
  assert.deepEqual(data.evidence, ["mem_001", "mem_002"]);
  assert.ok(data.name && data.description !== undefined && data.created);
  assert.ok(text.includes("## 步骤") && text.includes("1. 先备份 facts 目录"));
});

// --- 2. 重复写不产生第二个文件，且保留 maturity ----------------------------
await checkAsync("同标题重写：仍是 1 个文件、status/count 保留、正文更新", async () => {
  promote(draftFileName("部署 DSH 插件"), "success", { root });
  const before = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  const out = JSON.parse(
    await draft.execute({
      title: "部署 DSH 插件",
      steps: ["备份 facts", "改版本号", "重启", "看 memory.log 有没有 section registered"],
      evidence: "mem_003",
    })
  );
  assert.equal(out.created, false);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".md")).length, before, "不得新建第二个文件");
  const text = readFileSync(join(dir, out.file), "utf8");
  const { data } = parseFrontmatter(text);
  assert.equal(data.status, "shadow", "更新正文不能把状态重置");
  assert.equal(data.success_count, 1, "更新正文不能清空成功计数");
  assert.ok(text.includes("4. 看 memory.log"), "正文应当是新的");
});

// --- 3. 成熟度：3 次成功 → active；失败计数 ---------------------------------
check("promote：success_count>=3 → active，fail 单独计数", () => {
  const file = draftFileName("部署 DSH 插件");
  promote(file, "success", { root }); // → 2
  const active = promote(file, "success", { root }); // → 3 → active
  assert.equal(active.successCount, 3);
  assert.equal(active.status, "active");
  assert.equal(active.failCount, 0);
  const failed = promote(file, "fail", { root });
  assert.equal(failed.failCount, 1);
  assert.equal(failed.status, "active", "已 active 的不会因一次失败掉级");
  assert.throws(() => promote(file, "maybe", { root }), /outcome/, "非法 outcome 必须抛");
});

// --- 4. 180 天未用 → stale（含自愈） ---------------------------------------
check("180 天未用显示 stale；再次使用后恢复", () => {
  const f = promote(draftFileName("部署 DSH 插件"), "success", { root }); // 刷新 last_used
  const later = Date.now() + 181 * 86400000;
  const stale = listDrafts({ root, now: later });
  assert.equal(stale.find((r) => r.fileName === f.fileName).status, "stale");
  // 使用一次后（用未来的 now）应自愈为 active
  const revived = promote(f.fileName, "success", { root, now: later });
  assert.equal(revived.status, "active");
  assert.equal(effectiveStatus({ status: "active", lastUsed: new Date().toISOString() }, Date.now()), "active");
});

// --- 5. 合法性校验 --------------------------------------------------------
await checkAsync("steps 少于 3 条 → ok:false 且不落盘", async () => {
  const before = readdirSync(dir).filter((x) => x.endsWith(".md")).length;
  const out = JSON.parse(await draft.execute({ title: "太短的流程", steps: ["一步"] }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "SKILL_DRAFT_FAILED");
  assert.match(out.message, /3-8/);
  assert.equal(readdirSync(dir).filter((x) => x.endsWith(".md")).length, before);
});

await checkAsync("steps 超过 8 条 → 拒绝", async () => {
  const out = JSON.parse(await draft.execute({ title: "太长的流程", steps: Array.from({ length: 9 }, (_, i) => `第${i}步`) }));
  assert.equal(out.ok, false);
});

// --- 6. list --------------------------------------------------------------
await checkAsync("memory_skill_list：一行一条、含 status 与计数、上限 20", async () => {
  const list = registered.get("memory_skill_list");
  const text = await list.execute({ limit: 20 });
  const lines = text.split("\n");
  assert.ok(lines.length <= 20);
  assert.match(text, /\| (shadow|active|stale) \| ok=\d+ fail=\d+/);
  assert.ok(!text.includes("\n---\n"), "不应把 frontmatter 吐出来");
});

// --- 7. suggestDrafts -----------------------------------------------------
check("suggest：同 subject 同谓词 >=3 条 → 1 条建议，≤3 条，每行 ≤120", () => {
  const facts = [];
  for (let i = 0; i < 4; i += 1) {
    facts.push({ id: `m_${i}`, subject: "dsh", predicate: "deploy", value: `部署步骤 ${i}` });
  }
  for (let i = 0; i < 3; i += 1) {
    facts.push({ id: `p_${i}`, subject: "pnpm", predicate: "lockfile", value: `锁文件修复 ${i}`, tags: "pnpm,lock" });
  }
  facts.push({ id: "x_0", subject: "dsh", predicate: "other", value: "不成簇" });

  const items = suggestDrafts(facts);
  assert.ok(items.length >= 1 && items.length <= 3, `建议数 ${items.length} 应在 1..3`);
  for (const item of items) {
    assert.equal(item.count >= 3, true);
    assert.ok(item.line.length <= 120, `行超长：${item.line.length}`);
    assert.ok(Array.isArray(item.factIds) && item.factIds.length >= 3);
  }
  // 参数上限也生效
  assert.ok(suggestDrafts(facts, { limit: 1 }).length === 1);
  // 事实不足 3 条 → 无建议
  assert.equal(suggestDrafts(facts.slice(0, 2)).length, 0);
});

await checkAsync("memory_skill_suggest：没有 listFacts → NO_FACT_SOURCE；有则返回 ≤3 行", async () => {
  const baren = new Map();
  registerSkillDrafts({ root, register: (d) => baren.set(d.name, d), log: () => {} });
  const out = JSON.parse(await baren.get("memory_skill_suggest").execute({}));
  assert.equal(out.code, "NO_FACT_SOURCE");

  const withFacts = new Map();
  registerSkillDrafts({
    root,
    register: (d) => withFacts.set(d.name, d),
    log: () => {},
    listFacts: async () => [
      { id: "a1", subject: "dsh", predicate: "deploy", value: "1" },
      { id: "a2", subject: "dsh", predicate: "deploy", value: "2" },
      { id: "a3", subject: "dsh", predicate: "deploy", value: "3" },
    ],
  });
  const text = await withFacts.get("memory_skill_suggest").execute({});
  const lines = text.split("\n");
  assert.ok(lines.length <= 3);
  assert.ok(text.includes("dsh"), "建议应提到 subject");
});

// --- 8. 只读边界 -----------------------------------------------------------
check("只写 skills-drafts 子目录，不碰正式 skill 目录", () => {
  const all = readdirSync(dir);
  assert.ok(all.every((f) => f.endsWith(".md")), "目录里只应有 md 草稿");
  assert.ok(dir.endsWith(join("global", "skills-drafts")), `路径应为 global/skills-drafts：${dir}`);
});

// --- 9. 坏文件不影响整体 ----------------------------------------------------
check("目录里混入坏 md 时 list 不抛", () => {
  writeFileSync(join(dir, "broken.md"), "no frontmatter at all", "utf8");
  assert.ok(listDrafts({ root }).length >= 1);
});

rmSync(root, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exitCode = 1;