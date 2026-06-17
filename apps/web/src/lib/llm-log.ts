/**
 * Structured per-call logging for Anthropic API calls.
 *
 * Emits one JSON line per LLM call to stdout. On Cloud Run, Cloud Logging
 * parses the line into a structured jsonPayload, so calls are queryable by
 * any field, e.g.:
 *
 *   jsonPayload.event="llm_call" AND jsonPayload.feed_id=419
 *
 * `tool_calls` captures the full tool inputs — this is the audit trail of
 * what the chat agent actually changed (chat_messages only stores text).
 * `request_id` is Anthropic's trace ID for support escalation.
 */

import type Anthropic from "@anthropic-ai/sdk";

export function logLlmCall(opts: {
  // Stable identifier for the call site, e.g. "chat", "rerank".
  callSite: string;
  message: Anthropic.Message;
  // From `response._request_id` (create) or `stream.request_id` (streaming).
  requestId: string | null | undefined;
  feedId?: number;
  ms: number;
  // Call-site-specific fields, merged into the log line.
  extra?: Record<string, unknown>;
}): void {
  const { message } = opts;
  console.log(
    JSON.stringify({
      event: "llm_call",
      call_site: opts.callSite,
      feed_id: opts.feedId,
      model: message.model,
      request_id: opts.requestId ?? null,
      stop_reason: message.stop_reason,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
      tool_calls: message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ name: b.name, input: b.input })),
      ms: Math.round(opts.ms),
      ...opts.extra,
    })
  );
}
