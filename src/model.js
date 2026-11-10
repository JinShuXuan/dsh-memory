// 本地向量模型：首次按需下载，失败降级纯 FTS。任何情况下都不 throw。
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_REPO = "Xenova/bge-small-zh-v1.5";
const BASE = `https://huggingface.co/${MODEL_REPO}/resolve/main/`;
const FILES = [
  { remote: "onnx/model_quantized.onnx", local: "onnx/model_quantized.onnx", minBytes: 1_000_000 },
  { remote: "tokenizer.json", local: "tokenizer.json", minBytes: 100_000 },
];

export function modelStatus(dir) {
  try {
    const missing = FILES.filter((f) => !existsSync(join(dir, f.local))).map((f) => f.local);
    const bytes = FILES.reduce((n, f) => {
      try {
        return n + statSync(join(dir, f.local)).size;
      } catch {
        return n;
      }
    }, 0);
    return { present: missing.length === 0, missing, bytes, dir };
  } catch (error) {
    return { present: false, missing: FILES.map((f) => f.local), bytes: 0, dir, error: String(error?.message ?? error) };
  }
}

async function downloadTo(url, dest, minBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`下载内容过小（${buf.length} bytes），可能不是模型文件`);
  mkdirSync(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  return buf.length;
}

/**
 * 确保模型文件就绪；缺失且允许下载时拉取。
 * @returns {Promise<{ready:boolean, path:string, error:(string|null)}>}
 */
export async function ensureModel({ dir, log = () => {}, download = true, env = process.env } = {}) {
  const target = dir || env.DSH_MEMORY_MODEL_DIR;
  if (!target) return { ready: false, path: "", error: "model_dir_unknown" };
  const status = modelStatus(target);
  if (status.present) return { ready: true, path: target, error: null };
  const allowed = download && String(env.DSH_MEMORY_NO_DOWNLOAD ?? "") !== "1";
  if (!allowed) {
    log("model missing, download disabled:", status.missing.join(", "));
    return { ready: false, path: target, error: "download_disabled" };
  }
  try {
    mkdirSync(target, { recursive: true });
    for (const f of FILES) {
      const dest = join(target, f.local);
      if (existsSync(dest)) continue;
      log("model download:", f.remote);
      await downloadTo(BASE + f.remote, dest, f.minBytes);
    }
    const after = modelStatus(target);
    return after.present
      ? { ready: true, path: target, error: null }
      : { ready: false, path: target, error: "incomplete_after_download" };
  } catch (error) {
    log("model download failed:", String(error?.message ?? error));
    try {
      for (const f of FILES) {
        const part = `${join(target, f.local)}.part`;
        if (existsSync(part)) unlinkSync(part);
      }
    } catch {
      /* ignore */
    }
    return { ready: false, path: target, error: String(error?.message ?? error) };
  }
}