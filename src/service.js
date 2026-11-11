// UI 用的宿主侧服务：只读查询 + 白名单写操作 + 系统原生目录对话框。
// 不 import 任何 client 代码，headless 环境可安全跳过。
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 宿主约定：插件用 ctx.webServer.register({kind:"exact", path, handler}) 挂载
// 自己的同源 HTTP 路由，路由名由插件自定（对照 dsh-switchman 的 /api/dsh-switchman）。
const API_PREFIX = "/api/dsh-memory";

/** 挂载结果快照：/diag 会把它原样吐出来，面板据此显示真实状态。 */
const MOUNT_STATE = { mounted: false, prefix: API_PREFIX, routes: 0, failures: [], at: null, reason: "尚未尝试挂载", trying: false };
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
  // 面板概览用：主语分布（Top 10）与类型分布。任一步失败都只损失该字段，不让 /stats 整体抛错。
  let subjects = [];
  try {
    subjects = store.db
      .prepare(
        "SELECT subject, COUNT(*) AS n FROM memory WHERE subject IS NOT NULL AND subject <> '' AND status <> 'deleted' AND deleted_at IS NULL GROUP BY subject ORDER BY n DESC LIMIT 10",
      )
      .all()
      .map((r) => ({ subject: String(r.subject), count: Number(r.n ?? 0) }));
  } catch {
    subjects = [];
  }
  // modes 口径：按 memory.mtype 计数（fact/skill/lesson/decision/node…），未标 mtype 的记作 fact；
  // 另加入错误台账 error 一项（表不存在时为 0）。staged/archived 不在 modes 里，见 counts。
  const modes = {};
  try {
    for (const r of store.db
      .prepare("SELECT COALESCE(NULLIF(LOWER(mtype), ''), 'fact') AS k, COUNT(*) AS n FROM memory WHERE deleted_at IS NULL GROUP BY k")
      .all()) {
      modes[String(r.k)] = Number(r.n ?? 0);
    }
  } catch {
    /* ignore */
  }
  try {
    const e = store.db.prepare("SELECT COUNT(*) AS n FROM error_ledger WHERE COALESCE(status, 'active') <> 'archived'").get();
    if (e) modes.error = Number(e.n ?? 0);
  } catch {
    /* ignore */
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
    subjects,
    modes,
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
const PKG_JSON = join(dirname(UI_HTML), "..", "package.json");

/** 浏览用：把「模式」翻译成 SQL 条件。错误模式走台账表。 */
function browseRows(store, { mode = "facts", query = "", subject = "", limit = 50, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const q = String(query || "").trim();
  const subj = String(subject || "").trim();
  const kind = mode === "error" ? "error" : ["facts", "all", "staged", "archive", "timeline", "skill", "lesson", "decision", "node"].includes(mode) ? mode : "facts";

  if (kind === "error") {
    const where = [];
    const args = [];
    if (q) {
      where.push("(cmd LIKE ? OR symptom LIKE ? OR lesson LIKE ? OR root_cause LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    try {
      const total = store.db.prepare(`SELECT COUNT(*) AS n FROM error_ledger${w}`).get(...args)?.n ?? 0;
      const rows = store.db
        .prepare(`SELECT id, cmd, symptom, lesson, root_cause, where_solution, status, hits, updated_at FROM error_ledger${w} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...args, lim, off);
      return { mode: kind, total, limit: lim, offset: off, rows };
    } catch {
      return { mode: kind, total: 0, limit: lim, offset: off, rows: [] };
    }
  }

  const where = ["deleted_at IS NULL"];
  const args = [];
  if (kind === "staged") where.push("stage = 'staged'");
  else if (kind === "archive") where.push("status = 'archived'");
  else if (kind === "timeline" || kind === "all") {
    /* 不限状态 */
  } else where.push("status = 'active'", "stage <> 'staged'");
  // skill 复刻插件的 TYPES 口径：skill 同时包含 lesson
  if (kind === "skill") where.push("mtype IN ('skill', 'lesson')");
  else if (["lesson", "decision", "node"].includes(kind)) {
    where.push("mtype = ?");
    args.push(kind);
  }
  if (subj) {
    where.push("subject = ?");
    args.push(subj);
  }
  if (q) {
    where.push("(value LIKE ? OR subject LIKE ? OR predicate LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const w = ` WHERE ${where.join(" AND ")}`;
  const total = store.db.prepare(`SELECT COUNT(*) AS n FROM memory${w}`).get(...args)?.n ?? 0;
  const rows = store.db
    .prepare(
      `SELECT id, subject, predicate, value, tags, status, scope, stage, mtype, layer, confidence, pinned, source_type, created_at, updated_at, last_access, access_count FROM memory${w} ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, lim, off)
    .map((r) => ({ ...r, value: String(r.value ?? "").slice(0, 160), short_id: `#${String(r.id).slice(-5)}` }));
  return { mode: kind, total, limit: lim, offset: off, rows };
}

/** 掩码占位符判定：GET /config 下发的密钥形如 sk-…abcd / *** / ••••，回写时不能当真值。 */
const SECRET_KEY_RE = /(^|[._])(api[-_]?key|key|token|secret|password)$/i;
const MASK_MARKERS = ["…", "***", "••"];
function isMaskedSecret(field, value) {
  if (!(field?.type === "secret" || SECRET_KEY_RE.test(String(field?.key || "")))) return false;
  const s = typeof value === "string" ? value : "";
  return s !== "" && MASK_MARKERS.some((m) => s.includes(m));
}

/** 一行日志脱敏：密钥、Bearer 头、以及绝对路径只保留末两级。 */
function redactLine(input) {
  let t = String(input ?? "");
  t = t.replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-***");
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 ***");
  t = t.replace(/((?:"?(?:api[_-]?key|token|secret|password)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1***");
  t = t.replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, (m) => {
    const parts = m.split(/[\\/]+/).filter(Boolean);
    return parts.length <= 2 ? m : `…${sep}${parts.slice(-2).join(sep)}`;
  });
  return t.slice(0, 400);
}

function logTail(maxLines = 30) {
  const candidates = [join(dirname(UI_HTML), "..", "memory.log"), join(dirname(UI_HTML), "..", "memory.log.1")];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      const span = Math.min(size, 32 * 1024);
      const buf = Buffer.alloc(span);
      const fd = openSync(file, "r");
      try {
        readSync(fd, buf, 0, span, size - span);
      } finally {
        closeSync(fd);
      }
      const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
      return lines.slice(-maxLines).map(redactLine);
    } catch {
      /* 换下一个候选 */
    }
  }
  return [];
}

/** /diag 的数据：全部字段单独兜底，绝不因某张表缺失而抛错。 */
function diagOf(store, api) {
  const one = (sql) => {
    try {
      return Number(store.db.prepare(sql).get()?.n ?? 0);
    } catch {
      return 0;
    }
  };
  let version = "unknown";
  try {
    version = String(JSON.parse(readFileSync(PKG_JSON, "utf8")).version || "unknown");
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    version,
    apiPrefix: API_PREFIX,
    mount: { ...MOUNT_STATE, failures: MOUNT_STATE.failures.slice() },
    counts: {
      active: one("SELECT COUNT(*) AS n FROM memory WHERE status = 'active' AND deleted_at IS NULL"),
      staged: one("SELECT COUNT(*) AS n FROM memory WHERE stage = 'staged' AND deleted_at IS NULL"),
      archive: one("SELECT COUNT(*) AS n FROM memory WHERE status = 'archived'"),
      errors: one("SELECT COUNT(*) AS n FROM error_ledger WHERE COALESCE(status, 'active') <> 'archived'"),
      edges: one("SELECT COUNT(*) AS n FROM memory_link"),
    },
    channels: { fts: Boolean(store.fts), vec: Boolean(store.embedder?.ready) },
    subjects: (() => {
      try {
        return store.db
          .prepare(
            "SELECT subject, COUNT(*) AS n FROM memory WHERE subject IS NOT NULL AND subject <> '' AND status <> 'deleted' AND deleted_at IS NULL GROUP BY subject ORDER BY n DESC LIMIT 10",
          )
          .all()
          .map((r) => ({ subject: String(r.subject), count: Number(r.n ?? 0) }));
      } catch {
        return [];
      }
    })(),
    logTail: logTail(30),
    client: { declared: true, slots: ["settings.section", "sidebar.pannellist"] },
  };
}

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
    diag: () => diagOf(store, api),
    browse: (opts) => browseRows(store, opts ?? {}),
    // 面板行内「钉选」：直接改 memory.pinned（与 memory_pin 工具同口径），复用 store 的卡片刷新（若存在）。
    pin: (id, pinned) => {
      if (!id) return { ok: false, code: "BAD_ARGS" };
      const flag = pinned === false || pinned === 0 || pinned === "0" || pinned === "false" ? 0 : 1;
      const row = store.db.prepare("SELECT id FROM memory WHERE (id = ? OR id LIKE ?) AND deleted_at IS NULL").get(String(id), `%${String(id)}`);
      if (!row) return { ok: false, code: "NOT_FOUND" };
      store.db.prepare("UPDATE memory SET pinned = ?, pin_source = 'manual', updated_at = ? WHERE id = ?").run(flag, new Date().toISOString(), row.id);
      try {
        store.refreshCard?.(row.id);
      } catch {
        /* 卡片刷新失败不影响本体 */
      }
      return { ok: true, id: row.id, pinned: Boolean(flag) };
    },
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
      // 客户端把 GET 得到的掩码原样回传时跳过该字段，避免把真 key 覆盖成 sk-…abcd
      const skipped = [];
      for (const field of CONFIG_SCHEMA) {
        const v = getPath(patch ?? {}, field.key);
        if (v === undefined) continue;
        if (isMaskedSecret(field, v)) {
          skipped.push(field.key);
          continue;
        }
        setPath(next, field.key, field.type === "number" ? Number(v) : field.type === "bool" ? Boolean(v) : v);
      }
      const saved = api.saveConfig(next);
      const masked = JSON.parse(JSON.stringify(saved));
      if (masked?.extractor?.apiKey) masked.extractor.apiKey = api.maskKey?.(masked.extractor.apiKey) ?? "…";
      return { config: masked, schema: CONFIG_SCHEMA, skipped, restartRequired: Object.keys(next).includes("root") };
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
    ["/diag", "GET", () => service.diag()],
    ["/browse", "POST", (b) => service.browse(b)],
    ["/pin", "POST", (b) => service.pin(b?.id, b?.pinned)],
  ];

  /** 读一个 JSON 请求体（1 MiB 上限）。 */
  const readJsonBody = (req) =>
    new Promise((res, rej) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          rej(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!chunks.length) return res({});
        try {
          res(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          rej(new Error(`invalid JSON body: ${error?.message ?? error}`));
        }
      });
      req.on("error", rej);
    });

  /** 写出响应；连接已断时静默。 */
  const send = (res, status, body, type) => {
    try {
      res.writeHead(status, { "content-type": type ?? "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    } catch {
      /* 连接已断 */
    }
  };
  const sendJson = (res, status, payload) => send(res, status, JSON.stringify(payload));

  /** 挂到宿主 webServer 上（ctx.webServer.register）；幂等。 */
  const mount = (web) => {
    if (MOUNT_STATE.mounted || MOUNT_STATE.trying) return;
    const register = web?.register?.bind(web) ?? web?.webServer?.register?.bind(web);
    if (typeof register !== "function") {
      MOUNT_STATE.reason = "webServer 服务不可用（宿主未暴露 register）";
      return;
    }
    MOUNT_STATE.trying = true;
    const ok = [];
    const failures = [];
    const put = (route) => {
      try {
        const dispose = register(route);
        ok.push(route.path);
        // 与宿主约定一致（对照 dsh-switchman）：注册返回的 disposer 交给 ctx.effect 管理，
        // 插件卸载/热重载时才不会留下悬挂路由。
        if (typeof dispose === "function") {
          try {
            ctx.effect?.(() => dispose);
          } catch {
            /* 无 effect 能力的宿主忽略 */
          }
        }
      } catch (error) {
        failures.push({ path: route.path, error: String(error?.message ?? error) });
      }
    };

    // 独立页面兜底（面板之外也能直接用 /api/dsh-memory/ui 打开）
    put({
      kind: "exact",
      path: API_PREFIX + "/ui",
      handler: (_req, res) => {
        try {
          send(res, 200, readFileSync(UI_HTML, "utf8"), "text/html; charset=utf-8");
        } catch (error) {
          send(res, 500, `记忆库页面不可用：${String(error?.message ?? error)}`, "text/plain; charset=utf-8");
        }
      },
    });

    const byPath = new Map();
    for (const [path, method, run] of routes) {
      const key = API_PREFIX + path;
      const entry = byPath.get(key) ?? new Map();
      entry.set(method, run);
      byPath.set(key, entry);
    }

    // 一条 path 只注册一次（宿主按 path 建索引，同 path 二次注册会覆盖/抛错），
    // method 在 handler 里分派。
    for (const [fullPath, runners] of byPath) {
      const allow = [...runners.keys()].join(", ");
      put({
        kind: "exact",
        path: fullPath,
        handler: async (req, res) => {
          try {
            const run = runners.get(req.method);
            if (typeof run !== "function") {
              // 头必须在 writeHead 之前设，否则无效
              try {
                res.setHeader?.("allow", allow);
              } catch {
                /* ignore */
              }
              sendJson(res, 405, { ok: false, message: `method not allowed: ${req.method}` });
              return;
            }
            const body = req.method === "POST" ? await readJsonBody(req) : {};
            const data = await run(body);
            // 业务失败也用 200 返：前端按 {ok, code} 判；只有异常才是 500。
            sendJson(res, 200, { ok: !(data && data.ok === false), data });
          } catch (error) {
            sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
          }
        },
      });
    }

    MOUNT_STATE.trying = false;
    MOUNT_STATE.routes = ok.length;
    MOUNT_STATE.failures = failures;
    MOUNT_STATE.at = new Date().toISOString();
    MOUNT_STATE.mounted = ok.length > 0;
    MOUNT_STATE.reason = ok.length > 0 ? `已挂载 ${ok.length} 条路由` : "所有路由注册都被宿主拒绝";
    try {
      api.log?.(
        `${API_PREFIX}：${MOUNT_STATE.reason}` +
          (failures.length ? `；失败 ${failures.length} 条：${failures.map((f) => `${f.path} ← ${f.error}`).join(" | ")}` : ""),
      );
    } catch {
      /* ignore */
    }
  };

  // web 载体可能晚于本插件就绪：先直接取，取不到再用 cordis 的 inject 等它出现。
  try {
    mount(ctx.get?.("webServer") ?? ctx.webServer);
  } catch {
    /* ignore */
  }
  if (!MOUNT_STATE.mounted && typeof ctx.inject === "function") {
    try {
      ctx.inject(["webServer"], (c) => mount(c?.webServer ?? c?.get?.("webServer")));
    } catch (error) {
      MOUNT_STATE.reason = "webServer 注入失败：" + String(error?.message ?? error);
    }
  }

  if (!MOUNT_STATE.mounted) {
    try {
      api.log?.(`面板接口未挂载（${API_PREFIX}/* 会 404）：${MOUNT_STATE.reason}`);
    } catch {
      /* ignore */
    }
  }

  return service;
}

export const __internal = { pageRows, statsOf, CONFIG_SCHEMA, getPath, setPath };