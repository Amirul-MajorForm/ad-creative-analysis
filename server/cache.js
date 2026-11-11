// Small JSON file cache so a page reload doesn't burn through the TMR
// run-query rate limit (15/min, 500/hour).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// On Railway, use the attached volume (if any) so the cache survives redeploys.
const CACHE_DIR =
  process.env.CACHE_DIR ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "cache")) ||
  path.resolve("data/cache");
const TTL_MS = (Number(process.env.CACHE_TTL_HOURS) || 12) * 3600 * 1000;

function fileFor(key) {
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${hash}.json`);
}

export async function getCached(key) {
  try {
    const raw = await fs.readFile(fileFor(key), "utf8");
    const entry = JSON.parse(raw);
    if (entry.key !== key || Date.now() - entry.savedAt > TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function setCached(key, value) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const entry = { key, savedAt: Date.now(), value };
  await fs.writeFile(fileFor(key), JSON.stringify(entry));
  return entry;
}
