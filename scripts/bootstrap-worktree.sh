#!/usr/bin/env bash
# Bootstrap a fresh worktree so typecheck and dev servers work immediately:
# installs deps for both apps and generates the Next.js types (next-env.d.ts
# + .next/types) that `tsc --noEmit` needs — without this, png imports in
# landing.tsx fail with TS2307 until a dev server has run once.
#
# Usage: ./scripts/bootstrap-worktree.sh  (from anywhere)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "── apps/web: npm install + next typegen"
(cd "$ROOT/apps/web" && npm install && npx next typegen)

echo "── apps/jetstream-indexer: npm install"
(cd "$ROOT/apps/jetstream-indexer" && npm install)

echo "── worktree ready: $ROOT"
