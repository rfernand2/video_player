// Per-video cache directory for derived data (frame index, shot scores, scrub
// audio). Keyed by path + size + modification time, so an edited file gets a
// fresh cache.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function cacheDirFor(root, file) {
  const stat = await fs.stat(file);
  const key = createHash('sha1')
    .update(`${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  const dir = path.join(root, key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'source.txt'), file); // also marks the entry as recently used
  return dir;
}

/** Delete cache entries that have not been opened for `maxAgeDays`. */
export async function pruneCache(root, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // nothing cached yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const used = await fs.stat(path.join(dir, 'source.txt'));
      if (used.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
    } catch { /* not one of ours, or in use: leave it */ }
  }
}

export async function readTypedArray(file, Type) {
  const buf = await fs.readFile(file);
  return new Type(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Written via a temp file so an interrupted write never leaves a half-filled cache entry. */
export async function writeTypedArray(file, array) {
  await fs.writeFile(`${file}.part`, Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  await fs.rename(`${file}.part`, file);
}
