import { readFileSync, writeFileSync } from "node:fs";
const FILE = "<repo>/dsh-memory/index.js";
let s = readFileSync(FILE, "utf8");
const patches = [];
const add = (name, from, to) => patches.push({ name, from, to });

// 1) 删 boot-probe（import 期写盘）
add(
  "boot-probe",
  String.raw`// boot-probe：模块一被 import 就落一行，用来区分「模块没加载」与「apply 没跑」
try {
  appendFileSync("~/.dsh-memory\\boot-probe.log", ` + "`" + String.raw`${new Date().toISOString()} imported pid=${process.pid}\n` + "`" + String.raw`);
} catch {
  /* ignore */
}
`,
  "",
);

// 2) 包名
add("pkg.name", String.raw`export const name = "@me/dsh-memory";`, String.raw`export const name = "@jinshuxuan/dsh-memory";`);

// 3) 根目录 / 配置路径 / 模型目录
add(
  "root.paths",
  String.raw`const ROOT = process.env.DSH_MEMORY_ROOT || "~/.dsh-memory";
const LOG_FILE = join(ROOT, "memory.log");
const DB_PATH = join(ROOT, "index", "memory.db");
const CONFIG_PATH = join(ROOT, "config.json");`,
  String.raw`const ROOT = resolveRoot();
const LOG_FILE = join(ROOT, "memory.log");
const DB_PATH = join(ROOT, "index", "memory.db");
const CONFIG_PATH = configPath(ROOT);
const MODEL_DIR = modelDir(ROOT);`,
);

// 4) 新增 import
add(
  "imports",
  String.raw`import { Embedder, MODEL_VER, cosine, rrf } from "./embed.js";
import { PaperStore } from "./papers.js";`,
  String.raw`import { Embedder, MODEL_VER, cosine, rrf } from "./embed.js";
import { PaperStore } from "./papers.js";
import { resolveRoot, modelDir } from "./src/paths.js";
import {
  configPath,
  loadConfig as readConfig,
  saveConfig,
  resolveApiKey,
  maskKey,
} from "./src/config.js";
import { ensureModel } from "./src/model.js";`,
);

// 5) 旧 loadConfig 改名，新的追加在文件尾（函数声明提升，后者生效）
add("legacy.loadConfig", String.raw`function loadConfig() {`, String.raw`function loadConfigLegacy() {`);

// 6) Embedder 用 MODEL_DIR
add("embedder.dir", String.raw`    store.embedder = new Embedder({ log });`, String.raw`    store.embedder = new Embedder({ modelDir: MODEL_DIR, log });`);

// 7) 先确保模型再加载
add(
  "embedder.ensure",
  String.raw`    void store.embedder.ensure();`,
  String.raw`    void ensureModel({ dir: MODEL_DIR, log }).then((m) => {
      if (m.ready) void store.embedder.ensure();
      else log("model unavailable, fallback to FTS:", m.error ?? "unknown");
    });`,
);

// 8) 尾部：apply 改为不再写盘，并挂可选模块
add(
  "apply.tail",
  String.raw`export function apply(ctx) {
  try {
    applyInner(ctx);
  } catch (error) {
    try {
      appendFileSync(
        "~/.dsh-memory\\boot-probe.log",
        ` + "`" + String.raw`${new Date().toISOString()} apply THREW pid=${process.pid} ${String(error?.stack ?? error)}\n` + "`" + String.raw`,
      );
    } catch {
      /* ignore */
    }
    throw error;
  }
}`,
  String.raw`/** 运行时配置包装：M2 阶段的 service / commands 都从这里拿 api。 */
function runtimeApi(config) {
  return {
    root: ROOT,
    configPath: CONFIG_PATH,
    modelDir: MODEL_DIR,
    loadConfig,
    saveConfig: (patch) => saveConfig(ROOT, patch),
    resolveApiKey: () => resolveApiKey(config),
    maskKey,
  };
}

async function attachOptionalModules(ctx, config) {
  const api = runtimeApi(config);
  try {
    const svc = await import("./src/service.js").catch(() => null);
    if (svc?.attachService) await svc.attachService(ctx, await ensureStore(config), api);
  } catch (error) {
    log("service attach failed:", String(error?.message ?? error));
  }
  try {
    const cmd = await import("./src/commands.js").catch(() => null);
    if (cmd?.registerCommands) {
      await cmd.registerCommands(ctx, { ...api, store: await ensureStore(config) });
    }
  } catch (error) {
    log("commands attach failed:", String(error?.message ?? error));
  }
}

export function apply(ctx) {
  applyInner(ctx);
  void attachOptionalModules(ctx, loadConfig()).catch((error) =>
    log("optional modules failed:", String(error?.message ?? error)),
  );
}

/** 统一配置入口：从 config.json 读，带 v1→v2 迁移与告警。 */
function loadConfig() {
  try {
    const { config, warnings } = readConfig(ROOT);
    for (const w of warnings) log("config:", w);
    return config;
  } catch (error) {
    log("config read failed:", String(error?.message ?? error));
    return { ...DEFAULT_CONFIG };
  }
}`,
);

const failed = [];
for (const p of patches) {
  const first = s.indexOf(p.from);
  if (first < 0) {
    failed.push(`${p.name}: NOT FOUND`);
    continue;
  }
  if (s.indexOf(p.from, first + 1) >= 0) {
    failed.push(`${p.name}: AMBIGUOUS`);
    continue;
  }
  s = s.slice(0, first) + p.to + s.slice(first + p.from.length);
}
if (failed.length) {
  console.error("PATCH ABORTED:\n" + failed.join("\n"));
  process.exit(1);
}
writeFileSync(FILE, s, "utf8");
console.log(`applied ${patches.length} patches`);