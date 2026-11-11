// 冒烟测试：不引任何依赖，用极简 React 替身把 client/index.js 的挂载函数渲染一遍。
// 覆盖：模块加载形状、三个槽位各 inject 一次、正常数据渲染不抛、401 时渲染树含 401 与 base。
import assert from "node:assert/strict";

let failures = 0;
const fail = (msg, err) => {
  failures += 1;
  console.error("FAIL:", msg, err ? `\n  ${err?.stack || err}` : "");
};

// ── 极简 React 替身 ────────────────────────────────────────────────────────
let current = null;
let pendingEffects = [];

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) };
}

function useState(init) {
  const inst = current;
  const i = inst.idx++;
  if (!(i in inst.hooks)) {
    inst.hooks[i] = { value: typeof init === "function" ? init() : init };
  }
  const cell = inst.hooks[i];
  const set = (next) => {
    const value = typeof next === "function" ? next(cell.value) : next;
    if (!Object.is(value, cell.value)) {
      cell.value = value;
      inst.dirty = true;
    }
  };
  return [cell.value, set];
}

function useCallback(fn, deps) {
  const inst = current;
  const i = inst.idx++;
  const cell = inst.hooks[i];
  if (cell && sameDeps(cell.deps, deps)) return cell.fn;
  inst.hooks[i] = { fn, deps };
  return fn;
}

function useEffect(fn, deps) {
  const inst = current;
  const i = inst.idx++;
  const cell = inst.hooks[i];
  if (cell && sameDeps(cell.deps, deps)) return;
  inst.hooks[i] = { deps };
  pendingEffects.push({ inst, fn });
}

const miniReact = { createElement, useState, useEffect, useCallback, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), Fragment: "fragment" };

// 渲染树：函数组件挂到按路径定位的实例上，钩子状态跨轮存活。
const instances = new Map();

function getInst(path) {
  let inst = instances.get(path);
  if (!inst) {
    inst = { hooks: [], idx: 0, dirty: false };
    instances.set(path, inst);
  }
  return inst;
}

function instantiate(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child, i) => instantiate(child, `${path}.${i}`));
  if (typeof node !== "object" || !node.type) return null;

  const { type, props, children } = node;
  if (typeof type === "function") {
    const inst = getInst(path);
    inst.idx = 0;
    const passed = { ...(props || {}) };
    if (children.length === 1) passed.children = children[0];
    else if (children.length > 1) passed.children = children;
    const prev = current;
    current = inst;
    let out;
    try {
      out = type(passed);
    } finally {
      current = prev;
    }
    return instantiate(out, `${path}/out`);
  }
  return { tag: type, props, children: instantiate(children, `${path}/c`) };
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 有界重渲染：最多 8 轮，直到没有组件再标脏。effect 的异步拒绝必须冒泡，不能被吞掉。 */
async function settle(Component, props = {}) {
  let tree = null;
  for (let round = 0; round < 8; round += 1) {
    for (const inst of instances.values()) inst.dirty = false;
    pendingEffects = [];
    tree = instantiate(createElement(Component, props), "$root");
    const promises = [];
    const rejected = [];
    for (const { fn } of pendingEffects) {
      const out = fn();
      if (out && typeof out.then === "function") promises.push(out.catch((err) => rejected.push(err)));
    }
    await Promise.all(promises);
    await sleep();
    await sleep();
    if (rejected.length) throw rejected[0];
    if (![...instances.values()].some((inst) => inst.dirty)) break;
  }
  return tree;
}

/** 先渲染；opts.interact(tree, rerender) 可在树上触发交互后再渲染一轮（组件状态保留）。 */
async function renderRoot(Component, props = {}, opts = {}) {
  instances.clear();
  let tree = await settle(Component, props);
  if (typeof opts.interact === "function") {
    const rerender = () => settle(Component, props);
    await opts.interact(tree, rerender);
    tree = await rerender();
  }
  return tree;
}

function texts(node, acc = []) {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, acc);
    return acc;
  }
  if (typeof node === "object" && node.tag) {
    const p = node.props || {};
    for (const key of ["title", "placeholder", "aria-label"]) if (typeof p[key] === "string") acc.push(p[key]);
    texts(node.children, acc);
  }
  return acc;
}
const flatText = (tree) => texts(tree).join(" ");

/** 收集渲染树里的 host <button>，用于模拟点击。 */
function buttons(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, acc);
    return acc;
  }
  if (node.tag === "button") acc.push(node);
  if (node.children) buttons(node.children, acc);
  return acc;
}
const buttonText = (b) => flatText(b.children || []).trim();

// ── 假 fetch ───────────────────────────────────────────────────────────────
const BASE0 = "/api/dsh-memory";
const STATS = {
  root: "D:\\memory",
  gate: "assist",
  embedder: { ready: true, dim: 1024 },
  counts: { active: 7, staged: 0, archived: 0, deleted: 0, superseded: 0, total: 7, vectors: 5, links: 2, pending: 0, trash: 0 },
  budget: {},
  llm: { enabled: false },
  subjects: [{ subject: "user", count: 4 }, { subject: "dsh", count: 3 }],
  modes: { fact: 5, decision: 2 },
};
const DIAG = {
  ok: true,
  version: "0.3.0",
  apiPrefix: BASE0,
  mount: { mounted: true, prefix: BASE0, routes: 31, failures: [], at: "2026-11-11T06:10:00.000Z", reason: "已挂载 31 条路由" },
  counts: { active: 7, staged: 0, archive: 0, errors: 0, edges: 2 },
  channels: { fts: true, vec: true },
  subjects: [{ subject: "user", count: 4 }],
  logTail: ["[memory] ready"],
  client: { declared: true, slots: ["settings.section", "sidebar.pannellist"] },
};

let mode401 = false;
const posts = [];
const fakeFetch = async (url, init = {}) => {
  const path = String(url);
  const method = String(init?.method || "GET").toUpperCase();
  if (method === "POST") {
    let body = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = String(init?.body);
    }
    posts.push({ path, body });
  }
  if (mode401) return { ok: false, status: 401, json: async () => ({ ok: false, message: "unauthorized" }) };
  if (path.endsWith("/diag")) return { ok: true, status: 200, json: async () => ({ ok: true, data: DIAG }) };
  if (path.endsWith("/stats")) return { ok: true, status: 200, json: async () => ({ ok: true, data: STATS }) };
  if (path.endsWith("/browse")) return { ok: true, status: 200, json: async () => ({ ok: true, data: { mode: "facts", total: 1, rows: [{ id: "abcdef12345", subject: "user", predicate: "likes", value: "鱼", pinned: 0, short_id: "#12345" }] } }) };
  if (path.endsWith("/pending")) return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
  if (path.endsWith("/config")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          config: { root: "D:\\memory", extractor: { enabled: true, apiKey: "sk-…abcd" } },
          schema: [
            { group: "基础", key: "root", type: "dir", label: "记忆库路径" },
            { group: "抽取", key: "extractor.apiKey", type: "secret", label: "API Key" },
            { group: "抽取", key: "extractor.enabled", type: "bool", label: "启用抽取" },
          ],
          skipped: ["extractor.apiKey"],
          restartRequired: false,
        },
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, message: "not found" }) };
};
globalThis.fetch = fakeFetch;

// ── 加载模块 ───────────────────────────────────────────────────────────────
function installWindow() {
  const holder = { confirm: () => true, location: { origin: "http://127.0.0.1:1" } };
  let captured = null;
  holder.__ModuleLoader__ = { load(def) { captured = def; } };
  globalThis.window = holder;
  return () => captured;
}

async function loadClient(tag) {
  const getDef = installWindow();
  const mod = await import(`../client/index.js?case=${tag}`);
  assert.ok(mod, "client/index.js 没有导出");
  const def = getDef();
  assert.ok(def, "client/index.js 没有调用 window.__ModuleLoader__.load");
  assert.equal(def.id, "@jinshuxuan/dsh-memory", "loader id 不对");
  return def;
}

function mountNames(def) {
  const require = (name) => {
    if (name === "react") return miniReact;
    throw new Error(`未知模块 ${name}`);
  };
  const exportsObj = def.factory(require);
  const regs = [];
  const ctx = {
    slots: {
      inject(name, fn) {
        regs.push({ name, fn });
        return () => {};
      },
      register(spec, Comp) {
        return Comp;
      },
    },
    locale: { register() {} },
    effect(fn) {
      fn();
    },
  };
  exportsObj.apply(ctx);
  return { exportsObj, regs };
}

const slotNames = (regs) => regs.map((r) => r.name);

async function main() {
  // ① 加载形状
  const def = await loadClient("ok");
  const { exportsObj, regs } = mountNames(def);
  assert.deepEqual(exportsObj.inject, ["slots", "locale"], "inject 数组应为 [slots, locale]");
  assert.deepEqual(slotNames(regs), ["settings.section", "sidebar.pannellist", "main"], "三个槽位应各注册一次");
  assert.equal(regs.length, 3, "槽位注册数应为 3");

  // ② 正常数据渲染：设置页 + 侧边栏，各自拿到组件并渲染，不应抛错
  const settingsComp = regs[0].fn();
  assert.equal(typeof settingsComp, "function", "settings.section 挂载函数应返回组件");
  const settingsTree = await renderRoot(settingsComp, {});
  const settingsText = flatText(settingsTree);
  assert.ok(settingsText.includes("记忆库"), "设置页标题缺失");
  assert.ok(settingsText.includes("活跃 7"), `状态条应显示活跃 7，实际：${settingsText.slice(0, 300)}`);
  assert.ok(settingsText.includes("v0.3.0"), "状态条应显示包版本");
  assert.ok(settingsText.includes("user"), "概览应显示主语分布");
  assert.ok(settingsText.includes("事实"), "概览应显示类型分布");

  const sideComp = regs[1].fn();
  const sideTree = await renderRoot(sideComp, { size: 18, active: false });
  const sideText = flatText(sideTree);
  assert.ok(sideText.includes("记忆库"), "侧边栏 title 应提示记忆库");
  assert.ok(sideText.includes("活跃 7") && sideText.includes("待审 0"), `侧边栏 badge 应显示活跃 7 / 待审 0，实际：${sideText}`);

  const mainComp = regs[2].fn();
  await renderRoot(mainComp, {});
  assert.equal(typeof mainComp, "function", "main 槽位应挂完整面板");

  // ④ 配置页：切到「配置」→ 点保存，掩码占位符不得被回传覆盖真 key
  posts.length = 0;
  await renderRoot(settingsComp, {}, {
    interact: async (tree, rerender) => {
      const tabBtn = buttons(tree).find((b) => buttonText(b) === "配置");
      assert.ok(tabBtn, "找不到「配置」页签按钮");
      tabBtn.props.onClick?.();
      const cfgTree = await rerender();
      assert.ok(flatText(cfgTree).includes("API Key"), "配置页应渲染密钥字段");
      const saveBtn = buttons(cfgTree).find((b) => buttonText(b) === "保存");
      assert.ok(saveBtn, "配置页缺少保存按钮");
      saveBtn.props.onClick?.();
      await sleep();
      await sleep();
    },
  });
  const cfgPost = posts.filter((p) => p.path.endsWith("/config")).at(-1);
  assert.ok(cfgPost, "保存配置时没有发出 POST /config");
  const bodyRaw = JSON.stringify(cfgPost.body ?? null);
  assert.ok(!bodyRaw.includes("…") && !bodyRaw.includes("***"), `POST /config 回传了掩码占位符：${bodyRaw}`);
  assert.equal(cfgPost.body?.extractor?.apiKey, undefined, "掩码 apiKey 不应写回");
  assert.equal(cfgPost.body?.root, "D:\\memory", "非密钥字段应正常回传");

  // ③ 401：换一个 ESM 实例（模块内探测缓存不共享），全 401 时必须渲染出 401 与 base
  mode401 = true;
  const def401 = await loadClient("unauthorized");
  const mount401 = mountNames(def401);
  assert.deepEqual(slotNames(mount401.regs), ["settings.section", "sidebar.pannellist", "main"], "401 场景槽位注册不一致");
  const errorComp = mount401.regs[0].fn();
  const errorTree = await renderRoot(errorComp, {});
  const errorText = flatText(errorTree);
  assert.ok(errorText.includes("401"), `401 场景渲染树应含 401，实际：${errorText.slice(0, 300)}`);
  assert.ok(errorText.includes(BASE0), "401 场景应显示实际 base");
  assert.ok(errorText.includes("重试"), "401 场景应提供重试按钮");

  console.log("PASS client smoke: 3 slots, inject deep-equal, render ok, config mask-safe, 401 banner ok");
}

try {
  await main();
} catch (err) {
  fail("冒烟测试中断", err);
}
if (failures > 0) {
  console.error(`FAILED: ${failures} 项`);
  process.exit(1);
}
console.log("PASS");