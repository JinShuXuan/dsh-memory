# dsh-memory · 市场文案（发布用）

> 用途：GitHub / npm / DSH 插件市场索引的对外文案。功能描述均可在 `README.md`、`CHANGELOG.md`、`package.json`、`index.js`、`p1.js` 中核实；未核实的能力不写。
> 当前版本：`@jinshuxuan/dsh-memory` 0.3.0（MIT，Node.js >= 22.5）。

---

## 一句话定位

**本地长期记忆：SQLite 全文 + 本地向量混合召回，模型缺失自动退化为纯 FTS，零 API 花费。**

> Local long-term memory: hybrid recall over SQLite full-text search plus local embeddings — degrades to FTS-only when the model is missing, and never bills an API.

---

## 市场卡片（可直接填索引 PR）

```json
{
  "title": { "en": "dsh-memory — local long-term memory", "zh": "dsh-memory — 本地长期记忆" },
  "description": {
    "zh": "给 AI 装一个本地长期记忆：SQLite 全文 + 本地向量混合召回，规则自动抽取、冲突裁决、关系图、skill 草稿、错误台账、论文库；模型缺席自动退化纯 FTS，零 API 花费。",
    "en": "Long-term memory for your agent: hybrid full-text + local-vector recall, rule-based extraction with conflict resolution, relation graph, skill drafts, mistake ledger, paper library. Falls back to FTS-only without the model; zero API cost."
  },
  "tags": ["memory", "rag", "sqlite", "fts5", "local-first", "dsh-plugin"],
  "license": "MIT"
}
```

短描述（中文 108 字，英文同义；均 ≤120 字/600 字符）：

- 中文：给 AI 装一个本地长期记忆：SQLite 全文 + 本地向量混合召回，规则自动抽取、冲突裁决、关系图、skill 草稿、错误台账、论文库；模型缺席自动退化纯 FTS，零 API 花费。
- English: Long-term memory for your agent: hybrid full-text + local-vector recall, rule extraction with conflict resolution, relation graph, skill drafts, mistake ledger, paper library. FTS-only fallback, zero API cost.

---

## 六个卖点

| # | 卖点 | 一句话理由 |
|---|---|---|
| 1 | **混合召回**：FTS5 全文 + 本地向量余弦，结果融合排序 | 关键词精确（`pnpm`、`D:\work`）和语义近似（"上次那个排错"）都要，单靠一种总会漏 |
| 2 | **规则自动抽取 + 冲突裁决**：默认零 API | 只认显式句式（"记住…""我的 X 是 Y"），空壳值直接丢弃；新旧事实冲突时按来源与置信度裁决，可进待审队列人工 approve/reject |
| 3 | **关系图 + 可逆遗忘**：命中即带出一跳邻居 | 记忆不是散列条目；按权重降采样归档，软删进回收站，**绝不自动删除** |
| 4 | **skill 草稿 + 错误台账**：踩过的坑只踩一次 | `memory_skill` 写经验步骤（3–8 步）等审核；`memory_error` 记报错/根因/教训，同签名只加 hits |
| 5 | **论文库**：本地 PDF/md/txt 导入即检索 | 建索引后与记忆共用一套检索，读论文不用另开一套 RAG |
| 6 | **面板 UI + 零硬依赖**：装了就能跑 | 设置页/概览/审批/回收站都在宿主 Web UI 里；`node:sqlite` 是内置模块，原生件全缺也能降级运行；10 个常驻工具合计仅 1929 B |

### 1. 混合召回

全文检索负责"叫什么"，向量检索负责"像什么"，两路结果融合后按分数排序返回。检索入口 `memory_search`，另有两个省 token 的通道：`memory_recall` 只回 60 字首句（先判断是哪一场对话，再取原话），`memory_get` 按 id 取全文。

**为什么值**：模型和检索都在本机，一次查询的 JS 开销在毫秒级（见 [PERF.md](PERF.md)），不给对话加延迟、不烧 API 额度。

### 2. 规则自动抽取与冲突裁决

不联网也能抽取：`p1.js` 里的规则只认显式句式，含糊值（"什么""哪里""多少"）和代码块一律不算事实，宁缺毋滥。同一 `subject + predicate` 出现新值时，按来源类型与置信度决定覆盖、并存还是转入待审；冲突不静默合并。

**为什么值**：默认零 API 花费，且不会把"我在问问题"误记成"我的偏好"。

### 3. 关系图与可逆遗忘

新事实入库时自动与相似/同事实的记忆建边，检索命中一条可带出一跳邻居（`memory_link` 可手工补连）。衰减按权重降采样并归档，软删进回收站 30 天后清理。

**为什么值**：库越用越像"知识"，而不是越用越像"日志"；"忘了"永远是可撤销操作。

### 4. skill 草稿与错误台账

`memory_skill`：把重复流程写成 3–8 步草稿，带坑和验证方法，成熟后再转正式 skill。
`memory_error`：一条报错 = 命令 + 现象 + 根因 + 教训 + 解法位置；同根因只累加 hits，不刷屏。

**为什么值**：这是"同一件事不问第二遍"的实现方式——记忆存事实，台账存教训。

### 5. 论文库

`paper`（`action=ingest`）递归导入本地 PDF/md/txt，按内容去重分块；`action=search` 按语义片段检索，`action=chunk` 取原文上下文。`action=delete` 只删索引，不动原文件。

**为什么值**：PDF 阅读和日常记忆用同一套本地索引，省掉维护第二个 RAG 栈。

### 6. 面板 UI 与零硬依赖

宿主 Web UI 里有设置、概览（活跃/向量/关联/待审/回收站计数）、审批、回收站；接口挂在 `/api/dsh-memory/*`。依赖面只有 `node:sqlite`（Node 22.5+ 内置），`@huggingface/tokenizers`、`onnxruntime-node`、`pdfjs-dist` 三个原生件缺失时逐项降级，不会装不上。

**为什么值**：`npm i` 不编译、不需要 VS Code 编译器或 Python 工具链，Windows 上也不会卡在 node-gyp。

---

## 安装三步

```bash
# 1. 装插件（Node.js >= 22.5）
dsh plugin add @jinshuxuan/dsh-memory

# 2. 重启 DSH（让 plugin 与工具注册生效）

# 3. 打开插件面板：设置 → 记忆库路径 → 概览
```

首启会在 `~/.dsh-memory`（或 `DSH_MEMORY_ROOT`）自动建空库，首次需要时可下载 ~30 MB 嵌入模型（`Xenova/bge-small-zh-v1.5`）。

## 最小示例

```text
# 存一条（显式指令或工具调用都会落库）
记住：我的默认编辑器是 Neovim，日志在 D:\work\build.log

# 取回来
memory_search("编辑器 是什么")        → 命中偏好事实 + 一跳邻居
memory_recall("上次排错怎么弄的")     → 先给 60 字首句，锁定会话后再取原话
memory_get("abcdef123456")           → 原文与元数据
```

不用 LLM 抽取也能用：默认只有规则抽取 + 检索；要开模型抽取，在设置页填 `extractor.enabled` / `apiKey` / `baseURL` / `model` 四项，缺一不发请求。

---

## 诚实边界（发布前请原样保留）

| 边界 | 说明 |
|---|---|
| **可选原生依赖会降级** | `@huggingface/tokenizers` 缺 → 不做向量；`onnxruntime-node` 缺 → 不做向量；`pdfjs-dist` 缺 → 不能读 PDF。此时检索退化为纯 FTS，功能可用但语义召回变弱。 |
| **模型要下载一次** | 默认依次尝试 `hf-mirror.com`、`huggingface.co`，约 30 MB；会暴露 IP 与"装了此插件"这一事实，不含记忆内容。 |
| **可彻底离线** | `DSH_MEMORY_NO_DOWNLOAD=1` → 不下载、不重试，纯 FTS 启动。 |
| **新装时库是空的** | 没有任何预置事实；第一次 `memory_search` 大概率空结果，属正常，需要先存。 |
| **不自动删除** | 衰减只归档，软删进回收站（30 天后清理），不会静默丢数据。 |
| **不是云同步** | 单机、单库；换机请拷 `DSH_MEMORY_ROOT` 整个目录。 |
| **抽取默认关** | 开 LLM 抽取 = 开 API 花费；规则抽取免费但只认显式句式。 |

---

# English

**One-liner.** Local long-term memory: hybrid recall over SQLite FTS5 plus local embeddings — degrades to FTS-only when the model is missing, and never bills an API.

**Selling points.** (1) Hybrid recall — BM25 and cosine fused, so both exact keys and fuzzy "that bug from last week" work. (2) Rule-based extraction with conflict resolution, zero API by default — only explicit phrasings count, vague values are dropped, and conflicts are adjudicated (or queued for review) instead of silently merged. (3) Relation graph with reversible forgetting — hits bring one-hop neighbors; decay archives, delete moves to trash, nothing is auto-destroyed. (4) Skill drafts (`memory_skill`) and a mistake ledger (`memory_error`, deduped by root cause). (5) Paper library — import local PDF/md/txt, search them with the same index. (6) Panel UI in the host Web UI plus zero hard dependencies — `node:sqlite` is built in; the three native packages (`@huggingface/tokenizers`, `onnxruntime-node`, `pdfjs-dist`) each degrade instead of failing installation; the 10 resident tools total 1929 B of schema.

**Install.** `dsh plugin add @jinshuxuan/dsh-memory` → restart DSH → open the plugin panel. Node.js >= 22.5. An empty database is created on first boot under `~/.dsh-memory` (or `DSH_MEMORY_ROOT`).

**Honest limits.** Missing native packages degrade to FTS-only; the embedding model (~30 MB) is fetched once from `hf-mirror.com` then `huggingface.co`, or skipped with `DSH_MEMORY_NO_DOWNLOAD=1`; a fresh install starts empty; memory is local to one machine with no sync; LLM extraction is off by default and costs API money when enabled.