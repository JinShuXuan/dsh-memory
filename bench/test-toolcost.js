/**
 * test-toolcost.js —— 常驻工具面开销回归：name + description 字节数。
 * 主扫 tool-glue.js 的 GROUPS（memory_error / memory_skill），再扫 index.js 里真正 register({...})
 * 的合并工具；collect({...}) 的细粒度定义不进常驻 schema，不计。同名以后出现的为准。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// 阈值按 2026-11-11 实测上浮写死；超了说明描述又变长，需要复核是否值得常驻
const LIMIT_TOTAL = 2800;
const LIMIT_EACH = 260;
const LIMIT_GLUE_SUM = 300;

const PATTERN = /name:\s*"(memory_[a-z_]+)",\s*\n\s*description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g;

const scan = (file, onlyRegistered = false) => {
  const text = readFileSync(join(ROOT, file), "utf8");
  const hits = [];
  for (const m of text.matchAll(PATTERN)) {
    if (onlyRegistered) {
      // 往前找最近一次 register( / collect( 调用，只保留 register 的（collect 是折叠进合并工具的低频 def）
      const before = text.slice(0, m.index);
      const lastRegister = before.lastIndexOf("register({");
      const lastCollect = before.lastIndexOf("collect({");
      if (lastCollect > lastRegister) continue;
    }
    hits.push({ file, name: m[1], desc: m[2] });
  }
  return hits;
};

const merged = new Map();
for (const hit of [...scan("tool-glue.js"), ...scan("index.js", true)]) merged.set(hit.name, hit);

let pass = 0;
let fail = 0;
const check = (ok, label) => {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};

const bytes = (s) => Buffer.byteLength(String(s), "utf8");
const rows = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
let total = 0;
let glueSum = 0;
for (const row of rows) {
  const n = bytes(row.name) + bytes(row.desc);
  total += n;
  if (row.file === "tool-glue.js") glueSum += n;
  console.log(`  ${String(n).padStart(4)}B  ${row.name.padEnd(16)} ${row.file}`);
}

console.log(`  合计 ${rows.length} 个常驻工具 / ${total}B（阈值 ${LIMIT_TOTAL}B）`);
check(rows.length >= 8 && rows.length <= 12, `常驻工具数 ${rows.length} 在 8..12`);
check(total <= LIMIT_TOTAL, `总字节 ${total} <= ${LIMIT_TOTAL}`);
check(glueSum <= LIMIT_GLUE_SUM, `tool-glue 两工具合计 ${glueSum}B <= ${LIMIT_GLUE_SUM}`);
for (const row of rows) {
  if (row.file === "tool-glue.js") check(bytes(row.desc) <= LIMIT_EACH, `${row.name} description ${bytes(row.desc)}B <= ${LIMIT_EACH}`);
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);