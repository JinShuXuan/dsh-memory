// 配置：默认值、加载/保存、v1→v2 迁移、密钥解析与遮蔽。
// 所有阈值集中在这里，index.js 只负责用。
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 2;

export const DEFAULTS = {
  schema_version: SCHEMA_VERSION,
  root: "",
  ui: { lang: "auto" },
  gate: "assist", // off | shadow | assist
  hits: 6,
  hitsChars: 800,
  rulesChars: 800,
  sessionInjects: 6,
  sessionInjectWindow: 40,
  extractor: {
    enabled: false,
    baseURL: "",
    model: "",
    apiKey: "",
    apiKeyEnv: "",
    maxFactsPerTurn: 5,
    timeoutMs: 20000,
  },
  promote: { enabled: true, minAtoms: 5 },
  link: {
    enabled: true,
    maxOut: 10,
    similarMin: 0.82,
    similarTop: 3,
    sameFactCos: 0.8,
    sameEpisode: 0.8,
    sameSession: 0.45,
    expandHits: 3,
    expandTop: 2,
    expandChars: 140,
  },
  decay: {
    enabled: true,
    auto: true,
    tauDays: 45,
    archiveDays: 90,
    archiveBelow: 0.18,
    maxPerCluster: 8,
    archivedFactor: 0.5,
    touchThrottleMs: 60000,
    subjectOverrides: { assistant: { tauDays: 20, archiveDays: 30 } },
  },
  abstract: {
    enabled: true,
    auto: false,
    minAtoms: 4,
    sample: 12,
    maxPerRun: 3,
    staleAfter: 2,
    autoPerSweep: 2,
    staleWeight: 0.8,
    llm: { model: "", baseURL: "", apiKey: "", timeoutMs: 30000 },
  },
  replay: { enabled: true, auto: false, maxAttempts: 3, settleAfter: 2, perRun: 20, maxCalls: 5 },
  budget: { monthlyYuan: 20, costPerCallYuan: 0.005 },
};

export function configPath(root) {
  return join(root, "config.json");
}

export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const cur = base?.[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function readJson(path) {
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

/**
 * 读配置：缺文件写默认；旧版（无 schema_version）自动迁移到 v2；坏 JSON 回退默认并告警。
 * @returns {{config:object, warnings:string[]}}
 */
export function loadConfig(root) {
  const warnings = [];
  const path = configPath(root);
  let raw = null;
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2), "utf8");
      chmodSync(path, 0o600);
    } catch (error) {
      warnings.push(`无法创建 config.json：${String(error?.message ?? error)}`);
    }
    return { config: { ...DEFAULTS }, warnings };
  }
  try {
    raw = readJson(path);
  } catch (error) {
    warnings.push(`config.json 解析失败，已回退默认值：${String(error?.message ?? error)}`);
    // 不要静默覆盖坏文件：留一份 .bad 方便人工修
    try {
      copyFileSync(path, `${path}.bad`);
      warnings.push(`坏配置已备份到 ${path}.bad`);
    } catch {
      /* ignore */
    }
    return { config: { ...DEFAULTS }, warnings };
  }
  const merged = deepMerge(DEFAULTS, raw ?? {});
  // 版本号要读原始文件：merged 里已有默认的 schema_version，不能用它判断
  const version = Number(raw?.schema_version) || 1;
  if (version < SCHEMA_VERSION) {
    warnings.push(`配置从 v${version} 迁移到 v${SCHEMA_VERSION}`);
  }
  if (String(merged.gate) === "enforce") {
    merged.gate = "assist";
    warnings.push("gate=enforce 已并入 assist，已自动改写");
  }
  merged.schema_version = SCHEMA_VERSION;
  // 迁移结果回写一次（放在所有改写之后），避免每次 load 都重复迁移/重复告警
  if (version < SCHEMA_VERSION) {
    try {
      writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
      chmodSync(path, 0o600);
    } catch (error) {
      warnings.push(`配置回写失败：${String(error?.message ?? error)}`);
    }
  }
  if (merged.extractor && merged.extractor.apiKey) {
    warnings.push("config.json 内存在明文 apiKey，建议改用环境变量 DSH_MEMORY_API_KEY");
  }
  if (merged.extractor && merged.extractor.enabled && (!merged.extractor.baseURL || !merged.extractor.model)) {
    warnings.push("extractor.enabled=true 但缺少 baseURL/model，LLM 抽取不会生效");
  }
  return { config: merged, warnings };
}

/** 原子保存：深合并 + 临时文件 + rename + 0600。 */
export function saveConfig(root, patch) {
  const { config } = loadConfig(root);
  const next = deepMerge(config, patch ?? {});
  next.schema_version = SCHEMA_VERSION;
  const path = configPath(root);
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows 上可能不生效 */
  }
  renameSync(tmp, path);
  return next;
}

/** 密钥优先级：DSH_MEMORY_API_KEY > config.extractor.apiKeyEnv 指向的 env > config.extractor.apiKey。 */
export function resolveApiKey(config, env = process.env) {
  const direct = env && env.DSH_MEMORY_API_KEY ? String(env.DSH_MEMORY_API_KEY) : "";
  if (direct) return { key: direct, source: "env" };
  const named = config?.extractor?.apiKeyEnv ? env?.[config.extractor.apiKeyEnv] : "";
  if (named) return { key: String(named), source: "env" };
  const fromFile = config?.extractor?.apiKey ? String(config.extractor.apiKey) : "";
  if (fromFile) return { key: fromFile, source: "file" };
  return { key: "", source: null };
}

export function maskKey(key) {
  const s = String(key ?? "");
  if (!s) return "";
  if (s.length <= 8) return "…";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}