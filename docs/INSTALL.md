# Install

Three routes, one result: the bundle `@jinshuxuan/dsh-memory` shows up in a profile's dependency list and its `dsh.profile.bundles` array. Pick one; they differ only in where the code comes from.

Before you start: a DeepSeek Harness install with at least one profile (`dsh` must be on `PATH`), and Node **22.5 or newer** (the plugin relies on the built-in SQLite API).

---

## Route A — from npm (recommended)

```sh
dsh plugin --profile <profile> add @jinshuxuan/dsh-memory
```

Pin a version if you prefer reproducible installs:

```sh
dsh plugin --profile <profile> add @jinshuxuan/dsh-memory@0.1.0
```

## Route B — from GitHub

```sh
dsh plugin --profile <profile> add github:JinShuXuan/dsh-memory
```

Useful for a pre-release or a specific commit:

```sh
dsh plugin --profile <profile> add github:JinShuXuan/dsh-memory#<commit-sha>
```

## Route C — from a local folder

For development, or when you cannot reach a registry.

```sh
# 1. put the code somewhere stable
mkdir -p ~/.dsh/local-packages
git clone https://github.com/JinShuXuan/dsh-memory ~/.dsh/local-packages/dsh-memory

# 2. register it as a linked bundle
dsh plugin --profile <profile> add link:~/.dsh/local-packages/dsh-memory
```

If your DSH build ships the bundle installer tool (`install_bundle`), you can hand it the local folder instead of using the CLI; both end up as a `link:` dependency in the profile's `package.json`.

> Keep the folder where it is. With `link:` the profile references the path directly — move or delete it and the plugin fails to load after the next restart.

## Optional dependencies

Three dependencies are optional, so a bare install still works:

| Package | Used for | Without it |
|---|---|---|
| `onnxruntime-node` | local embeddings | vector search off — FTS-only retrieval |
| `@huggingface/tokenizers` | tokenizer for the embedding model | same as above |
| `pdfjs-dist` | `paper` ingest of PDFs | PDF ingest unavailable; Markdown/TXT still work |

If you installed with `--no-optional` (common offline or in a locked-down registry), expect exactly those degradations. `memory_health` will show the vector model as unavailable; everything else keeps working.

---

## Restart and first start

1. **Fully quit DSH and start it again.** A running process keeps the old bundle; a new dependency is invisible until restart.
2. On first start the plugin creates its data root (`~/.dsh-memory`) and starts downloading the embedding model in the background.

What appears on disk:

```
~/.dsh-memory/
├── config.json          # created on first write; may hold an API key
├── index/memory.db      # SQLite + FTS5 + vectors (rebuildable)
├── global/facts/        # the source of truth (*.md)
├── trash/               # soft-deleted files
├── models/              # Xenova/bge-small-zh-v1.5
└── memory.log           # runtime log, rotates at 5 MB
```

The model download needs network access once (~30 MB). Offline? Set `DSH_MEMORY_NO_DOWNLOAD=1` — memory still works, retrieval degrades to FTS (see [TROUBLESHOOTING](TROUBLESHOOTING.md#model-download-fails--offline)).

---

## Verify the install

**1. The bundle is registered:**

```sh
dsh plugin --profile <profile> list | grep dsh-memory
```

You should see `@jinshuxuan/dsh-memory` in the list. If your build has no `list` subcommand, apply the same check by hand: the package must appear both in the profile's `package.json` → `dependencies` and in `dsh.profile.bundles`.

**2. The tools are live:** ask the agent to run `memory_health`. A healthy answer reports the data root, the fact counts and whether the vector model is available. A missing tool means the process did not reload — restart again and check `memory.log`.

**3. Round-trip a fact:**

> Remember that my editor is Neovim.

then, in a **new session**:

> What is my editor?

**4. Cold start in a throwaway root** (safe: touches no real data):

```sh
DSH_MEMORY_ROOT=$(mktemp -d) DSH_MEMORY_NO_DOWNLOAD=1 \
  node -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

It must create the directory, print its exports, and exit 0. This also proves the pack contains no absolute paths from someone else's machine.

---

## After installing: the first three things（装完先做的三件事）

Do these in **Settings → dsh-memory**. All three are optional in the sense that the defaults already work — but doing them now saves confusion later.

**1. Pick the memory directory（选记忆库目录）**

Open the **配置 / Settings** tab — it is the tab the panel opens on — and press **选择目录 / Choose directory**. A native folder picker opens; do not type a path. The current root is shown next to the button.

- Leave it alone if `~/.dsh-memory` is fine (it usually is).
- Change it when the home drive is small, synced to a cloud folder, or on a network share.
- Verify: the **概览 / Overview** tab shows the new path and a fact count, and `memory_health` reports the same root.

**2. Only if you want automatic extraction: add a key and flip the switch（需要自动抽取再开）**

In the same tab: paste a key (or name the env var), fill `baseURL` and `model`, then enable **LLM 抽取 / LLM extraction** and save.

- Nothing is spent while the switch is off; the built-in rule extractor keeps working.
- Verify: after a fact-bearing sentence or two, the **审批 / Review** tab starts showing candidates, and `memory_health` reports the model as configured.

**3. Export a backup once（点导出备份一次）**

Press **导出 / Export** on the **维护 / Maintenance** tab and choose a destination in the save dialog. You get a JSONL file, one active fact per line, without API keys.

- Verify: the file exists, is non-empty, and opens as line-delimited JSON.
- Repeat before big maintenance actions (rebuild index, cleanup) and before upgrading.

Full walkthrough of every tab: [UI.md](UI.md).

## Environment variables

| Variable | Effect |
|---|---|
| `DSH_MEMORY_ROOT` | Data root (default `~/.dsh-memory`). Config `root` wins over it. |
| `DSH_MEMORY_MODEL_DIR` | Where the embedding model is looked up. |
| `DSH_MEMORY_NO_DOWNLOAD=1` | Never download the model; run FTS-only. |
| `DSH_MEMORY_API_KEY` | API key for extraction/induction/replay; wins over `config.json`. |

---

## Uninstall

```sh
dsh plugin --profile <profile> remove @jinshuxuan/dsh-memory
```

Your data is untouched. Delete `~/.dsh-memory` only when you mean it — copy `global/facts/` first if you want to keep what was learned.

---

## Next

- [CONFIG.md](CONFIG.md) — every setting and its default
- [PRIVACY.md](PRIVACY.md) — what is stored where, what leaves the machine
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — when something is not right