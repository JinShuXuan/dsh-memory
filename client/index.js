// DSH 设置页 · 记忆库面板（React，无 JSX，无构建步骤）
// 加载形状由宿主约定：window.__ModuleLoader__.load({ id, factory(require) })
// 三个入口共用同一数据层：settings.section（完整页）、main（完整页，key 与 id 相同）、
// sidebar.pannellist（纯图标列表，放图标 + badge，title 提示「设置 → 记忆库」）。
window.__ModuleLoader__.load({
  id: "@jinshuxuan/dsh-memory",
  factory: (require) => {
    const module = { exports: {} };

    try {
      const React = require("react");
      const h = React.createElement;
      const NS = "dsh-memory";

      // ── 路由前缀：宿主侧固定挂在 /api/dsh-memory（src/service.js 的 API_PREFIX）────
      const API_BASES = ["/api/dsh-memory"];
      let apiBase = API_BASES[0];
      let probeCache = null;

      class ApiError extends Error {
        constructor(message, info = {}) {
          super(message);
          this.name = "ApiError";
          this.status = Number(info.status || 0);
          this.path = info.path || "";
          this.base = info.base || "";
          this.code = info.code || "";
        }
      }

      function where(base) {
        const origin = typeof window !== "undefined" && window.location ? String(window.location.origin || "") : "";
        return origin && base.startsWith("/") ? origin + base : base;
      }

      function resetProbe() {
        probeCache = null;
        apiBase = API_BASES[0];
      }

      /** 探测所有前缀；返回能通的 base 与 /diag 数据。失败时保留每个前缀的状态供面板展示。 */
      async function probe() {
        if (probeCache) return probeCache;
        probeCache = (async () => {
          const tried = [];
          for (const base of API_BASES) {
            try {
              const res = await fetch(base + "/diag", {
                method: "GET",
                headers: { accept: "application/json" },
                credentials: "same-origin",
              });
              let json = null;
              try {
                json = await res.json();
              } catch {
                json = null;
              }
              tried.push({ base, status: res.status, ok: res.ok && Boolean(json) });
              if (res.ok && json) {
                apiBase = base;
                return { ok: true, base, diag: json.data !== undefined ? json.data : json, tried };
              }
            } catch (error) {
              tried.push({ base, status: 0, ok: false, error: String(error?.message || error) });
            }
          }
          return { ok: false, base: apiBase, tried };
        })();
        return probeCache;
      }

      /** 统一调用：非 2xx 与 {ok:false} 都抛 ApiError，错误里带 status/path/base。 */
      async function call(path, method = "GET", body) {
        const base = apiBase || API_BASES[0];
        const res = await fetch(base + path, {
          method,
          credentials: "same-origin",
          headers: body ? { "content-type": "application/json" } : { accept: "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        if (!res.ok) {
          throw new ApiError(json?.message || `请求失败（HTTP ${res.status}）`, {
            status: res.status,
            path,
            base,
            code: json?.code,
          });
        }
        if (json && json.ok === false) {
          const inner = json.data || {};
          throw new ApiError(json.message || inner.message || inner.code || "操作未成功", {
            status: res.status,
            path,
            base,
            code: json.code || inner.code,
          });
        }
        return json && json.data !== undefined ? json.data : json;
      }

      // ── 小工具 ─────────────────────────────────────────────────────────────
      const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : String(v ?? 0));
      const getPath = (obj, key) => String(key).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
      const setPath = (obj, key, value) => {
        const keys = String(key).split(".");
        const last = keys.pop();
        let cur = obj;
        for (const k of keys) {
          if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
          cur = cur[k];
        }
        cur[last] = value;
        return obj;
      };
      const MODE_LABEL = {
        facts: "事实", skill: "技能", lesson: "教训", decision: "决策", error: "错误台账",
        staged: "待审/K 线", archive: "归档", timeline: "时间线", node: "节点", all: "全部",
      };
      const MODE_KEYS = ["facts", "skill", "lesson", "decision", "error", "staged", "archive", "timeline"];

      // 主题无关：只用 currentColor / inherit + 中性半透明底，深浅色自动跟随。
      const LINE = "1px solid rgba(127,127,127,.28)";
      const SOFT = "rgba(127,127,127,.10)";
      const S = {
        line: LINE,
        soft: SOFT,
        soft2: "rgba(127,127,127,.18)",
        dim: { opacity: 0.66 },
        row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
        btn: {
          padding: "4px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.35)",
          background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, lineHeight: 1.6,
        },
        card: { border: LINE, borderRadius: 10, padding: "10px 12px", background: SOFT },
        input: {
          padding: "4px 8px", borderRadius: 8, border: LINE, background: "transparent",
          color: "inherit", fontSize: 13, minWidth: 120,
        },
        danger: { color: "var(--danger, #e05252)" },
        ok: { color: "var(--success, #3aa675)" },
        accent: { color: "var(--accent, #4c8dff)" },
      };

      const T = {
        title: "记忆库",
        connecting: "连接中…", connected: "已连接", failed: "连接失败", probing: "探测中…",
        retry: "重试", refresh: "刷新", loading: "加载中…", empty: "没有数据", failed2: "失败",
        save: "保存", saving: "保存中…", saved: "已保存", restart: "保存后需重启 DSH 才生效",
        search: "搜索", prev: "上一页", next: "下一页", close: "收起", detail: "详情",
        tabs: { overview: "概览", browse: "浏览", review: "审批", maintenance: "维护", config: "配置", log: "日志" },
      };

      // ── 原子组件 ───────────────────────────────────────────────────────────
      function Btn(props) {
        const { children, onClick, disabled, danger, title, style, type } = props || {};
        return h(
          "button",
          {
            type: type || "button",
            title,
            disabled,
            onClick,
            style: { ...S.btn, ...(danger ? S.danger : null), ...(disabled ? { opacity: 0.5, cursor: "default" } : null), ...style },
          },
          children,
        );
      }

      function Card(props) {
        return h("div", { style: { ...S.card, ...(props?.style || null) } }, props?.children);
      }

      function Dim(props) {
        return h("span", { style: { ...S.dim, fontSize: 12 } }, props?.children);
      }

      function Stat(props) {
        const { label, value, hint } = props || {};
        return h(
          "div",
          { style: { ...S.card, minWidth: 96, flex: "1 1 96px" } },
          h("div", { style: { fontSize: 11, opacity: 0.62 } }, label),
          h("div", { style: { fontSize: 20, fontWeight: 600, lineHeight: 1.4 } }, value),
          hint ? h("div", { style: { fontSize: 10, ...S.dim } }, hint) : null,
        );
      }

      /** 纯 CSS 横向条，不引图表库。 */
      function Bars(props) {
        const { items, labelKey, valueKey, empty } = props || {};
        const rows = Array.isArray(items) ? items : [];
        if (!rows.length) return h(Dim, null, empty || T.empty);
        const max = rows.reduce((m, r) => Math.max(m, Number(r[valueKey]) || 0), 0) || 1;
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 6 } },
          rows.map((r) =>
            h(
              "div",
              { key: String(r[labelKey] ?? Math.random()), style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
              h("span", { style: { width: 110, flex: "0 0 110px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 } }, String(r[labelKey] ?? "—")),
              h("span", { style: { flex: 1, height: 8, borderRadius: 999, background: S.soft2, overflow: "hidden" } },
                h("span", { style: { display: "block", height: "100%", width: `${Math.round(((Number(r[valueKey]) || 0) / max) * 100)}%`, background: "currentColor", opacity: 0.55, borderRadius: 999 } }),
              ),
              h("span", { style: { width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" } }, n(r[valueKey])),
            ),
          ),
        );
      }

      function StateBlock(props) {
        const { phase, error, onRetry, children } = props || {};
        if (phase === "loading") return h("div", { style: { ...S.dim, padding: 16, fontSize: 13 } }, T.loading);
        if (phase === "error") return h(ErrorBanner, { error, onRetry });
        return children;
      }

      const STATUS_TEXT = (status) => {
        if (status === 401) return "HTTP 401 · 未登录：请从 DSH 界面打开（独立地址 /ui 没有登录态）";
        if (status === 404) return "HTTP 404 · host 路由未挂载：检查 dsh-memory 插件是否启用";
        if (!status) return "网络不可达：host 未响应";
        return `HTTP ${status}`;
      };

      function ErrorBanner(props) {
        const { error, onRetry, tried } = props || {};
        const status = error?.status ?? 0;
        return h(
          "div",
          {
            role: "alert",
            style: {
              border: "1px solid currentColor", borderLeftWidth: 4, borderRadius: 8,
              padding: "8px 10px", margin: "8px 0", background: S.soft, fontSize: 12, color: "var(--danger, #e05252)",
            },
          },
          h("div", { style: { fontWeight: 600 } }, STATUS_TEXT(status)),
          h("div", { style: { color: "inherit", opacity: 0.85, marginTop: 2 } },
            h("code", null, `${error?.path || "/diag"} @ ${error?.base || apiBase || "?"}`),
            error?.message ? ` · ${error.message}` : "",
            error?.code ? ` · ${error.code}` : "",
          ),
          Array.isArray(tried) && tried.length
            ? h("div", { style: { marginTop: 4, opacity: 0.75 } }, "已尝试：" + tried.map((x) => `${x.base} → ${x.status || "网络错误"}`).join("；"))
            : null,
          onRetry ? h(Btn, { onClick: onRetry, style: { marginTop: 6 } }, T.retry) : null,
        );
      }

      // ── 数据层 ─────────────────────────────────────────────────────────────
      function usePanel() {
        const [phase, setPhase] = React.useState("loading");
        const [stats, setStats] = React.useState(null);
        const [diag, setDiag] = React.useState(null);
        const [tried, setTried] = React.useState([]);
        const [base, setBase] = React.useState("");
        const [error, setError] = React.useState(null);

        const load = React.useCallback(async (force) => {
          if (force) resetProbe();
          setPhase("loading");
          setError(null);
          const pr = await probe();
          setTried(pr.tried);
          setBase(pr.base);
          setDiag(pr.diag || null);
          if (!pr.ok) {
            const first = (pr.tried && pr.tried[0]) || {};
            setError(new ApiError(first.error || "无法连接记忆库接口", { status: first.status || 0, path: "/diag", base: pr.base }));
            setPhase("error");
            return;
          }
          try {
            const s = await call("/stats");
            setStats(s);
            setPhase("ready");
          } catch (err) {
            setError(err);
            setPhase("error");
          }
        }, []);

        React.useEffect(() => {
          let alive = true;
          (async () => {
            await load(false);
            if (!alive) return;
          })();
          return () => {
            alive = false;
          };
        }, [load]);

        return { phase, stats, diag, tried, base, error, reload: () => load(true) };
      }

      /** 侧边栏只要两个计数，单独轻量拉一次。 */
      function useCounts() {
        const [counts, setCounts] = React.useState(null);
        React.useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const pr = await probe();
              if (!pr.ok) return;
              const s = await call("/stats");
              if (alive) setCounts(s?.counts || {});
            } catch {
              /* 侧边栏静默失败，title 里会提示 */
            }
          })();
          return () => {
            alive = false;
          };
        }, []);
        return counts;
      }

      // ── 概览 ───────────────────────────────────────────────────────────────
      function Overview(props) {
        const { p } = props || {};
        const s = p.stats || {};
        const c = s.counts || {};
        const subj = Array.isArray(s.subjects) ? s.subjects : [];
        const modes = s.modes && typeof s.modes === "object" ? Object.entries(s.modes).map(([k, v]) => ({ mode: MODE_LABEL[k] || k, count: v })) : [];
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 12 } },
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            h(Stat, { label: "活跃记忆", value: n(c.active ?? 0) }),
            h(Stat, { label: "待审（审批队列）", value: n(c.pending ?? 0) }),
            h(Stat, { label: "暂存（staged）", value: n(p.diag?.counts?.staged ?? 0) }),
            h(Stat, { label: "归档", value: n(c.archived ?? 0) }),
            h(Stat, { label: "关联边", value: n(c.links ?? 0) }),
            h(Stat, { label: "向量", value: n(c.vectors ?? 0) }),
            h(Stat, { label: "回收站", value: n(c.trash ?? 0) }),
          ),
          h(Card, null,
            h("div", { style: { ...S.row, justifyContent: "space-between" } },
              h("strong", null, "通道"),
              h(Dim, null, `向量模型：${s.embedder?.ready ? `就绪 ${s.embedder.dim || ""} 维` : "未就绪 / 降级为纯 FTS"}`),
            ),
            h("div", { style: { ...S.row, marginTop: 6, fontSize: 12 } },
              h("span", { style: s.embedder?.ready ? S.ok : S.danger }, `向量 ${s.embedder?.ready ? "可用" : "不可用"}`),
              h("span", { style: S.dim }, "·"),
              h("span", null, `FTS ${p.diag?.channels?.fts === undefined ? "未知" : p.diag.channels.fts ? "可用" : "不可用"}`),
              h("span", { style: S.dim }, "·"),
              h("span", null, `注入闸门：${s.gate || "—"}`),
            ),
          ),
          h(Card, null, h("div", { style: { fontWeight: 600, marginBottom: 8 } }, "主语分布（Top 10）"),
            h(Bars, { items: subj, labelKey: "subject", valueKey: "count", empty: "还没有主语统计" })),
          h(Card, null, h("div", { style: { fontWeight: 600, marginBottom: 8 } }, "类型分布"),
            h(Bars, { items: modes, labelKey: "mode", valueKey: "count", empty: "还没有类型统计" })),
        );
      }

      // ── 浏览 ───────────────────────────────────────────────────────────────
      function Browse(props) {
        const { p } = props || {};
        const [mode, setMode] = React.useState("facts");
        const [query, setQuery] = React.useState("");
        const [subject, setSubject] = React.useState("");
        const [filters, setFilters] = React.useState({ query: "", subject: "" });
        const [offset, setOffset] = React.useState(0);
        const [limit, setLimit] = React.useState(20);
        const [phase, setPhase] = React.useState("loading");
        const [res, setRes] = React.useState(null);
        const [err, setErr] = React.useState(null);
        const [openId, setOpenId] = React.useState(null);
        const [notice, setNotice] = React.useState("");

        const load = React.useCallback(async () => {
          setPhase("loading");
          setErr(null);
          try {
            const r = await call("/browse", "POST", {
              mode, query: filters.query, subject: filters.subject, limit, offset,
            });
            setRes(r);
            setPhase("ready");
          } catch (error) {
            setErr(error);
            setPhase("error");
          }
        }, [mode, filters, limit, offset]);

        React.useEffect(() => {
          load();
        }, [load]);

        const apply = () => {
          setOffset(0);
          setFilters({ query: query.trim(), subject: subject.trim() });
        };
        const act = async (path, id) => {
          setNotice("");
          try {
            await call(path, "POST", { id });
            setNotice("已提交：" + path);
            await load();
          } catch (error) {
            setNotice("失败：" + (error?.message || error));
          }
        };
        const pin = async (row) => {
          try {
            await call("/pin", "POST", { id: row.id, pinned: !row.pinned });
            setNotice(row.pinned ? "已取消钉选" : "已钉选（进常驻卡）");
            await load();
          } catch (error) {
            setNotice("失败：" + (error?.message || error));
          }
        };

        const rows = Array.isArray(res?.rows) ? res.rows : [];
        const total = Number(res?.total || 0);
        const subjects = Array.isArray(p?.stats?.subjects) ? p.stats.subjects : [];
        const isErrorMode = mode === "error";

        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: S.row },
            h("input", {
              style: { ...S.input, flex: "1 1 180px" }, placeholder: "关键词：内容 / 主语 / 谓词",
              value: query, onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") apply(); },
            }),
            h("select", { style: S.input, value: mode, onChange: (e) => { setMode(e.target.value); setOffset(0); } },
              MODE_KEYS.map((k) => h("option", { key: k, value: k }, `${MODE_LABEL[k]}`))),
            subjects.length
              ? h("select", { style: S.input, value: subject, onChange: (e) => { setSubject(e.target.value); setOffset(0); setFilters((f) => ({ ...f, subject: e.target.value })); } },
                  h("option", { value: "" }, "全部主语"),
                  subjects.map((s) => h("option", { key: s.subject, value: s.subject }, `${s.subject}（${s.count}）`)))
              : h("input", { style: S.input, placeholder: "主语过滤", value: subject, onChange: (e) => setSubject(e.target.value) }),
            h(Btn, { onClick: apply }, T.search),
            h(Btn, { onClick: () => load() }, T.refresh),
          ),
          notice ? h(Dim, null, notice) : null,
          h(StateBlock, { phase, error: err, onRetry: load },
            h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("div", { style: { ...S.row, justifyContent: "space-between" } },
                h(Dim, null, `共 ${n(total)} 条 · 第 ${total ? Math.floor(offset / limit) + 1 : 0} / ${Math.max(1, Math.ceil(total / limit))} 页`),
                h(Dim, null, `模式：${MODE_LABEL[mode] || mode}`),
              ),
              rows.length === 0 ? h("div", { style: { ...S.dim, padding: 16 } }, T.empty) : null,
              rows.map((row) => {
                const key = String(row.id);
                const expanded = openId === key;
                const title = isErrorMode ? String(row.cmd || "—") : String(row.value || "—");
                const sub = isErrorMode
                  ? String(row.symptom || "").slice(0, 120)
                  : `${row.subject || "—"} · ${row.predicate || "—"}`;
                return h(
                  "div",
                  { key, style: { ...S.card, padding: "8px 10px" } },
                  h("div", { style: { ...S.row, cursor: "pointer", justifyContent: "space-between" }, onClick: () => setOpenId(expanded ? null : key) },
                    h("div", { style: { flex: "1 1 240px", minWidth: 0 } },
                      h("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: expanded ? "normal" : "nowrap" } }, title),
                      h(Dim, null, `${isErrorMode ? "" : row.short_id || String(row.id).slice(-6) + " · "}${sub}${row.pinned ? " · 📌" : ""}${row.stage === "staged" ? " · 暂存" : ""}`),
                    ),
                    h(Dim, null, expanded ? T.close : T.detail),
                  ),
                  expanded
                    ? h("div", { style: { marginTop: 8, borderTop: S.line, paddingTop: 8, fontSize: 12 } },
                        isErrorMode
                          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                              h("div", null, `现象：${row.symptom || "—"}`),
                              h("div", null, `根因：${row.root_cause || "—"}`),
                              h("div", null, `解法位置：${row.where_solution || "—"}`),
                              h("div", null, `教训：${row.lesson || "—"}`),
                              h(Dim, null, `命中 ${row.hits ?? 0} 次 · ${row.status || ""} · ${row.updated_at || ""}`))
                          : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                              h("div", null, `类型：${row.mtype || "fact"} · 层：${row.layer || "atomic"} · 置信度：${row.confidence ?? "—"}`),
                              h("div", null, `来源：${row.source_type || "—"} · 作用域：${row.scope || "global"}`),
                              h("div", null, `标签：${row.tags || "[]"}`),
                              h("div", null, `创建：${row.created_at || "—"} · 更新：${row.updated_at || "—"} · 访问 ${row.access_count ?? 0} 次`),
                              h("div", null, `ID：${row.id}`),
                            ),
                        h("div", { style: { ...S.row, marginTop: 8 } },
                          !isErrorMode && h(Btn, { onClick: () => void pin(row) }, row.pinned ? "取消钉选" : "钉选"),
                          !isErrorMode && row.status !== "deleted" && h(Btn, { danger: true, onClick: () => { if (window.confirm("软删除这条记忆？可在回收站恢复。")) void act("/delete", row.id); } }, "软删"),
                          !isErrorMode && row.status && row.status !== "active" && h(Btn, { onClick: () => void act("/restore", row.id) }, "恢复"),
                        ))
                    : null,
                );
              }),
              h("div", { style: { ...S.row, justifyContent: "space-between", marginTop: 4 } },
                h(Btn, { disabled: offset <= 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, T.prev),
                h("select", { style: S.input, value: limit, onChange: (e) => { setLimit(Number(e.target.value)); setOffset(0); } },
                  [20, 50, 100].map((v) => h("option", { key: v, value: v }, `${v} 条/页`))),
                h(Btn, { disabled: offset + limit >= total, onClick: () => setOffset(offset + limit) }, T.next),
              ),
            ),
          ),
        );
      }

      // ── 审批 ───────────────────────────────────────────────────────────────
      function Review() {
        const [phase, setPhase] = React.useState("loading");
        const [rows, setRows] = React.useState([]);
        const [err, setErr] = React.useState(null);
        const [notice, setNotice] = React.useState("");

        const load = React.useCallback(async () => {
          setPhase("loading");
          setErr(null);
          try {
            const r = await call("/pending");
            setRows(Array.isArray(r) ? r : []);
            setPhase("ready");
          } catch (error) {
            setErr(error);
            setPhase("error");
          }
        }, []);

        React.useEffect(() => {
          load();
        }, [load]);

        const decide = async (row, action) => {
          try {
            await call(action === "approve" ? "/approve" : "/reject", "POST", { id: row.id });
            setNotice(`${action === "approve" ? "已通过" : "已驳回"} · ${row.subject || row.id}`);
            await load();
          } catch (error) {
            setNotice("失败：" + (error?.message || error));
          }
        };

        return h(StateBlock, { phase, error: err, onRetry: load },
          h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            notice ? h(Dim, null, notice) : null,
            rows.length === 0 ? h("div", { style: { ...S.dim, padding: 16 } }, "没有待审条目") : null,
            rows.map((row) => h("div", { key: String(row.id), style: S.card },
              h("div", { style: { fontSize: 13 } }, String(row.value ?? "—")),
              h(Dim, null, `${row.subject || "—"} · ${row.predicate || "—"} · ${row.created_at || ""} · ${String(row.id).slice(-6)}`),
              h("div", { style: { ...S.row, marginTop: 6 } },
                h(Btn, { onClick: () => void decide(row, "approve") }, "通过"),
                h(Btn, { danger: true, onClick: () => void decide(row, "reject") }, "驳回"),
              ),
            )),
          ),
        );
      }

      // ── 维护 ───────────────────────────────────────────────────────────────
      const MAINT_ACTIONS = [
        { key: "rebuild", label: "重建索引（全量）", confirm: "重建记忆库索引？可能耗时数分钟。", warn: "调用 store.reconcile()：重建 FTS/向量/关联" },
        { key: "decay", label: "遗忘扫描（直接生效）", confirm: "执行遗忘扫描？会直接修改记忆权重/归档，无法撤销。", warn: "后端未提供 dry-run，按钮即真执行" },
        { key: "cleantrash", label: "清理回收站（30 天前）", confirm: "清理回收站里 30 天前的内容？不可恢复。", warn: "" },
      ];

      function Maintenance() {
        const [out, setOut] = React.useState("");
        const [busy, setBusy] = React.useState("");
        const run = async (action, confirmText) => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(action);
          setOut("");
          try {
            const r = await call("/maintenance", "POST", { action });
            setOut(JSON.stringify(r, null, 2));
          } catch (error) {
            setOut("失败：" + (error?.message || error));
          } finally {
            setBusy("");
          }
        };
        const exportTo = async () => {
          setBusy("export");
          setOut("");
          try {
            const picked = await call("/dialog/export", "POST", { name: `memory-${new Date().toISOString().slice(0, 10)}.jsonl` });
            if (!picked?.ok) {
              if (picked?.code !== "CANCELLED") setOut("选择导出位置失败：" + (picked?.code || "未知"));
              return;
            }
            const r = await call("/export", "POST", { path: picked.path });
            setOut(`已导出 ${r?.count ?? 0} 条到 ${r?.path || picked.path}`);
          } catch (error) {
            setOut("失败：" + (error?.message || error));
          } finally {
            setBusy("");
          }
        };
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          h("div", { style: { ...S.row } },
            MAINT_ACTIONS.map((a) => h(Btn, { key: a.key, disabled: Boolean(busy), onClick: () => void run(a.key, a.confirm) },
              busy === a.key ? "执行中…" : a.label)),
            h(Btn, { disabled: Boolean(busy), onClick: () => void exportTo() }, busy === "export" ? "导出中…" : "导出全部事实"),
          ),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
            MAINT_ACTIONS.filter((a) => a.warn).map((a) => h(Dim, { key: a.key }, `· ${a.label}：${a.warn}`)),
          ),
          out ? h("pre", { style: { ...S.card, fontSize: 11, whiteSpace: "pre-wrap", margin: 0, maxHeight: 320, overflow: "auto" } }, out) : null,
        );
      }

      // ── 配置 ───────────────────────────────────────────────────────────────
      function isSecretField(field) {
        return /key|token|secret|password/i.test(String(field?.key || ""));
      }

      /** GET /config 回传的密钥是掩码（sk-…abcd / *** / ••••），不能当作新值写回。 */
      function looksMasked(value) {
        const s = typeof value === "string" ? value : "";
        return s !== "" && (s.includes("…") || s.includes("***") || s.includes("••"));
      }

      function ConfigTab() {
        const [phase, setPhase] = React.useState("loading");
        const [err, setErr] = React.useState(null);
        const [schema, setSchema] = React.useState([]);
        const [draft, setDraft] = React.useState({});
        const [notice, setNotice] = React.useState("");

        const load = React.useCallback(async () => {
          setPhase("loading");
          setErr(null);
          try {
            const r = await call("/config");
            setSchema(Array.isArray(r?.schema) ? r.schema : []);
            setDraft(r?.config || {});
            setPhase("ready");
          } catch (error) {
            setErr(error);
            setPhase("error");
          }
        }, []);

        React.useEffect(() => {
          load();
        }, [load]);

        const groups = [];
        for (const f of schema) {
          const g = groups.find((x) => x.name === (f.group || "其它"));
          if (g) g.items.push(f);
          else groups.push({ name: f.group || "其它", items: [f] });
        }

        const pick = async (field) => {
          try {
            const picked = await call("/dialog/dir", "POST");
            if (picked?.ok && picked.path) setDraft((d) => setPath({ ...d }, field.key, picked.path));
            else if (picked?.code && picked.code !== "CANCELLED") setNotice("选择目录失败：" + picked.code);
          } catch (error) {
            if (error?.code === "CANCELLED") return; // 用户取消，不算失败
            setNotice("失败：" + (error?.message || error));
          }
        };

        const save = async () => {
          setNotice(T.saving);
          const patch = {};
          for (const f of schema) {
            const v = getPath(draft, f.key);
            if (v === undefined) continue;
            // 密钥字段仍是服务端下发的掩码占位符 → 不发送，交给服务端保留旧值
            if (isSecretField(f) && looksMasked(v)) continue;
            setPath(patch, f.key, v);
          }
          try {
            const r = await call("/config", "POST", patch);
            setDraft(r?.config || draft);
            setNotice(T.saved + "。" + (r?.restartRequired ? T.restart : ""));
          } catch (error) {
            setNotice("失败：" + (error?.message || error));
          }
        };

        return h(StateBlock, { phase, error: err, onRetry: load },
          h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
            h(Dim, null, "带说明的项鼠标悬停可看提示；密钥类字段只显示占位符，留空或保持占位符即保留服务器上的原值，不会被掩码覆盖。"),
            groups.map((g) => h(Card, { key: g.name },
              h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, g.name),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                g.items.map((f) => {
                  const value = getPath(draft, f.key);
                  const secret = isSecretField(f);
                  const masked = secret && looksMasked(value);
                  return h("div", { key: f.key, style: { ...S.row, alignItems: "flex-start" } },
                    h("label", { title: f.desc || "", style: { width: 200, flex: "0 0 200px", fontSize: 12, opacity: 0.85, paddingTop: 4 } }, f.label || f.key),
                    f.type === "bool"
                      ? h("input", { type: "checkbox", checked: Boolean(value), onChange: (e) => setDraft((d) => setPath({ ...d }, f.key, e.target.checked)) })
                      : h("input", {
                          type: secret ? "password" : "text",
                          style: { ...S.input, flex: "1 1 220px" },
                          value: masked ? "" : value ?? "",
                          placeholder: masked ? value : f.desc || "",
                          onChange: (e) => setDraft((d) => setPath({ ...d }, f.key, e.target.value)),
                        }),
                    f.type === "dir" ? h(Btn, { onClick: () => void pick(f) }, "选择…") : null,
                  );
                }),
              ),
            )),
            h("div", { style: S.row },
              h(Btn, { onClick: () => void save() }, T.save),
              h(Dim, null, notice || T.restart),
            ),
          ),
        );
      }

      // ── 日志 ───────────────────────────────────────────────────────────────
      function LogTab(props) {
        const { p } = props || {};
        const lines = Array.isArray(p?.diag?.logTail) ? p.diag.logTail : [];
        return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h(Dim, null, `只读 · 来源 ${p?.base || apiBase}/diag · 最近 ${lines.length} 行`),
          lines.length
            ? h("pre", { style: { ...S.card, margin: 0, fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto" } }, lines.join("\n"))
            : h("div", { style: { ...S.dim, padding: 16 } }, "没有日志可显示（宿主日志文件尚未产生或为空）"),
        );
      }

      // ── 外壳 ───────────────────────────────────────────────────────────────
      const TABS = ["overview", "browse", "review", "maintenance", "config", "log"];

      function StatusBar(props) {
        const { p } = props || {};
        const c = p.stats?.counts || {};
        const probed = p.phase === "error" ? "失败" : p.phase === "loading" ? T.probing : T.connected;
        const diagCounts = p.diag?.counts || {};
        const active = c.active ?? diagCounts.active ?? 0;
        const staged = diagCounts.staged ?? 0;
        const pending = c.pending ?? 0;
        const archive = c.archived ?? diagCounts.archive ?? 0;
        return h("div", { style: { ...S.row, fontSize: 12, gap: 10, padding: "6px 0", borderBottom: S.line } },
          h("span", { style: p.phase === "error" ? S.danger : p.phase === "ready" ? S.ok : S.dim }, `● ${probed}`),
          h("code", { style: { fontSize: 11, opacity: 0.8 } }, p.base || apiBase),
          h(Dim, null, `v${p.diag?.version || "?"}`),
          h("span", null, `活跃 ${n(active)}`),
          h("span", null, `待审 ${n(pending)}`),
          h("span", null, `暂存 ${n(staged)}`),
          h("span", null, `归档 ${n(archive)}`),
          h(Btn, { onClick: () => p.reload(), style: { marginLeft: "auto", padding: "2px 8px" } }, T.retry),
        );
      }

      /** 完整面板：设置分区与 main 槽位共用。 */
      function SettingsPage(props) {
        const p = usePanel();
        const [tab, setTab] = React.useState("overview");
        const size = props?.size;
        return h("section", { style: { display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "inherit", maxWidth: size ? undefined : 980 } },
          h("div", { style: { ...S.row, justifyContent: "space-between" } },
            h("div", null,
              h("div", { style: { fontSize: 16, fontWeight: 650 } }, T.title),
              h(Dim, null, "本地长期记忆：事实、技能、教训、决策与错误台账"),
            ),
          ),
          h(StatusBar, { p }),
          p.phase === "error" ? h(ErrorBanner, { error: p.error, onRetry: p.reload, tried: p.tried }) : null,
          p.phase === "error" ? null : h("div", { role: "tablist", style: { ...S.row, gap: 4, flexWrap: "wrap" } },
            TABS.map((k) => h("button", {
              key: k,
              role: "tab",
              type: "button",
              "aria-selected": tab === k,
              onClick: () => setTab(k),
              style: {
                ...S.btn,
                fontWeight: tab === k ? 650 : 400,
                borderColor: tab === k ? "currentColor" : "rgba(127,127,127,.35)",
                background: tab === k ? S.soft2 : "transparent",
              },
            }, T.tabs[k])),
          ),
          p.phase === "error" ? null : h(StateBlock, { phase: p.phase, error: p.error, onRetry: p.reload },
            h("div", { key: tab, style: { paddingTop: 4 } },
              tab === "overview" ? h(Overview, { p })
                : tab === "browse" ? h(Browse, { p })
                : tab === "review" ? h(Review, null)
                : tab === "maintenance" ? h(Maintenance, null)
                : tab === "config" ? h(ConfigTab, null)
                : h(LogTab, { p }),
            ),
          ),
        );
      }

      /** sidebar.pannellist：纯图标列表，按钮由侧边栏渲染，这里只给图标 + 计数 badge。 */
      function SidebarCard(props) {
        const counts = useCounts();
        const [hint, setHint] = React.useState(false);
        const active = Number(counts?.active || 0);
        const pending = Number(counts?.pending || 0);
        const size = Number(props?.size || 18);
        const title = `记忆库 · 活跃 ${active} / 待审 ${pending}（设置 → 记忆库）`;
        return h("span", {
          title,
          style: { display: "inline-flex", alignItems: "center", gap: 4, color: "inherit", position: "relative" },
          onClick: () => setHint((v) => !v),
        },
          h("svg", {
            width: size, height: size, viewBox: "0 0 24 24", fill: "none",
            stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
            "aria-label": T.title,
          },
            h("path", { d: "M12 4a3 3 0 0 0-3 3v1.2A3.4 3.4 0 0 0 6 11.5c0 .9.3 1.7.9 2.3A3 3 0 0 0 9 19h1a2 2 0 0 0 2-2V4z" }),
            h("path", { d: "M12 4a3 3 0 0 1 3 3v1.2a3.4 3.4 0 0 1 3 3.3c0 .9-.3 1.7-.9 2.3A3 3 0 0 1 15 19h-1a2 2 0 0 1-2-2V4z" }),
          ),
          pending > 0 ? h("span", {
            style: {
              fontSize: 9, lineHeight: "12px", padding: "0 3px", borderRadius: 6,
              background: S.soft2, border: S.line, fontVariantNumeric: "tabular-nums",
            },
          }, `${active}/${pending}`) : null,
          hint ? h("span", {
            style: { position: "absolute", left: 0, top: "100%", marginTop: 6, whiteSpace: "nowrap", fontSize: 11, padding: "3px 6px", borderRadius: 6, background: S.soft2, border: S.line, zIndex: 10 },
          }, "在 设置 → 记忆库 打开") : null,
        );
      }

      function apply(ctx) {
        try {
          ctx.locale?.register?.(NS, { zh: { meta: { title: T.title, description: "本地长期记忆库" } } });
        } catch {
          /* 老宿主没有 locale.register */
        }
        const offs = [];
        const mount = (slot, Component, key) => {
          try {
            const reg = { name: slot, id: "dsh-memory", order: 30, label: () => T.title, locale: NS };
            if (key) reg.key = key; // 只有 main 槽位用 key；settings/sidebar 复用同名 key 会被宿主去重吞掉
            const off = ctx.slots.inject(slot, () =>
              ctx.slots.register(reg, Component),
            );
            offs.push(off);
          } catch (error) {
            // 该 slot 在此版本不存在时跳过，不影响其它入口
            try {
              console.warn("[dsh-memory] slot missing", slot, error);
            } catch {
              /* ignore */
            }
          }
        };
        mount("settings.section", SettingsPage);
        mount("sidebar.pannellist", SidebarCard);
        mount("main", SettingsPage, "dsh-memory");
        const dispose = () => {
          for (const off of offs) {
            try {
              off?.();
            } catch {
              /* ignore */
            }
          }
        };
        if (typeof ctx.effect === "function") {
          try {
            ctx.effect(() => dispose);
          } catch {
            /* ignore */
          }
        }
        return dispose;
      }

      module.exports = { inject: ["slots", "locale"], apply };
      return module.exports;
    } catch (err) {
      // 加载期不静默：打印错误并挂一张纯文本错误卡，避免面板整个消失。
      console.error("[dsh-memory] client load failed", err);
      const makeErrorCard = (req) => {
        try {
          const R = req("react");
          const msg = String(err?.stack || err?.message || err);
          const Comp = () =>
            R.createElement(
              "div",
              { style: { border: "1px solid currentColor", borderRadius: 8, padding: 10, margin: 8, fontSize: 12, color: "var(--danger, #e05252)" } },
              R.createElement("strong", null, "记忆库面板加载失败"),
              R.createElement("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.8 } }, msg),
            );
          return Comp;
        } catch {
          return () => null;
        }
      };
      module.exports = {
        inject: ["slots", "locale"],
        __error: String(err?.message || err),
        apply: (ctx) => {
          try {
            ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-memory", order: 30, label: () => "记忆库" }, makeErrorCard(require)));
          } catch {
            /* ignore */
          }
        },
      };
      return module.exports;
    }
  },
});