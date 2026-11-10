// 本地 embedding：onnxruntime-node + @huggingface/tokenizers，mean-pooling + L2 归一
// 设计：加载失败不抛错，只把 ready=false / error 记下来，调用方降级到 FTS。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultModelDir() {
  if (process.env.DSH_MEMORY_MODEL_DIR) return process.env.DSH_MEMORY_MODEL_DIR;
  const root = process.env.DSH_MEMORY_ROOT || join(homedir(), ".dsh-memory");
  return join(root, "models", "Xenova", "bge-small-zh-v1.5");
}
const DEFAULT_MODEL_DIR = defaultModelDir();
export const MODEL_VER = "bge-small-zh-v1.5-q8";

export class Embedder {
  constructor({ modelDir = DEFAULT_MODEL_DIR, log = () => {} } = {}) {
    this.modelDir = modelDir;
    this.log = log;
    this.ready = false;
    this.error = null;
    this.dim = 0;
    this.session = null;
    this.tokenizer = null;
    this.loading = null;
    this.calls = 0;
    this.ms = 0;
  }

  /** 幂等初始化；并发调用共享同一次加载 */
  ensure() {
    if (this.ready) return Promise.resolve(true);
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const modelPath = join(this.modelDir, "onnx", "model_quantized.onnx");
        const tokPath = join(this.modelDir, "tokenizer.json");
        if (!existsSync(modelPath) || !existsSync(tokPath)) {
          throw new Error(`model files missing under ${this.modelDir}`);
        }
        const ort = await import("onnxruntime-node");
        const { Tokenizer } = await import("@huggingface/tokenizers");
        this.ort = ort;
        const t0 = performance.now();
        this.tokenizer = new Tokenizer(JSON.parse(readFileSync(tokPath, "utf8")), {});
        this.session = await ort.InferenceSession.create(modelPath, {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
        });
        this.ready = true;
        this.error = null;
        this.log(`embedder ready in ${(performance.now() - t0).toFixed(0)}ms`);
        return true;
      } catch (error) {
        this.error = String(error?.message ?? error);
        this.ready = false;
        this.log("embedder unavailable:", this.error);
        return false;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** @returns {Promise<Float32Array|null>} */
  async embed(text) {
    if (!(await this.ensure())) return null;
    const t0 = performance.now();
    try {
      const enc = this.tokenizer.encode(String(text ?? ""));
      const ids = enc.ids.slice(0, 512);
      if (ids.length === 0) return null;
      const len = ids.length;
      const t = (arr) => {
        const a = new BigInt64Array(len);
        for (let i = 0; i < len; i += 1) a[i] = BigInt(arr[i]);
        return a;
      };
      const feeds = {
        input_ids: new this.ort.Tensor("int64", t(ids), [1, len]),
        attention_mask: new this.ort.Tensor("int64", t(new Array(len).fill(1)), [1, len]),
        token_type_ids: new this.ort.Tensor("int64", t(new Array(len).fill(0)), [1, len]),
      };
      const out = await this.session.run(feeds);
      const hidden = out.last_hidden_state ?? out[Object.keys(out)[0]];
      const [, seq, dim] = hidden.dims;
      const pooled = new Float32Array(dim);
      for (let i = 0; i < seq; i += 1) {
        const off = i * dim;
        for (let d = 0; d < dim; d += 1) pooled[d] += hidden.data[off + d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d += 1) {
        pooled[d] /= seq;
        norm += pooled[d] * pooled[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d += 1) pooled[d] /= norm;
      this.dim = dim;
      this.calls += 1;
      this.ms += performance.now() - t0;
      return pooled;
    } catch (error) {
      this.log("embed failed:", String(error?.message ?? error));
      return null;
    }
  }

  stats() {
    return {
      ready: this.ready,
      error: this.error,
      model_ver: MODEL_VER,
      dim: this.dim,
      calls: this.calls,
      avg_ms: this.calls ? Number((this.ms / this.calls).toFixed(2)) : 0,
    };
  }
}

export function cosine(a, b) {
  // 维度不一致直接判 0：静默按 min(dim) 截断会让不同模型的向量混出错误相似度
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/** Reciprocal Rank Fusion：lists = [{ id, score }...][]，返回 [{id, rrf}] 降序 */
export function rrf(lists, k = 60) {
  const acc = new Map();
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const { id } = list[i];
      acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => y.score - x.score);
}