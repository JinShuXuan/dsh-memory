# 配置

所有可调项都在这一个文件里：

```
<root>/config.json
```

`<root>` 默认 `~/.dsh-memory`。首次加载时插件会把**全部默认值**写进去，所以不用猜键名——打开文件改就行。缺键回落默认，文件坏了回落默认并告警，不会把记忆库弄崩。

改完**重启 DSH 生效**。也可以直接点设置页改常用项（见 [UI.md](UI.md)），两者改的是同一份文件。

本文按「先能跑起来 → 再调优」排列：**先改这 5 项 → 常用 5 项 → 进阶**。每个键后那句中文，就是设置页里鼠标悬停看到的同一句话。

---

## 一、先改这 5 项

### 1. `root` — 记忆库放哪

| | |
|---|---|
| 类型 / 默认 | string / `""`（等于 `~/.dsh-memory`） |
| 说明 | 记忆库存放位置，换盘或换目录时才改 |

- **要不要改**：多数情况不用。只有家目录盘小、或者目录被同步盘/网络共享挂住时才改。
- **改了什么会变**：整个库换位置——事实、索引、回收站、模型全部跟着走。旧目录的数据**不会自动搬过去**，新位置从空库开始。
- **怎么验证**：重启后「概览」页显示新路径和事实数；`memory_health` 报的 root 一致；旧目录的 `global/facts/` 还在原地等你复制。
- **推荐做法**：优先用设置页的「选择目录」按钮，别手打路径。环境变量 `DSH_MEMORY_ROOT` 只在 `root` 为空时生效——文件里的值优先。

### 2. `extractor.enabled` — 要不要让模型帮忙抽事实

| | |
|---|---|
| 类型 / 默认 | boolean / `false` |
| 说明 | LLM 抽取总开关，关着不花钱 |

- **要不要改**：想从自由聊天里自动攒事实才开；只想手动 `memory_store` 就保持关。
- **改了什么会变**：打开后会按轮次把对话片段发给模型抽事实，产生 API 费用（受 `budget` 约束）。关着时规则抽取照常工作，零花费。
- **怎么验证**：开之前「审批」页是空的且 `memory_health` 显示未配置模型；开了并聊几轮后「审批」页出现候选。

### 3. `extractor.apiKey` — 模型服务的密钥

| | |
|---|---|
| 类型 / 默认 | string / `""` |
| 说明 | 模型服务密钥，优先用环境变量 |

- **要不要改**：只在开抽取/归纳/重放时需要。
- **改了什么会变**：决定能不能认证成功。写进文件的密钥是明文（文件权限 `0600`），更推荐环境变量 `DSH_MEMORY_API_KEY` 或 `extractor.apiKeyEnv` 指定的变量。
- **怎么验证**：`memory_health` 只显示 `sk-…abcd` 这种掩码；日志里出现明文 key 说明配置方式该改了，加载时也会告警。
- **优先级**：`DSH_MEMORY_API_KEY` → `apiKeyEnv` 指的那个变量 → 本字段。

### 4. `extractor.baseURL` — 接口地址

| | |
|---|---|
| 类型 / 默认 | string / `""` |
| 说明 | OpenAI 兼容接口地址，留空不调用 |

- **要不要改**：开抽取就必填，形如 `https://api.example.com/v1`（脚本会自动拼 `/chat/completions`）。
- **改了什么会变**：决定请求发到哪。留空时即使开关打开也不会发出任何请求——这是刻意的安全默认。
- **怎么验证**：加载时若 `enabled=true` 而缺 `baseURL`/`model`，`memory.log` 会明确告警。

### 5. `extractor.model` — 用哪个模型

| | |
|---|---|
| 类型 / 默认 | string / `""` |
| 说明 | 抽取用模型名，按服务商填 |

- **要不要改**：开抽取就必填。
- **改了什么会变**：直接决定抽取质量与单价（计费按真实 token，预算只是粗估）。
- **怎么验证**：同上，缺它会告警；配好后聊几句看「审批」页有没有候选。

> 5 项联动关系：`enabled` 是总闸，`apiKey` + `baseURL` + `model` 三者缺一就不会真正发请求。只想试水，可以先只填后三项、最后再开开关。

`extractor` 里还有三项，一般不用动：

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `apiKeyEnv` | string | `""` | 从哪个环境变量读密钥 | 填变量名，比写明文强 |
| `maxFactsPerTurn` | number | `5` | 每轮最多抽几条事实 | 上限 10 左右就够 |
| `timeoutMs` | number | `20000` | 抽取请求超时 | 超时算失败，重试有上限 |

---

## 二、常用：注入多少

| 键 | 类型 | 默认 | 说明（悬停同一句） | 影响面 |
|---|---|---|---|---|
| `gate` | `"off"` \| `"shadow"` \| `"assist"` | `"assist"` | 注入档位：off 关 / shadow 只看 / assist 注入 | 提示词形态；调参期用 `shadow` 最安全 |
| `hits` | number | `6` | 每轮最多注入几条记忆卡片 | 条数越多，留给对话本身的空间越少 |
| `hitsChars` | number | `800` | 每轮卡片合计字符上限 | 直接影响每轮 token 成本 |
| `sessionInjects` | number | `6` | 一个窗口内最多注入几次 | 长会话会自然变安静 |
| `sessionInjectWindow` | number | `40` | 额度按最近多少轮计算，0 为整会话 | 填 `0` 回到旧版「整会话只有 6 次」 |
| `rulesChars` | number | `800` | 系统提示常驻卡的字符上限 | 常驻卡每步都重发，调大成本更高 |

常驻卡**每一步都会重发**，所以 `rulesChars` 的代价比 `hitsChars` 高：先动 `hits`，再动 `rulesChars`。

---

## 三、进阶

### `link` — 关联图

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 关联图总开关，关掉连带邻居一起关 | 最省事的降噪开关 |
| `maxOut` | number | `10` | 每个节点最多连几条出边 | 防图变成一团 |
| `similarMin` | number | `0.82` | 判为相似邻居的余弦门槛 | 调低更密更吵，调高更稀更准 |
| `similarTop` | number | `3` | 每条只连最像的几条 | 与上一条共同决定密度 |
| `sameFactCos` | number | `0.8` | 达到就判同一件事改口，直接覆盖 | 误并/漏并的分界线 |
| `sameEpisode` | number | `0.8` | 同段对话产生的事实的连边权重 | 只影响邻居排序 |
| `sameSession` | number | `0.45` | 同会话不同轮之间的连边权重 | 同上 |
| `expandHits` | number | `3` | 拿前几条命中去找邻居 | 种子越多越发散 |
| `expandTop` | number | `2` | 每轮最多带出几条邻居 | 占注入名额，不占 6 条卡片 |
| `expandChars` | number | `140` | 关联行的字符上限 | 每条一行，别设太大 |

### `decay` — 遗忘（可逆）

激活分在读取时现算，不落库：

```
activation = min( max(prot, 0.55·fresh + 0.30·freq + conn), 1.2 )
fresh = exp(-days / tau)     freq = min(log(1+access)/log(11), 1)
conn  = min(degree,10)/10 · 0.15
prot  = pinned ? 1 : (user_explicit ? 0.9 : 0)
```

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 遗忘总开关，关掉不再降权归档 | 关掉后所有事实长期等价 |
| `auto` | boolean | `true` | 启动后超过一天自动扫一次 | 设 `false` 只能手动跑 |
| `tauDays` | number | `45` | 新鲜度衰减时间常数，越大越慢忘 | 约 31 天半衰 |
| `archiveDays` | number | `90` | 多久没碰才考虑归档 | 与 `archiveBelow` 同时满足才归档 |
| `archiveBelow` | number | `0.18` | 激活分低于它才归档 | 调低=几乎不归档 |
| `maxPerCluster` | number | `8` | 同主题过多时压低分者的频次加成 | 防某主题淹没检索 |
| `archivedFactor` | number | `0.5` | 归档事实的检索权重折扣 | 归档≠删除，仍可被搜到 |
| `touchThrottleMs` | number | `60000` | 同一条多久内只记一次访问 | 防刷分 |
| `subjectOverrides` | object | `{"assistant":{"tauDays":20,"archiveDays":30}}` | 按主题覆盖遗忘速度，助手淡得更快 | 键名必须是 subject |

置顶（pinned）与「用户明说」的事实永不归档。

### `abstract` — 归纳

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 归纳功能开关 | 关掉后只能看原子事实 |
| `auto` | boolean | `false` | 自动归纳，默认手动 | 质量需要人看一眼 |
| `minAtoms` | number | `4` | 同主题至少几条才归纳 | 太少会归纳出废话 |
| `sample` | number | `12` | 一次最多喂多少条事实 | 直接决定单次成本 |
| `maxPerRun` | number | `3` | 一次最多产出几条归纳 | 防一次刷屏 |
| `staleAfter` | number | `2` | 同簇变动几条算陈旧 | 陈旧只降权，不删 |
| `autoPerSweep` | number | `2` | 自动巡检每次重算几个簇 | 控制后台开销 |
| `staleWeight` | number | `0.8` | 陈旧归纳的检索权重 | 新鲜的是 `1.2` |
| `llm.model` | string | `""` | 归纳用模型，留空跟抽取一致 | 可分模型省钱 |
| `llm.baseURL` | string | `""` | 归纳用接口，留空跟抽取一致 | 同上 |
| `llm.apiKey` | string | `""` | 归纳用密钥，留空跟抽取一致 | 同上 |
| `llm.timeoutMs` | number | `30000` | 归纳请求超时 | 超时算失败，重试有上限 |

> **实现提示**：同一组值也支持写成扁平的 `abstract.model` / `abstract.baseURL` / `abstract.apiKey` / `abstract.timeoutMs`——当前归纳链路读的是扁平键，`llm.*` 是分组写法，两者都写时扁平键优先。都不填则继承 `extractor.*`。

### `replay` — 重放旧对话

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 重放开关，回看旧对话补漏 | 关掉完全不跑 |
| `auto` | boolean | `false` | 自动重放，默认手动 | 先手动看补漏效果 |
| `maxAttempts` | number | `3` | 一段对话最多回看几次，成本上界 | 硬上界，别调大 |
| `settleAfter` | number | `2` | 连续几次没新东西就标记完成 | 防反复重跑同一段 |
| `perRun` | number | `20` | 每次选几段 | 与 `maxCalls` 共同限成本 |
| `maxCalls` | number | `5` | 每次最多调用几次模型 | 同上 |

只在启动时检查，且距上次超过 24 小时才跑。

### `budget` — 花费上限

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `monthlyYuan` | number | `20` | 每月估算花费上限，超了停调模型 | 只管模型调用，不管别的 |
| `costPerCallYuan` | number | `0.005` | 每次调用的估算单价 | 按约 1500 入 + 300 出 token 估 |

用尽后：抽取退回本地规则，归纳与重放直接跳过。这是防跑飞的护栏，不是账单——真实计费以服务商为准。

### `promote` — 重复提及升级为事实

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 重复提及自动升级为事实 | 关掉只保留显式写入 |
| `minAtoms` | number | `5` | 提到几次才升级 | 调高更保守 |

### 元信息

| 键 | 类型 | 默认 | 说明 | 影响面 |
|---|---|---|---|---|
| `schema_version` | number | `2` | 配置版本号，迁移用，不要手改 | 手改会触发迁移告警 |
| `ui.lang` | string | `"auto"` | 面板语言，auto 跟随界面 | 纯界面，不影响记忆行为 |

---

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_MEMORY_ROOT` | `root` 为空时的数据根目录（文件里的 `root` 优先） |
| `DSH_MEMORY_MODEL_DIR` | 向量模型所在目录（无对应配置键） |
| `DSH_MEMORY_NO_DOWNLOAD=1` | 禁止下载模型，纯 FTS 运行 |
| `DSH_MEMORY_API_KEY` | 模型服务密钥，优先级最高 |

另：`extractor.apiKeyEnv` 可以指定一个变量名，从那里读密钥。

## 密钥解析顺序

1. `DSH_MEMORY_API_KEY`
2. `extractor.apiKeyEnv` 指向的环境变量
3. `extractor.apiKey`（文件内明文）

界面与日志只显示掩码（`sk-…abcd`）。

---

## 改完之后

- 手改文件：重启 DSH。
- 设置页保存：页面会提示「下次启动生效」。
- 想确认当前生效值：`memory_health` 报 root、模型状态、事实数与注入档位。
- 值看着不对：先排查环境变量——除了 `root`，文件是唯一来源；但 `root`、密钥、模型目录都可能被 env 抢先。

## 读文件时的几个坑

- **反斜杠**：JSON 里写 `"root": "C:\\memory"` 或 `"root": "C:/memory"`。写成单个 `\m` 整份文件都会解析失败（会回退默认，不会崩）。
- **`~` 不展开**：`root` 要么不填，要么写绝对路径。
- **未知键**：会被忽略，不影响加载。
- **旧文件**：自动迁移到 `schema_version: 2`，日志里会留一行。
- **明文密钥**：加载时告警，建议换环境变量。

## 加载告警对照

| 日志里出现 | 含义 |
|---|---|
| 无法创建 `config.json` | 数据目录权限不足 |
| 解析失败，已回退默认值 | JSON 语法错误，修文件 |
| 从 v1 迁移到 v2 | 一次性，正常 |
| `gate=enforce` 已并入 `assist` | 旧档位自动改写 |
| 存在明文 `apiKey` | 建议改用环境变量 |
| `enabled=true` 但缺 `baseURL`/`model` | 抽取不会真正发生 |

---

## 相关

- [UI.md](UI.md) — 设置页怎么点
- [PRIVACY.md](PRIVACY.md) — 密钥与三条花钱路径
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — 设置看起来没生效