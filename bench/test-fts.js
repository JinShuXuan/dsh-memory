/**
 * bench/test-fts.js — 索引地基回归：FTS 双列 / 短语召回 / fusion 排序 / indexStats / subject 归一
 * 跑法：node bench/test-fts.js
 * 全程用临时目录（<repo>/.tmp-test/<ts>/），process.env.DSH_MEMORY_ROOT 指向它，绝不碰真实 ~/.dsh-memory。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "..", ".tmp-test", String(Date.now()));
process.env.DSH_MEMORY_ROOT = TMP;
mkdirSync(join(TMP, "index"), { recursive: true });
mkdirSync(join(TMP, "global", "facts"), { recursive: true });

const { DatabaseSync } = await import("node:sqlite");
const { MemoryStore, DEFAULT_CONFIG } = await import("../index.js");

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
    if (process.env.DEBUG) console.log(error?.stack ?? error);
    process.exitCode = 1;
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** 写临时配置：fusion/fts 可逐场景切换（loadConfig 每次读文件，改完即生效） */
function writeConfig(patch = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    fts: { ...DEFAULT_CONFIG.fts, ...(patch.fts ?? {}) },
    fusion: { ...DEFAULT_CONFIG.fusion, ...(patch.fusion ?? {}) },
    decay: { ...DEFAULT_CONFIG.decay, ...(patch.decay ?? {}) },
  };
  writeFileSync(join(TMP, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
}
writeConfig();

function openStore(name) {
  const root = join(TMP, name);
  mkdirSync(join(root, "index"), { recursive: true });
  const file = join(root, "index", "memory.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const store = new MemoryStore(db, root);
  store.migrate();
  return { store, db, root, file };
}

const SAMPLES = [
  ["记忆插件的日志在 ~/.dsh-memory\\memory.log", "dsh", "logs_in"],
  ["Alice在示例大学读大一", "user", "studies_at"],
  ["农历三月初三是Alice的生日", "user", "born_on"],
  ["DSH 的配置文件放在 config.json 里", "dsh", "config_at"],
  ["sqlite 的 FTS5 支持中文短语匹配", "dsh", "uses_fts"],
  ["向量检索使用余弦相似度排序", "dsh", "ranks_by"],
  ["索引地基包含建表和回填两部分", "dsh", "consists_of"],
  ["记忆库按主题聚类归纳", "dsh", "clusters_by"],
  ["插件启动时加载全部向量到内存", "dsh", "loads_vectors"],
  ["遗忘曲线按新鲜度和频次计算激活分", "dsh", "decay_formula"],
  ["对账会修复缺失的 markdown 文件", "dsh", "reconciles"],
  ["备份文件以 bak 后缀保存在同目录", "dsh", "backup_suffix"],
  ["召回写回只在真正注入时发生", "dsh", "writeback_when"],
  ["subject 归一化把别名改成标准主语", "dsh", "canonicalizes"],
  ["全文索引升级为双列结构", "dsh", "dual_column"],
  ["测试用临时目录不碰真实数据库", "dsh", "temp_dir"],
  ["权威事实以 markdown 为真源", "dsh", "source_of_truth"],
  ["待审队列处理冲突的记忆", "dsh", "pending_review"],
  ["墓碑文件七天后清理", "dsh", "tombstone"],
  ["关联图按相似度连边", "dsh", "links_by_cos"],
  ["The memory plugin writes logs to memory.log", "dsh", "writes_logs"],
  ["SQLite FTS5 provides full text search", "dsh", "provides"],
  ["Vector search ranks results by cosine similarity", "dsh", "ranks"],
  ["The index foundation has tables and backfill", "dsh", "has_parts"],
  ["Backup files keep a bak suffix", "dsh", "keeps_suffix"],
  ["Recall writeback only happens on injection", "dsh", "happens_when"],
  ["Subject normalization rewrites aliases", "dsh", "rewrites"],
  ["Full text index stores two columns", "dsh", "stores_columns"],
  ["Tests run in a temporary directory", "dsh", "run_in"],
  ["Markdown files are the source of truth", "dsh", "is_truth"],
];

function seed(store) {
  const ids = [];
  for (const [value, subject, predicate] of SAMPLES) {
    const r = store.store({ value, subject, predicate, tags: [subject, "bench"], scope: "global", sourceType: "explicit" });
    assert(r?.id, `store failed: ${value} → ${JSON.stringify(r)}`);
    ids.push(r.id);
  }
  return ids;
}

// 查询 → 可接受的 top1 集合（下标对应 SAMPLES）
const QUERIES = [
  ["农历三月初三", [2]],
  ["示例大学物理学院", [1]],
  ["余弦相似度", [5, 22]],
  ["全文索引升级为双列结构", [14]],
  ["召回写回只在真正注入时发生", [12]],
  ["subject 归一化", [13]],
  ["墓碑文件七天后清理", [18]],
  ["backfill", [23]],
  ["cosine similarity", [5, 22]],
  ["source of truth", [16, 29]],
];

/** 假向量：给每条样本一个 8 维 one-hot，embed(query) 由「期望下标」决定，用来验证 fusion 用上向量那一路 */
function stubVectors(store, ids) {
  const dim = 8;
  const vecOf = (i) => {
    const v = new Float32Array(dim);
    v[i % dim] = 1;
    return v;
  };
  ids.forEach((id, i) => store.vec.set(id, vecOf(i)));
  // 查询 -> 期望下标（中文短语取首个词元的槽位），让语义路给出一个稳定候选
  store.embedder = {
    ready: true,
    async embed(query) {
      const q = String(query);
      const hit = ids.findIndex((_, i) => SAMPLES[i][0].includes(q.slice(0, 4)));
      const v = new Float32Array(dim);
      v[(hit >= 0 ? hit : 0) % dim] = 1;
      return v;
    },
    stats: () => ({ ready: true, dim, model: "stub" }),
  };
}

function rankOf(hits, allowedIds) {
  const idx = hits.findIndex((h) => allowedIds.includes(h.id));
  return idx; // -1 = 未命中
}

const main = await openStore("main");
const ids = seed(main.store);
// 没有真 embedder，write 时排队的向量算不完；把队列清掉，indexStats 才可能报健康
main.db.exec("UPDATE memory SET vec_state = 'done' WHERE vec_state = 'pending'");

await checkAsync("FTS 行数 == memory 行数", () => {
  const mem = main.db.prepare("SELECT COUNT(*) n FROM memory").get().n;
  const fts = main.db.prepare("SELECT COUNT(*) n FROM memory_fts").get().n;
  assert(mem === SAMPLES.length, `memory 行数 ${mem} != ${SAMPLES.length}`);
  assert(fts === mem, `fts 行数 ${fts} != memory ${mem}`);
});

await checkAsync("FTS 表是双列结构（memory_id/seg/raw）", () => {
  const cols = main.db.prepare("PRAGMA table_info(memory_fts)").all().map((c) => c.name);
  assert(cols.includes("seg") && cols.includes("raw"), `列：${cols.join(",")}`);
});

// 中文/英文 top1 命中：10 条查询里至少 8 条把期望事实排在第一位
let top1Hits = 0;
const top1Detail = [];
for (const [query, expectIdxs] of QUERIES) {
  const hits = await main.store.search(query, undefined, 10);
  const allowed = expectIdxs.map((i) => ids[i]);
  const rank = rankOf(hits, allowed);
  if (rank === 0) top1Hits += 1;
  top1Detail.push(`${query}:${rank === 0 ? "ok" : `rank${rank + 1}`}`);
}
await checkAsync(`检索 top1 命中数 ${top1Hits}/10（要求 ≥8）`, () => {
  assert(top1Hits >= 8, `明细 ${top1Detail.join(" | ")}`);
});

stubVectors(main.store, ids);
const fusionHits = [];
for (const [query, expectIdxs] of QUERIES) {
  const hits = await main.store.search(query, undefined, 10);
  fusionHits.push(rankOf(hits, expectIdxs.map((i) => ids[i])) === 0);
}
writeConfig({ fusion: { enabled: false } });
const rrfHits = [];
for (const [query, expectIdxs] of QUERIES) {
  const hits = await main.store.search(query, undefined, 10);
  rrfHits.push(rankOf(hits, expectIdxs.map((i) => ids[i])) === 0);
}
writeConfig();
const fCount = fusionHits.filter(Boolean).length;
const rCount = rrfHits.filter(Boolean).length;
await checkAsync(`fusion top1 ${fCount} >= rrf ${rCount}`, () => {
  assert(fCount >= rCount, `fusion ${fCount} < rrf ${rCount}`);
});

await checkAsync("indexStats 结构与健康的库", () => {
  const s = main.store.indexStats();
  assert(s.ok === true && s.ftsTable === true, `ftsTable=${s.ftsTable}`);
  assert(s.rows.memory === SAMPLES.length, `rows.memory=${s.rows.memory}`);
  assert(s.rows.ftsMissing === 0, `ftsMissing=${s.rows.ftsMissing}`);
  assert(s.coverage.fts === 1, `coverage.fts=${s.coverage.fts}`);
  assert(s.healthy === true, `healthy=false ${JSON.stringify(s.orphans)}`);
  assert(s.markdown.rows === SAMPLES.length, `md rows=${s.markdown.rows}`);
});

await checkAsync("删一行 → 孤儿可检出 → rebuildFts 复原", () => {
  const victim = ids[0];
  main.db.prepare("DELETE FROM memory WHERE id = ?").run(victim);
  const broken = main.store.indexStats();
  assert(broken.orphans.ftsWithoutMemory === 1, `重建前 ftsWithoutMemory=${broken.orphans.ftsWithoutMemory}`);
  assert(broken.healthy === false, "删行后仍报 healthy");
  const out = main.store.rebuildFts();
  assert(out.rebuilt === SAMPLES.length - 1, `rebuilt=${out.rebuilt}`);
  const fixed = main.store.indexStats();
  assert(fixed.rows.ftsMissing === 0, `重建后 ftsMissing=${fixed.rows.ftsMissing}`);
  assert(fixed.healthy === true, `重建后 healthy=false ${JSON.stringify(fixed.orphans)}`);
});

await checkAsync("fts.enabled=false：走 LIKE 兜底且不抛", async () => {
  writeConfig({ fts: { enabled: false } });
  try {
    const off = openStore("nofts");
    seed(off.store);
    assert(off.store.fts === false, "store.fts 应为 false");
    const table = off.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get();
    assert(!table, "fts.enabled=false 仍建了 memory_fts");
    const hits = await off.store.search("余弦相似度", undefined, 5);
    assert(hits.length > 0, "LIKE 兜底没结果");
    const s = off.store.indexStats();
    assert(s.ftsTable === false && s.healthy === false, `关闭 FTS 时 indexStats 应报不健康：${JSON.stringify(s)}`);
    off.db.close();
  } finally {
    writeConfig();
  }
});

await checkAsync("旧单列 FTS 自动升级出 raw 列", () => {
  const legacy = openStore("legacy");
  seed(legacy.store);
  legacy.db.exec("DROP TABLE memory_fts");
  legacy.db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, seg, tokenize='unicode61')");
  const ins = legacy.db.prepare("INSERT INTO memory_fts(memory_id, seg) SELECT id, value FROM memory");
  ins.run();
  const before = legacy.db.prepare("SELECT COUNT(*) n FROM memory_fts").get().n;
  // 模拟重启：同一个库文件重新 migrate
  const db2 = new DatabaseSync(legacy.file);
  const store2 = new MemoryStore(db2, legacy.root);
  store2.migrate();
  const cols = db2.prepare("PRAGMA table_info(memory_fts)").all().map((c) => c.name);
  assert(cols.includes("raw"), `升级后列：${cols.join(",")}`);
  const after = db2.prepare("SELECT COUNT(*) n FROM memory_fts").get().n;
  assert(after === before, `回填行数 ${after} != ${before}`);
  const raw = db2.prepare("SELECT raw FROM memory_fts LIMIT 1").get()?.raw;
  assert(typeof raw === "string" && raw.length > 0, "raw 列为空");
  db2.close();
  legacy.db.close();
});

await checkAsync("normalizeSubjects：dry-run 不写库，apply 同步 md", () => {
  const norm = openStore("norm");
  const nids = seed(norm.store);
  // 绕过写入层直接把主语改成历史别名（真实库里遗留数据就是这样）
  norm.db.prepare("UPDATE memory SET subject = '用户' WHERE id = ?").run(nids[0]);
  norm.db.prepare("UPDATE memory SET subject = 'dsh_memory' WHERE id = ?").run(nids[1]);
  norm.store.writeMarkdown(norm.store.get(nids[0]));
  norm.store.writeMarkdown(norm.store.get(nids[1]));
  const dry = norm.store.normalizeSubjects({ dryRun: true });
  assert(dry.dryRun === true && dry.count === 2, `dry-run count=${dry.count}`);
  assert(norm.db.prepare("SELECT subject FROM memory WHERE id=?").get(nids[0]).subject === "用户", "dry-run 写了库");
  const applied = norm.store.normalizeSubjects({ dryRun: false });
  assert(applied.updated === 2, `updated=${applied.updated}`);
  const s1 = norm.db.prepare("SELECT subject FROM memory WHERE id=?").get(nids[0]).subject;
  const s2 = norm.db.prepare("SELECT subject FROM memory WHERE id=?").get(nids[1]).subject;
  assert(s1 === "user" && s2 === "dsh", `归一后=${s1}/${s2}`);
  const md = readFileSync(join(norm.root, "global", "facts", `${nids[0]}.md`), "utf8");
  assert(md.includes('subject: "user"'), `md 未同步：${md.split("\n").slice(0, 8).join(" ")}`);
  const ftsRow = norm.db.prepare("SELECT raw FROM memory_fts WHERE memory_id=?").get(nids[0]);
  assert(ftsRow && ftsRow.raw.includes("user"), "FTS raw 未随主语更新");
  norm.db.close();
});

// 2026-11-11（B1）：来源分级 —— 同激活、同 BM25 下，分数只差 sourceTier
await checkAsync("来源序：explicit 排 auto 前、inferred 排 auto 后", async () => {
  const mk = (tier, suffix) => {
    const r = main.store.store({
      value: `来源序标记${suffix}`,
      subject: "bench",
      predicate: `tier_${tier}`,
      tags: ["bench"],
      scope: "global",
      sourceType: tier,
    });
    assert(r?.id, `store(${tier}) 失败：${JSON.stringify(r)}`);
    return r.id;
  };
  const autoId = mk("auto", "甲");
  const explicitId = mk("explicit", "乙");
  const inferredId = mk("inferred", "丙");
  const hits = await main.store.search("来源序标记", undefined, 10);
  const order = hits.map((h) => h.id);
  const pos = (id) => order.indexOf(id);
  assert(pos(explicitId) >= 0 && pos(autoId) >= 0 && pos(inferredId) >= 0, `命中不全：${order.join(",")}`);
  assert(pos(explicitId) < pos(autoId), `explicit@${pos(explicitId)} 未排到 auto@${pos(autoId)} 前`);
  assert(pos(autoId) < pos(inferredId), `auto@${pos(autoId)} 未排到 inferred@${pos(inferredId)} 前`);
});

// 2026-11-11（D）：语义路缺席时按 wB+wS 归一，pin+inferred 的强度分不能压过词面强匹配
await checkAsync("renorm：语义缺席时 pinned 不能仅凭强度冲第一", async () => {
  const t = openStore("tier");
  try {
    const weak = t.store.store({
      value: "排名测试 用来验证 pin 强度不能霸榜",
      subject: "bench",
      predicate: "renorm_weak",
      tags: ["bench"],
      scope: "global",
      sourceType: "inferred",
    });
    const strong = t.store.store({
      value: "排名测试 排名测试 排名测试 排名测试 排名测试",
      subject: "bench",
      predicate: "renorm_strong",
      tags: ["bench"],
      scope: "global",
      sourceType: "auto",
    });
    assert(weak?.id && strong?.id, `store 失败：${JSON.stringify({ weak, strong })}`);
    t.db.prepare("UPDATE memory SET pinned = 1 WHERE id = ?").run(weak.id);
    const hits = await t.store.search("排名测试", undefined, 10);
    assert(hits.length >= 2, `命中数 ${hits.length}`);
    assert(hits[0].id === strong.id, `top1=${hits[0].id}（strong=${strong.id} weak=${weak.id}）`);
  } finally {
    t.db.close();
  }
});

// 2026-11-11（C2）：检索命中 → used_count 递增 + 置脏；flushUsage 回写 md 并清脏
await checkAsync("学习回路：search 只读、两次 bumpUsage → used=2 且脏，flush 后 md frontmatter used: 2", async () => {
  const r = main.store.store({
    value: "回写标记 学习回路闭环检查",
    subject: "bench",
    predicate: "usage_flush",
    tags: ["bench"],
    scope: "global",
  });
  assert(r?.id, `store 失败：${JSON.stringify(r)}`);
  await main.store.search("回写标记", undefined, 5);
  const ro = main.db.prepare("SELECT used_count FROM memory WHERE id = ?").get(r.id);
  assert(Number(ro.used_count ?? 0) === 0, `search 不应写 used_count=${ro.used_count}`);
  main.store.bumpUsage([r.id]);
  main.store.bumpUsage([r.id]);
  const row = main.db.prepare("SELECT used_count, usage_dirty FROM memory WHERE id = ?").get(r.id);
  assert(Number(row.used_count) === 2, `used_count=${row.used_count}`);
  assert(Number(row.usage_dirty) === 1, `usage_dirty=${row.usage_dirty}`);
  const flushed = main.store.flushUsage();
  assert(flushed.written >= 1, `flush written=${flushed.written}`);
  const after = main.db.prepare("SELECT usage_dirty FROM memory WHERE id = ?").get(r.id);
  assert(Number(after.usage_dirty) === 0, `flush 后仍脏=${after.usage_dirty}`);
  const md = readFileSync(join(main.root, "global", "facts", `${r.id}.md`), "utf8");
  assert(/^used: 2$/m.test(md), `md used 不对：${md.split("\n").slice(0, 12).join(" | ")}`);
});

// 2026-11-11（复审 A）：md 落后于库时 restore 不能清脏位，否则库增量永久滞留、md 权威破裂
await checkAsync("脏位保护：md 落后时 restore 不清脏，flush 把库增量（used=3）写回 md", async () => {
  const r = main.store.store({ value: "脏位保护 回写竞争检查", subject: "bench", predicate: "usage_race", tags: ["bench"], scope: "global" });
  assert(r?.id, `store 失败：${JSON.stringify(r)}`);
  main.store.bumpUsage([r.id]);
  main.store.bumpUsage([r.id]);
  main.store.bumpUsage([r.id]); // 库 used=3，md 仍是 used: 0
  main.store.restoreUsageFromMarkdown(); // md 落后：必须保住 dirty
  const row = main.db.prepare("SELECT used_count, usage_dirty FROM memory WHERE id = ?").get(r.id);
  assert(Number(row.used_count) === 3, `used 被 md 倒退=${row.used_count}`);
  assert(Number(row.usage_dirty) === 1, `脏位被误清=${row.usage_dirty}`);
  main.store.flushUsage();
  const md = readFileSync(join(main.root, "global", "facts", `${r.id}.md`), "utf8");
  assert(/^used: 3$/m.test(md), `md used 未追平：${md.split("\n").slice(0, 12).join(" | ")}`);
});

main.db.close();

const pass = results.filter((r) => r.startsWith("PASS")).length;
const fail = results.length - pass;
for (const line of results) console.log(line);
console.log(`\n${pass} pass / ${fail} fail`);
if (fail === 0) rmSync(TMP, { recursive: true, force: true });
else console.log(`临时目录保留：${TMP}`);
process.exitCode = fail === 0 ? 0 : 1;