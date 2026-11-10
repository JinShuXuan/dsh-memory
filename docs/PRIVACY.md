# Privacy

Short version: **everything stays in a directory you own, and nothing runs that costs money unless you turn it on.** There is no account, no sync, no analytics endpoint.

---

## What is stored, and where

All state lives under the data root — `~/.dsh-memory` by default (`root` in config → `DSH_MEMORY_ROOT` → default).

| Path | Contents | Sensitivity |
|---|---|---|
| `global/facts/*.md` | Atomic facts as Markdown with YAML front-matter: subject, predicate, value, tags, source ref, timestamps | **high** — plain text, no encryption |
| `global/facts/scenarios/*.md` | Induced summaries that reference their source facts | high |
| `index/memory.db` | SQLite: facts, full-text index (FTS5), vector blobs, association edges, review queue, budget counters | high |
| `trash/` | Soft-deleted fact files, kept 30 days, then deleted | high |
| `models/` | `Xenova/bge-small-zh-v1.5` ONNX weights | none |
| `config.json` | Settings; **may contain an API key in plain text** | high if a key is there |
| `memory.log`, `memory.log.1` | Runtime log: counts, ids, retrieval decisions, errors. Rotates at 5 MB, one old file kept | medium |

Two scopes share the root: `global` (cross-project) and one per workspace (`ws-xxxxxxxx`). Facts do not leak between scopes unless you search with the other scope selected.

The store is **not encrypted at rest**. Anyone who can read your home directory can read your memory — that is the same trust boundary as your shell history. Use full-disk encryption if the machine is shared or portable.

---

## API keys

Resolution order, first match wins:

1. `DSH_MEMORY_API_KEY` environment variable
2. The environment variable named by `extractor.apiKeyEnv` (e.g. `"apiKeyEnv": "MY_GATEWAY_KEY"`)
3. `extractor.apiKey` in `config.json`

Prefer one of the env routes: a key in `config.json` is stored as plain text, though the file is written with `0600` permissions (owner-only on POSIX; on Windows it inherits the user-profile ACL, which `chmod` cannot tighten). On load, the plugin warns in `memory.log` when it finds a plaintext key. Keys are masked everywhere they are displayed — `memory_health` and logs show `sk-…abcd`, never the whole thing.

If you ever paste a key into a chat, rotate it. It is now in that conversation's transcript.

---

## What can leave the machine

Only these, and only when you have configured an endpoint (extraction is off by default; induction and replay never run on their own, since `abstract.auto` and `replay.auto` default to `false`):

| Path | When it fires | Payload |
|---|---|---|
| **Extraction** | After a turn, if `extractor.enabled`; conversation episode must be ≥ 20 characters | That episode's text — user messages up to 4000 characters, each assistant message up to 2000. Up to 5 facts are requested back |
| **Induction** (`memory_abstract`) | Manual by default (`abstract.auto: false`) | Up to `abstract.sample` (12) facts from one cluster |
| **Replay** | Only if `replay.enabled` *and* `auto: true`, checked at startup when the last run was > 24 h ago | Up to `replay.perRun` (20) conversation segments |

Everything goes to the OpenAI-compatible `baseURL` **you** configured — never to the project author, never to a default endpoint (the default `baseURL` is empty, which disables the call).

Not sent: your whole database, your file paths, your profile list, tool call arguments, or anything from retrieval. Search and injection are pure local computation.

Two more network touches that carry no content:

- **Model download** — a one-time fetch of the embedding model from Hugging Face (`Xenova/bge-small-zh-v1.5`). This reveals your IP and the fact that you installed the plugin, nothing else. Set `DSH_MEMORY_NO_DOWNLOAD=1` to skip it entirely.
- **Nothing else.** No version check, no usage ping, no crash report.

---

## Budget: how the cap actually works

| Setting | Default | Meaning |
|---|---|---|
| `budget.monthlyYuan` | `20` | Estimated ceiling per calendar month |
| `budget.costPerCallYuan` | `0.005` | Coarse per-call estimate (≈1500 input + 300 output tokens) |

- Every model call increments a counter kept in `memory.db`; cost = calls × `costPerCallYuan`.
- When the month's estimated spend is exhausted (remaining ≤ 0.01), calls **stop**. Extraction falls back to the local rule-based extractor; induction and replay simply skip.
- The cap is a guard rail against runaway loops, not an invoice. Your provider bills by real tokens; treat the number as an order-of-magnitude estimate.
- The default `20` yuan ≈ 4000 calls at the default per-call estimate — far more than normal interactive use.

Change it any time by editing `config.json`; the counter is not reset by lowering the cap.

---

## Deletion

- **Soft delete** (`memory_delete`) moves the Markdown file to `trash/` and marks the row deleted. The fact stops being retrievable immediately; the file survives 30 days.
- **Purge** (`memory_purge`) removes it for real, leaving a tombstone for 7 days so a stale index cannot resurrect it.
- **Forgetting** never hard-deletes. Decay only down-weights and archives; archived facts can be restored.
- Deleting the data root removes everything, including the budget counter. Back up `global/facts/` first.

---

## Telemetry

None. The plugin makes no analytics, crash-reporting or update-check request. The only outbound traffic is the model download and the LLM calls described above, both of which you control.

Settings-panel screenshots showing the privacy-relevant toggles: **TODO(Lead)** — panel arrives in M2.

---

## Related

- [CONFIG.md](CONFIG.md) — turn the paid paths on/off
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — what the log records