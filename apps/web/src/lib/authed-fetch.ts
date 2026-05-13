import { auth } from "./firebase";

export interface ApiErrorDetail {
  url: string;
  status: number;
  message: string;
  hint?: string;
}

/**
 * Fetch wrapper that automatically includes the Firebase ID token.
 *
 * On any non-OK response, also dispatches a `ripple:api-error` CustomEvent
 * on `window` with the URL, status, and best-effort error message. The
 * `<ServerErrorToast />` component in the root layout listens for these
 * and renders a banner — so individual call sites don't need to do
 * anything to surface server errors.
 *
 * Streaming consumers (NDJSON, SSE) that don't await `.json()` still get
 * an event for the initial status; per-chunk failures during streaming
 * are the caller's responsibility.
 */
export async function authedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const user = auth.currentUser;
  const headers = new Headers(options.headers);

  if (user) {
    const token = await user.getIdToken();
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...options, headers });

  if (!res.ok && typeof window !== "undefined") {
    // Clone so callers can still read the body themselves.
    const clone = res.clone();
    const ct = clone.headers.get("content-type") || "";
    let message = `${res.status} ${res.statusText || "Error"}`;
    let hint: string | undefined;
    try {
      if (ct.includes("application/json")) {
        const data = (await clone.json()) as {
          error?: string;
          message?: string;
          hint?: string;
        };
        if (data.message) message = data.message;
        else if (data.error) message = data.error;
        if (data.hint) hint = data.hint;
      }
    } catch {
      /* response body unparseable — keep status-line message */
    }
    if (!hint && res.status >= 500 && process.env.NODE_ENV !== "production") {
      hint =
        "In local dev this is usually a stale ADC session — try " +
        "`gcloud auth application-default login` and reload.";
    }
    const detail: ApiErrorDetail = { url, status: res.status, message, hint };
    window.dispatchEvent(new CustomEvent("ripple:api-error", { detail }));
  }

  return res;
}
