/**
 * Client-side Bluesky handle validation, shared by every surface that takes
 * a free-text handle before starting the OAuth flow. Catches the common
 * mistake of typing a bare username ("lolorara06") instead of the full
 * handle ("lolorara06.bsky.social") before we round-trip to the server,
 * where the identity resolver rejects it with an opaque 500.
 */

/** Trim whitespace and strip a leading "@" from user input. */
export function cleanBskyHandle(input: string): string {
  return input.trim().replace(/^@/, "");
}

// AT Protocol handle syntax: dot-separated DNS labels, each 1..63 chars of
// [a-zA-Z0-9-] not starting/ending with a hyphen; the final label must start
// with a letter. (Matches @atproto/syntax's isValidHandle.)
const HANDLE_RE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Returns a user-facing error message for an invalid handle, or null if the
 * handle is plausibly valid. Expects input already passed through
 * cleanBskyHandle; empty input returns null (callers no-op on empty).
 */
export function bskyHandleError(handle: string): string | null {
  if (!handle) return null;
  if (!handle.includes(".")) {
    return "Enter your full handle, including the domain, like yourname.bsky.social";
  }
  if (handle.length > 253 || !HANDLE_RE.test(handle)) {
    return "That doesn't look like a valid Bluesky handle, like yourname.bsky.social";
  }
  return null;
}
