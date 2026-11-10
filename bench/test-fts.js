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

main.db.close();

const pass = results.filter((r) => r.startsWith("PASS")).length;
const fail = results.length - pass;
for (const line of results) console.log(line);
console.log(`\n${pass} pass / ${fail} fail`);
if (fail === 0) rmSync(TMP, { recursive: true, force: true });
else console.log(`临时目录保留：${TMP}`);
process.exitCode = fail === 0 ? 0 : 1;