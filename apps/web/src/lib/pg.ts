// Barrel for the feed-db data-access layer. The implementation lives in
// ./db/* split by domain; this file preserves the historical `@/lib/pg`
// import surface so call sites don't need to change.
//
//   connection      — pool/connector lifecycle, query(), withClient()
//   users           — users table
//   feeds           — feeds CRUD + row mapping
//   preview         — feed preview pipeline + result cache + public skeleton
//   chat            — chat_messages
//   feedback        — feedback table
//   subscribers     — landing-page mailing list
//   rerank-prompts  — saved reranker prompts + versions (/search)
//   search-runs     — search run telemetry (/search)
//   ai-labels       — Hive AI-image-label cache (ai_image_labels)
//
// Filter translation (MechanicalFilters → SearchFilter) is feed-config domain
// logic and lives in ./db/filters; it is intentionally not part of this
// data-access surface.

export * from "./db/connection";
export * from "./db/users";
export * from "./db/feeds";
export * from "./db/preview";
export * from "./db/seen";
export * from "./db/chat";
export * from "./db/feedback";
export * from "./db/subscribers";
export * from "./db/rerank-prompts";
export * from "./db/search-runs";
export * from "./db/ai-labels";
