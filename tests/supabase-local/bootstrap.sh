#!/usr/bin/env bash
# tests/supabase-local/bootstrap.sh — disposable, CI-ONLY Supabase stack for the auth E2E suite (C1).
#
#   bash tests/supabase-local/bootstrap.sh plan
#       Prints the plan (config, ports, schema path, migrations to replay). No side effects;
#       safe anywhere. Starts nothing.
#   bash tests/supabase-local/bootstrap.sh up [--schema-mode full|baseline-only] [--env-out FILE]
#       GitHub-hosted CI runner ONLY. Starts the stack from tests/supabase-local, restores the
#       governed schema baseline, replays newer migrations, health-checks, and (optionally)
#       appends the auth-suite environment to FILE (e.g. "$GITHUB_ENV").
#   bash tests/supabase-local/bootstrap.sh down
#       GitHub-hosted CI runner ONLY. Stops THIS stack (project_id omnivyra-auth-e2e-local)
#       and removes its volumes. Touches nothing else.
#
# Safety: refuses to run `up`/`down` outside a GitHub-hosted runner; refuses if any hosted-
# Supabase variable is set or the workdir carries a hosted link; never falls back to a hosted
# endpoint; validates every endpoint as loopback (same validator as the auth E2E guard);
# never prints keys or the database URL (`supabase start` output is captured to a private
# 0600 file, not the log). Output ends with one line:
#   BOOTSTRAP_RESULT {"status":"ok"|"failed",...}
# Referenced only by .github/workflows/auth-integrity-local.yml (C3, advisory; not yet pushed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKDIR_REL="tests/supabase-local"
WORKDIR="$ROOT/$WORKDIR_REL"
PLAN=(node "$ROOT/node_modules/tsx/dist/cli.mjs" "$WORKDIR/localStackPlan.ts")
PINNED_CLI="2.122.0"
BASELINE="$ROOT/supabase/_schema/baseline.sql"
EXTENSIONS="$WORKDIR/stack-extensions.sql"

STAGE="startup"
SCHEMA_MODE="full"
ENV_OUT=""
RUN_DIR=""
COMPLETE=0
WARNINGS=""
REPLAYED=0
TABLES=""

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
result() {
  local status="$1"
  printf 'BOOTSTRAP_RESULT {"status":"%s","stage":"%s","schemaMode":"%s","tables":"%s","migrationsReplayed":%s,"warnings":"%s"}\n' \
    "$status" "$STAGE" "$SCHEMA_MODE" "$TABLES" "$REPLAYED" "$(json_escape "$WARNINGS")"
}
fail() { printf 'FAIL [%s]: %s\n' "$STAGE" "$*" >&2; exit 1; }
on_exit() {
  local code=$?
  if [ "$COMPLETE" != "1" ]; then result failed; fi
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ]; then rm -f -- "$RUN_DIR/status.env" "$RUN_DIR/auth.env" "$RUN_DIR/stack.env" "$RUN_DIR/start.log"; fi
  exit "$code"
}
trap on_exit EXIT

require_tool() { command -v "$1" >/dev/null 2>&1 || fail "required tool '$1' is not on PATH"; }

# Connection hygiene (v3; review finding F15). psql runs with an EMPTY environment apart from PATH
# and a private HOME, and -X, so no PG* variable (PGHOSTADDR, PGSERVICE, PGSYSCONFDIR, ...), no
# ~/.pg_service.conf / ~/.pgpass and no psqlrc can change where it connects or what it runs.
# curl ignores every proxy variable and ~/.curlrc (-q), and never follows a redirect. The Supabase
# CLI runs without the app variables this script exports (it must see only its own config).
run_psql() { env -i PATH="$PATH" HOME="$RUN_DIR" LC_ALL=C psql -X "$@"; }
run_curl() { curl -q --noproxy '*' --proto '=http' --max-redirs 0 "$@"; }
run_supabase() { env -u SUPABASE_URL -u SUPABASE_SECRET_KEY -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY supabase "$@"; }

preflight_runner() {
  STAGE="preflight"
  "${PLAN[@]}" check-ci
  "${PLAN[@]}" check-env
  require_tool supabase; require_tool docker; require_tool psql; require_tool curl; require_tool node
  local v
  v="$(run_supabase --version 2>/dev/null | tr -d '\r' | head -1)"
  [ "$v" = "$PINNED_CLI" ] || fail "Supabase CLI version is '$v'; this bootstrap is pinned to $PINNED_CLI (see README)"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  plan)
    STAGE="plan"
    "${PLAN[@]}" plan
    COMPLETE=1; result ok
    exit 0
    ;;
  down)
    preflight_runner
    STAGE="down"
    run_supabase stop --workdir "$WORKDIR" --no-backup
    COMPLETE=1; result ok
    exit 0
    ;;
  up) ;;
  *) STAGE="usage"; fail "usage: bootstrap.sh plan | up [--schema-mode full|baseline-only] [--env-out FILE] | down" ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --schema-mode) SCHEMA_MODE="${2:-}"; shift 2 ;;
    --env-out) ENV_OUT="${2:-}"; shift 2 ;;
    *) fail "unknown argument '$1'" ;;
  esac
done
case "$SCHEMA_MODE" in
  full) ;;
  baseline-only) WARNINGS="migrations newer than the baseline were NOT replayed (explicit --schema-mode baseline-only)" ;;
  *) fail "--schema-mode must be 'full' or 'baseline-only'" ;;
esac

preflight_runner
"${PLAN[@]}" plan
[ -f "$BASELINE" ] || fail "missing supabase/_schema/baseline.sql"
[ -f "$EXTENSIONS" ] || fail "missing $WORKDIR_REL/stack-extensions.sql"
RUN_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/supabase-local.XXXXXX")"
chmod 700 "$RUN_DIR"

STAGE="start"
# `supabase start` prints the local API keys and DB URL on success (review finding F6). Its output
# goes to a 0600 file in RUN_DIR (never uploaded, removed on exit); on failure only credential-free
# lines are shown.
: > "$RUN_DIR/start.log"
chmod 600 "$RUN_DIR/start.log"
if ! run_supabase start --workdir "$WORKDIR" > "$RUN_DIR/start.log" 2>&1; then
  grep -viE 'key|secret|jwt|token|password|postgres(ql)?://' "$RUN_DIR/start.log" | tail -20 | sed 's/^/      /' >&2 || true
  fail "supabase start failed"
fi
echo "supabase start: ok (output withheld: it contains local credentials)"

STAGE="status"
: > "$RUN_DIR/status.env"
chmod 600 "$RUN_DIR/status.env"
run_supabase status --workdir "$WORKDIR" -o env > "$RUN_DIR/status.env"
# Validates API_URL/DB_URL as strict loopback on the configured ports (a duplicated key is refused),
# proves the auth guard accepts the result, and writes the VALIDATED strings to stack.env. Only
# those strings are used below: one parser, one value (v3; review finding F8).
"${PLAN[@]}" export-env "$RUN_DIR/status.env" "$RUN_DIR/auth.env" "$RUN_DIR/stack.env"
read_validated() {
  local n
  n="$(grep -c -E "^$1=" "$2" || true)"
  [ "$n" = "1" ] || fail "validated file must contain $1 exactly once (found $n)"
  grep -E "^$1=" "$2" | cut -d= -f2-
}
DB_URL="$(read_validated STACK_DB_URL "$RUN_DIR/stack.env")"
API_URL="$(read_validated STACK_API_URL "$RUN_DIR/stack.env")"
SECRET="$(read_validated E2E_SUPABASE_SECRET_KEY "$RUN_DIR/auth.env")"
[ -n "$DB_URL" ] && [ -n "$API_URL" ] && [ -n "$SECRET" ] || fail "status output incomplete"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::add-mask::$DB_URL"
  echo "::add-mask::$SECRET"
  while IFS= read -r line; do case "$line" in *KEY=*) echo "::add-mask::${line#*=}" ;; esac; done < "$RUN_DIR/auth.env"
fi

STAGE="extensions"
run_psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$EXTENSIONS" >/dev/null

STAGE="baseline-restore"
# Same rule as scripts/ci/real-schema-ci.sh: the baseline is a pg_dump, so "already exists"
# collisions are expected and psql runs WITHOUT ON_ERROR_STOP. Three independent checks must all
# pass before the next stage (review B2):
#   1. psql's exit status: without ON_ERROR_STOP it is non-zero only for a fatal psql error or a
#      lost / failed connection, so any non-zero status is a failed restore;
#   2. the error classification: only plain "ERROR: ... already exists" is tolerated; any other
#      ERROR and any FATAL / PANIC / connection-loss line fails;
#   3. the result: a numeric public-table count of at least the baseline's recorded count.
set +e
run_psql "$DB_URL" -q -f "$BASELINE" > /dev/null 2> "$RUN_DIR/restore.err"
RESTORE_EXIT=$?
set -e
if [ "$RESTORE_EXIT" != "0" ]; then
  "${PLAN[@]}" classify-restore "$RUN_DIR/restore.err" >&2 || true
  fail "baseline restore: psql exited with status $RESTORE_EXIT (fatal error or lost connection); the restore is incomplete"
fi
"${PLAN[@]}" classify-restore "$RUN_DIR/restore.err" || fail "baseline restore produced unexpected errors (anything but a plain 'already exists')"
TABLES="$(run_psql "$DB_URL" -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'" | tr -d '[:space:]')"
MIN_TABLES="$("${PLAN[@]}" min-tables)"
case "$TABLES" in ''|*[!0-9]*) fail "could not read the public table count after the restore" ;; esac
case "$MIN_TABLES" in ''|*[!0-9]*) fail "could not read the baseline's expected table count" ;; esac
[ "$TABLES" -ge "$MIN_TABLES" ] || fail "expected >= $MIN_TABLES public tables after restore, got $TABLES (partial restore)"

STAGE="migration-replay"
if [ "$SCHEMA_MODE" = "full" ]; then
  # The list is produced FIRST and its exit status checked: a failing or truncated producer stops
  # the bootstrap instead of yielding a silently partial replay (v3; review finding F7).
  "${PLAN[@]}" migrations > "$RUN_DIR/migrations.txt" || fail "could not list the migrations to replay"
  EXPECTED_MIGRATIONS="$(grep -c . "$RUN_DIR/migrations.txt" || true)"
  PLANNED_MIGRATIONS="$("${PLAN[@]}" migration-count)" || fail "could not count the planned migrations"
  [ "$EXPECTED_MIGRATIONS" = "$PLANNED_MIGRATIONS" ] || fail "migration list has $EXPECTED_MIGRATIONS entries but the plan has $PLANNED_MIGRATIONS"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if run_psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/migrations/$f" > "$RUN_DIR/mig.out" 2>&1; then
      REPLAYED=$((REPLAYED + 1))
    else
      tail -5 "$RUN_DIR/mig.out" | sed 's/^/      /' >&2
      fail "migration $f did not apply onto the baseline (same failure real-schema-ci would report)"
    fi
  done < "$RUN_DIR/migrations.txt"
  [ "$REPLAYED" = "$PLANNED_MIGRATIONS" ] || fail "replayed $REPLAYED of $PLANNED_MIGRATIONS planned migrations"
fi

STAGE="health"
ok=0
for _ in $(seq 1 30); do
  if run_curl -fsS --max-time 5 -o /dev/null -H "apikey: $SECRET" "$API_URL/auth/v1/health" \
     && run_curl -fsS --max-time 5 -o /dev/null -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" "$API_URL/rest/v1/"; then
    ok=1; break
  fi
  sleep 1
done
[ "$ok" = "1" ] || fail "local stack did not become healthy (auth and REST); no fallback is attempted"

STAGE="export"
if [ -n "$ENV_OUT" ]; then
  cat "$RUN_DIR/auth.env" >> "$ENV_OUT"
fi

STAGE="complete"
COMPLETE=1
result ok
