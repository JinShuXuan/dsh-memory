// DSH 设置页 · 记忆库面板（React，无 JSX，无需构建）
// 宿主按 package.json 的 exports["./client"] + dsh.client 加载本文件。
window.__ModuleLoader__.load({
  id: "@jinshuxuan/dsh-memory",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const NS = "dsh-memory";
    const API = "/api/memory";

    const STR = {
      language: "zh",
      zh: {
        nav: "记忆库",
        tabs: { overview: "概览", browse: "浏览", review: "审批", maintenance: "维护" },
        common: { refresh: "刷新", loading: "加载中…", empty: "没有数据", confirm: "确认执行？", cancel: "取消", retry: "重试" },
        overview: {
          active: "活跃记忆", vectors: "向量", links: "关联边", pending: "待审", trash: "回收站", total: "总计",
          gate: "注入闸门", embedder: "向量模型", ready: "就绪", degraded: "降级为纯 FTS",
          spend: "本月花费", llmOn: "LLM 抽取：开", llmOff: "LLM 抽取：关（默认）",
          llmIntro: "LLM 抽取默认关闭：只用规则与检索，零花费。在配置里填 API key 并开启 extractor.enabled 后，才会自动从对话抽取事实；每次调用约 0.005 元，每月上限 20 元，超了自动退回纯本地规则。",
        },
        browse: { search: "搜索 value / subject / predicate", status: "状态", all: "全部", active: "active", archived: "archived", deleted: "deleted", del: "软删", restore: "恢复", total: "共 {n} 条" },
        review: { approve: "通过", reject: "驳回", reason: "原因" },
        maintenance: { rebuild: "重建索引", decay: "执行遗忘扫描", cleantrash: "清理回收站（30 天前）", done: "完成", result: "结果" },
      },
      en: {
        nav: "Memory",
        tabs: { overview: "Overview", browse: "Browse", review: "Review", maintenance: "Maintenance" },
        common: { refresh: "Refresh", loading: "Loading…", empty: "No data", confirm: "Are you sure?", cancel: "Cancel", retry: "Retry" },
        overview: {
          active: "Active", vectors: "Vectors", links: "Links", pending: "Pending", trash: "Trash", total: "Total",
          gate: "Gate", embedder: "Embedder", ready: "ready", degraded: "FTS only",
          spend: "Spend this month", llmOn: "LLM extraction: on", llmOff: "LLM extraction: off (default)",
          llmIntro: "LLM extraction is off by default — rules and retrieval only, zero cost. Fill an API key and enable extractor.enabled to auto-extract facts; ~$0.0007 per call, capped at $3/month.",
        },
        browse: { search: "Search value / subject / predicate", status: "Status", all: "All", active: "active", archived: "archived", deleted: "deleted", del: "Soft delete", restore: "Restore", total: "{n} items" },
        review: { approve: "Approve", reject: "Reject", reason: "Reason" },
        maintenance: { rebuild: "Rebuild index", decay: "Run decay sweep", cleantrash: "Clean trash (>30d)", done: "Done", result: "Result" },
      },
    };

    function makeT(lang) {
      const pick = (dict, key) => key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
      return (key, vars) => {
        let s = pick(STR[lang] ?? STR.zh, key) ?? key;
        if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
        return s;
      };
    }

    async function api(path, method = "GET", body) {
      const res = await fetch(API + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(json?.message || `HTTP ${res.status}`);
      return json.data;
    }

    const card = { border: "1px solid rgba(127,127,127,.25)", borderRadius: 10, padding: "10px 12px", minWidth: 96 };
    const btn = { padding: "4px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.35)", cursor: "pointer", background: "transparent" };
    const row = { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(127,127,127,.12)" };

    function Overview({ stats, t }) {
      if (!stats) return h("div", null, t("common.loading"));
      const c = stats.counts || {};
      const Cell = ({ label, value }) => h("div", { style: card }, h("div", { style: { opacity: 0.6, fontSize: 12 } }, label), h("div", { style: { fontSize: 20, fontWeight: 600 } }, String(value)));
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h(Cell, { label: t("overview.active"), value: c.active ?? 0 }),
          h(Cell, { label: t("overview.vectors"), value: c.vectors ?? 0 }),
          h(Cell, { label: t("overview.links"), value: c.links ?? 0 }),
          h(Cell, { label: t("overview.pending"), value: c.pending ?? 0 }),
          h(Cell, { label: t("overview.trash"), value: c.trash ?? 0 }),
          h(Cell, { label: t("overview.total"), value: c.total ?? 0 }),
        ),
        h("div", { style: { fontSize: 13, lineHeight: 1.7 } },
          h("div", null, `${t("overview.gate")}: ${stats.gate} · ${t("overview.embedder")}: ${stats.embedder?.ready ? t("overview.ready") : t("overview.degraded")}`),
          stats.budget ? h("div", null, `${t("overview.spend")}: ¥${Number(stats.budget.used ?? 0).toFixed(3)} / ¥${Number(stats.budget.limit ?? 0).toFixed(0)}`) : null,
          h("div", null, stats.llm?.enabled ? t("overview.llmOn") : t("overview.llmOff")),
        ),
        h("div", { style: { fontSize: 12, opacity: 0.75, borderLeft: "3px solid rgba(127,127,127,.4)", paddingLeft: 10 } }, t("overview.llmIntro")),
      );
    }

    function Browse({ t }) {
      const [query, setQuery] = React.useState("");
      const [status, setStatus] = React.useState("active");
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const load = React.useCallback(async () => {
        setError("");
        try {
          setData(await api("/list", "POST", { query, status, limit: 50 }));
        } catch (e) {
          setError(String(e.message || e));
        }
      }, [query, status]);
      React.useEffect(() => { void load(); }, [load]);
      const act = async (path, id) => {
        await api(path, "POST", { id }).catch((e) => setError(String(e.message || e)));
        await load();
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", { value: query, placeholder: t("browse.search"), onChange: (e) => setQuery(e.target.value),
            style: { flex: 1, minWidth: 180, padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit" } }),
          h("select", { value: status, onChange: (e) => setStatus(e.target.value), style: { ...btn } },
            ["active", "archived", "deleted", "all"].map((s) => h("option", { key: s, value: s }, t("browse." + s))),
          ),
          h("button", { style: btn, onClick: () => void load() }, t("common.refresh")),
        ),
        error ? h("div", { style: { color: "#e5484d", fontSize: 12 } }, error) : null,
        !data ? h("div", null, t("common.loading")) :
          data.items.length === 0 ? h("div", { style: { opacity: 0.6 } }, t("common.empty")) :
          h("div", null,
            h("div", { style: { fontSize: 12, opacity: 0.6, padding: "4px 0" } }, t("browse.total", { n: data.total })),
            data.items.map((it) => h("div", { key: it.id, style: row },
              h("code", { style: { fontSize: 11, opacity: 0.65, minWidth: 52 } }, it.short_id),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.value),
                h("div", { style: { fontSize: 11, opacity: 0.55 } }, `${it.subject} · ${it.predicate} · ${it.status}`),
              ),
              it.status === "deleted"
                ? h("button", { style: btn, onClick: () => act("/restore", it.id) }, t("browse.restore"))
                : h("button", { style: btn, onClick: () => act("/delete", it.id) }, t("browse.del")),
            )),
          ),
      );
    }

    function Review({ t }) {
      const [items, setItems] = React.useState(null);
      const [error, setError] = React.useState("");
      const load = React.useCallback(async () => {
        try { setItems(await api("/pending")); } catch (e) { setError(String(e.message || e)); }
      }, []);
      React.useEffect(() => { void load(); }, [load]);
      const act = async (path, id) => { await api(path, "POST", { id }).catch((e) => setError(String(e.message || e))); await load(); };
      if (error) return h("div", { style: { color: "#e5484d" } }, error);
      if (!items) return h("div", null, t("common.loading"));
      if (items.length === 0) return h("div", { style: { opacity: 0.6 } }, t("common.empty"));
      return h("div", null, items.map((p) => h("div", { key: p.id, style: row },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 13 } }, String(p.candidate?.value ?? "").slice(0, 160)),
          h("div", { style: { fontSize: 11, opacity: 0.55 } }, `${p.reason} · ${p.candidate?.subject ?? ""}/${p.candidate?.predicate ?? ""}`),
        ),
        h("button", { style: btn, onClick: () => act("/approve", p.id) }, t("review.approve")),
        h("button", { style: btn, onClick: () => act("/reject", p.id) }, t("review.reject")),
      )));
    }

    function Maintenance({ t }) {
      const [out, setOut] = React.useState("");
      const run = async (action) => {
        if (!window.confirm(t("common.confirm"))) return;
        try {
          const r = await api("/maintenance", "POST", { action });
          setOut(JSON.stringify(r));
        } catch (e) {
          setOut(String(e.message || e));
        }
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("button", { style: btn, onClick: () => void run("rebuild") }, t("maintenance.rebuild")),
          h("button", { style: btn, onClick: () => void run("decay") }, t("maintenance.decay")),
          h("button", { style: btn, onClick: () => void run("cleantrash") }, t("maintenance.cleantrash")),
        ),
        out ? h("pre", { style: { fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.8 } }, out) : null,
      );
    }

    function Panel(props) {
      const t = props?.t ?? makeT(STR.language);
      const [tab, setTab] = React.useState("overview");
      const [stats, setStats] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        api("/stats").then((s) => { if (alive) setStats(s); }).catch(() => {});
        return () => { alive = false; };
      }, [tab]);
      const Tabs = h("div", { style: { display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" } },
        ["overview", "browse", "review", "maintenance"].map((k) =>
          h("button", {
            key: k,
            style: { ...btn, fontWeight: tab === k ? 600 : 400, borderColor: tab === k ? "rgba(56,189,248,.8)" : "rgba(127,127,127,.35)" },
            onClick: () => setTab(k),
          }, t("tabs." + k)),
        ),
      );
      const body =
        tab === "overview" ? h(Overview, { stats, t }) :
        tab === "browse" ? h(Browse, { t }) :
        tab === "review" ? h(Review, { t }) :
        h(Maintenance, { t });
      return h("div", { style: { padding: "4px 2px", fontSize: 13 } }, Tabs, body);
    }

    function apply(ctx) {
      ctx.effect(() => {
        try {
          ctx.locale?.register?.(NS, { zh: STR.zh, en: STR.en });
        } catch { /* ignore */ }
        return ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "dsh-memory", order: 80, label: () => makeT(STR.language)("nav"), locale: NS },
            Panel,
          ),
        );
      }, "dsh-memory-settings");
    }

    return { inject: ["slots", "locale"], apply };
  },
});