// 模块级回归：配置迁移、路径优先级、模型降级、service 白名单
// 运行：node test/modules.test.mjs
import { strict as A } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS, SCHEMA_VERSION, loadConfig, saveConfig, resolveApiKey, maskKey, configPath } from "../src/config.js";
import { resolveRoot, modelDir, legacyRoots } from "../src/paths.js";
import { ensureModel, modelStatus } from "../src/model.js";
import { attachService, __internal } from "../src/service.js";

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};
const tmp = () => mkdtempSync(join(tmpdir(), "dshmem-mod-"));

// ---- 配置 ----
{
  const root = tmp();
  ok("首启自动生成 config.json 且 schema=2", () => {
    const { config } = loadConfig(root);
    A.equal(config.schema_version, SCHEMA_VERSION);
    A.equal(config.gate, "assist");
    A.ok(existsSync(configPath(root)));
  });
  ok("load→save→load 幂等", () => {
    const before = loadConfig(root).config;
    saveConfig(root, { hits: 9 });
    const after = loadConfig(root).config;
    A.equal(after.hits, 9);
    A.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    saveConfig(root, { hits: 6 });
  });
  ok("v1 配置迁移：补默认键、保留用户键、回写版本号", () => {
    const r2 = tmp();
    writeFileSync(configPath(r2), JSON.stringify({ gate: "enforce", hits: 3, myCustom: 1 }), "utf8");
    const { config, warnings } = loadConfig(r2);
    A.equal(config.schema_version, 2);
    A.equal(config.gate, "assist"); // enforce 并入 assist
    A.equal(config.hits, 3);
    A.equal(config.myCustom, 1);
    A.ok(warnings.length > 0);
    const onDisk = JSON.parse(readFileSync(configPath(r2), "utf8"));
    A.equal(onDisk.schema_version, 2, "迁移结果应回写");
  });
  ok("坏 JSON 回退默认且备份 .bad", () => {
    const r3 = tmp();
    writeFileSync(configPath(r3), "{not json", "utf8");
    const { config, warnings } = loadConfig(r3);
    A.equal(config.schema_version, SCHEMA_VERSION);
    A.ok(warnings.some((w) => w.includes("解析失败")));
    A.ok(existsSync(configPath(r3) + ".bad"));
    rmSync(r3, { recursive: true, force: true });
  });
  ok("resolveApiKey：env 优先于文件", () => {
    A.equal(resolveApiKey({ extractor: { apiKey: "from-file" } }, { DSH_MEMORY_API_KEY: "from-env" }).source, "env");
    A.equal(resolveApiKey({ extractor: { apiKey: "from-file" } }, {}).source, "file");
    A.equal(resolveApiKey({ extractor: {} }, {}).source, null);
  });
  ok("maskKey 不泄露完整 key", () => {
    const masked = maskKey("sk-1234567890abcdef");
    A.ok(!masked.includes("567890"));
    A.ok(masked.includes("…"));
  });
  rmSync(root, { recursive: true, force: true });
}

// ---- 路径 ----
{
  ok("resolveRoot：override > env > 家目录", () => {
    A.equal(resolveRoot({ env: { DSH_MEMORY_ROOT: "/tmp/a" }, home: "/home/u" }), resolveRoot({ override: "/tmp/a" }));
    A.ok(resolveRoot({ env: {}, home: "/home/u" }).endsWith(join(".dsh-memory")));
    A.ok(resolveRoot({ env: { DSH_MEMORY_ROOT: "/tmp/x" }, home: "/home/u", override: "/tmp/y" }).includes("y"));
  });
  ok("modelDir 拼接", () => {
    A.ok(modelDir("/r").endsWith(join("models", "Xenova", "bge-small-zh-v1.5")));
  });
  ok("legacyRoots 非 win32 为空", () => {
    if (process.platform !== "win32") A.deepEqual(legacyRoots("/tmp/cur"), []);
  });
  ok("ensureModel 禁下载时返回 ready:false 不抛", async () => {
    const dir = join(tmp(), "m");
    const r = await ensureModel({ dir, download: false });
    A.equal(r.ready, false);
    A.equal(modelStatus(dir).present, false);
  });
}

// ---- service 白名单 ----
{
  ok("attachService：只暴露允许的方法，无编辑原文入口", () => {
    const db = { prepare: () => ({ get: () => ({ n: 0 }), all: () => [] }) };
    const store = { db, embedder: { ready: false }, budgetState: () => ({ used: 0, limit: 20 }) };
    const ctx = { get: () => null, provide: () => {}, connection: null };
    const svc = attachService(ctx, store, { root: "/tmp/r", loadConfig: () => DEFAULTS, saveConfig: () => ({}), maskKey: (k) => k });
    const names = Object.keys(svc);
    A.ok(names.includes("list"));
    A.ok(names.includes("approve"));
    A.ok(!names.includes("edit"));
    A.ok(!names.includes("updateFact"));
  });
}

{
  ok("设置面板配置项：必须先改项在最前", () => {
    const schema = __internal.CONFIG_SCHEMA;
    A.equal(schema[0].group, "先改这几项");
    const essentials = schema.filter((f) => f.group === "先改这几项").map((f) => f.key);
    A.ok(essentials.includes("root"));
    A.ok(essentials.includes("extractor.enabled"));
    A.ok(essentials.includes("extractor.apiKey"));
    A.ok(schema.findIndex((f) => f.group !== "先改这几项") >= essentials.length, "先改项必须连续排在最前");
  });
  ok("每个配置项都有中文说明（悬停提示）", () => {
    A.ok(__internal.CONFIG_SCHEMA.every((f) => typeof f.desc === "string" && f.desc.trim().length >= 4));
  });
}

console.log(`${pass} passed, exitCode=${process.exitCode ?? 0}`);
process.exit(process.exitCode ?? 0);