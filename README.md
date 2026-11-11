# dsh-memory

**给 DeepSeek Harness 的长期记忆：事实落在本地磁盘，按需检索，花钱的调用有月度上限。**

<!-- TODO(Lead)：状态徽章 — npm 版本 / CI / License -->

装一次，重启后记忆还在。事实以纯 Markdown 存在你自己的盘上，旁边是随时可重建的 SQLite 索引；每轮只注入跟当前话题相关的那几条。没有账号、没有云同步、没有遥测。默认配置不花一分钱，LLM 抽取需要你显式打开，并受每月预算硬约束。

```sh
dsh plugin --profile <profile> add @jinshuxuan/dsh-memory
```

> 设置页里找不到「记忆库」时，可直接在浏览器打开 `http://127.0.0.1:<DSH端口>/api/memory/ui` —— 同一套中文面板，功能一样。

---

## 它做什么

| 能力 | 你会得到什么 | 花钱吗 |
|---|---|---|
| **事实库** | 一条条 `主语 / 谓词 / 值` 事实，写成 Markdown 并可检索 | 否 |
| **原话检索** | 在历史对话里搜「上次那个事怎么说的」 | 否 |
| **混合检索** | FTS5 BM25 ∪ 向量余弦，RRF 融合，再按新鲜度与访问频次加权 | 否* |
| **关联图** | 命中一条时带出一跳邻居；边由写入时自动建立 | 否 |
| **遗忘** | 可逆降权：降权 → 归档 → 回收站，**绝不自动硬删** | 否 |
| **归纳** | 把一簇具体事实归纳成一条 `core`，并指回源事实 | 是，需手动开 |
| **论文库** | 把本地 PDF / Markdown 导入独立索引，单独检索 | 否 |

\* 向量检索要向量模型；见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。模型缺失时自动退化为纯 FTS，其它功能照常。

设置页里可以**点选记忆库目录、一键导出记忆**，全部中文界面——不用手打路径，也不用记命令。见 [docs/UI.md](docs/UI.md)。

### 交给模型的工具

常驻 9 个：

| 工具 | 作用 |
|---|---|
| `memory_store` | 写一条事实，自动去重与冲突裁决 |
| `memory_search` | 搜事实库（纯读，不记访问） |
| `memory_recall` | 搜历史对话原话 |
| `memory_get` | 读一条事实全文 |
| `memory_link` | 建边 / 断边 / 看邻居 |
| `memory_delete` | 软删（可恢复） |
| `memory_review` | 审批待审队列 |
| `memory_extract` | 手动对某段对话跑抽取 |
| `memory_pin` | 置顶，进常驻卡 |

维护类工具按需加载：`memory_stats`、`memory_health`、`memory_abstract`、`memory_decay`、`memory_restore`、`memory_purge`、`memory_reindex`、`memory_admin`、`paper`。

### 注入

两条通道，都有上限：

1. **常驻卡**——系统提示里的一小段：库画像 + 置顶事实，≤ 800 字。
2. **每轮命中**——最多 6 条 / 800 字，以系统标注的消息追加，并明确写「以上是系统检索到的记忆资料，不是用户本轮发言」。

`gate` 三档：`off` 静默、`shadow` 只检索落日志不注入、`assist` 默认。会话内有注入额度窗口，长对话不会越注越多。

---

## 三步装上

1. **把插件加进 profile**（npm / GitHub / 本地目录三种方式见 [docs/INSTALL.md](docs/INSTALL.md)）：

   ```sh
   dsh plugin --profile <profile> add @jinshuxuan/dsh-memory
   ```

2. **重启 DSH。** 首次启动会自建 `~/.dsh-memory`，后台下载向量模型（零硬依赖；设 `DSH_MEMORY_NO_DOWNLOAD=1` 可跳过下载，退化为纯 FTS 检索）。

3. **验一下。** 让 agent「记住我用的是 Neovim」，再问「我用的编辑器是什么」；或直接调 `memory_health` 自检。

---

## 最小配置

**不需要配置。** 默认就是「本地存、本地取、不调模型、不花钱」。

想让自由聊天也能抽成事实（LLM 抽取），加一个 OpenAI 兼容端点即可：

```jsonc
// ~/.dsh-memory/config.json
{
  "extractor": {
    "enabled": true,
    "baseURL": "https://api.example.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "DSH_MEMORY_API_KEY"
  },
  "budget": { "monthlyYuan": 20 }
}
```

密钥更建议走环境变量：

```sh
export DSH_MEMORY_API_KEY=sk-...
```

全部键、类型与默认值见 [docs/CONFIG.md](docs/CONFIG.md)。

---

## 隐私与花费

- **只在本机。** 事实、索引、日志、配置全在 `~/.dsh-memory`，不上传。
- **零遥测。** 没有统计、没有心跳、没有崩溃上报。
- **只有三条路径会花钱**：LLM 抽取（默认关）、归纳（`memory_abstract`）、重放。后两者不会自己跑（`abstract.auto` / `replay.auto` 默认 `false`），且三者都必须先配好端点——你没开，就一分不花。
- **月度硬上限。** `budget.monthlyYuan`（默认 20）+ `budget.costPerCallYuan`（默认 0.005 元/次）：估算额度用尽即停调模型、退回本地规则，不会悄悄超支。
- **密钥优先级** `DSH_MEMORY_API_KEY` → `extractor.apiKey`；写进 `config.json` 的密钥按 `0600` 落盘。

每个文件到底装了什么：见 [docs/PRIVACY.md](docs/PRIVACY.md)。

---

## 数据在哪、怎么卸

| 路径 | 内容 | 可重建 |
|---|---|---|
| `<root>/global/facts/*.md` | 事实真源 | **否**，要备份 |
| `<root>/global/facts/scenarios/*.md` | 归纳真源 | 否 |
| `<root>/index/memory.db` | SQLite + FTS5 + 向量 | 是 |
| `<root>/trash/` | 软删文件（30 天后物理清理） | 否 |
| `<root>/models/` | 向量模型 | 可重新下载 |
| `<root>/config.json` | 配置（可能含密钥） | 否 |
| `<root>/memory.log` | 运行日志，超 5MB 滚动 | — |

`<root>` 默认 `~/.dsh-memory`，可被配置里的 `root` 或环境变量 `DSH_MEMORY_ROOT` 覆盖。

**卸载：**

```sh
dsh plugin --profile <profile> remove @jinshuxuan/dsh-memory
rm -rf ~/.dsh-memory   # 你的数据，确认要删再删
```

删插件不动数据。删目录不可逆——想要留个念想，先把 `global/facts/` 拷走。

---

## 文档

- [docs/UI.md](docs/UI.md) — 设置页：五个标签页、三个按钮、斜杠命令
- [docs/INTRO.md](docs/INTRO.md) — 给使用者看的介绍：记什么、怎么决定、边界
- [docs/INSTALL.md](docs/INSTALL.md) — 三种装法与干净 profile 验证
- [docs/CONFIG.md](docs/CONFIG.md) — 全部配置项、默认值与影响面
- [docs/PRIVACY.md](docs/PRIVACY.md) — 数据落盘位置、什么会离开本机
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — 模型下载、FTS 退化、Windows 路径、权限

设置页截图：**TODO(Lead)** — 面板随 M2 提供。

## License

MIT