// UI 用的宿主侧服务：只读查询 + 白名单写操作（软删/恢复/审批/维护）。
// 不 import 任何 client 代码，headless 环境可安全跳过。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API_PREFIX = "/api/memory";

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
    items: rows.map((r) => ({
      ...r,
      value: String(r.value ?? "").slice(0, 160),
      short_id: `#${String(r.id).slice(-5)}`,
    })),
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
    for (const r of store.db.prepare("SELECT status, COUNT(*) AS n FROM memory GROUP BY status").all()) {
      byStatus[r.status] = Number(r.n);
    }
  } catch {
    /* ignore */
  }
  let budget = null;
  try {
    budget = store.budgetState ? store.budgetState() : null;
  } catch {
    budget = null;
  }
  let garbage = 0;
  try {
    garbage = readdirSync(join(root, "trash")).length;
  } catch {
    garbage = 0;
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
      trash: garbage,
    },
    budget,
    llm: {
      enabled: Boolean(config?.extractor?.enabled),
      keySource: config?.extractor?.apiKey ? "file" : null,
    },
  };
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} store MemoryStore
 * @param {object} api { root, loadConfig, saveConfig, maskKey }
 */
export function attachService(ctx, store, api) {
  const service = {
    stats: () => statsOf(store, api.root, api.loadConfig()),
    list: (opts) => pageRows(store, opts),
    get: (id) => {
      const row = store.getById ? store.getById(id) : null;
      return row ?? null;
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
    softDelete: (id, reason = "ui") => {
      if (store.remove) return store.remove({ idOrSuffix: id, reason });
      const info = store.db.prepare("SELECT id FROM memory WHERE id = ? OR id LIKE ?").get(id, `%${id}`);
      if (!info) return { ok: false, code: "NOT_FOUND" };
      store.setStatus(info.id, "deleted");
      return { ok: true, id: info.id };
    },
    restore: (id) => (store.restore ? store.restore({ idOrSuffix: id }) : { ok: false, code: "UNSUPPORTED" }),
    maintenance: (action) => {
      const a = String(action || "").toLowerCase();
      if (a === "rebuild") {
        const r = store.reconcile();
        return { ok: true, action: a, ...r };
      }
      if (a === "decay") return { ok: true, action: a, counts: store.decaySweep({ dryRun: false }).counts };
      if (a === "cleantrash") return { ok: true, action: a, removed: store.cleanTrash(30) };
      return { ok: false, code: "BAD_ARGS", message: "rebuild | decay | cleantrash" };
    },
    getConfig: () => {
      const cfg = api.loadConfig();
      const masked = JSON.parse(JSON.stringify(cfg));
      if (masked?.extractor?.apiKey) masked.extractor.apiKey = api.maskKey?.(masked.extractor.apiKey) ?? "…";
      return masked;
    },
    setConfig: (patch) => {
      const allowed = {};
      for (const k of ["gate", "hits", "hitsChars", "sessionInjects", "sessionInjectWindow"]) {
        if (patch && patch[k] !== undefined) allowed[k] = patch[k];
      }
      if (patch?.extractor) {
        allowed.extractor = {};
        for (const k of ["enabled", "baseURL", "model", "apiKey", "apiKeyEnv", "maxFactsPerTurn"]) {
          if (patch.extractor[k] !== undefined) allowed.extractor[k] = patch.extractor[k];
        }
      }
      const next = api.saveConfig(allowed);
      const masked = JSON.parse(JSON.stringify(next));
      if (masked?.extractor?.apiKey) masked.extractor.apiKey = api.maskKey?.(masked.extractor.apiKey) ?? "…";
      return masked;
    },
  };

  // 1) cordis 服务（同一进程内的 client 可直接取）
  try {
    ctx.provide?.("memory.service", service);
  } catch {
    /* 老版本 ctx 没有 provide，忽略 */
  }

  // 2) Web 客户端走 HTTP：/api/memory/*
  const routes = [
    ["/stats", "GET", () => service.stats()],
    ["/list", "POST", (body) => service.list(body)],
    ["/pending", "GET", () => service.pending()],
    ["/approve", "POST", (body) => service.approve(String(body?.id ?? ""))],
    ["/reject", "POST", (body) => service.reject(String(body?.id ?? ""))],
    ["/delete", "POST", (body) => service.softDelete(String(body?.id ?? ""), String(body?.reason ?? "ui"))],
    ["/restore", "POST", (body) => service.restore(String(body?.id ?? ""))],
    ["/maintenance", "POST", (body) => service.maintenance(body?.action)],
    ["/config", "GET", () => service.getConfig()],
    ["/config", "POST", (body) => service.setConfig(body)],
  ];
  try {
    const connection = ctx.get?.("connection") ?? ctx.connection;
    const register = connection?.fetch?.register;
    if (typeof register === "function") {
      for (const [path, method, run] of routes) {
        register({
          path: API_PREFIX + path,
          methods: [method],
          requestBody: method === "POST" ? "buffered" : undefined,
          fetch: async (req) => {
            try {
              const body = method === "POST" && req?.json ? await req.json().catch(() => ({})) : {};
              const data = await run(body);
              return new Response(JSON.stringify({ ok: true, data }), {
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
    /* 没有 web 端（headless）时静默跳过 */
  }

  return service;
}

export const __internal = { pageRows, statsOf, API_PREFIX };
export { existsSync };