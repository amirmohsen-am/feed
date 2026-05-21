/**
 * Watch the local ADC credentials file and notify subscribers when it
 * changes. Used by our cached singletons (pg pools, Cloud SQL connectors,
 * GCP service clients) to drop their state after the user re-runs
 * `gcloud auth application-default login` — so the next request rebuilds
 * everything with the fresh refresh token, no dev-server restart needed.
 *
 * Dev-only: guarded by `NODE_ENV !== "production"` and the watcher is
 * silently a no-op if the ADC file doesn't exist (Cloud Run has no ADC
 * file; it uses metadata-server creds).
 */

import { watch, type FSWatcher } from "fs";
import { homedir } from "os";
import { join } from "path";

function adcPath(): string {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

const handlers = new Set<() => void>();
let watcher: FSWatcher | null = null;
let warned = false;

function ensureWatcher() {
  if (watcher) return;
  if (process.env.NODE_ENV === "production") return;
  const p = adcPath();
  try {
    watcher = watch(p, { persistent: false }, (event) => {
      // `gcloud auth application-default login` rewrites the file atomically
      // (rename), so we typically see a "rename" event. Some platforms emit
      // "change" instead — handle both.
      if (event === "rename" || event === "change") {
        console.log(`[adc-watcher] ${p} ${event} — resetting GCP caches`);
        for (const h of handlers) {
          try { h(); } catch (e) {
            console.warn("[adc-watcher] handler threw:", e);
          }
        }
        // On macOS, fs.watch loses the watch after a rename. Re-arm.
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        // Defer slightly so the new file is in place before re-watching.
        setTimeout(ensureWatcher, 250);
      }
    });
  } catch (e) {
    if (!warned) {
      console.warn(
        `[adc-watcher] not watching ${p} (probably absent): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      warned = true;
    }
  }
}

/**
 * Register a callback to run when the ADC credentials file changes.
 * Handler should drop any cached auth-bearing state (pool, connector,
 * GCP service client) so the next request rebuilds it.
 */
export function onAdcChange(handler: () => void): void {
  handlers.add(handler);
  ensureWatcher();
}
