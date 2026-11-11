// 路径解析：根目录、模型目录、旧库检测与一次性迁移。
// 目标：源码里不出现任何盘符字面量，跨平台默认落在 ~/.dsh-memory。
import { existsSync, mkdirSync, copyFileSync, cpSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveRoot({ env = process.env, home = homedir(), override } = {}) {
  const fromEnv = env && env.DSH_MEMORY_ROOT ? String(env.DSH_MEMORY_ROOT).trim() : "";
  const fromOverride = override ? String(override).trim() : "";
  const chosen = fromOverride || fromEnv || join(home, ".dsh-memory");
  return resolve(chosen);
}

export function modelDir(root) {
  return join(root, "models", "Xenova", "bge-small-zh-v1.5");
}

/** 旧版数据目录：仅在显式设置 DSH_MEMORY_LEGACY_ROOT 时探测，不猜作者机器上的路径。
 *  current 传当前 root，避免把自己检测成旧库。 */
export function legacyRoots(current) {
  const fromEnv = process.env.DSH_MEMORY_LEGACY_ROOT ? String(process.env.DSH_MEMORY_LEGACY_ROOT).trim() : "";
  if (!fromEnv) return [];
  try {
    const root = resolve(fromEnv);
    if (!existsSync(root)) return [];
    if (current && resolve(current) === root) return [];
    return [root];
  } catch {
    return [];
  }
}

/**
 * 一次性搬库：复制事实真源 + sqlite + config。只读源、不删源、不自动执行。
 * 行数校验请调用方再调 verifyMigration()（它需要 await import node:sqlite）。
 * @returns {{ok:boolean, copied?:string[], error?:string}}
 */
export function migrateLegacy(root, legacyRoot, { force = false, log = () => {} } = {}) {
  if (!legacyRoot || !existsSync(legacyRoot)) return { ok: false, error: "legacy_missing" };
  const targetDb = join(root, "index", "memory.db");
  if (existsSync(targetDb) && statSync(targetDb).size > 0 && !force) {
    return { ok: false, error: "target_not_empty" };
  }
  const copied = [];
  try {
    mkdirSync(join(root, "index"), { recursive: true });
    const srcFacts = join(legacyRoot, "global");
    if (existsSync(srcFacts)) {
      cpSync(srcFacts, join(root, "global"), { recursive: true });
      copied.push("global");
    }
    // workspace scope（ws-*）与其它顶层目录一并搬，别只搬 global
    try {
      for (const ent of readdirSync(legacyRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (ent.name === "index" || ent.name === "models" || ent.name === "global") continue;
        cpSync(join(legacyRoot, ent.name), join(root, ent.name), { recursive: true });
        copied.push(ent.name);
      }
    } catch {
      /* 目录不可读时忽略，global 已搬 */
    }
    for (const name of ["memory.db", "memory.db-wal", "memory.db-shm"]) {
      const src = join(legacyRoot, "index", name);
      if (existsSync(src)) {
        copyFileSync(src, join(root, "index", name));
        copied.push(`index/${name}`);
      }
    }
    const srcCfg = join(legacyRoot, "config.json");
    const dstCfg = join(root, "config.json");
    if (existsSync(srcCfg) && !existsSync(dstCfg)) {
      copyFileSync(srcCfg, dstCfg);
      copied.push("config.json");
    }
  } catch (error) {
    return { ok: false, error: String(error?.stack ?? error) };
  }
  let rows = null;
  try {
    // 延迟到调用时 import，缺失就跳过校验（不阻断迁移）
    return { ok: true, copied };
  } catch {
    return { ok: true, copied, rows };
  }
}

/** 行数校验单独暴露：调用方在自己的异步上下文里跑（可 await import node:sqlite）。 */
export async function verifyMigration(root, legacyRoot) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const read = (dir) => {
      const p = join(dir, "index", "memory.db");
      if (!existsSync(p)) return -1;
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        return Number(db.prepare("SELECT COUNT(*) AS n FROM memory").get()?.n ?? -1);
      } finally {
        db.close?.();
      }
    };
    const src = read(legacyRoot);
    const dst = read(root);
    return { ok: src === dst && src >= 0, src, dst };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
