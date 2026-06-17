import { NextResponse } from "next/server";
import { BskyWriteError } from "./bsky-write";

/**
 * Convert a thrown value into a JSON error response: `{ error: <message> }`.
 *
 * Errors that carry their own HTTP status (e.g. `BskyWriteError` from the
 * Bluesky write helpers) surface that status; anything else is a 500. When a
 * `label` is given, the error is logged — `console.error` for 5xx (keeps the
 * stack), `console.warn` for client-side statuses.
 *
 * Centralizes the `catch (e) { ... return NextResponse.json(...) }` block that
 * was duplicated across API routes.
 */
export function jsonError(e: unknown, label?: string): NextResponse {
  const status = e instanceof BskyWriteError ? e.status : 500;
  const message = e instanceof Error ? e.message : "Internal error";
  if (label) {
    (status >= 500 ? console.error : console.warn)(`[${label}]`, e);
  }
  return NextResponse.json({ error: message }, { status });
}
