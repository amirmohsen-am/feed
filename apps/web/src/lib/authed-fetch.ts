export interface ApiErrorDetail {
  url: string;
  status: number;
  message: string;
  hint?: string;
  /** Seconds from the `Retry-After` header, set on 429 responses. */
  retryAfter?: number;
}

/**
 * Fetch wrapper. The session cookie is sent automatically by the browser.
 *
 * On any non-OK response, dispatches a `ripple:api-error` CustomEvent
 * on `window` so `<ServerErrorToast />` can display a banner.
 */
export async function authedFetch(
  url: string,
  options: RequestInit & { suppressErrorToast?: boolean } = {}
): Promise<Response> {
  const { suppressErrorToast, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);

  if (!headers.has("Content-Type") && fetchOptions.body) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...fetchOptions, headers });

  if (
    !res.ok &&
    !suppressErrorToast &&
    typeof window !== "undefined"
  ) {
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
    const detail: ApiErrorDetail = { url, status: res.status, message, hint };
    const retryAfter = clone.headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      detail.retryAfter = parseInt(retryAfter, 10);
    }
    window.dispatchEvent(new CustomEvent("ripple:api-error", { detail }));
  }

  return res;
}
