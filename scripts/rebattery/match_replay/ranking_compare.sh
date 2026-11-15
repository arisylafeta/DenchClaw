#!/usr/bin/env bash
# Old versus new supply Matches ranking on live data, read only.
#   ranking_compare.sh <main-worktree> <out-dir>
# Runs the real supplyMatchesV2 from origin/main (<main-worktree>) and from this checkout with MATCH_BUYER_LINES=off and on.
# Off must be byte-identical to origin/main; the on/old difference is the 1c change.
set -euo pipefail
MAIN="$(cd "$1" && pwd)"; OUT="$2"; HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$OUT"; export PGOPTIONS='-c default_transaction_read_only=on'
build() { # name web-root
  sed -e "s|MODULE|$2/lib/crm-postgres/supply-matches-v2|" -e "s|POSTGRES|$2/lib/postgres|" "$(dirname "$0")/ranking_compare_entry.ts" > "$OUT/entry_$1.ts"
  "$HERE/node_modules/.bin/esbuild" "$OUT/entry_$1.ts" --bundle --format=esm --platform=node --outfile="$OUT/$1.mjs" \
    --alias:server-only="$2/lib/empty-module.js" --alias:@="$2" --log-level=error --external:pg-native \
    --banner:js="import {createRequire} from 'module';const require=createRequire(import.meta.url);"
}
build old "$MAIN/apps/web"; build new "$HERE/apps/web"
MATCH_BUYER_LINES=off node "$OUT/old.mjs" > "$OUT/old.json"
MATCH_BUYER_LINES=off node "$OUT/new.mjs" > "$OUT/new_off.json"
MATCH_BUYER_LINES=on node "$OUT/new.mjs" > "$OUT/new_on.json"
cmp "$OUT/old.json" "$OUT/new_off.json" && echo "flag off is identical to origin/main"
