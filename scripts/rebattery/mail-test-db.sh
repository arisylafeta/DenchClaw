#!/usr/bin/env bash
# Throwaway Postgres for the mail CLI and mail library tests. Synthetic data only.
#
#   scripts/rebattery/mail-test-db.sh up     # start, load schema.sql and every migration, print the DSN
#   scripts/rebattery/mail-test-db.sh down   # stop and delete it
#
# Seed core objects before object-layout migrations; the live chain has no 034.
set -euo pipefail

NAME="${MAIL_TEST_DB_NAME:-crm-test-mail}"
PORT="${MAIL_TEST_DB_PORT:-55470}"
SQL_DIR="$(cd "$(dirname "$0")/../../apps/web/lib/crm-postgres" && pwd)"
PSQL=(docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$NAME" psql -U postgres -d denchclaw -v ON_ERROR_STOP=1 -q)

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --rm --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
      -e POSTGRES_PASSWORD=test -e POSTGRES_DB=denchclaw postgres:16 >/dev/null
    for _ in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres -q && break; sleep 1; done
    sleep 2
    for file in "$SQL_DIR/schema.sql" $(ls "$SQL_DIR"/migrations/*.sql | sort); do
      "${PSQL[@]}" < "$file" >/dev/null || { echo "Failed loading $(basename "$file")" >&2; exit 1; }
      if [[ "$(basename "$file")" == schema.sql ]]; then
        "${PSQL[@]}" -c "insert into crm_objects (id, name, entity_table, display_field) values ('obj_people','people','crm_people','full_name'), ('obj_company','company','crm_companies','name') on conflict do nothing" >/dev/null
      fi
      if [[ "$(basename "$file")" == 050_mail_log.sql ]]; then
        "${PSQL[@]}" -c 'create database mail_pre_cutover_test template denchclaw' >/dev/null
      fi
    done
    echo "dbname=denchclaw host=127.0.0.1 port=${PORT} user=postgres password=test"
    ;;
  down)
    docker stop "$NAME" >/dev/null && echo "Stopped $NAME"
    ;;
  *)
    echo "Usage: $0 up|down" >&2
    exit 2
    ;;
esac
