# Configuration

Every setting lives in one JSON file:

```
<root>/config.json
```

`<root>` is `~/.dsh-memory` unless overridden. The file is written with the full default set the first time the plugin loads, deep-merged over the built-in defaults on every load, and saved atomically with `0600` permissions. A partial file is fine: absent keys fall back to the defaults below.

**Changes take effect after restarting DSH.** Editing the file while DSH runs is safe (the plugin re-reads on start), it just will not apply until then.

Two settings are read from the environment first, or rather the environment *is* their default:

| Variable | Meaning |
|---|---|
| `DSH_MEMORY_ROOT` | Data root used when `root` is empty. **`root` in the file wins over it** |
| `DSH_MEMORY_MODEL_DIR` | Where the embedding model is looked up (no config equivalent) |
| `DSH_MEMORY_NO_DOWNLOAD=1` | Disables model download (no config equivalent) |
| `DSH_MEMORY_API_KEY` | Key for extraction/induction/replay. Wins over `extractor.apiKey` and `extractor.apiKeyEnv` |

For every key except `root`, the file is the only source.

---

## Quick recipes

**Do nothing.** Defaults store and retrieve locally, never call a model, never spend.

**Turn on LLM extraction:**

```jsonc
{
  "extractor": {
    "enabled": true,
    "baseURL": "https://api.example.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "DSH_MEMORY_API_KEY"
  },
  "budget": { "monthlyYuan": 10 }
}
```

**Observe without injecting** (good for tuning):

```jsonc
{ "gate": "shadow" }
```

**Move the data root:**

```jsonc
{ "root": "/absolute/path/to/memory" }
```

---

## Top level

| Key | Type | Default | Effect | Blast radius |
|---|---|---|---|---|
| `schema_version` | number | `2` | Config schema version. Managed by the plugin; do not edit | A manual downgrade triggers a migration warning |
| `root` | string | `""` (→ `~/.dsh-memory`) | Data root. Empty means "resolve": `DSH_MEMORY_ROOT`, then the home default. Wins over the env var | Everything. Move it and you start from an empty store |
| `ui` | object | `{ "lang": "auto" }` | Settings-panel preferences: `lang` follows the UI language by default | Cosmetic only; no effect on memory behaviour |
| `gate` | `"off"` \| `"shadow"` \| `"assist"` | `"assist"` | `off` = never inject; `shadow` = retrieve and log but never inject; `assist` = inject into the turn. The old value `"enforce"` is read as `assist` | Prompt shape. `shadow` is the safe way to experiment |
| `hits` | number | `6` | Maximum memory cards injected per turn | More cards = more context, less room for the actual conversation |
| `hitsChars` | number | `800` | Character budget for those cards | Token cost per turn |
| `rulesChars` | number | `800` | Character cap for the resident card in the system prompt | The resident card is re-sent every step — raising this costs on every turn |
| `sessionInjects` | number | `6` | Maximum injections per window | Noise; long sessions get quieter |
| `sessionInjectWindow` | number | `40` | Window (in turns) the budget is counted over; `0` = whole-session lifetime quota (old behaviour) | Set `0` only if you want the pre-2026-11-10 behaviour |

## `extractor` — turning conversations into facts

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. `false` = local rule extractor only, zero spend |
| `baseURL` | string | `""` | OpenAI-compatible endpoint, e.g. `https://api.example.com/v1`. Empty = never call |
| `model` | string | `""` | Model id used for extraction |
| `apiKey` | string | `""` | Key in the file. Prefer `DSH_MEMORY_API_KEY` |
| `apiKeyEnv` | string | `""` | Name of an env var to read the key from. Resolution order: `DSH_MEMORY_API_KEY` → the env var named here → `apiKey` in the file |
| `maxFactsPerTurn` | number | `5` | Upper bound of facts requested per turn (10 is a practical ceiling) |
| `timeoutMs` | number | `20000` | Per-request timeout. A timeout counts as a failed attempt |

Extraction runs asynchronously after a turn, single-flight, only on episodes of 20+ characters. Failures retry up to 3 times, then the episode is marked failed permanently.

## `promote` — when a repeated mention becomes a fact

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Allow the rule extractor to promote repeated mentions |
| `minAtoms` | number | `5` | How many mentions before promotion is considered |

## `link` — the association graph

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` disables edge building *and* neighbour expansion |
| `maxOut` | number | `10` | Out-degree cap per node; weakest edges are pruned first |
| `similarMin` | number | `0.82` | Cosine threshold for a "similar" edge. Lower = denser graph, noisier neighbours |
| `similarTop` | number | `3` | How many most-similar nodes each new node connects to |
| `sameFactCos` | number | `0.8` | At or above this, a same-slot write is treated as an amendment (`supersede`) rather than a second fact |
| `sameEpisode` | number | `0.8` | Edge weight: two facts learned from the same episode |
| `sameSession` | number | `0.45` | Edge weight: same session, different episode |
| `expandHits` | number | `3` | How many hits are used as seeds for neighbour expansion |
| `expandTop` | number | `2` | Neighbours injected per turn |
| `expandChars` | number | `140` | Character cap for the neighbour line |

Edge weights are combined with cosine similarity; `maxOut` bounds how large the graph can get. Turning `link.enabled` off is the cheapest way to cut retrieval noise.

## `decay` — forgetting, reversibly

Activation is computed on read, never stored:

```
activation = min( max(prot, 0.55·fresh + 0.30·freq + conn), 1.2 )
fresh = exp(-days / tau)     freq = min(log(1+access)/log(11), 1)
conn  = min(degree,10)/10 · 0.15
prot  = pinned ? 1 : (user_explicit ? 0.9 : 0)
```

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for decay and archiving |
| `auto` | boolean | `true` | Run the sweep at startup when the last one was more than 24 h ago. `false` = manual (`memory_decay`) only |
| `tauDays` | number | `45` | Time constant; roughly a 31-day half-life |
| `archiveDays` | number | `90` | A fact must be untouched this long before archiving is considered |
| `archiveBelow` | number | `0.18` | …and its activation must be below this |
| `maxPerCluster` | number | `8` | Above this many facts for one subject, low scorers lose their frequency bonus |
| `archivedFactor` | number | `0.5` | Retrieval weight multiplier for archived facts |
| `touchThrottleMs` | number | `60000` | One access record per fact per minute |
| `subjectOverrides` | object | `{ "assistant": { "tauDays": 20, "archiveDays": 30 } }` | Per-subject overrides. The assistant's own conclusions fade faster than user preferences |

Archiving never deletes. Pinned facts and `user_explicit` facts are never archived.

## `abstract` — induction

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Allow induction at all |
| `auto` | boolean | `false` | Automatic recomputation. Off by default: quality deserves a human look |
| `minAtoms` | number | `4` | Minimum facts in a cluster before induction is attempted |
| `sample` | number | `12` | Maximum facts sent to the model |
| `maxPerRun` | number | `3` | Maximum summaries produced per run |
| `staleAfter` | number | `2` | This many changed facts in the cluster mark an existing summary stale |
| `autoPerSweep` | number | `2` | Clusters recomputed per automatic sweep |
| `staleWeight` | number | `0.8` | Retrieval weight of a stale summary (fresh ones get `1.2`) |
| `llm.model` | string | `""` | Model for induction. Empty = reuse `extractor.model` |
| `llm.baseURL` | string | `""` | Empty = reuse `extractor.baseURL` |
| `llm.apiKey` | string | `""` | Empty = reuse the extractor key resolution |
| `llm.timeoutMs` | number | `30000` | Per-request timeout for induction |

Summaries are an index, not a replacement: they link back to the facts they came from, and the facts stay.

> **Note on the induction endpoint.** The same four values also work as flat keys directly under `abstract.*` (`abstract.model`, `abstract.baseURL`, `abstract.apiKey`, `abstract.timeoutMs`); those are what the induction path reads today, while `abstract.llm.*` is the grouped form. When both are set, the flat key wins. Leave everything empty to inherit `extractor.*`.

## `replay` — periodically re-reading old conversations

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Allow replay |
| `auto` | boolean | `false` | Off by default: run it manually for a while and check the yield first |
| `maxAttempts` | number | `3` | A conversation is re-read at most this many times — a hard cost bound |
| `settleAfter` | number | `2` | This many consecutive runs with nothing new marks the segment settled |
| `perRun` | number | `20` | Segments selected per run |
| `maxCalls` | number | `5` | Model calls per run (same-session segments are merged) |

Replay is checked at startup only, and only when the previous run was more than 24 h ago.

## `budget` — the spend cap

| Key | Type | Default | Effect |
|---|---|---|---|
| `monthlyYuan` | number | `20` | Estimated ceiling per calendar month |
| `costPerCallYuan` | number | `0.005` | Coarse per-call estimate (≈1500 in + 300 out tokens) |

Every model call increments a counter in the database. When the month's estimate is exhausted, calls stop: extraction falls back to local rules, induction and replay skip. This is a guard rail, not an invoice — your provider bills by real tokens.

---

## Reading the file safely

- **It is created for you.** On first load the plugin writes the complete default set to `config.json`, so you can open it and edit in place instead of guessing keys.
- **Backslashes.** JSON strings: `"root": "C:\\memory"` or `"root": "C:/memory"`. A lone `\m` is invalid JSON and the whole file is ignored.
- **`~` is not expanded.** `root` must be absolute or omitted.
- **Unknown keys are ignored**; they do not crash the plugin.
- **Older files migrate automatically** to the current schema (`schema_version: 2`).
- **A corrupt file does not brick memory:** unreadable JSON falls back to defaults and the store still opens. Fix or delete `config.json` and restart.

### Warnings you may see in `memory.log`

| Warning | Meaning |
|---|---|
| `config.json` could not be created | Permissions on the data root — see [TROUBLESHOOTING](TROUBLESHOOTING.md#permissions) |
| config parse failed, defaults used | Invalid JSON; fix the file |
| migrated from v1 to v2 | One-time, informational |
| `gate=enforce` rewritten to `assist` | The old level was merged into `assist` |
| plaintext `apiKey` in `config.json` | Move the key to `DSH_MEMORY_API_KEY` |
| `extractor.enabled` without `baseURL`/`model` | Extraction will not fire |

## Checking what is in effect

`memory_health` reports the resolved root, the model state, the fact count, and the effective gate. If a value surprises you, check for a competing environment variable first — env beats file.

---

## Related

- [PRIVACY.md](PRIVACY.md) — key handling and what each paid path sends
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — when a setting seems ignored