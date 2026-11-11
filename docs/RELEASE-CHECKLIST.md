# 发布验收清单 — @jinshuxuan/dsh-memory

快照：2026-11-11T16:45:38+08:00(Asia/Shanghai) ｜ 复测 2026-11-11（v0.3.1 + 方案A，③ 已转 PASS） ｜ 仓库 `D:\学习资料\Downloads\无聊\dsh-memory`
版本 `0.3.1` ｜ HEAD `4fce5e7` (main) ｜ 工作树 clean（除本文件）｜ node v26.13.0 / npm 11.20.0 / dsh 0.2.2-rc.1 / pnpm 11.28.5
验证者：wp-verify（只读验证；仅写本文件与 %TEMP%）

## 结果总表

| 项 | 命令 | 结果 | 结论 |
| ① 打包清单（0.3.1 终版） | `npm pack --dry-run --json` | 终版 tgz `jinshuxuan-dsh-memory-0.3.1.tgz` 163641 B / 34 files（lead 复核）；首版 34 项 / 160017 B，方案 A 只改 package.json。`p1.js`=yes，`index.js`/`client/index.js`/`src/service.js`/`src/ui.html`/`locale/zh-CN.json`/`docs/INSTALL.md`/`cordis.patch.yml`/`icon.svg` 全部在包；`bench/`、`test/`、`PLAN.md`、`node_modules`、`*.tgz` 全部不在包 | **PASS** |
| ① 打包清单（0.3.1） | `npm pack --dry-run --json` | `jinshuxuan-dsh-memory-0.3.1.tgz`，34 项，size 160017 B，unpacked 490429 B；`p1.js`=yes，`index.js`/`client/index.js`/`src/service.js`/`src/ui.html`/`locale/zh-CN.json`/`docs/INSTALL.md`/`cordis.patch.yml`/`icon.svg` 全部在包；`bench/`、`test/`、`PLAN.md`、`node_modules`、`*.tgz` 全部不在包 | **PASS** |
| ② 解包后导入 | `tar -xzf` → `node --input-type=module -e "await import('file:///<unpack>/package/index.js')"` | `IMPORT_OK exports=DEFAULT_CONFIG,MemoryStore,apply,formatHits,inject,migrateLegacy,name,verifyMigration`；无 ERR_MODULE_NOT_FOUND。修复前（0.3.0，files 缺 `p1.js`）为 `ERR_MODULE_NOT_FOUND: Cannot find module '.../package/p1.js' imported from .../package/index.js` | **PASS（0.3.0 为 FAIL）** |
| ③ 全新 DSH_HOME 安装（v0.3.1 + 方案 A，2026-11-11 复测） | `DSH_HOME=<tmp> dsh plugin --profile web add <终版 tgz>`（**不加** --ignore-scripts） | **exit=0**（pnpm "Done in 13.7s"，仅 store 硬链接 WARN）；`dsh.profile.bundles=@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @jinshuxuan/dsh-memory`；`--dump-config` **3 命中**；`dsh plugin list --depth 0` 显示 `@jinshuxuan/dsh-memory@0.3.1`；同包解包 `import index.js` 仍 `IMPORT_OK exports=8` | **PASS**（首版 0.3.1 为 FAIL，见下两行变体） |
| ③' 同一 tarball 加 `--ignore-scripts` | `dsh plugin --profile web add <tgz> --ignore-scripts` | exit=0；`dsh.profile.bundles=@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @jinshuxuan/dsh-memory`；`--dump-config` 3 命中（`# == @jinshuxuan/dsh-memory`、`- id: dsh-memory`、`name: '@jinshuxuan/dsh-memory'`），exit 0 | PASS（证明 ③ 的唯一失败原因就是 pnpm 非零退出） |
| ③'' 变体：仅移除 optionalDependencies.onnxruntime-node | 同上（保留 @huggingface/tokenizers、pdfjs-dist） | exit=0，15 deps，16.3s；bundles 自动含 `@jinshuxuan/dsh-memory` | PASS（方案 A 的等价实测） |
| ④ 空库 | `DSH_MEMORY_ROOT=<tmp> DSH_MEMORY_NO_DOWNLOAD=1 node test/regress.mjs`；再 `MemoryStore.open({root})` + `node:sqlite` 只读计数 | regress `18 passed`，exit 0；新库仅生成 `index/memory.db`(4096B)，`memory_rows=0`、`episode_rows=0`、`memory_vec_rows=0`、`memory_link_rows=0`，无 `facts` 表（该表本就不存在，计数看 `memory`） | **PASS（开箱空库）** |
| ⑤ 自动登记链路（源码确认） | 读 `…\@deepseek-ai\dsh-app-boot\lib\index.js`（在 app.asar 内） | `:1992 reconcileProfilePlugins()` 在**包操作成功后**把新 bundle 依赖 push 进 `dsh.profile.bundles`（`:1969 writeProfileBundles`、`:2006` 写盘），判定依据是包 `package.json` 有 `dsh.bundle.patch`（`:1956/:2000`）；bundle 目录按「安装锚点 → profile 目录」两段解析（`:1774`），不要求包导出 `./package.json` | PASS（`docs/INSTALL.md:3/:93` 的「出现在 dependencies 和 bundles」在安装成功时**属实**，无需改写） |

## 原阻断项（已按方案 A 解除）：onnxruntime-node@1.30.0 的 build script

因果链：`onnxruntime-node@1.30.0` 有 `postinstall: node ./script/install` → pnpm 11 strictDepBuilds 拒绝执行并整体 exit 1 → `dsh plugin add` 视为失败、不执行 `reconcileProfilePlugins` → 包进 dependencies 却不进 `bundles` → `dsh --dump-config` 无 `dsh-memory` → 用户以为装上了，实际插件不运行。

修复选项（三者均已实测或源码确认）：
- **A（主线）**：从 `package.json` 的 `optionalDependencies` 删除 `onnxruntime-node` → 零配置安装 exit 0 且自动挂载（③'' 实测 PASS）。**无需改源码**：`embed.js:40-41` 是 `await import("onnxruntime-node")` / `await import("@huggingface/tokenizers")` 的**动态**导入，整体包在 `embed.js:34-57` 的 `try/catch` 内，缺包时 `this.error` 记因、`embed()` 返回 `null`，检索退化为纯 FTS，启动不崩。代价：默认不启用向量检索。
- **B（备选）**：保留依赖，`docs/INSTALL.md` 改两步装法：`dsh plugin --profile <p> add @jinshuxuan/dsh-memory --ignore-scripts`（实测 exit 0 + 自动挂载），再说明 onnx 原生绑定缺失时退化 FTS；或用 `pnpm approve-builds` 放行后重装。代价：安装命令非标准。
- **C（不推荐）**：pin 到无 postinstall 的旧版（`npm view scripts.postinstall` 实测：1.16.0 / 1.17.0 / **1.18.1** 无 postinstall；1.18.0、1.19.2、1.20.1、1.21.0、1.22.0、1.23.0、1.30.0 均有）。风险：旧版原生库在 node v26 上未验证，且可能与推理调用不兼容，不建议为发布引入未验证的二进制。

## 复现命令（可直接照抄）

```powershell
$env:npm_config_cache="$env:TEMP\wp3\npmcache"      # 否则 EPERM npm-cache\_cacache
cd D:\学习资料\Downloads\无聊\dsh-memory
npm pack --dry-run --json | ConvertFrom-Json | % { $_.filename, $_.entryCount, $_.size, $_.unpackedSize }
npm pack; tar -xzf jinshuxuan-dsh-memory-0.3.1.tgz -C $un
node --input-type=module -e "await import('file:///' + process.argv[1].replace(/\\/g,'/') + '/index.js')" $pkg
$env:DSH_HOME = (mktemp 目录); dsh plugin --profile web add <tgz 绝对路径>; dsh plugin --profile web list --depth 0
dsh --profile web --dump-config | Select-String dsh-memory      # 0 命中 = 未挂载
$env:DSH_MEMORY_ROOT=(mktemp 目录); $env:DSH_MEMORY_NO_DOWNLOAD=1; node test/regress.mjs
```

## 环境限制（未阻断验收）

- `test/regress.mjs:102-103` 自建 `mkdtempSync`，**不读** `DSH_MEMORY_ROOT`；「库为空」用独立 bootstrap 脚本 `MemoryStore.open({root})` + `node:sqlite` 只读计数验证。
- `dsh plugin` 是纯 pnpm 转发器（`dsh plugin --help`），没有独立注册表；「已登记」以 profile `package.json` 的 `dependencies` + `dsh plugin list` 为准。
- 宿主 GUI 内可视验证（面板真的出现）需带 API key 启动并交互，**本清单未做**，属 SKIPPED：发布前由维护者在含 key 的 profile 里装一次并确认「插件」页出现 dsh-memory 条目。补做者：wp-sanitize 或 lead。
- app.asar 为单文件归档，源码需按 asar 头解析后读取；`D:\DSH\resources\app.asar\dsh` 只是虚拟路径，不可直接 `grep`。

## 结论

**可以发布**（HEAD 4fce5e7 + 方案 A，2026-11-11 复测）。①–⑤ 全部 PASS：包内容完整、解包可导入、全新 `DSH_HOME` 下默认 `dsh plugin add` exit=0 且自动写入 `dsh.profile.bundles`、`--dump-config` 命中、空库开箱 0 行、自动登记链路源码正确。原阻断（onnxruntime-node build script 使 pnpm 非零退出、连带 bundles 不写）已由删除该 optionalDependency 解除，源码零改动（`embed.js:40-41` 动态 import + try/catch 降级纯 FTS）。唯一 SKIPPED：宿主 GUI 内可视确认，不阻断发布。
