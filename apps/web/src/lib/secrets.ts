import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { onAdcChange } from "./adc-watcher";

/**
 * Fetch named secrets from Google Secret Manager.
 *
 * Resolution order:
 *   1. If `process.env[envName]` is already set, return it (lets local `.env.local`
 *      or Cloud Run env-var overrides win — handy for testing or for vars not
 *      kept in Secret Manager yet).
 *   2. Otherwise, call Secret Manager's `accessSecretVersion` and cache.
 *
 * The runtime needs `roles/secretmanager.secretAccessor` on each secret. Locally
 * that's whoever ran `gcloud auth application-default login`; on Cloud Run it's
 * the runtime SA `777152549518-compute@developer.gserviceaccount.com`.
 */

const PROJECT = process.env.GCP_SECRETS_PROJECT || "timelines-492720";

const cache = new Map<string, string>();
let _client: SecretManagerServiceClient | null = null;

function client(): SecretManagerServiceClient {
  if (!_client) _client = new SecretManagerServiceClient();
  return _client;
}

// Secret values themselves don't change when ADC rotates — they're the
// secrets, not auth state. But the Secret Manager *client* holds the stale
// refresh token, so any future cache-miss `accessSecretVersion` call would
// fail. Drop it on ADC change so the next fetch rebuilds it.
onAdcChange(() => {
  if (_client !== null) {
    _client = null;
    console.log("[secrets] Secret Manager client reset after ADC change");
  }
});

function envFor(secretName: string): string {
  return secretName.toUpperCase().replace(/-/g, "_");
}

export async function getSecret(secretName: string): Promise<string> {
  const envName = envFor(secretName);
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;

  const cached = cache.get(secretName);
  if (cached) return cached;

  const [version] = await client().accessSecretVersion({
    name: `projects/${PROJECT}/secrets/${secretName}/versions/latest`,
  });
  const value = version.payload?.data?.toString();
  if (!value) throw new Error(`Secret ${secretName} returned an empty payload`);
  cache.set(secretName, value);
  return value;
}

/**
 * Make sure `process.env[envName]` is populated for the duration of the
 * process, fetching from Secret Manager if needed. Useful when an SDK
 * reads its config from `process.env` directly (e.g. `new Anthropic()`).
 */
export async function ensureEnvFromSecret(
  secretName: string
): Promise<void> {
  const envName = envFor(secretName);
  if (process.env[envName]) return;
  process.env[envName] = await getSecret(secretName);
}
