/**
 * tool-glue.js —— 把 error-ledger / skill-drafts 的 6 个细粒度工具折叠成 2 个合并工具。
 *
 * 目的：常驻 tools schema 只 +2（memory_error / memory_skill），而不是 +6。
 * 每个合并工具用 `action` 分派到原 def 的 execute，参数取 6 个 def 的并集（全部 optional，
 * 只有 action 必填）；原 def 自己的 required/上限仍在各 def 内部生效。
 */
import registerSkillDrafts from "./skill-drafts.js";
import registerErrorLedger from "./error-ledger.js";

const TEXT_OUTPUT = { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: String(v) }] };

/** limit 在两个 def 里语义不同：search 默认 1/最大 5，list 默认 20/最大 20 —— 不设全局 maximum，交给各 def clamp。 */
const LIMIT_DESC = "search：返回条数，默认 1、最大 5；list：默认 20、最大 20。";

export const GROUPS = [
  {
    name: "memory_error",
    description:
      "错误台账（合并工具）。action=report：把刚发生的错误记进台账（同 signature 只累加 hits）；action=search：动手前先查历史教训（query 必填，limit≤5，每条 ≤200 字符）；action=writeback：把台账条目写回长期记忆（id 指定一条，或 all=1 批量）。",
    actions: {
      report: "memory_error_report",
      search: "memory_error_search",
      writeback: "memory_error_writeback",
    },
  },
  {
    name: "memory_skill",
    description:
      "skill 草稿（合并工具）。action=draft：把可复用经验写成草稿（title+steps，3-8 步）；action=list：列出草稿与成熟度（limit≤20，只读）；action=suggest：按 subject 给出沉淀建议（只读，不写文件）。",
    actions: {
      draft: "memory_skill_draft",
      list: "memory_skill_list",
      suggest: "memory_skill_suggest",
    },
  },
];

function unionProperties(entries) {
  const properties = {};
  for (const [, def] of entries) {
    for (const [key, schema] of Object.entries(def?.parameters?.properties ?? {})) {
      if (key === "action" || properties[key]) continue;
      properties[key] = { ...schema };
    }
  }
  if (properties.limit) {
    properties.limit = { ...properties.limit, type: "integer", description: LIMIT_DESC };
  }
  return properties;
}

function buildMerged(group, byName) {
  const entries = Object.entries(group.actions)
    .map(([action, toolName]) => [action, byName.get(toolName)])
    .filter(([, def]) => Boolean(def));
  const actionMap = new Map(entries);
  const properties = {
    action: {
      type: "string",
      enum: entries.map(([action]) => action),
      description: `动作：${entries.map(([action]) => action).join(" | ")}`,
    },
    ...unionProperties(entries),
  };
  return {
    name: group.name,
    description: group.description,
    parameters: { type: "object", properties, required: ["action"] },
    output: TEXT_OUTPUT,
    async execute(args = {}, exec) {
      const raw = args?.action;
      const action = typeof raw === "string" ? raw.trim() : String(raw ?? "");
      const target = actionMap.get(action);
      if (!target) {
        return `未知 action：${action || "(空)"}，可用: ${entries.map(([a]) => a).join(" | ")}`;
      }
      const { action: _action, ...rest } = args;
      try {
        return await target.execute(rest, exec);
      } catch (error) {
        return JSON.stringify({ ok: false, code: "GLUE_EXEC_FAILED", message: String(error?.message ?? error).slice(0, 160) });
      }
    },
  };
}

/** 纯折叠：不注册、不碰磁盘，给测试与自定义注册顺序用。 */
export function foldToolDefs(defs = [], groups = GROUPS) {
  const byName = new Map(defs.map((def) => [def.name, def]));
  return groups.map((group) => buildMerged(group, byName));
}

/**
 * 主入口：内部先让两个模块各自「注册」到临时数组，再折叠成 2 个工具并通过 api.register 注册。
 * api = { register, root, log, db, addFact, store, factsDir, listFacts }
 */
export async function mergeMemoryTools(api = {}) {
  const log = typeof api.log === "function" ? api.log : () => {};
  const collected = [];

  try {
    registerSkillDrafts({
      register: (def) => collected.push(def),
      root: api.root,
      log,
      listFacts: typeof api.listFacts === "function" ? api.listFacts : null,
    });
  } catch (error) {
    log("tool-glue skill-drafts:", String(error?.message ?? error));
  }

  try {
    registerErrorLedger({
      addTool: (def) => collected.push(def),
      db: api.db,
      addFact: typeof api.addFact === "function" ? api.addFact : undefined,
      store: api.store,
      log,
      dataDir: api.root,
      factsDir: api.factsDir,
    });
  } catch (error) {
    log("tool-glue error-ledger:", String(error?.message ?? error));
  }

  const defs = foldToolDefs(collected);
  const registered = [];
  if (typeof api.register === "function") {
    for (const def of defs) {
      try {
        api.register(def);
        registered.push(def.name);
      } catch (error) {
        log("tool-glue register failed:", def.name, String(error?.message ?? error));
      }
    }
  }
  return { registered, defs, collected: collected.map((def) => def.name) };
}

export default mergeMemoryTools;