// P1：抽取与裁决的纯逻辑（不碰 DB、不碰宿主，便于单测）
// 规则来自方案 §7（写入管线）与 §10（冲突、真值与时间）
import { resolveApiKey } from "./src/config.js";

export const PRIORITY = { manual: 4, explicit: 3, user_explicit: 3, auto: 2, import: 1, inferred: 0 };
const DAY = 86400000;

/** 全角转半角、压空白 */
export function normText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** 判重用的值归一：去空白、大小写、常见标点与语气词 */
export function normValue(s) {
  return normText(s)
    .toLowerCase()
    .replace(/[。．。，,；;！!？?、"'“”‘’（）()\[\]【】:：]/g, "")
    .replace(/(呀|啊|呢|吧|哦|嘛|啦)$/u, "");
}

/** 索引键归一：subject/predicate 用 */
export function normKey(s) {
  return normText(s)
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, "")
    .slice(0, 60);
}

export function priorityOf(sourceType) {
  return PRIORITY[sourceType] ?? 0;
}

const NUMERIC_PREDS = new Set(["amount", "budget", "price", "cost", "deadline", "date", "age", "count", "版本", "预算", "价格"]);
const NEGATION_RE = /(不|别|取消|停用|没有|不再|解约|卸载)/;

/**
 * 隐私闸门（方案 §11）：证件号、手机号、银行卡、常见 API Key 一律拒存。
 * 顺序重要：先证件/密钥，再银行卡（16–19 位数字会与身份证重叠）。
 */
const SECRET_PATTERNS = [
  { code: "DENIED_SECRET", re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { code: "DENIED_SECRET", re: /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  { code: "DENIED_SECRET", re: /(?<!\d)\d{16,19}(?!\d)/ },
  { code: "DENIED_SECRET", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
];

export function privacyCheck(text) {
  const s = String(text ?? "");
  for (const { code, re } of SECRET_PATTERNS) {
    if (re.test(s)) return { code };
  }
  return null;
}

/**
 * §10 判定表。existing 为同 scope+subject+predicate 的 active 原子行（无则 undefined）。
 * 返回 { action, ... }：
 *  insert | merge | supersede | pending
 */
export function decideConflict({ existing, candidate, now = Date.now() }) {
  if (!existing) return { action: "insert" };

  // 已过期但仍占唯一键的行：先 supersede 再插入（§10 脚注）
  if (existing.expires_at && Number(existing.expires_at) <= now) {
    return { action: "supersede", supersedeId: existing.id, reason: "expired" };
  }

  const oldVal = normValue(existing.content ?? existing.value);
  const newVal = normValue(candidate.value);
  if (oldVal === newVal) return { action: "merge", id: existing.id };

  const oldP = priorityOf(existing.source_type);
  const newP = priorityOf(candidate.source_type);

  // inferred 永不覆盖真值
  if (candidate.source_type === "inferred" && oldP > 0) {
    return { action: "pending", reason: "conflict_inferred" };
  }

  // 自动抽取遇到数值/日期变化：可能是笔误，转人工（方案之外的安全阀，可关）
  const looksNumeric =
    NUMERIC_PREDS.has(String(candidate.predicate ?? "")) || /^\d+(\.\d+)?$/.test(normText(candidate.value));
  const negated = NEGATION_RE.test(normText(candidate.value)) !== NEGATION_RE.test(normText(existing.content ?? existing.value));

  // 自动抽取的安全阀必须统一前置：原先只写在 newP>oldP 分支里，同级「30 天外 evolve」可绕过它
  const valve =
    candidate.source_type === "auto" && (looksNumeric || negated) ? negotiableReason(looksNumeric, negated) : "";

  if (newP > oldP) {
    if (valve) return { action: "pending", reason: valve };
    return { action: "supersede", supersedeId: existing.id, reason: "higher_priority" };
  }

  if (newP < oldP) return { action: "pending", reason: "conflict_lower_priority" };

  // 同级：看时间
  const gap = now - Number(existing.created_at ?? now);
  if (gap > 30 * DAY) {
    if (valve) return { action: "pending", reason: valve };
    return { action: "supersede", supersedeId: existing.id, reason: "evolved" };
  }
  return { action: "pending", reason: valve || "conflict_recent" };
}

function negotiableReason(looksNumeric, negated) {
  if (looksNumeric) return "conflict_numeric";
  if (negated) return "conflict_negation";
  return "";
}

// ---------------- 规则抽取（P1a，零成本） ----------------

// 规则一律锚定句首：先切句再逐句匹配，避免「…我的问题是什么」这种句中片段被误抓成事实
const SENTENCE_SPLIT = /(?<=[。！？!?；;])|\n/u;

const RULES = [
  { re: /^记住\s*[：:，, ]*\s*(.+)$/u, make: (m) => ({ value: m[1] }) },
  { re: /^以后(?:都|一律|就)?\s*[：:]?\s*(.+)$/u, make: (m) => ({ value: m[1] }) },
  { re: /^别再\s*(.+)$/u, make: (m) => ({ value: `不要再${m[1]}` }) },
  { re: /^我(?:更|比较)?喜欢\s*(.+)$/u, make: (m) => ({ subject: "user", predicate: "prefers", value: m[1] }) },
  { re: /^我(?:的)?\s*([^\s，,。！？]{1,12})\s*是\s*(.+)$/u, make: (m) => ({ subject: "user", predicate: normKey(m[1]), value: m[2] }) },
  { re: /^我(?:的)?\s*([^\s，,。！？]{1,10})\s*(?:放在|存在|保存在|位于)\s*(.+)$/u, make: (m) => ({ subject: "user", predicate: normKey(m[1]), value: m[2] }) },
];

/** 空壳值黑名单：「什么」「哪里了吗」「放在最后的」这类不是事实 */
const VAGUE_VALUES = new Set([
  "什么", "啥", "谁", "哪里", "哪儿", "哪个", "哪些", "多少", "怎么", "怎样", "如何", "为什么", "干嘛",
  "这个", "那个", "这样", "那样", "这么", "那么", "吗", "呢", "吧", "对", "好", "嗯", "是", "有", "没有", "可以",
]);
const STRUCTURAL_HEAD = /^(放在|存在|保存在|位于|了|的|吗|呢|吧|啊|呀|嘛|哦)/u;
const QUESTION_PRED = /^(问题|什么|啥|谁|哪里|哪儿|多少|怎么|怎样|为什么)$/u;

/** 值是否够「实」：长度、空壳词、谓语是否疑问化、无谓语时是否以结构词/语气词开头结尾 */
export function isSubstantive(value, predicate) {
  const v = normText(value);
  if (v.length < 2) return false;
  if (VAGUE_VALUES.has(v)) return false;
  if (/^[的了呢吧啊呀嘛哦哈嗯\s]+$/u.test(v)) return false;
  const key = normKey(predicate ?? "");
  if (key && QUESTION_PRED.test(key)) return false;
  if (!key && (STRUCTURAL_HEAD.test(v) || /[吗呢吧啊呀]$/u.test(v))) return false;
  return true;
}

/** 从一段用户原话里抠事实；只认显式句式，宁缺毋滥 */
/** 代码块 / JSON / HTML 片段不是「话」，一律不算事实 */
const CODEISH = /```|<[a-z!/][^>]*>|^\s*[{[]|"type"\s*:|\\u[0-9a-f]{4}|function\s|=>\s*\{/i;

export function ruleExtract(transcript) {
  const out = [];
  const lines = String(transcript ?? "").split("\n");
  let speaker = "user"; // 说话人是轮次级状态：只有首行带「助手:」，后续续行沿用同一说话人
  for (const raw of lines) {
    if (/^(助手|assistant)\s*[：:]/i.test(raw)) speaker = "assistant";
    else if (/^(用户|user)\s*[：:]/i.test(raw)) speaker = "user";
    const line = normText(raw.replace(/^(用户|user|助手|assistant)\s*[：:]\s*/i, ""));
    if (!line) continue;
    if (CODEISH.test(line)) continue;
    const sentences = line
      .split(SENTENCE_SPLIT)
      .map((s) => s.replace(/[。！？!?；;]+$/u, "").trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (CODEISH.test(sentence)) continue;
      for (const rule of RULES) {
        const m = rule.re.exec(sentence);
        if (!m) continue;
        const base = rule.make(m);
        const value = normText(base.value).slice(0, 200);
        if (!isSubstantive(value, base.predicate)) continue;
        out.push({
          subject: base.subject ?? null,
          predicate: base.predicate ?? null,
          value,
          tags: ["rule"],
          confidence: 0.8,
          evidence: sentence.slice(0, 120),
          author: speaker,
          source_type: "explicit",
        });
        break; // 一句只抽一条，避免一句话刷出多条
      }
    }
  }
  return out;
}

// ---------------- LLM 抽取（P1b） ----------------

/**
 * 2026-11-10 归属修复：episode 里同时有「用户:」和「助手:」，模型分不清谁说的，
 * 会把助手的提议当成用户意愿存进库。抽事实前先只截出用户段落，evidence 必须落在这里。
 */
export function userSegments(transcript) {
  const s = String(transcript ?? "");
  // 只认「行首」的 用户:/助手: 标记。正文里引用格式（如讨论记忆库时写的「用户: … 助手: …」）
  // 大多在行中间，用行首匹配才不会把助手的整段回复吞进用户段落。
  const lines = s.split("\n");
  const parts = [];
  let cur = null;
  for (const line of lines) {
    if (/^用户[:：]/.test(line)) {
      if (cur && cur.length) parts.push(cur.join("\n"));
      cur = [line.replace(/^用户[:：]\s*/, "")];
    } else if (/^助手[:：]/.test(line)) {
      if (cur && cur.length) parts.push(cur.join("\n"));
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur && cur.length) parts.push(cur.join("\n"));
  return parts.length > 0 ? parts.join("\n") : s; // 解析不出就退回全文，兼容无前缀的旧数据
}

/** 对称版：只截出助手段落。解析不出返回空串（没有助手内容就是没有，不能退回全文） */
export function assistantSegments(transcript) {
  const s = String(transcript ?? "");
  const lines = s.split("\n");
  const parts = [];
  let cur = null;
  for (const line of lines) {
    if (/^助手[:：]/.test(line)) {
      if (cur && cur.length) parts.push(cur.join("\n"));
      cur = [line.replace(/^助手[:：]\s*/, "")];
    } else if (/^用户[:：]/.test(line)) {
      if (cur && cur.length) parts.push(cur.join("\n"));
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur && cur.length) parts.push(cur.join("\n"));
  return parts.join("\n");
}

export function extractorReady(cfg) {
  const e = cfg?.extractor ?? {};
  return Boolean(e.enabled && e.baseURL && e.model && resolveApiKey({ extractor: e }).key);
}

const PROMPT = `从下面的对话里抽取「可长期记住的事实」。规则：
1. 只抽「用户:」开头的段落里用户本人陈述或确认过的信息：偏好、身份、习惯、计划、关系、约定、决定。
2. **「助手:」开头的段落一律不抽**——那是助手的建议和猜测，不是用户的事实。即使看起来像用户的心声也不行。
3. 不要抽一次性任务细节、工具输出、模型自己的猜测、以及明显的临时状态。
4. 每条给出 subject（英文小写标识，如 user / dsh / project-x）、predicate（英文小写动词短语，如 prefers / lives_in / uses）、value（中文自然语句，≤120 字）。
5. evidence 必须是从「用户:」段落里逐字复制的一小段原文，否则该条作废。
6. 最多 5 条；没有就返回空数组。

另外把「助手:」段落里助手自己给出的**承诺、决定、结论、判断**抽成 assistant_notes：
- 只抽这四类（如「这个改动要重启才生效」「我建议先做遗忘」「下周我给你出方案」），
- 不抽解释、举例、过程叙述、工具输出、客套话，
- predicate 只能是 promised / concluded / decided_to / told_user，
- 最多 1 条；evidence 必须逐字来自「助手:」段落；没有就空数组。
只输出 JSON：{"facts":[{"subject":"","predicate":"","value":"","tags":[],"confidence":0.8,"evidence":""}],"assistant_notes":[{"predicate":"","value":"","evidence":"","confidence":0.8}]}`;

export async function llmExtract(cfg, transcript) {
  const e = cfg.extractor;
  const apiKey = resolveApiKey({ extractor: e }).key;
  const url = `${String(e.baseURL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(e.timeoutMs) || 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: e.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: String(transcript).slice(0, 12000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`extract HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text);
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    const flat = normText(userSegments(transcript));
    const max = Math.min(Math.max(Number(e.maxFactsPerTurn) || 5, 1), 10);
    const factsOut = facts
      .filter((f) => f && typeof f.value === "string" && f.value.trim())
      .filter((f) => {
        const ev = normText(f.evidence ?? "").slice(0, 60);
        return ev.length >= 4 && flat.includes(ev);
      })
      .slice(0, max)
      .map((f) => ({
        subject: f.subject ? normKey(f.subject) : null,
        predicate: f.predicate ? normKey(f.predicate) : null,
        value: normText(f.value).slice(0, 200),
        tags: Array.isArray(f.tags) ? f.tags.slice(0, 6).map((t) => normText(t).slice(0, 20)) : [],
        confidence: Math.min(Math.max(Number(f.confidence) || 0.7, 0.1), 1),
        evidence: normText(f.evidence).slice(0, 120),
        author: "user",
        source_type: "auto",
      }));

    // 2026-11-10 助手侧：只抽承诺/决定/结论，每段最多 1 条，证据必须落在「助手:」段落
    const ALLOWED_NOTES = new Set(["promised", "concluded", "decided_to", "told_user"]);
    const asstText = normText(assistantSegments(transcript));
    const notesRaw = Array.isArray(parsed?.assistant_notes) ? parsed.assistant_notes : [];
    const notes = asstText
      ? notesRaw
          .filter((n) => n && typeof n.value === "string" && n.value.trim())
          .filter((n) => {
            const ev = normText(n.evidence ?? "").slice(0, 60);
            return ev.length >= 4 && asstText.includes(ev);
          })
          .slice(0, 1)
          .map((n) => {
            const pred = normKey(n.predicate ?? "");
            return {
              subject: "assistant",
              predicate: ALLOWED_NOTES.has(pred) ? pred : "concluded",
              value: normText(n.value).slice(0, 200),
              tags: ["assistant-said"],
              confidence: Math.min(Math.max(Number(n.confidence) || 0.7, 0.1), 1),
              source_type: "auto",
              author: "assistant",
            };
          })
      : [];
    return { facts: factsOut, notes };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 场景卡（L1→L2，确定性，不依赖模型） ----------------

export function summarizeScenario(subject, atoms) {
  const top = [...atoms].sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0)).slice(0, 6);
  const value = `${subject ? `关于 ${subject} 的` : "一组"} ${atoms.length} 条记录：` + top.map((a) => String(a.content ?? a.value)).join("；");
  return { value: value.slice(0, 600), nodeIds: atoms.map((a) => a.id), tags: ["scenario"] };
}

// ---------------- 抽象（L3：从多条具体事实归纳规律） ----------------

const ABSTRACT_PROMPT = `你从记忆库里的一组具体事实中归纳「这一类事情的规律」。规则：
1. **不要复述单条事实，也不要把几条事实合并成一句**。例如输入说「他 2026 年 9 月入职 X 公司研发部」，输出「他是 X 公司的员工」就是复述，作废。
2. 要抽象出**共性、条件、因果或做事原则**，让没见过的新情况也能用它推断。多用「都」「每次」「凡是」「只要…就」「需要…才」这类规律表述。
3. 只能使用下面事实里出现过的实体、名称、数字，不得引入任何新信息。
4. 每条归纳至少被 2 条事实支持，support 里写事实编号；被 ≥4 条支持的更像真规律。
5. 与归纳相冲突的事实写进 exceptions，不要丢掉它。
6. 最多 3 条；如果这些事实只是零散的档案信息、没有共性，返回空数组。

示例（假设输入是三条关于工作习惯的事实）：
✅ 好：「凡是涉及对外交付的改动，都先在小范围试跑再全量上线」
✅ 好：「需要反复斟酌的判断，只要能写成规则或清单，就优先写成规则」
❌ 坏：「张三有三条工作习惯」（复述，没结论）
❌ 坏：「张三是个严谨的人」（空话，无法用来源验证）
只输出 JSON：{"abstracts":[{"statement":"","support":[1,2],"exceptions":[],"confidence":0.8}]}`;

/** 归纳：模型只负责「说规律」，编号到 id 的映射和校验由调用方做 */
export async function llmAbstract(cfg, subject, facts) {
  const a = cfg?.abstract ?? {};
  const e = { ...(cfg?.extractor ?? {}) };
  for (const [k, v] of Object.entries(a)) if (v) e[k] = v;
  // 分组写法 abstract.llm.* 也要认（CONFIG.md 承诺两种都生效）
  for (const [k, v] of Object.entries(a.llm ?? {})) if (v) e[k] = v;
  const apiKey = resolveApiKey({ extractor: e }).key;
  if (!e.baseURL || !e.model || !apiKey) throw new Error("abstract: 未配置模型（abstract 或 extractor）");
  const url = `${String(e.baseURL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(e.timeoutMs) || 30000);
  try {
    const numbered = facts.map((f, i) => `[${i + 1}] ${f.value}`).join("\n");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: e.model,
        temperature: 0, // 2026-11-10 归零：同一输入同一输出，便于复现与排错
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ABSTRACT_PROMPT },
          { role: "user", content: `主题：${subject || "（未命名）"}\n事实：\n${numbered}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`abstract HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.abstracts) ? parsed.abstracts : [];
    return list
      .filter((x) => x && typeof x.statement === "string" && normText(x.statement).length >= 4)
      .map((x) => ({
        statement: normText(x.statement).slice(0, 200),
        support: (Array.isArray(x.support) ? x.support : [])
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= facts.length),
        exceptions: (Array.isArray(x.exceptions) ? x.exceptions : [])
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= facts.length),
        confidence: Math.min(Math.max(Number(x.confidence) || 0.6, 0.1), 1),
      }));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 批量重放（巩固节律：隔天带着「已记住什么」回看同一段对话） ----------------

const REPLAY_PROMPT = `你在做记忆巩固：同一段对话，之前已经抽取过一次。现在带着「已记住什么」再回看一遍，做三件事：
1. new_facts：上次漏掉的、值得长期记住的事实。**不要重复已知的**。
2. duplicates：已知事实里，哪些已经被这段对话完全覆盖（只报编号）。
3. suspicions：已知事实里哪些与对话内容不符或有误（报编号 + 一句原因）。**不要改写它们**，只报告。
规则：
- new_facts 的 evidence 必须是从「用户:」段落逐字复制的一小段，否则该条作废。
- 「助手:」段落属于助手的话，**一律不抽**，即便它听起来像用户的意愿。
- 只抽用户本人陈述或确认过的信息（偏好/身份/习惯/计划/约定/决定），不抽任务细节与模型猜测。
- 没有新东西就返回空数组，宁可空也不要凑数。
只输出 JSON：{"new_facts":[{"subject":"","predicate":"","value":"","evidence":"","confidence":0.8}],"duplicates":[1],"suspicions":[{"index":2,"why":""}]}`;

/** 重放：输入原文 + 已记住的事实，输出「新增 / 已覆盖 / 有疑点」三段 */
export async function llmReplay(cfg, transcript, knownFacts) {
  const e = cfg?.extractor ?? {};
  const apiKey = resolveApiKey({ extractor: e }).key;
  if (!e.baseURL || !e.model || !apiKey) throw new Error("replay: 未配置模型");
  const url = `${String(e.baseURL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(e.timeoutMs) || 20000);
  try {
    const known = knownFacts.map((f, i) => `[${i + 1}] ${f.value}`).join("\n") || "（暂无）";
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: e.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REPLAY_PROMPT },
          {
            role: "user",
            content: `对话原文：\n${String(transcript).slice(0, 12000)}\n\n已记住的事实：\n${known}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`replay HTTP ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    const flat = normText(userSegments(transcript));
    const max = Math.min(Math.max(Number(e.maxFactsPerTurn) || 5, 1), 10);
    const newFacts = (Array.isArray(parsed?.new_facts) ? parsed.new_facts : [])
      .filter((f) => f && typeof f.value === "string" && f.value.trim())
      .filter((f) => {
        const ev = normText(f.evidence ?? "").slice(0, 60);
        return ev.length >= 4 && flat.includes(ev);
      })
      .slice(0, max)
      .map((f) => ({
        subject: f.subject ? normKey(f.subject) : null,
        predicate: f.predicate ? normKey(f.predicate) : null,
        value: normText(f.value).slice(0, 200),
        tags: ["replayed"],
        confidence: Math.min(Math.max(Number(f.confidence) || 0.7, 0.1), 1),
        source_type: "auto",
        author: "user",
      }));
    const idxList = (arr, key) =>
      (Array.isArray(arr) ? arr : [])
        .map((x) => (key ? Number(x?.[key]) : Number(x)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= knownFacts.length);
    return {
      newFacts,
      duplicates: idxList(parsed?.duplicates, null),
      suspicions: idxList(parsed?.suspicions, "index").map((n) => ({
        index: n,
        why: normText((parsed.suspicions.find((s) => Number(s?.index) === n) || {}).why ?? "").slice(0, 120),
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}