// 宿主路由层冒烟：验证 src/service.js 用 ctx.webServer.register({kind:"exact",path,handler})
// 挂出 /api/dsh-memory/*，且 handler 是 Node 风格的 (req,res)。
// 这套断言就是 2026-11-11 那次「UI 全 404」的回归防线。
import assert from "node:assert/strict";
import { attachService } from "../src/service.js";

const routes = new Map();
const webServer = {
  register(route) {
    if (!route || typeof route.path !== "string" || typeof route.handler !== "function") {
      throw new Error("route 形状不对：需要 {kind:'exact',path,handler}");
    }
    if (route.kind !== "exact") throw new Error("只支持 kind:'exact'");
    if (!route.path.startsWith("/")) throw new Error("path 必须以 / 开头");
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
};

const ctx = {
  get: (name) => (name === "webServer" ? webServer : undefined),
  inject: () => {},
};
const api = { root: process.cwd(), log: () => {}, loadConfig: () => ({ lane: "test" }), maskKey: (k) => k };
const store = null; // 需要 store 的接口会在 handler 里抛错 → 断言 500 信封，不静默

attachService(ctx, store, api);

// ── 1. 注册了什么 ─────────────────────────────────────────────────────────
const PREFIX = "/api/dsh-memory";
for (const path of ["/ui", "/stats", "/list", "/pending", "/approve", "/reject", "/delete", "/restore", "/maintenance", "/config", "/diag", "/browse", "/pin", "/open", "/export"]) {
  assert.ok(routes.has(PREFIX + path), `缺少路由 ${PREFIX}${path}`);
}
// 客户端实际会 fetch 的路径必须在服务端存在（两侧契约对齐）
for (const path of ["/stats", "/list", "/pending", "/browse", "/pin", "/config", "/dialog/dir", "/dialog/export", "/export", "/maintenance"]) {
  assert.ok(routes.has(PREFIX + path), `客户端调用的 ${path} 服务端未注册`);
}
assert.ok(![...routes.keys()].some((p) => p.startsWith("/api/jinshuxuan")), "不应再注册旧的 scope 前缀");
assert.ok(![...routes.keys()].some((p) => p.startsWith("/memory-api")), "不应再注册 /memory-api");

// ── 2. handler：假 req/res ────────────────────────────────────────────────
function fakeReq(method, body) {
  const listeners = {};
  const req = {
    method,
    on(evt, fn) {
      (listeners[evt] ||= []).push(fn);
      return req;
    },
    destroy() {},
  };
  setImmediate(() => {
    if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
    (listeners.end || []).forEach((fn) => fn());
  });
  return req;
}
function fakeRes() {
  const out = {};
  return {
    status: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = String(chunk ?? "");
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

const uiRes = fakeRes();
await routes.get(PREFIX + "/ui").handler(fakeReq("GET"), uiRes);
assert.equal(uiRes.status, 200);
assert.match(uiRes.headers["content-type"], /text\/html/);
assert.match(uiRes.body, /<html/i, "UI 页面没吐 HTML");
// 独立页里的前端 API 前缀必须和宿主挂载前缀一致（曾因两者漂移导致页面全 401）
assert.match(uiRes.body, /API_BASES = \["\/api\/dsh-memory"\]/, "ui.html 的 API_BASES 与挂载前缀不一致");
assert.ok(!uiRes.body.includes("/api/jinshuxuan/dsh-memory"), "ui.html 仍残留旧的 scope 前缀");

// GET /config 走 api.loadConfig，不需要 store → 必须 200 + {ok:true,data}
const cfgRes = fakeRes();
await routes.get(PREFIX + "/config").handler(fakeReq("GET"), cfgRes);
assert.equal(cfgRes.status, 200, "GET /config 应为 200");
assert.equal(cfgRes.json.ok, true, "GET /config 应返回 ok:true 信封");
assert.equal(typeof cfgRes.json.data, "object", "GET /config data 应为配置对象");

// 方法不匹配 → 405（/diag 只挂 GET）
const badRes = fakeRes();
await routes.get(PREFIX + "/diag").handler(fakeReq("POST", "{}"), badRes);
assert.equal(badRes.status, 405);

// POST 体解析：坏 JSON → 500 且信封 ok:false
const badJson = fakeRes();
await routes.get(PREFIX + "/browse").handler(fakeReq("POST", "{not json"), badJson);
assert.equal(badJson.status, 500);
assert.equal(badJson.json.ok, false);
assert.match(badJson.json.message, /invalid JSON body/);

// 需要 store 的接口在缺 store 时兜成 500 信封，不能挂死或吐非 JSON
const diagRes = fakeRes();
await routes.get(PREFIX + "/diag").handler(fakeReq("GET"), diagRes);
assert.equal(diagRes.status, 500);
assert.equal(diagRes.json.ok, false);
assert.match(diagRes.headers["content-type"], /application\/json/);

console.log(`PASS routes smoke: ${routes.size} routes on ${PREFIX}, ${PREFIX}/ui 吐 HTML, 405 / 坏 JSON 500 / 缺 store 兜底均正常`);