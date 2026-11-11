/**
 * skill-drafts.js — 「经验 → skill 草稿」模块（dsh-memory P1，新文件）
 *
 * 设计边界（刻意保持窄）：
 *   1. 只往 <root>/global/skills-drafts/ 写 *.md 草稿，**从不**改正式 skill
 *      （~/.dsh/skills、workspace skills 一律只读不碰）。
 *   2. 只做「生成草稿 / 成熟度推进 / 集群建议」三件事，不自动 approve、不自动建。
 *   3. 不 import index.js、不碰 db：事实列表与日志由胶水注入（api.listFacts / api.log）。
 *   4. 每个工具输出保持短，异常一律 try/catch + log，返回 {ok:false, code} 而不是抛出。
 *
 * 本包是 ESM（package.json "type":"module"），用 export 而不是 module.exports。
 *
 * 用法（由 index.js 的 apply() 里加胶水，本文件不自我注册）：
 *   const { registerSkillDrafts } = await import("./skill-drafts.js");
 *   registerSkillDrafts({ register, tools: toolCtx.tools, log, root: base, listFacts });
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveRoot } from "./src/paths.js";

const DEFAULT_ROOT = resolveRoot();
const SUBDIR = ["global", "skills-drafts"];
const STALE_DAYS = 180;
const ACTIVE_AT = 3;
const MAX_STEPS = 8;
const MIN_STEPS = 3;
const MAX_LIST = 20;
const MAX_SUGGEST = 3;
const MAX_LINE = 120;

// ---------------------------------------------------------------- 小工具

function msg(error) {
  return String(error?.message ?? error ?? "");
}

function nowIso(now) {
  return new Date(typeof now === "number" ? now : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function oneLine(value, max = 400) {
  const s = String(value ?? "").replace(/\s*\r?\n\s*/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortHash(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 6);
}

function normTitle(title) {
  return String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 标题 → kebab；无 ASCII 词时退化为 "skill"，靠短 hash 区分。 */
export function slugify(title) {
  const ascii = normTitle(title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (ascii.length >= 3 ? ascii.slice(0, 48).replace(/-+$/g, "") : "skill") || "skill";
}

/** 文件名 = 标题 kebab + 短 hash（同标题必得同名 → 天然去重）。 */
export function draftFileName(title) {
  return `${slugify(title)}-${shortHash(normTitle(title))}.md`;
}

/** 草稿目录：<root>/global/skills-drafts */
export function skillsDir(root) {
  return join(root || DEFAULT_ROOT, ...SUBDIR);
}

function evidenceArray(evidence) {
  if (Array.isArray(evidence)) return evidence.map((e) => oneLine(e, 80)).filter(Boolean);
  const s = oneLine(evidence, 400);
  return s ? s.split(/\s*[,，;；]\s*/).filter(Boolean) : [];
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 只解析「key: scalar / flow-sequence」，够用且不引 yaml 依赖。 */
export function parseFrontmatter(text) {
  const m = String(text ?? "").match(FM_RE);
  if (!m) return { data: {}, body: String(text ?? "") };
  const data = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (value.startsWith("[") || value.startsWith('"')) {
      try {
        data[key] = JSON.parse(value);
        continue;
      } catch {
        /* 非 JSON，按原串留 */
      }
    }
    data[key] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return { data, body: String(text ?? "").slice(m[0].length) };
}

function baseName(file) {
  const s = String(file ?? "");
  return s.slice(Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")) + 1);
}

function readDraftFile(file) {
  const text = readFileSync(file, "utf8");
  const { data, body } = parseFrontmatter(text);
  return {
    file,
    fileName: baseName(file),
    name: data.name || "",
    title: data.title || data.name || "",
    description: data.description || "",
    status: data.status || "shadow",
    created: data.created || "",
    updated: data.updated || "",
    lastUsed: data.last_used || "",
    successCount: Number(data.success_count) || 0,
    failCount: Number(data.fail_count) || 0,
    evidence: Array.isArray(data.evidence) ? data.evidence : evidenceArray(data.evidence),
    body,
  };
}

function mdBullets(text, max) {
  const s = oneLine(text, max);
  if (!s) return [];
  const parts = s.split(/(?<=[。.;；])/).map((x) => x.trim()).filter(Boolean);
  return (parts.length ? parts : [s]).map((x) => `- ${x}`);
}

/** 渲染完整 markdown（frontmatter + 正文），落盘与测试断言共用。 */
export function renderDraft(d) {
  const evidence = evidenceArray(d.evidence);
  const head = [
    "---",
    `name: ${slugify(d.name || d.title)}`,
    `title: ${JSON.stringify(oneLine(d.title, 120))}`,
    `description: ${JSON.stringify(oneLine(d.description ?? "", 200))}`,
    `status: ${d.status}`,
    `created: ${d.created}`,
    `updated: ${d.updated}`,
    `last_used: ${d.lastUsed || ""}`,
    `success_count: ${d.successCount || 0}`,
    `fail_count: ${d.failCount || 0}`,
    `evidence: ${JSON.stringify(evidence)}`,
    `origin: dsh-memory/skill-drafts`,
    "---",
    "",
  ];
  const body = [`# ${oneLine(d.title, 120)}`, ""];
  if (d.description) body.push(oneLine(d.description, 300), "");
  body.push("## 步骤", "");
  (d.steps || []).forEach((step, i) => body.push(`${i + 1}. ${oneLine(step, 300)}`));
  body.push("");
  if (d.pitfalls) body.push("## 坑", "", ...mdBullets(d.pitfalls, 1200), "");
  if (d.verification) body.push("## 验证", "", ...mdBullets(d.verification, 1200), "");
  if (evidence.length) body.push("## 证据", "", ...evidence.map((e) => `- ${e}`), "");
  body.push("<!-- dsh-memory 草稿：确认可用后再自行采纳为正式 skill；本模块不写正式 skill 目录。 -->", "");
  return head.join("\n") + body.join("\n");
}

// ---------------------------------------------------------------- 核心 API

export function normalizeSteps(steps) {
  if (Array.isArray(steps)) return steps.map((s) => oneLine(s, 300)).filter(Boolean);
  if (typeof steps === "string") {
    return steps
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 新建或更新一份草稿。同标题命中已有文件 → 就地更新正文，
 * status / success_count / fail_count / last_used / created 全部保留。
 */
export function upsertDraft(input = {}) {
  const root = input.root || DEFAULT_ROOT;
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title 必填");
  const steps = normalizeSteps(input.steps);
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new Error(`steps 需要 ${MIN_STEPS}-${MAX_STEPS} 条，收到 ${steps.length}`);
  }
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  const fileName = draftFileName(title);
  const file = join(dir, fileName);
  const now = nowIso(input.now);
  const evidence = evidenceArray(input.evidence);

  if (existsSync(file)) {
    const old = readDraftFile(file);
    const next = {
      ...old,
      title,
      description: input.description ?? old.description,
      updated: now,
      steps,
      pitfalls: input.pitfalls ?? "",
      verification: input.verification ?? "",
      evidence: evidence.length ? evidence : old.evidence,
    };
    writeFileSync(file, renderDraft(next), "utf8");
    return {
      created: false,
      file,
      fileName,
      name: slugify(title),
      status: old.status,
      title,
      steps,
      evidence: next.evidence,
    };
  }

  const record = {
    name: slugify(title),
    title,
    description: input.description ?? "",
    status: "shadow",
    created: now,
    updated: now,
    lastUsed: "",
    successCount: 0,
    failCount: 0,
    evidence,
    steps,
    pitfalls: input.pitfalls ?? "",
    verification: input.verification ?? "",
  };
  writeFileSync(file, renderDraft(record), "utf8");
  return { created: true, file, fileName, name: record.name, status: record.status, title, steps, evidence };
}

/** 从正文回读步骤，保证 promote 重写文件时不丢内容。 */
function stepsFromBody(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## 步骤");
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    const m = line.match(/^\d+\.\s*(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** 180 天未用 → stale（纯计算，不改盘）。 */
export function effectiveStatus(rec, now = Date.now()) {
  const status = rec?.status || "shadow";
  const last = Date.parse(rec?.lastUsed || rec?.updated || rec?.created || "");
  if (Number.isFinite(last) && now - last > STALE_DAYS * 86400000) return "stale";
  return status;
}

/** 列出全部草稿（不做写操作）。status 为「有效状态」：超 180 天未用显示 stale。 */
export function listDrafts(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const dir = skillsDir(root);
  const now = typeof options.now === "number" ? options.now : Date.now();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    try {
      const rec = readDraftFile(join(dir, entry));
      rec.status = effectiveStatus(rec, now);
      out.push(rec);
    } catch {
      /* 单个坏文件不影响其余 */
    }
  }
  out.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
  return out;
}

function findDraft(root, target) {
  const dir = skillsDir(root);
  const raw = String(target ?? "").trim();
  if (!raw) throw new Error("slug 必填");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  const byFile = files.find((f) => f === raw || f === `${raw}.md`);
  const byName = byFile
    ? null
    : files.find((f) => {
        const rec = readDraftFile(join(dir, f));
        return rec.name === raw || rec.title === raw || f.startsWith(`${raw}-`);
      });
  const hit = byFile || byName;
  if (!hit) throw new Error(`草稿不存在：${raw}`);
  return { file: join(dir, hit), fileName: hit };
}

/**
 * 成熟度推进：success 计一次成功，fail 计一次失败。
 * success_count >= 3 → active；任何一次使用都刷新 last_used（stale 因此自愈）。
 * 签名保持在 task-3 约定的 promote(slug, outcome)，第三参可选 {root, now}。
 */
export function promote(target, outcome, options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const now = typeof options.now === "number" ? options.now : Date.now();
  const kind = String(outcome ?? "").toLowerCase();
  const ok = ["success", "ok"].includes(kind);
  if (!ok && !["fail", "failed", "error"].includes(kind)) {
    throw new Error(`outcome 只接受 success|fail，收到 ${outcome}`);
  }
  const hit = findDraft(root, target);
  const rec = readDraftFile(hit.file);
  const wasStale = effectiveStatus(rec, now) === "stale";
  if (ok) rec.successCount += 1;
  else rec.failCount += 1;
  rec.lastUsed = nowIso(now);
  rec.updated = rec.lastUsed;
  if (ok && rec.successCount >= ACTIVE_AT) rec.status = "active";
  else if (wasStale) rec.status = rec.successCount >= ACTIVE_AT ? "active" : "shadow";
  writeFileSync(hit.file, renderDraft({ ...rec, steps: stepsFromBody(rec.body) }), "utf8");
  return {
    ok: true,
    slug: rec.name,
    fileName: hit.fileName,
    status: effectiveStatus(rec, now),
    successCount: rec.successCount,
    failCount: rec.failCount,
  };
}

/** 维护用：把超期未用的草稿真正改写成 stale（list 只做显示层判定）。 */
export function refreshStale(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const now = typeof options.now === "number" ? options.now : Date.now();
  let changed = 0;
  for (const rec of listDrafts({ root, now })) {
    if (rec.status !== "stale") continue;
    const body = readDraftFile(rec.file);
    if (body.status === "stale") continue;
    writeFileSync(rec.file, renderDraft({ ...body, status: "stale", steps: stepsFromBody(body.body) }), "utf8");
    changed += 1;
  }
  return { ok: true, changed };
}

/**
 * 集群建议（只读，不落盘）：同 subject 下按「谓词」或「共用 tag」成簇，
 * 簇内 >=3 条事实 → 一条建议，最多 3 条，每条 <=120 字符。
 */
export function suggestDrafts(facts, options = {}) {
  const limit = Math.min(MAX_SUGGEST, Math.max(1, Number(options.limit) || MAX_SUGGEST));
  const rows = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const buckets = new Map();
  const push = (key, subject, kind, fact) => {
    const k = `${subject}\u0000${kind}\u0000${key}`;
    if (!buckets.has(k)) buckets.set(k, { subject, key, kind, facts: [] });
    buckets.get(k).facts.push(fact);
  };
  for (const fact of rows) {
    const subject = oneLine(fact.subject ?? "（无主语）", 40);
    const predicate = oneLine(fact.predicate ?? "", 40);
    if (predicate) push(predicate, subject, "predicate", fact);
    const tags = Array.isArray(fact.tags) ? fact.tags : String(fact.tags ?? "").split(/[\s,，]+/).filter(Boolean);
    for (const tag of tags.slice(0, 6)) push(oneLine(tag, 24), subject, "tag", fact);
  }
  const picked = [];
  const seen = new Set();
  for (const bucket of [...buckets.values()].sort((a, b) => b.facts.length - a.facts.length)) {
    const ids = bucket.facts.map((f) => oneLine(f.id, 32)).filter(Boolean);
    const dedupeKey = `${bucket.subject}|${ids.slice().sort().join(",")}`;
    if (bucket.facts.length < 3 || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const first = bucket.facts[0] ?? {};
    const sample = oneLine(first.value ?? first.content ?? first.text ?? "", 40);
    const title = `${bucket.subject}·${bucket.key} 流程化`;
    const line = oneLine(`${bucket.subject} · ${bucket.key} ×${bucket.facts.length}：${sample}`, MAX_LINE);
    picked.push({
      subject: bucket.subject,
      key: bucket.key,
      kind: bucket.kind,
      count: bucket.facts.length,
      factIds: ids,
      title,
      line,
    });
    if (picked.length >= limit) break;
  }
  return picked;
}

// ---------------------------------------------------------------- 工具注册

function textOutput() {
  return { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: String(v) }] };
}

/**
 * 注册三个工具。api：
 *   register(def)        首选，复用 index.js 里 try/catch 的 register 包装
 *   tools                兜底：{ register }
 *   log(fn)              可选
 *   root                 记忆库根目录（默认 resolveRoot()）
 *   listFacts({subject}) 可选，返回事实数组；不提供时 memory_skill_suggest 回 NO_FACT_SOURCE
 */
export function registerSkillDrafts(api = {}) {
  const root = api.root || DEFAULT_ROOT;
  const log = typeof api.log === "function" ? api.log : () => {};
  const listFacts = typeof api.listFacts === "function" ? api.listFacts : null;
  const register =
    typeof api.register === "function"
      ? api.register
      : (def) => {
          if (!api.tools || typeof api.tools.register !== "function") {
            throw new Error("skill-drafts: 需要 api.register 或 api.tools.register");
          }
          return api.tools.register(def);
        };
  const output = textOutput();

  const defs = [
    {
      name: "memory_skill_draft",
      description:
        "把一条可复用的经验写成 skill 草稿（3-8 步），落到记忆库的 skills-drafts 目录，供以后人工采纳。只在用户要求沉淀流程/经验时调用；同标题会更新原草稿而不是新建。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "草稿标题，一句话（同标题视为同一份草稿）" },
          steps: { type: "array", items: { type: "string" }, description: "操作步骤 3-8 条，每条一句话" },
          pitfalls: { type: "string", description: "可选：已知的坑/失败原因，一段话" },
          verification: { type: "string", description: "可选：怎么验证做对了，一段话" },
          evidence: { type: "string", description: "可选：支撑的事实 id 或来源，逗号分隔" },
          description: { type: "string", description: "可选：一句话描述这份 skill 用来干什么" },
        },
        required: ["title", "steps"],
      },
      output,
      async execute(args) {
        try {
          const rec = upsertDraft({
            root,
            title: args?.title,
            steps: args?.steps,
            pitfalls: args?.pitfalls,
            verification: args?.verification,
            evidence: args?.evidence,
            description: args?.description,
          });
          log("skill-draft", rec.fileName, rec.created ? "created" : "updated");
          return JSON.stringify({
            ok: true,
            slug: rec.name,
            status: rec.status,
            created: rec.created,
            file: rec.fileName,
          });
        } catch (error) {
          log("skill-draft failed:", msg(error));
          return JSON.stringify({ ok: false, code: "SKILL_DRAFT_FAILED", message: msg(error).slice(0, 120) });
        }
      },
    },
    {
      name: "memory_skill_list",
      description: "列出 skill 草稿及其成熟度（标题 / 状态 / 成功次数），最多 20 行。只读。",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "最多返回几行，默认 20，上限 20" } },
      },
      output,
      async execute(args) {
        try {
          const limit = Math.min(MAX_LIST, Math.max(1, Number(args?.limit) || MAX_LIST));
          const rows = listDrafts({ root }).slice(0, limit);
          if (!rows.length) return "（暂无 skill 草稿）";
          return rows
            .map((r) => oneLine(`${oneLine(r.title, 40)} | ${r.status} | ok=${r.successCount} fail=${r.failCount}`, 80))
            .join("\n");
        } catch (error) {
          log("skill-list failed:", msg(error));
          return JSON.stringify({ ok: false, code: "SKILL_LIST_FAILED", message: msg(error).slice(0, 120) });
        }
      },
    },
    {
      name: "memory_skill_suggest",
      description:
        "只读建议：同一 subject 下有 >=3 条高相关事实（同谓词或同 tag）时，建议把它们沉淀成 skill。只给建议，不写文件。",
      parameters: {
        type: "object",
        properties: { subject: { type: "string", description: "可选：只看某个主语" } },
      },
      output,
      async execute(args) {
        try {
          if (!listFacts) {
            return JSON.stringify({ ok: false, code: "NO_FACT_SOURCE", message: "胶水未提供 listFacts" });
          }
          const facts = await listFacts({ subject: args?.subject, limit: 2000 });
          const items = suggestDrafts(facts, { limit: MAX_SUGGEST });
          if (!items.length) return "（暂无建议：没有 >=3 条同簇事实）";
          return items.map((s) => s.line).join("\n");
        } catch (error) {
          log("skill-suggest failed:", msg(error));
          return JSON.stringify({ ok: false, code: "SKILL_SUGGEST_FAILED", message: msg(error).slice(0, 120) });
        }
      },
    },
  ];

  const registered = [];
  for (const def of defs) {
    try {
      register(def);
      registered.push(def.name);
    } catch (error) {
      log("skill-draft tool register failed:", def.name, msg(error));
    }
  }
  return { ok: true, dir: skillsDir(root), tools: registered };
}

export default registerSkillDrafts;