#!/usr/bin/env bash
# Throwaway Postgres for the CRM database tests. Local to this machine, synthetic data only.
#
#   scripts/rebattery/crm-test-db.sh up     # start, load schema.sql and every migration, print the URL
#   scripts/rebattery/crm-test-db.sh down   # stop and delete it
#
# Then, from apps/web:
#   BULK_TRADES_TEST_DATABASE_URL=<url> NODE_ENV=test npx vitest run lib/crm-postgres
set -euo pipefail

NAME="${CRM_TEST_DB_NAME:-crm-test-db}"
PORT="${CRM_TEST_DB_PORT:-55433}"
URL="postgres://postgres:test@127.0.0.1:${PORT}/denchclaw"
SQL_DIR="$(cd "$(dirname "$0")/../../apps/web/lib/crm-postgres" && pwd)"

case "${1:-}" in
  up)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "$NAME is already running. Run '$0 down' first for a clean database." >&2
      exit 1
    fi
    docker run -d --rm --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
      -e POSTGRES_PASSWORD=test -e POSTGRES_DB=denchclaw postgres:16 >/dev/null
    for _ in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres -q && break; sleep 1; done
    # schema.sql, then migrations in file-name order (two files share the 003 prefix; both load).
    for file in "$SQL_DIR/schema.sql" $(ls "$SQL_DIR"/migrations/*.sql | sort); do
      docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -d denchclaw -v ON_ERROR_STOP=1 -q < "$file" >/dev/null \
        || { echo "Failed loading $(basename "$file")" >&2; exit 1; }
    done
    echo "$URL"
    ;;
  down)
    docker stop "$NAME" >/dev/null && echo "Stopped $NAME"
    ;;
  *)
    echo "Usage: $0 up|down" >&2
    exit 2
    ;;
esac
