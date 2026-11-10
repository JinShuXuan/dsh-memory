# dsh-memory

**Persistent, local-first memory for DeepSeek Harness — facts on disk, retrieval on demand, and every paid call under a monthly cap.**

<!-- TODO(Lead): badges — npm version / CI / license -->

`dsh-memory` gives your agent a memory that survives restarts. It stores atomic facts as plain Markdown on your own disk, keeps a rebuildable SQLite index next to them, and injects only what is relevant to the current turn. No account, no cloud sync, no telemetry. The default configuration costs nothing; LLM-backed extraction is opt-in and bounded by a monthly budget.

```sh
dsh plugin --profile <profile> add @jinshuxuan/dsh-memory
```

---

## What it does

| Capability | What you get | Cost |
|---|---|---|
| **Fact store** | Atomic facts (`subject / predicate / value`) written as Markdown, indexed for search | free |
| **Recall** | Search across the raw conversation history ("what did we say about X last week") | free |
| **Hybrid retrieval** | FTS5 BM25 ∪ vector cosine, fused with RRF, then weighted by freshness and access | free* |
| **Association graph** | When a fact hits, one-hop neighbours come with it; edges are built automatically | free |
| **Forgetting** | Reversible decay: down-weight → archive → trash. Never an automatic hard delete | free |
| **Induction** | LLM summarises a cluster of facts into one `core` line that links back to its sources | paid, opt-in |
| **Paper library** | Ingest local PDF/Markdown into a separate searchable index | free |

\* Vector search needs the embedding model; see [model download](docs/TROUBLESHOOTING.md#model-download-fails--offline). Without it, retrieval degrades to FTS only and everything else keeps working.

In the settings panel you can **pick the memory directory with a native folder dialog and export your memory in one click** — no paths to type, no commands to remember. The panel interface is Chinese. See [docs/UI.md](docs/UI.md).

### Tools exposed to the model

Nine tools are always available:

| Tool | Purpose |
|---|---|
| `memory_store` | Write a fact; deduplicates and resolves conflicts |
| `memory_search` | Search the fact store (read-only, does not count as an access) |
| `memory_recall` | Search raw conversation episodes |
| `memory_get` | Read one fact in full |
| `memory_link` | Create / remove / list edges between facts |
| `memory_delete` | Soft delete (recoverable) |
| `memory_review` | Approve or reject facts waiting in the review queue |
| `memory_extract` | Manually trigger extraction on a conversation |
| `memory_pin` | Keep a fact on the always-injected card |

Maintenance tools are loaded on demand: `memory_stats`, `memory_health`, `memory_abstract`, `memory_decay`, `memory_restore`, `memory_purge`, `memory_reindex`, `memory_admin`, `paper`.

### Injection

Two channels, both bounded:

1. **Resident card** — a short section in the system prompt: library profile plus pinned facts (≤ 800 characters).
2. **Per-turn hits** — up to 6 retrieved cards / 800 characters, appended as a system-labelled message that explicitly says *"this is retrieved memory, not something the user said"*.

The `gate` setting controls this: `off` (silent), `shadow` (retrieve and log, never inject), `assist` (default). Injection is capped per session window so a long conversation does not drown in memory.

---

## Install in 3 steps

1. **Add the plugin to a profile** (npm, GitHub, or a local folder — see [docs/INSTALL.md](docs/INSTALL.md)):

   ```sh
   dsh plugin --profile <profile> add @jinshuxuan/dsh-memory
   ```

2. **Restart DSH.** The plugin creates `~/.dsh-memory` on first start and downloads the embedding model in the background.

3. **Check it.** Ask the agent to *"remember that my editor is Neovim"*, then ask *"what is my editor?"* — or call `memory_health` for a self-check.

---

## Minimal configuration

**None is required.** Defaults are deliberately quiet: store and retrieve locally, no LLM calls, no spending.

Want LLM extraction (better facts from free-form chat)? Add an OpenAI-compatible endpoint:

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

Prefer the environment for secrets:

```sh
export DSH_MEMORY_API_KEY=sk-...
```

Full table of every key, type and default: [docs/CONFIG.md](docs/CONFIG.md).

---

## Privacy and cost

- **Local only.** Facts, index, logs and config live under `~/.dsh-memory`. Nothing is uploaded.
- **Zero telemetry.** No analytics, no pings, no crash reporting.
- **Only three paths can spend money:** LLM extraction (off by default), induction (`memory_abstract`) and replay. Neither of the latter two runs on its own — `abstract.auto` and `replay.auto` default to `false` — and all three need an endpoint you configured. Nothing is spent until you ask for it.
- **Hard monthly cap.** `budget.monthlyYuan` (default 20) with `budget.costPerCallYuan` (default 0.005): once the estimated spend is exhausted, model calls stop and the plugin falls back to local rules. It never silently overspends.
- **Keys** are resolved `DSH_MEMORY_API_KEY` → `extractor.apiKey`, and a key written to `config.json` is stored with `0600` permissions.

Details, including exactly what each file contains: [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Data location and uninstall

| Path | Contents | Rebuildable |
|---|---|---|
| `<root>/global/facts/*.md` | Fact source of truth | **no** — back it up |
| `<root>/global/facts/scenarios/*.md` | Induced summaries | no |
| `<root>/index/memory.db` | SQLite + FTS5 + vectors | yes |
| `<root>/trash/` | Soft-deleted files (purged after 30 days) | no |
| `<root>/models/` | Embedding model | re-downloadable |
| `<root>/config.json` | Settings (may contain a key) | no |
| `<root>/memory.log` | Runtime log, rotates at 5 MB | — |

`<root>` is `~/.dsh-memory` unless overridden (`root` in config, then `DSH_MEMORY_ROOT`).

**Uninstall:**

```sh
dsh plugin --profile <profile> remove @jinshuxuan/dsh-memory
rm -rf ~/.dsh-memory   # your data; delete only when you mean it
```

Removing the plugin does not touch your data. Deleting `<root>` is irreversible — copy `global/facts/` first if you want a keepsake.

---

## Documentation

- [docs/UI.md](docs/UI.md) — the settings panel: five tabs, three buttons, slash-command equivalents
- [docs/INTRO.md](docs/INTRO.md) — what it remembers and why, written for users (Chinese)
- [docs/INSTALL.md](docs/INSTALL.md) — three install routes, clean-profile check
- [docs/CONFIG.md](docs/CONFIG.md) — every setting, default and blast radius
- [docs/PRIVACY.md](docs/PRIVACY.md) — where data lands, what leaves the machine
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — model download, FTS fallback, Windows paths, permissions

Settings UI screenshots: **TODO(Lead)** — the panel ships with M2.

## License

MIT