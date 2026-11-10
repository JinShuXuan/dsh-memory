# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-10

首个可发布版本（M1）。

### 新增
- 本地长期记忆存储：SQLite（`node:sqlite`）+ FTS5/BM25 检索，数据默认在 `~/.dsh-memory`。
- 可选本地向量检索：`bge-small-zh-v1.5`（onnxruntime-node），首次按需下载；缺模型/缺依赖自动降级纯 FTS，不阻塞启动。
- 混合检索：向量与 BM25 结果经 RRF 融合排序。
- 注入闸门 `gate`：`off` / `shadow` / `assist` 三档，按回合注入命中卡。
- 规则自动抽取：默认关 LLM 抽取，零 API 花费；填了 key 也需显式开 `extractor.enabled`。
- 记忆关系图：命中记忆带出一跳邻居并自动建边。
- 可逆遗忘：按权重降权/归档，绝不自动删除；软删进 trash 可恢复。
- 待审队列：冲突记忆可 approve / reject。
- 论文库：导入本地 PDF/md/txt，分块索引后与记忆并用检索。
- 工具族：`memory_store`、`memory_search`、`memory_get`、`memory_recall`、`memory_link`、`memory_admin`、`memory_health`、`memory_abstract`、`paper`。
- 配置模块：`SCHEMA_VERSION = 2`，v1 自动迁移；`DSH_MEMORY_ROOT` 可覆盖根目录，支持从旧目录搬库。
- 文档：`README.md` 与 `README.zh-CN.md`。

### 说明
- 需要 Node.js >= 22.5（`node:sqlite`）。
- 不联网、不填 key 也能用：此时只有规则抽取 + 检索。