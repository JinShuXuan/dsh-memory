// 最小回归：抽取实义校验 / 冲突裁决 / 分块 / 余弦 / RRF
// 运行：node test/regress.mjs（或 npm test）
import { strict as A } from "node:assert";
import { ruleExtract, isSubstantive, decideConflict } from "../p1.js";
import { cosine, rrf } from "../embed.js";
import { PaperStore } from "../papers.js";
import { MemoryStore } from "../index.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

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
const mkStore = () => new PaperStore({}, { base: "C:\\tmp", embedder: null, log: () => {} });

// ---- 抽取：句中片段不再被当成事实，空壳值被挡 ----
ok("句中「我的X是Y」不再命中", () => A.equal(ruleExtract("你看我的问题是什么").length, 0));
ok("句首「我的名字是X」命中", () => {
  const f = ruleExtract("我的名字是张三");
  A.equal(f.length, 1);
  A.equal(f[0].value, "张三");
  A.equal(f[0].subject, "user");
});
ok("「什么」类空壳值被挡", () => A.equal(ruleExtract("我的问题是 什么").length, 0));
ok("结构词开头的无主语值被挡", () => A.equal(ruleExtract("记住：放在最后的").length, 0));
ok("多元句里只抽命中句", () => {
  const f = ruleExtract("先说别的。以后都用 pnpm 11。");
  A.equal(f.length, 1);
  A.equal(f[0].value, "用 pnpm 11");
});
ok("助手行不产生事实", () => A.equal(ruleExtract("助手：我建议以后都用 pnpm 11").length, 0));
ok("isSubstantive 边界", () => {
  A.equal(isSubstantive("学生", null), true);
  A.equal(isSubstantive("什么", null), false);
  A.equal(isSubstantive("哪里了吗", null), false);
});

// ---- 裁决：数值/否定安全阀不再被「30 天外同级」绕过 ----
const DAY = 86400000;
const now = Date.now();
const base = { id: "m1", content: "预算 100", source_type: "auto", created_at: now - 40 * DAY };
ok("同级 30 天外 + 数值变化 → 转待审", () => {
  const r = decideConflict({ existing: base, candidate: { value: "预算 200", source_type: "auto", predicate: "budget" }, now });
  A.equal(r.action, "pending");
  A.equal(r.reason, "conflict_numeric");
});
ok("同级 30 天外 + 普通改写 → 仍可演进覆盖", () => {
  const r = decideConflict({
    existing: { ...base, content: "我喜欢吃辣", predicate: "prefers" },
    candidate: { value: "我喜欢吃甜", source_type: "auto", predicate: "prefers" },
    now,
  });
  A.equal(r.action, "supersede");
});

// ---- 向量：维度不一致返回 0 而不是静默截断 ----
ok("cosine 维度不等 → 0", () => A.equal(cosine([1, 0, 0], [1, 0, 0, 0]), 0));
ok("cosine 同维 → 点积", () => A.equal(cosine([1, 0, 0], [1, 0, 0]), 1));
ok("rrf 双路融合取并集", () => {
  const r = rrf([[{ id: "a" }, { id: "b" }], [{ id: "a" }]], 60);
  A.equal(r.length, 2);
  A.equal(r[0].id, "a");
});

// ---- 分块：偏移正确、有重叠、超长硬切、页码按 \f 推算 ----
ok("chunkText 偏移与重叠", () => {
  const store = mkStore();
  const text = "这是一句用来测试分块逻辑的普通句子，长度大约三十来个字符。".repeat(40);
  const chunks = store.chunkText(text);
  A.ok(chunks.length >= 3, "should produce several chunks, got " + chunks.length);
  for (const c of chunks) {
    A.ok(c.charEnd > c.charStart, "charEnd > charStart");
    A.ok(c.text.length <= 520, "chunk too long: " + c.text.length);
    A.equal(text.slice(c.charStart, c.charEnd).replace(/\s+/g, " ").trim(), c.text.replace(/\s+/g, " ").trim());
  }
  A.ok(chunks.some((c, i) => i > 0 && c.charStart < chunks[i - 1].charEnd), "相邻块应有重叠");
});
ok("chunkText 超长无标点片段被硬切", () => {
  const chunks = mkStore().chunkText("甲".repeat(1500));
  A.ok(chunks.length >= 3);
  for (const c of chunks) A.ok(c.text.length <= 520);
});
ok("chunkText 页码跟着 \\f 走", () => {
  const s = "第一页的正文内容，用来占位足够长度以便成块。".repeat(20);
  const chunks = mkStore().chunkText(s + "\n\f\n" + s);
  const pages = new Set(chunks.map((c) => c.page));
  A.ok(pages.has(1) && pages.has(2), "应同时出现第 1、2 页，实际：" + [...pages].join(",") + `（${chunks.length} 块）`);
});

// ---- 过程回查：episode FTS + 回填 + 空查询 ----
const memStore = () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), "dshmem-"));
  const s = new MemoryStore(new DatabaseSync(pathJoin(dir, "m.db")), dir);
  s.migrate();
  return { s, dir };
};
ok("recall 能按中文关键词找到原话", () => {
  const { s, dir } = memStore();
  try {
    s.saveEpisode({ session: "s1", turn: 3, transcript: "用户：上个星期我问过养生，你说先睡好。助手：对。" });
    const hits = s.recall("养生", 3, "", "full");
    A.equal(hits.length, 1);
    A.equal(hits[0].turn, 3);
    A.ok(hits[0].snippet.includes("养生"), "snippet: " + hits[0].snippet);
  } finally {
    try {
      s.db.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
ok("recall 空查询返回空且不抛", () => {
  const { s, dir } = memStore();
  try {
    A.equal(s.recall("", 3).length, 0);
  } finally {
    try {
      s.db.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
ok("recall 回填未进 FTS 的旧 episode", () => {
  const { s, dir } = memStore();
  try {
    s.db
      .prepare(
        "INSERT INTO episode (id, session, turn, seq, role, source_kind, raw, content_hash, created_at, extract_state) VALUES ('ep_x','s9',1,1,'turn','turn','用户：聊到 C++ 模板','h',?, 'done')",
      )
      .run(Date.now());
    A.equal(s.db.prepare("SELECT COUNT(*) AS n FROM episode_fts").get().n, 0);
    A.equal(s.backfillEpisodeFts(), 1);
    A.equal(s.db.prepare("SELECT COUNT(*) AS n FROM episode_fts").get().n, 1);
    A.equal(s.recall("C++", 3).length, 1);
  } finally {
    try {
      s.db.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed${process.exitCode ? ", some failed" : ""}`);