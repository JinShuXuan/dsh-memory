# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-11-11

### 修复
- **发布即崩**：`index.js` 从 `./p1.js` 导入，但 `package.json` 的 `files` 未包含 `p1.js`，装完启动 `ERR_MODULE_NOT_FOUND`；已补入白名单。
- **默认数据根不一致**：`skill-drafts.js` / `error-ledger.js` 硬编码 `D:dsh-memory`，与 `resolveRoot()` 的 `~/.dsh-memory` 冲突；统一走 `resolveRoot()`。
- **安装被 pnpm 拦成 exit 1**：`optionalDependencies` 里的 `onnxruntime-node` 带 postinstall，pnpm `strictDepBuilds` 拒绝执行 → `dsh plugin add` 失败 → 插件装上了却永不挂载。已移出依赖（`embed.js` 本就是动态 import + 失败降级），向量检索改为按需自装。
- 旧库探测 `legacyRoots()` 不再猜盘符，只在显式设置 `DSH_MEMORY_LEGACY_ROOT` 时启用。
- 测试夹具与注释去个人化（姓名、学校、本机路径），全仓不再出现作者机器路径。

### 新增
- `test/fresh-install.mjs`：空数据根 → 首次启动建库 → 写入 → 检索 → 重开仍可检索。
- `.gitattributes`：统一 LF，避免 Windows 检出时行尾漂移。
- 文档：零硬依赖说明、`DSH_MEMORY_NO_DOWNLOAD=1` 离线开关、pnpm `ERR_PNPM_IGNORED_BUILDS` 处置；向量检索改为按需安装 `onnxruntime-node`。

## [0.3.0] - 2026-11-11

### 变更
- 面板 UI 全面重做：六个页签（概览 / 浏览 / 审批 / 维护 / 配置 / 日志），数据全部经宿主接口获取，不再依赖旧的单页模板。
- 入口改为双通道：`settings.section` 挂完整设置页，`sidebar.pannellist` 只显示图标与角标（待审 + 草稿数量），另注册 `mount("main")` 页承载同一面板。

### 新增
- `GET /diag`：存储与引擎自检 + 最近 30 行日志（读 `memory.log` 尾部 32KB，敏感字段脱敏）。
- `POST /browse`：跨数据源浏览，支持 `facts / archive / staged / timeline / skill / lesson / decision / node / error / all` 与 `mtype` 过滤（原 `/list` 只能按 `status` 过滤）。
- `POST /pin`：面板内钉选 / 取消钉选（写 `memory.pinned`，`pin_source='manual'`）。
- `/stats` 增补 `subjects`（Top 10 主语分布）与 `modes`（按记忆类型计数，`error` 取错误台账）。
- 新增 `test/client-smoke.mjs`：用 React 替身加载 client bundle，断言三个槽位均已注册、`inject` 完整、正常数据可渲染、全 401 时出现 401 提示，纳入 `npm test`。

### 修复
- `package.json` 的 `files` 字段只有 13 条重复的 `"README*.md"`，发布包会漏掉 `client/`、`src/`、`index.js`、`icon.svg`、`locale/` 等运行时必需文件；已改为完整白名单。
- 面板不再在接口异常时白屏：统一按 `{ok, data}` 双层判断（业务失败也返回 200），失败时显示含 `HTTP <status>`、请求路径与 base 的红条并提供重试；401/404 另有专属说明。

## [0.2.1] - 2026-11-11

### 新增
- 错误台账自动起草 skill：同一 signature 第 2 次复现（`hits>=2`）时，`error-ledger.report()` 经 `onReport` 钩子交给 `upsertDraft` 生成草稿（标题含签名前缀，同标题幂等更新；现象/根因/做法不足 3 条不起草）。
- 常驻卡新增一行：工具调用失败且可归因（坏路径/坏 API/环境）时用 `memory_error report` 记一条，同坑再现先 `search`；`rulesChars` 800→880。
- 新增 `test/auto-draft.mjs` 回归，纳入 `npm test`。

## [0.1.3] - 2026-11-10

### 修复
- 向量模型：优先从旧数据目录复制，其次按「自定义端点 → hf-mirror → huggingface」回退下载；解决国内网络下首次下载失败导致退化为纯 FTS。

## [0.1.2] - 2026-11-10

### 修复
- 设置面板同时注册到 `settings.section` 与 `sidebar.panellist` 两个槽位，任一存在即可显示（此前只挂设置页，找不到入口）。
- 插件描述改为中文（插件列表里显示的那段）。

## [0.1.1] - 2026-11-10

### 变更
- 设置页全面中文化，首页改为「配置」tab：先改项（记忆库路径、LLM 抽取开关、API Key、接口地址、模型名）置顶，常用与进阶在后。
- 每个配置项带 ⓘ 悬停中文说明。
- 新增按钮：选择记忆库目录（系统原生目录选择框）、打开数据目录（资源管理器）、导出记忆（系统原生另存为）。
- 代码内日志与用户可见报错中文化；`papers.js` 的 OCR 判定改为按错误码而不是英文文案。

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