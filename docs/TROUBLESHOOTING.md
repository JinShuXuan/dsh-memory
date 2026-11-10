# Troubleshooting

Start every investigation in the log: `<root>/memory.log` (default `~/.dsh-memory/memory.log`). It rotates at 5 MB into `memory.log.1`, so the previous run is still there.

| Symptom | Most likely cause | Jump to |
|---|---|---|
| No `memory_*` tools at all | Plugin not loaded / DSH not restarted | [Tools are missing](#tools-are-missing) |
| Search works, "related meaning" does not | Embedding model absent — FTS fallback | [Model download fails / offline](#model-download-fails--offline) |
| Extraction never produces facts | `extractor.enabled: false`, no key, or budget spent | [Extraction does nothing](#extraction-does-nothing) |
| Nothing is injected into the prompt | `gate: shadow`/`off`, window exhausted, or no hits | [Nothing is injected](#nothing-is-injected) |
| `EACCES` / `EPERM` / `EROFS` | Permissions on the data root | [Permissions](#permissions) |
| Weird paths on Windows | Hardcoded legacy root or unescaped backslashes | [Windows paths](#windows-paths) |
| Index corrupted or stale | `memory.db` damaged | [Rebuild the index](#rebuild-the-index) |
| Vector search off after install | Optional dependency skipped | [Optional dependencies missing](#optional-dependencies-missing) |

---

## Tools are missing

The plugin is a bundle: it only loads when the profile's dependency list **and** its `dsh.profile.bundles` array both mention it, and only after a restart.

1. Confirm registration: `dsh plugin --profile <profile> list | grep dsh-memory`.
2. Fully quit DSH (close the tray/background process, not just the window) and start it again.
3. Look for the bundle id near the top of `memory.log`. Nothing at all means the module never loaded — check the install route in [INSTALL.md](INSTALL.md).

With a `link:` install, the first suspect is a moved folder: the profile stores the path, and a missing path fails silently at load time.

## Model download fails / offline

Vector search needs `Xenova/bge-small-zh-v1.5`. It is fetched once (about 30 MB) into `<root>/models/Xenova/bge-small-zh-v1.5` — specifically `onnx/model_quantized.onnx` and `tokenizer.json`.

When it cannot be fetched or loaded, **the plugin keeps working**: retrieval falls back to FTS-only, and `memory_health` reports the degraded state. You lose semantic matching (paraphrases, synonyms), not the store.

Options:

| Situation | Do this |
|---|---|
| Corporate proxy / TLS interception | Set `HTTPS_PROXY` before starting DSH |
| No network at all | `DSH_MEMORY_NO_DOWNLOAD=1` — start fast, FTS-only, no retry churn |
| You already have the files | Point `DSH_MEMORY_MODEL_DIR` at the directory that contains `Xenova/bge-small-zh-v1.5` |
| Download stalls repeatedly | Fetch the two files manually with a browser into the path above, then restart |
| Non-ASCII characters in the path | Move the root (or `DSH_MEMORY_MODEL_DIR`) to an ASCII-only directory — native ONNX loading is the most common victim of such paths |

Verify with `memory_health`: it reports whether the vector model is ready or whether the store is running FTS-only.

## Extraction does nothing

LLM extraction is **off by default** and has four independent gates. Check them in order:

1. `extractor.enabled` is `true`.
2. A key resolves — `DSH_MEMORY_API_KEY` or `extractor.apiKey` — and `baseURL` / `model` are set. All three empty means "never call".
3. The episode is long enough: a turn under 20 characters is not extracted.
4. Budget not spent: `memory_health` shows the month's counter; once exhausted, extraction silently drops to the rule-based extractor.

Also normal: extraction is asynchronous and single-flight. If one extraction is running, a second trigger returns 0 instead of queueing. Failures retry up to 3 times, then the segment is marked failed and will not be retried.

## Nothing is injected

Injection is easy to switch off by accident:

- `gate: "off"` — silent. `gate: "shadow"` — retrieves and logs, injects nothing. Only `"assist"` injects (the default).
- The per-session window (`sessionInjects` / `sessionInjectWindow`) is spent. The default is 6 injections per 40-turn sliding window; a long session will stop injecting, which is intended.
- The same query in the same turn is deduplicated — it never injects twice.
- No hits above the threshold. An empty query deliberately returns zero results (since 2026-11-10) rather than six arbitrary cards.

Use `shadow` while tuning: the log then shows what *would* have been injected without changing the prompt.

## Permissions

Typical messages: `EACCES`, `EPERM`, `EROFS`, or "cannot write config".

- The plugin must be able to create and write `<root>` (`mkdir -p ~/.dsh-memory` yourself if a parent directory is protected).
- `config.json` is written atomically with `0600`. If the file was created earlier by another user or an admin shell, rewriting it fails — `chmod 600` it, or delete it and let the plugin recreate it.
- Antivirus / controlled-folder-access on Windows blocks writes under the user profile for some processes. Add an exclusion for the data root or move it elsewhere with `DSH_MEMORY_ROOT`.
- A read-only or roaming home directory is not supported; point `DSH_MEMORY_ROOT` at a local writable path.

## Windows paths

- **Legacy root.** An old Windows build hard-coded a `dsh-memory` folder at the root of a specific drive instead of using the home directory. The current `paths.js` still recognises that folder, but **nothing is moved automatically**: it only reports the legacy location. Two clean options:
  - Keep using it: set `DSH_MEMORY_ROOT` to that folder (or `root` in config) and restart.
  - Move forward: copy `global/`, `index/` and `config.json` into `%USERPROFILE%\.dsh-memory`, restart, confirm the fact count in `memory_health`, then archive the old folder. The migration helper copies without deleting the source.
- **Backslashes in JSON.** `config.json` is JSON: `"root": "C:\\Users\\me\\memory"` (escaped) or `"root": "C:/Users/me/memory"` (forward slashes). A single `\U` is an invalid escape and the whole file fails to parse.
- **`~` is not expanded.** In `root`, write an absolute path or omit the key entirely.
- **Paths with spaces** are fine; paths with non-ASCII characters are fine for the store but occasionally break native modules — see the model section.
- **OneDrive / network shares.** SQLite over a synced or networked folder can corrupt under concurrent access. Keep the root on a local disk.

## Optional dependencies missing

Three dependencies are optional: `onnxruntime-node` and `@huggingface/tokenizers` (embeddings) and `pdfjs-dist` (PDF ingest). An install that skipped optional dependencies still loads — with a quieter feature set.

Symptoms:

- `Cannot find module 'onnxruntime-node'` (or the tokenizer package) in `memory.log`, retrieval answering only exact/keyword matches.
- `paper ingest` failing on `.pdf` while `.md` / `.txt` import fine.

Fix:

```sh
# inside the profile that hosts the plugin, or in the package directory for a link: install
npm install --include=optional
```

Offline or behind a mirror? Either pre-populate the npm cache/registry mirror, or install the two packages from a local tarball. If neither is possible, accept FTS-only: set `DSH_MEMORY_NO_DOWNLOAD=1` so the plugin stops retrying the model download and stays quiet.

## Rebuild the index

The Markdown files under `global/facts/` are the source of truth; `index/memory.db` is derived and may be rebuilt.

```sh
# stop DSH first
mv ~/.dsh-memory/index/memory.db ~/.dsh-memory/index/memory.db.bak
# start DSH — a fresh index is created and repopulated from the Markdown files
```

If the result looks wrong, keep the backup and file an issue with the last 50 lines of `memory.log`. Never delete `global/facts/` to "reset" — that is the data.

## Log locations

| File | Contents |
|---|---|
| `<root>/memory.log` | Current run: startup, tool registration, injections, extraction outcomes, budget, errors |
| `<root>/memory.log.1` | Previous run (kept when the current log passes 5 MB) |
| DSH's own logs | Bundle loading and host-level errors — check these if `memory.log` does not exist at all |

A log line per turn is expected. Logs can include fact ids and short excerpts; treat the file as sensitive as the store itself.

Still stuck? Open an issue with: OS, DSH version, how you installed (npm / GitHub / link), the `memory_health` output, and the tail of `memory.log`. Do not paste API keys.