// DSH 设置页 · 记忆库面板（React，无 JSX，无需构建）
// 宿主按 package.json 的 exports["./client"] + dsh.client 加载本文件。
// 界面默认中文；不依赖宿主 locale 键（宿主只提供 meta），所有文案内联在 STR.zh。
window.__ModuleLoader__.load({
  id: "@jinshuxuan/dsh-memory",
  factory: (require) => {
    // 宿主既可能用 factory 返回值，也可能读 module.exports；两边都写，避免导出为空导致面板静默消失。
    const module = { exports: {} };
    const React = require("react");
    const h = React.createElement;
    const NS = "dsh-memory";
    const API = "/api/memory";

    const STR = {
      zh: {
        nav: "记忆库",
        tabs: { config: "配置", overview: "概览", browse: "浏览", review: "审批", maintenance: "维护" },
        common: {
          refresh: "刷新", loading: "加载中…", empty: "没有数据", save: "保存", saving: "保存中…",
          saved: "已保存", cancel: "取消", confirm: "确认执行？", failed: "失败", retry: "重试",
          restart: "需要重启 DSH 才生效", choose: "选择目录", open: "打开目录", chooseExport: "选择导出位置",
          export: "导出", exporting: "导出中…", close: "关闭",
        },
        config: {
          lead: "先改这几项",
          hint: "带 ⓘ 的项鼠标悬停可看说明；改完点「保存」。",
          keySet: "已填写（只显示尾号）",
          keyEmpty: "未填写",
        },
        overview: {
          active: "活跃记忆", vectors: "向量", links: "关联边", pending: "待审", trash: "回收站", total: "总计",
          gate: "注入闸门", embedder: "向量模型", ready: "就绪", degraded: "降级为纯 FTS",
          spend: "本月花费", llmOn: "LLM 抽取：已开启", llmOff: "LLM 抽取：未开启（默认）",
          llmIntro: "LLM 抽取默认关闭：只用规则与检索，零花费。到「配置」里填 API Key 并打开开关后，才会自动从对话抽取事实；每次调用约 0.005 元，每月上限 20 元，超了自动退回纯本地规则。",
        },
        browse: { search: "搜索内容 / 主语 / 谓词", status: "状态", all: "全部", active: "活跃", archived: "已归档", deleted: "已删除", del: "删除", restore: "恢复", total: "共 {n} 条" },
        review: { approve: "通过", reject: "驳回" },
        maintenance: { rebuild: "重建索引", decay: "执行遗忘扫描", cleantrash: "清理回收站（30 天前）", done: "完成", result: "结果", exportDone: "已导出 {n} 条到 {path}" },
      },
    };

    function makeT(lang) {
      const dict = STR[lang] ?? STR.zh;
      return (key, vars) => {
        let s = key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict) ?? key;
        if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
        return s;
      };
    }
    const t = makeT("zh");

    async function api(path, method = "GET", body) {
      const res = await fetch(API + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || `请求失败（HTTP ${res.status}）`);
      return json.data;
    }

    const card = { border: "1px solid rgba(127,127,127,.25)", borderRadius: 10, padding: "10px 12px", minWidth: 96 };
    const btn = { padding: "4px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,.35)", cursor: "pointer", background: "transparent", color: "inherit", fontSize: 13 };
    const input = { padding: "5px 9px", borderRadius: 8, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", fontSize: 13, minWidth: 180 };
    const rowStyle = { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(127,127,127,.12)" };
    const fieldWrap = { display: "flex", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(127,127,127,.12)" };

    function getPath(obj, key) {
      return String(key).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
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

    function Label({ field }) {
      return h("div", { style: { minWidth: 150, fontSize: 13 } },
        h("span", null, field.label),
        h("span", { title: field.desc, style: { marginLeft: 6, opacity: 0.55, cursor: "help" } }, "ⓘ"),
      );
    }

    function Field({ field, value, onChange, onPick, onOpen }) {
      const common = { style: input };
      let control;
      if (field.type === "bool") {
        control = h("input", { type: "checkbox", checked: Boolean(value), onChange: (e) => onChange(field.key, e.target.checked) });
      } else if (field.type === "select") {
        control = h("select", { value: value ?? "", onChange: (e) => onChange(field.key, e.target.value), style: input },
          (field.options || []).map((o) => h("option", { key: o, value: o }, o)),
        );
      } else if (field.type === "secret") {
        control = h("input", { ...common, type: "password", value: value ?? "", placeholder: t("config.keyEmpty"), onChange: (e) => onChange(field.key, e.target.value) });
      } else {
        control = h("input", { ...common, type: field.type === "number" ? "number" : "text", value: value ?? "", onChange: (e) => onChange(field.key, field.type === "number" ? Number(e.target.value) : e.target.value) });
      }
      return h("div", { style: fieldWrap },
        h(Label, { field }),
        h("div", { style: { flex: 1, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          control,
          field.type === "dir" ? h("button", { style: btn, onClick: () => onPick(field.key) }, t("common.choose")) : null,
          field.type === "dir" ? h("button", { style: btn, onClick: () => onOpen(value) }, t("common.open")) : null,
          field.key === "extractor.apiKey" && value ? h("span", { style: { fontSize: 11, opacity: 0.6 } }, t("config.keySet")) : null,
        ),
      );
    }

    function Config({ t }) {
      const [data, setData] = React.useState(null);
      const [draft, setDraft] = React.useState({});
      const [msg, setMsg] = React.useState("");
      const [restart, setRestart] = React.useState(false);
      const load = React.useCallback(async () => {
        try {
          const d = await api("/config");
          setData(d);
          setDraft(d.config);
        } catch (e) {
          setMsg(String(e.message || e));
        }
      }, []);
      React.useEffect(() => { void load(); }, [load]);
      if (!data) return h("div", null, t("common.loading"));
      const groups = [];
      for (const f of data.schema) {
        let g = groups.find((x) => x.name === f.group);
        if (!g) { g = { name: f.group, items: [] }; groups.push(g); }
        g.items.push(f);
      }
      const onChange = (key, value) => setDraft((prev) => setPath(JSON.parse(JSON.stringify(prev)), key, value));
      const save = async () => {
        setMsg(t("common.saving"));
        try {
          const patch = {};
          for (const f of data.schema) setPath(patch, f.key, getPath(draft, f.key));
          const r = await api("/config", "POST", patch);
          setDraft(r.data.config);
          setRestart(Boolean(r.data.restartRequired));
          setMsg(t("common.saved") + (r.data.restartRequired ? " · " + t("common.restart") : ""));
        } catch (e) {
          setMsg(t("common.failed") + "：" + String(e.message || e));
        }
      };
      const pick = async (key) => {
        try {
          const r = await api("/dialog/dir", "POST", {});
          if (r.ok && r.path) onChange(key, r.path);
          else if (r.code !== "CANCELLED") setMsg(t("common.failed") + "：" + (r.code || ""));
        } catch (e) {
          setMsg(String(e.message || e));
        }
      };
      const open = async (path) => {
        try {
          const r = await api("/open", "POST", { path: path || getPath(draft, "root") });
          if (r.ok === false) setMsg(t("common.failed") + "：" + (r.code || ""));
        } catch (e) {
          setMsg(String(e.message || e));
        }
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
        h("div", { style: { fontSize: 12, opacity: 0.7 } }, t("config.hint")),
        groups.map((g) => h("div", { key: g.name, style: { ...card, padding: "8px 12px" } },
          h("div", { style: { fontSize: 13, fontWeight: 600, margin: "4px 0", opacity: 0.9 } }, g.name),
          g.items.map((f) => h(Field, { key: f.key, field: f, value: getPath(draft, f.key), onChange, onPick: pick, onOpen: open })),
        )),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("button", { style: { ...btn, fontWeight: 600 }, onClick: () => void save() }, t("common.save")),
          h("button", { style: btn, onClick: () => void load() }, t("common.refresh")),
          msg ? h("span", { style: { fontSize: 12, opacity: 0.75 } }, msg) : null,
        ),
        restart ? h("div", { style: { fontSize: 12, color: "#f5a524" } }, t("common.restart")) : null,
      );
    }

    function Overview({ stats, t }) {
      if (!stats) return h("div", null, t("common.loading"));
      const c = stats.counts || {};
      const Cell = ({ label, value }) => h("div", { style: card },
        h("div", { style: { opacity: 0.6, fontSize: 12 } }, label),
        h("div", { style: { fontSize: 20, fontWeight: 600 } }, String(value)));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h(Cell, { label: t("overview.active"), value: c.active ?? 0 }),
          h(Cell, { label: t("overview.vectors"), value: c.vectors ?? 0 }),
          h(Cell, { label: t("overview.links"), value: c.links ?? 0 }),
          h(Cell, { label: t("overview.pending"), value: c.pending ?? 0 }),
          h(Cell, { label: t("overview.trash"), value: c.trash ?? 0 }),
          h(Cell, { label: t("overview.total"), value: c.total ?? 0 }),
        ),
        h("div", { style: { fontSize: 13, lineHeight: 1.7 } },
          h("div", null, `${t("overview.gate")}：${stats.gate} · ${t("overview.embedder")}：${stats.embedder?.ready ? t("overview.ready") : t("overview.degraded")}`),
          stats.budget ? h("div", null, `${t("overview.spend")}：¥${Number(stats.budget.used ?? 0).toFixed(3)} / ¥${Number(stats.budget.limit ?? 0).toFixed(0)}`) : null,
          h("div", null, stats.llm?.enabled ? t("overview.llmOn") : t("overview.llmOff")),
          h("div", { style: { fontSize: 12, opacity: 0.7, wordBreak: "break-all" } }, `数据目录：${stats.root}`),
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
        try { setData(await api("/list", "POST", { query, status, limit: 50 })); }
        catch (e) { setError(String(e.message || e)); }
      }, [query, status]);
      React.useEffect(() => { void load(); }, [load]);
      const act = async (path, id) => {
        try { await api(path, "POST", { id }); } catch (e) { setError(String(e.message || e)); }
        await load();
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", { value: query, placeholder: t("browse.search"), onChange: (e) => setQuery(e.target.value), style: { ...input, flex: 1 } }),
          h("select", { value: status, onChange: (e) => setStatus(e.target.value), style: input },
            ["active", "archived", "deleted", "all"].map((s) => h("option", { key: s, value: s }, t("browse." + s)))),
          h("button", { style: btn, onClick: () => void load() }, t("common.refresh")),
        ),
        error ? h("div", { style: { color: "#e5484d", fontSize: 12 } }, error) : null,
        !data ? h("div", null, t("common.loading"))
          : data.items.length === 0 ? h("div", { style: { opacity: 0.6 } }, t("common.empty"))
          : h("div", null,
            h("div", { style: { fontSize: 12, opacity: 0.6, padding: "4px 0" } }, t("browse.total", { n: data.total })),
            data.items.map((it) => h("div", { key: it.id, style: rowStyle },
              h("code", { style: { fontSize: 11, opacity: 0.65, minWidth: 52 } }, it.short_id),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.value),
                h("div", { style: { fontSize: 11, opacity: 0.55 } }, `${it.subject} · ${it.predicate} · ${it.status}`)),
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
      const act = async (path, id) => {
        try { await api(path, "POST", { id }); } catch (e) { setError(String(e.message || e)); }
        await load();
      };
      if (error) return h("div", { style: { color: "#e5484d" } }, error);
      if (!items) return h("div", null, t("common.loading"));
      if (items.length === 0) return h("div", { style: { opacity: 0.6 } }, t("common.empty"));
      return h("div", null, items.map((p) => h("div", { key: p.id, style: rowStyle },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 13 } }, String(p.candidate?.value ?? "").slice(0, 160)),
          h("div", { style: { fontSize: 11, opacity: 0.55 } }, `${p.reason} · ${p.candidate?.subject ?? ""}/${p.candidate?.predicate ?? ""}`)),
        h("button", { style: btn, onClick: () => act("/approve", p.id) }, t("review.approve")),
        h("button", { style: btn, onClick: () => act("/reject", p.id) }, t("review.reject")),
      )));
    }

    function Maintenance({ t }) {
      const [out, setOut] = React.useState("");
      const run = async (action) => {
        if (!window.confirm(t("common.confirm"))) return;
        try { setOut(JSON.stringify(await api("/maintenance", "POST", { action }))); }
        catch (e) { setOut(String(e.message || e)); }
      };
      const exportTo = async () => {
        try {
          const picked = await api("/dialog/export", "POST", { name: `memory-${new Date().toISOString().slice(0, 10)}.jsonl` });
          if (!picked.ok) {
            if (picked.code !== "CANCELLED") setOut(t("common.failed") + "：" + picked.code);
            return;
          }
          const r = await api("/export", "POST", { path: picked.path });
          setOut(t("maintenance.exportDone", { n: r.count, path: r.path }));
        } catch (e) { setOut(String(e.message || e)); }
      };
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("button", { style: btn, onClick: () => void run("rebuild") }, t("maintenance.rebuild")),
          h("button", { style: btn, onClick: () => void run("decay") }, t("maintenance.decay")),
          h("button", { style: btn, onClick: () => void run("cleantrash") }, t("maintenance.cleantrash")),
          h("button", { style: btn, onClick: () => void exportTo() }, t("common.export")),
        ),
        out ? h("pre", { style: { fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.8 } }, out) : null,
      );
    }

    function Panel() {
      const [tab, setTab] = React.useState("config");
      const [stats, setStats] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        api("/stats").then((s) => { if (alive) setStats(s); }).catch(() => {});
        return () => { alive = false; };
      }, [tab]);
      const tabs = h("div", { style: { display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" } },
        ["config", "overview", "browse", "review", "maintenance"].map((k) =>
          h("button", {
            key: k,
            style: { ...btn, fontWeight: tab === k ? 600 : 400, borderColor: tab === k ? "rgba(56,189,248,.8)" : "rgba(127,127,127,.35)" },
            onClick: () => setTab(k),
          }, t("tabs." + k))));
      const body = tab === "config" ? h(Config, { t })
        : tab === "overview" ? h(Overview, { stats, t })
        : tab === "browse" ? h(Browse, { t })
        : tab === "review" ? h(Review, { t })
        : h(Maintenance, { t });
      return h("div", { style: { padding: "4px 2px", fontSize: 13 } }, tabs, body);
    }

    function apply(ctx) {
      ctx.effect(() => {
        try { ctx.locale?.register?.(NS, { zh: { meta: { title: STR.zh.nav, description: "本地长期记忆" } } }); } catch { /* ignore */ }
        const disposers = [];
        // 同时挂两个入口：设置页分区 + 侧边栏面板。哪个存在就出现在哪，互不影响。
        const mount = (slot) => {
          try {
            disposers.push(
              ctx.slots.inject(slot, () =>
                ctx.slots.register(
                  { name: slot, id: "dsh-memory", order: 30, label: () => STR.zh.nav, locale: NS },
                  Panel,
                ),
              ),
            );
          } catch (error) {
            // 该 slot 在此版本不存在时静默跳过
          }
        };
        mount("settings.section");
        mount("sidebar.panellist");
        return () => {
          for (const d of disposers) {
            try { d?.(); } catch { /* ignore */ }
          }
        };
      }, "dsh-memory-settings");
    }

    module.exports = { inject: ["slots", "locale"], apply };
    return module.exports;
  },
});