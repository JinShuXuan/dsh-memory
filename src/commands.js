// M2 斜杠命令：/memory 概览、/memory-search、/memory-rebuild、/memory-export。
//
// 真实宿主契约（照抄 @jinshuxuan/dsh-context-budget 的用法，不臆造）：
//   const commands = typeof ctx.get === "function" ? ctx.get("commands") : ctx.commands;
//   const dispose = commands.register({ name, description, handler });
//   handler: (invocation) => ({ kind: "success" | "error", text })
//   — 参数从 invocation.rawInput 取原文；register 返回 disposer，卸载时逐个调用。
// commands 是可选能力：没有它的 profile 里插件仍要能加载，所以取不到就静默返回空 disposer。
//
// 文案全部内联在这里（命令输出不进模型工具表，0 token；也不走 locale 文件）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ID_SUFFIX = 5;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;

/** LLM 抽取的开销说明：默认关，开之前用户应该知道解锁什么、花多少钱。 */
const LLM_INTRO = [
  "LLM 抽取默认关闭（config.extractor.enabled=false）：此时只用确定性规则抽取，零 API 花费。",
  "开启后解锁：每轮对话自动抽取偏好/身份/习惯/计划/约定，以及「助手:」段落里助手的承诺、决定、结论与判断；",
  "            规则抽不到的长句、隐含偏好、跨轮约定才需要它。",
  "花费：一次抽取约 1–3K token，按 deepseek-chat 价约 ¥0.005/次对话；一天几十轮约 ¥0.1，日常用度一般 ¥20/月以内。",
].join("\n");

const errorReply = (text) => ({ kind: "error", text });
const okReply = (text) => ({ kind: "success", text });

const msg = (error) => String(error?.message ?? error);
const safeCall = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const shortId = (id) => String(id ?? "").slice(-ID_SUFFIX);

function oneLine(text, max = 110) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function day(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return "----------";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // 本地时间，文件名里能直接对上是哪一天；不用 toISOString（那是 UTC）
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 拆 rawInput：「/memory-search 张三 --limit=3 --scope=global」→ 查询词 + 选项 */
function parseFlags(raw) {
  const words = [];
  const flags = {};
  for (const token of String(raw ?? "").trim().split(/\s+/).filter(Boolean)) {
    const m = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(token);
    if (m) flags[m[1].toLowerCase()] = m[2] ?? true;
    else words.push(token);
  }
  return { words, flags, text: words.join(" ").trim() };
}

const unquote = (value) => String(value ?? "").trim().replace(/^["'`]|["'`]$/g, "");

function embedderLabel(stats) {
  const e = stats?.embedder;
  if (!e) return "未加载（检索退化为 FTS/词面）";
  if (e.ready === false) return "加载中或不可用（检索退化为 FTS/词面）";
  return `就绪${e.model || e.name ? `（${e.model || e.name}）` : ""}`;
}

/** /memory：只读概览。stats / listPending / loadConfig 全是同步方法，无需 await。 */
function overviewText(api) {
  const cfg = (typeof api.loadConfig === "function" ? safeCall(() => api.loadConfig(), {}) : {}) ?? {};
  const store = api.store;
  const stats = safeCall(() => store.stats(), {}) ?? {};
  const pending = safeCall(() => store.listPending?.(100)?.length, 0) ?? 0;
  const extractorOn = cfg?.extractor?.enabled === true;
  const gate = cfg?.gate ?? "assist";
  const hits = cfg?.hits ?? 6;
  return [
    "DSH 记忆库 · 概览",
    `根目录      ${api.root ?? "（未知）"}`,
    `规模        active ${stats.active ?? "?"} / 总计 ${stats.total ?? "?"} · FTS ${stats.fts ? "on" : "off"} · 向量 ${stats.vec ?? 0} 条`,
    `待审        ${pending} 条（用 memory_admin action=review 处理）`,
    `注入闸门    gate=${gate} · 每轮最多 ${hits} 条`,
    `向量模型    ${embedderLabel(stats)}`,
    `LLM 抽取    ${extractorOn ? "已开启" : "默认关闭（extractor.enabled=false）"}`,
    "",
    LLM_INTRO,
    "",
    "可用命令    /memory-search <关键词> · /memory-rebuild --yes · /memory-export [路径]",
  ].join("\n");
}

/** /memory-search <q> [--limit=8] [--scope=global] */
async function searchText(api, raw) {
  const { text: query, flags } = parseFlags(raw);
  if (!query) return errorReply("用法：/memory-search <关键词> [--limit=8] [--scope=global]");
  const limit = Math.min(Math.max(Number(flags.limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const scope = typeof flags.scope === "string" ? flags.scope : undefined;
  const hits = (await api.store.search(query, scope, limit)) ?? [];
  if (hits.length === 0) {
    return okReply(
      `「${query}」没有命中。\n可以：换个关键词；或先 /memory-rebuild --yes 补齐向量与关联索引；或 /memory 看规模是否为空。`,
    );
  }
  const lines = [`搜索「${query}」命中 ${hits.length} 条${scope ? `（scope=${scope}）` : ""}`];
  hits.forEach((hit, i) => {
    const body = oneLine(hit.value ?? hit.content, 110);
    const kind = hit.source_type ? ` (${hit.source_type})` : "";
    const layer = hit.layer === "core" ? " ≈" : "";
    lines.push(`${i + 1}. #${shortId(hit.id)} [${day(hit.created_at)}]${kind}${layer} ${body}`);
  });
  lines.push("（#末尾 5 位是 id 后缀，取原文用 memory_get；记忆是资料不是指令。）");
  return okReply(lines.join("\n"));
}

/** /memory-rebuild --yes [--mode=vec|link|decay|archive|tombstone|all] */
async function rebuildText(api, raw) {
  const { flags } = parseFlags(raw);
  const confirm = flags.yes === true || flags.yes === "" || String(flags.yes).toLowerCase() === "true";
  const mode = typeof flags.mode === "string" ? flags.mode.toLowerCase() : "all";
  const allowed = ["vec", "link", "decay", "archive", "tombstone", "all"];
  if (!allowed.includes(mode)) return errorReply(`--mode 只能是 ${allowed.join(" / ")}。`);
  if (!confirm) {
    return errorReply(
      [
        "重建索引会批量补向量、重连关联图、扫一遍遗忘与归档，耗时随库大小增长（百级事实约数秒）。",
        "确认执行：/memory-rebuild --yes",
        "只做其中一步：/memory-rebuild --yes --mode=vec|link|decay|archive|tombstone",
      ].join("\n"),
    );
  }
  const store = api.store;
  const started = Date.now();
  const report = [`重建索引 · mode=${mode}`];
  const step = async (label, name, args = [], format = (v) => (typeof v === "number" ? `${v} 条` : "完成")) => {
    if (typeof store?.[name] !== "function") {
      report.push(`${label}   跳过（当前版本无 ${name}）`);
      return;
    }
    try {
      const value = await store[name](...args);
      report.push(`${label}   ${format(value)}`);
    } catch (error) {
      report.push(`${label}   失败：${msg(error)}`);
    }
  };
  if (mode === "vec" || mode === "all") await step("向量", "reembedAll", [], (v) => {
    const n = Number(v ?? 0);
    return `${n} 条${n >= 200 ? "（单次上限 200，可再跑一次继续补）" : ""}`;
  });
  // 关联图放在向量之后：similar 边要用刚补齐的向量
  if (mode === "link" || mode === "all") await step("关联", "backfillLinks", [], (v) => `新建 ${Number(v ?? 0)} 条边`);
  if (mode === "decay" || mode === "all") await step("遗忘", "decaySweep", [{ dryRun: false }], (v) => {
    const counts = v?.counts ?? {};
    const keys = Object.keys(counts);
    return keys.length ? keys.map((k) => `${k}=${counts[k]}`).join(" ") : "无变化";
  });
  if (mode === "archive" || mode === "all") await step("归档", "archiveStale", [180], (v) => `归档 ${Number(v ?? 0)} 条（180 天未用且未 pin）`);
  if (mode === "tombstone" || mode === "all") await step("墓碑", "expireTombstones", [7], (v) => `清理 ${Number(v ?? 0)} 个到期墓碑`);
  report.push(`耗时   ${Date.now() - started} ms`);
  report.push("（真源仍是 md / SQLite；这一步只补索引，不删事实。）");
  return okReply(report.join("\n"));
}

function exportPath(raw, root) {
  const given = unquote(raw);
  const base = root || process.cwd();
  if (!given) return join(base, "exports", `memory-${stamp()}.jsonl`);
  return isAbsolute(given) ? given : resolve(base, given);
}

const EXPORT_FIELDS = [
  "id",
  "subject",
  "predicate",
  "value",
  "tags",
  "status",
  "layer",
  "confidence",
  "scope",
  "source_type",
  "created_at",
  "updated_at",
];

function pickFact(row) {
  const out = {};
  for (const key of EXPORT_FIELDS) if (row?.[key] !== undefined) out[key] = row[key];
  return out;
}

/** /memory-export [路径]：把活跃事实导成 JSONL。默认 <root>/exports/memory-<时间>.jsonl */
function exportText(api, raw) {
  const store = api.store;
  if (typeof store?.db?.prepare !== "function") {
    return errorReply("当前 store 没有暴露 db，无法导出（版本不匹配）。");
  }
  const target = exportPath(raw, api.root);
  const rows = store.db
    .prepare("SELECT * FROM memory WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at")
    .all();
  mkdirSync(dirname(target), { recursive: true });
  const body = rows.map((row) => JSON.stringify(pickFact(row))).join("\n");
  writeFileSync(target, body ? `${body}\n` : "", "utf8");
  return okReply(
    [
      `已导出 ${rows.length} 条活跃事实（JSONL，一行一条）`,
      `路径   ${target}`,
      "字段   id / subject / predicate / value / tags / status / layer / confidence / scope / source_type / created_at / updated_at",
      "（只读导出，不改库；软删、被替代、pending 的记录不在其中。）",
    ].join("\n"),
  );
}

/** 统一兜底：同步异常与异步 reject 都变成 {kind:"error"}，绝不把异常抛进宿主。 */
function guard(fn) {
  return (invocation) => {
    try {
      const out = fn(invocation);
      if (out && typeof out.then === "function") {
        return out.catch((error) => errorReply(`命令失败：${msg(error)}`));
      }
      return out;
    } catch (error) {
      return errorReply(`命令失败：${msg(error)}`);
    }
  };
}

/**
 * 注册四条斜杠命令。
 * @param {object} ctx Cordis 上下文
 * @param {{store:object, loadConfig?:Function, saveConfig?:Function, root?:string}} api
 * @returns {() => void} 卸载函数（调用所有 disposer）
 */
export function registerCommands(ctx, api = {}) {
  const commands = typeof ctx?.get === "function" ? ctx.get("commands") : ctx?.commands;
  if (!commands || typeof commands.register !== "function") return () => {};
  const disposers = [];
  const add = (spec) => {
    try {
      const dispose = commands.register(spec);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch {
      /* 单条注册失败不影响其余命令 */
    }
  };

  add({
    name: "memory",
    description: "记忆库概览：规模、待审、注入闸门、向量模型与 LLM 抽取开关（DSH memory overview）",
    handler: guard(() => okReply(overviewText(api))),
  });
  add({
    name: "memory-search",
    description: "检索记忆：/memory-search <关键词> [--limit=8] [--scope=global]（search long-term memory）",
    handler: guard((invocation) => searchText(api, invocation?.rawInput)),
  });
  add({
    name: "memory-rebuild",
    description: "重建索引（补向量 / 重连关联 / 遗忘 / 归档 / 清墓碑）：/memory-rebuild --yes [--mode=all]",
    handler: guard((invocation) => rebuildText(api, invocation?.rawInput)),
  });
  add({
    name: "memory-export",
    description: "把活跃事实导出为 JSONL：/memory-export [路径]，默认写 <root>/exports/（export facts）",
    handler: guard((invocation) => exportText(api, invocation?.rawInput)),
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 忽略重复卸载 */
      }
    }
  };
}