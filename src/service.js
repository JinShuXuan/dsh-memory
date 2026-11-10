// UI 用的宿主侧服务：只读查询 + 白名单写操作 + 系统原生目录对话框。
// 不 import 任何 client 代码，headless 环境可安全跳过。
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const API_PREFIX = "/api/jinshuxuan/dsh-memory";
const IS_WIN = process.platform === "win32";

/** 配置项清单：面板按这个顺序渲染，essentials 在最上面。 */
const CONFIG_SCHEMA = [
  { group: "先改这几项", key: "root", type: "dir", label: "记忆库路径", desc: "记忆、索引、日志都放这里；改完需重启 DSH" },
  { group: "先改这几项", key: "extractor.enabled", type: "bool", label: "LLM 自动抽取", desc: "开启后用模型从对话抽事实；默认关，只用规则，零花费" },
  { group: "先改这几项", key: "extractor.apiKey", type: "secret", label: "API Key", desc: "填了才能调模型；也可用环境变量 DSH_MEMORY_API_KEY" },
  { group: "先改这几项", key: "extractor.baseURL", type: "text", label: "接口地址", desc: "OpenAI 兼容的 /v1 地址，例如 https://api.deepseek.com/v1" },
  { group: "先改这几项", key: "extractor.model", type: "text", label: "模型名", desc: "例如 deepseek-chat；留空则不会抽取" },
  { group: "常用", key: "gate", type: "select", options: ["off", "shadow", "assist"], label: "注入闸门", desc: "assist 命中就注入；shadow 只记日志不注入；off 关闭注入" },
  { group: "常用", key: "hits", type: "number", label: "每轮注入条数", desc: "每轮最多注入几条记忆，越大越占上下文" },
  { group: "常用", key: "hitsChars", type: "number", label: "注入字符上限", desc: "注入文本的字符预算，超了截断" },
  { group: "常用", key: "sessionInjects", type: "number", label: "每会话注入次数", desc: "滑动窗口内最多注入几次，防止长会话反复注入" },
  { group: "常用", key: "sessionInjectWindow", type: "number", label: "注入窗口（轮）", desc: "按最近多少轮统计注入次数，0 表示整会话累计" },
  { group: "进阶", key: "link.similarMin", type: "number", label: "连边相似度阈值", desc: "两条记忆向量相似到多少才建立关联" },
  { group: "进阶", key: "link.sameFactCos", type: "number", label: "改口判定阈值", desc: "同谓词两条相似到多少才算同一件事被改写并覆盖" },
  { group: "进阶", key: "decay.auto", type: "bool", label: "启动自动遗忘", desc: "每次启动距上次超过 24 小时就跑一次衰减扫描" },
  { group: "进阶", key: "decay.tauDays", type: "number", label: "遗忘时间常数（天）", desc: "越大衰减越慢；助手结论默认 20 天" },
  { group: "进阶", key: "decay.archiveDays", type: "number", label: "归档天数", desc: "多久没访问才考虑归档，归档可恢复" },
  { group: "进阶", key: "abstract.auto", type: "bool", label: "自动归纳", desc: "开启后维护时自动重算过时的归纳" },
  { group: "进阶", key: "replay.auto", type: "bool", label: "自动重放旧对话", desc: "开启后每天回看旧对话补漏，会产生模型调用费用" },
  { group: "进阶", key: "budget.monthlyYuan", type: "number", label: "每月预算（元）", desc: "超过后自动退回纯本地规则，不再调模型" },
];

function getPath(obj, key) {
  return String(key)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, key, value) {
  const parts = String(key).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function pageRows(store, { query = "", status = "active", limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const where = [];
  const args = [];
  if (status && status !== "all") {
    where.push("status = ?");
    args.push(status);
  }
  if (query) {
    where.push("(value LIKE ? OR subject LIKE ? OR predicate LIKE ?)");
    args.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM memory ${clause}`).get(...args)?.n ?? 0);
  const rows = store.db
    .prepare(
      `SELECT id, subject, predicate, value, status, layer, source_type, pinned, created_at, updated_at, last_access, access_count
         FROM memory ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, lim, off);
  return {
    total,
    offset: off,
    limit: lim,
    items: rows.map((r) => ({ ...r, value: String(r.value ?? "").slice(0, 160), short_id: `#${String(r.id).slice(-5)}` })),
  };
}

function statsOf(store, root, config) {
  const one = (sql) => {
    try {
      return Number(store.db.prepare(sql).get()?.n ?? 0);
    } catch {
      return 0;
    }
  };
  const byStatus = {};
  try {
    for (const r of store.db.prepare("SELECT status, COUNT(*) AS n FROM memory GROUP BY status").all()) byStatus[r.status] = Number(r.n);
  } catch {
    /* ignore */
  }
  let budget = null;
  try {
    budget = store.budgetState ? store.budgetState() : null;
  } catch {
    budget = null;
  }
  let trash = 0;
  try {
    trash = readdirSync(join(root, "trash")).length;
  } catch {
    trash = 0;
  }
  return {
    root,
    gate: config?.gate ?? "assist",
    embedder: { ready: Boolean(store.embedder?.ready), dim: store.embedder?.dim ?? 0 },
    counts: {
      active: byStatus.active ?? 0,
      archived: byStatus.archived ?? 0,
      deleted: byStatus.deleted ?? 0,
      superseded: byStatus.superseded ?? 0,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      vectors: one("SELECT COUNT(*) AS n FROM memory_vec"),
      links: one("SELECT COUNT(*) AS n FROM memory_link"),
      pending: one("SELECT COUNT(*) AS n FROM pending_review WHERE resolution IS NULL"),
      trash,
    },
    budget,
    llm: { enabled: Boolean(config?.extractor?.enabled) },
  };
}

/** 系统原生目录选择框（Windows）。非 Windows 返回 UNSUPPORTED。 */
function pickDirectory() {
  if (!IS_WIN) return Promise.resolve({ ok: false, code: "UNSUPPORTED" });
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$f.Description = '选择记忆库目录'",
    "$f.ShowNewFolderButton = $true",
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }",
  ].join("; ");
  return new Promise((resolvePromise) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 180000, windowsHide: true }, (error, stdout) => {
      const path = String(stdout || "").trim();
      if (error || !path) resolvePromise({ ok: false, code: error ? "DIALOG_FAILED" : "CANCELLED" });
      else resolvePromise({ ok: true, path });
    });
  });
}

/** 系统原生保存框（Windows），返回目标文件路径。 */
function pickSavePath(defaultName) {
  if (!IS_WIN) return Promise.resolve({ ok: false, code: "UNSUPPORTED" });
  const safe = String(defaultName || "memory-export.jsonl").replace(/'/g, "");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$f = New-Object System.Windows.Forms.SaveFileDialog",
    "$f.Filter = 'JSON Lines (*.jsonl)|*.jsonl|所有文件 (*.*)|*.*'",
    `$f.FileName = '${safe}'`,
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.FileName) }",
  ].join("; ");
  return new Promise((resolvePromise) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 180000, windowsHide: true }, (error, stdout) => {
      const path = String(stdout || "").trim();
      if (error || !path) resolvePromise({ ok: false, code: error ? "DIALOG_FAILED" : "CANCELLED" });
      else resolvePromise({ ok: true, path });
    });
  });
}

function openFolder(path) {
  if (!IS_WIN) return { ok: false, code: "UNSUPPORTED" };
  const target = resolve(String(path || ""));
  if (!target || target.split(sep).length < 2) return { ok: false, code: "BAD_PATH" };
  try {
    const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

function exportFacts(store, target) {
  const rows = store.db
    .prepare(
      "SELECT id, subject, predicate, value, tags, status, layer, confidence, scope, source_type, created_at, updated_at FROM memory WHERE status='active' AND deleted_at IS NULL ORDER BY created_at",
    )
    .all();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rows.map((r) => JSON.stringify({ ...r, tags: JSON.parse(r.tags || "[]") })).join("\n") + "\n", "utf8");
  return { path: target, count: rows.length };
}

const UI_HTML = join(dirname(fileURLToPath(import.meta.url)), "ui.html");

/**
 * @param {object} ctx cordis 上下文
 * @param {object} store MemoryStore
 * @param {object} api { root, loadConfig, saveConfig, maskKey }
 */
export function attachService(ctx, store, api) {
  const within = (p) => {
    try {
      const abs = resolve(String(p));
      const root = resolve(api.root);
      return abs === root || abs.startsWith(root + sep);
    } catch {
      return false;
    }
  };

  const service = {
    stats: () => statsOf(store, api.root, api.loadConfig()),
    list: (opts) => pageRows(store, opts),
    pending: () => {
      try {
        return store.listPending(50);
      } catch {
        return [];
      }
    },
    approve: (id) => store.resolvePending({ id, action: "approve" }),
    reject: (id) => store.resolvePending({ id, action: "rejected" }),
    softDelete: (id) => {
      if (store.remove) return store.remove({ idOrSuffix: id, reason: "ui" });
      return { ok: false, code: "UNSUPPORTED" };
    },
    restore: (id) => (store.restore ? store.restore({ idOrSuffix: id }) : { ok: false, code: "UNSUPPORTED" }),
    maintenance: (action) => {
      const a = String(action || "").toLowerCase();
      if (a === "rebuild") return { ok: true, action: a, ...store.reconcile() };
      if (a === "decay") return { ok: true, action: a, counts: store.decaySweep({ dryRun: false }).counts };
      if (a === "cleantrash") return { ok: true, action: a, removed: store.cleanTrash(30) };
      return { ok: false, code: "BAD_ARGS" };
    },
    configSchema: () => CONFIG_SCHEMA,
    getConfig: () => {
      const cfg = api.loadConfig();
      const masked = JSON.parse(JSON.stringify(cfg));
      if (masked?.extractor?.apiKey) masked.extractor.apiKey = api.maskKey?.(masked.extractor.apiKey) ?? "…";
      return { config: masked, schema: CONFIG_SCHEMA };
    },
    setConfig: (patch) => {
      const next = {};
      for (const field of CONFIG_SCHEMA) {
        const v = getPath(patch ?? {}, field.key);
        if (v === undefined) continue;
        setPath(next, field.key, field.type === "number" ? Number(v) : field.type === "bool" ? Boolean(v) : v);
      }
      const saved = api.saveConfig(next);
      const masked = JSON.parse(JSON.stringify(saved));
      if (masked?.extractor?.apiKey) masked.extractor.apiKey = api.maskKey?.(masked.extractor.apiKey) ?? "…";
      return { config: masked, schema: CONFIG_SCHEMA, restartRequired: Object.keys(next).includes("root") };
    },
    pickDirectory: () => pickDirectory(),
    pickExportPath: (name) => pickSavePath(name),
    openFolder: (path) => {
      const target = path || api.root;
      if (!within(target)) return { ok: false, code: "OUTSIDE_ROOT" };
      return openFolder(target);
    },
    exportFacts: (path) => {
      const target = path || join(api.root, "exports", `memory-${Date.now()}.jsonl`);
      if (!within(target)) return { ok: false, code: "OUTSIDE_ROOT" };
      return exportFacts(store, target);
    },
  };

  try {
    ctx.provide?.("memory.service", service);
  } catch {
    /* 老版本 ctx 没有 provide */
  }

  const routes = [
    ["/stats", "GET", () => service.stats()],
    ["/list", "POST", (b) => service.list(b)],
    ["/pending", "GET", () => service.pending()],
    ["/approve", "POST", (b) => service.approve(String(b?.id ?? ""))],
    ["/reject", "POST", (b) => service.reject(String(b?.id ?? ""))],
    ["/delete", "POST", (b) => service.softDelete(String(b?.id ?? ""))],
    ["/restore", "POST", (b) => service.restore(String(b?.id ?? ""))],
    ["/maintenance", "POST", (b) => service.maintenance(b?.action)],
    ["/config", "GET", () => service.getConfig()],
    ["/config", "POST", (b) => service.setConfig(b)],
    ["/dialog/dir", "POST", () => service.pickDirectory()],
    ["/dialog/export", "POST", (b) => service.pickExportPath(b?.name)],
    ["/open", "POST", (b) => service.openFolder(b?.path)],
    ["/export", "POST", (b) => service.exportFacts(b?.path)],
  ];

  try {
    const connection = ctx.get?.("connection") ?? ctx.connection;
    const register = connection?.fetch?.register;
    if (typeof register === "function") {
      // 独立页面兜底：客户端插件没被加载时，用户仍可直接打开 /api/memory/ui
      register({
        path: API_PREFIX + "/ui",
        methods: ["GET"],
        fetch: async () => {
          try {
            return new Response(readFileSync(UI_HTML, "utf8"), {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          } catch (error) {
            return new Response(`记忆库页面不可用：${String(error?.message ?? error)}`, {
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
        },
      });
      for (const [path, method, run] of routes) {
        register({
          path: API_PREFIX + path,
          methods: [method],
          requestBody: method === "POST" ? "buffered" : undefined,
          fetch: async (req) => {
            try {
              const body = method === "POST" && req?.json ? await req.json().catch(() => ({})) : {};
              const data = await run(body);
              // 业务失败也用 200 返回，交由前端看 {ok:false,code}；只有异常才是 500
              return new Response(JSON.stringify({ ok: !(data && data.ok === false), data }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            } catch (error) {
              return new Response(JSON.stringify({ ok: false, message: String(error?.message ?? error) }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }
          },
        });
      }
    }
  } catch {
    /* headless：没有 web 服务器 */
  }

  return service;
}

export const __internal = { pageRows, statsOf, CONFIG_SCHEMA, getPath, setPath };