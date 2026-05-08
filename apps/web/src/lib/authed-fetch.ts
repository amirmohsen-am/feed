import { auth } from "./firebase";

/**
 * Fetch wrapper that automatically includes the Firebase ID token.
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

  return fetch(url, { ...options, headers });
}
