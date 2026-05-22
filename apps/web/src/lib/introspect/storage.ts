/**
 * Local JSON storage for introspection snapshots, one file per handle.
 *
 * Path: apps/web/.local-data/introspect/<safe-handle>.json
 *
 * Cloud Run filesystems are ephemeral; this is demo-grade per the PRD. If we
 * later need persistence across restarts, swap this adapter for Postgres or
 * GCS-backed JSON — nothing else changes.
 */

import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "./types";

// Resolved relative to the Next.js process cwd, which is the `apps/web/`
// directory for both `next dev` and the standalone Cloud Run image.
const ROOT = ".local-data/introspect";

let _dirReady = false;
async function ensureDir() {
  if (_dirReady) return;
  await mkdir(ROOT, { recursive: true });
  _dirReady = true;
}

function safeHandle(handle: string): string {
  // Bluesky handles are domain-shaped (a.b.c). Replace anything non-safe with
  // an underscore so they map to valid filenames on every FS.
  return handle.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

function pathFor(handle: string): string {
  return join(ROOT, `${safeHandle(handle)}.json`);
}

export async function readSnapshot(handle: string): Promise<Snapshot | null> {
  await ensureDir();
  try {
    const data = await readFile(pathFor(handle), "utf8");
    return JSON.parse(data) as Snapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSnapshot(snap: Snapshot): Promise<void> {
  await ensureDir();
  // Pretty-print for human inspection (`cat the file` — see PRD decision #7).
  // Cost is ~2x file size for ~500 engagements ≈ a few hundred KB, fine.
  await writeFile(pathFor(snap.handle), JSON.stringify(snap, null, 2));
}

export async function deleteSnapshot(handle: string): Promise<void> {
  await ensureDir();
  try {
    await unlink(pathFor(handle));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Used by the API to enumerate cached snapshots (e.g. for a landing list). */
export async function listSnapshotHandles(): Promise<string[]> {
  await ensureDir();
  const entries = await readdir(ROOT);
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}
