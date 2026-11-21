#!/bin/bash
# Refuse `supabase db push` / `migration up` whenever the target COULD be production (b3/owner, 2026-11-21).
#
# Why a mechanism, not a note: production holds 38+ migration versions applied by owner-approved runners WITHOUT ledger
# rows (release-gates/APPLIED-WITHOUT-LEDGER.md: R23, 070/071, the Apollo slice, EXPAND-35, ...), and the repo has
# duplicate version prefixes. `supabase db push` decides what to run from the ledger, so against production it would
# try to re-run applied files or skip unapplied ones. Production migrations go ONLY through owner-approved runners.
#
# The old guard only looked for the prod ref in the ARGUMENTS. But `supabase db push` with no ref pushes to the LINKED
# project (supabase/.temp/project-ref), which on operator machines IS production, so the old guard passed it.
# This guard refuses if the prod ref appears in: the arguments (incl. --project-ref / --db-url values), the connection
# env vars, or the linked-project file. It passes ONLY a target PROVEN non-production: --local, a localhost --db-url,
# an explicit non-production --project-ref, or a readable link to a non-production project. An unreadable link file or
# no determinable target is refused (a failed read is never "safe").
PROD_REF="klkiseupptzbecbxwrky"
ROOT="${GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
refuse() { echo "🚫 BLOCKED: db push/migration up refused - $1"; echo "   Production schema changes go ONLY through owner-approved apply runners (release-gates)."; exit 1; }
is_local_url() { case "$1" in *localhost*|*127.0.0.1*|*host.docker.internal*) return 0 ;; esac; return 1; }

# 1. The prod ref anywhere in the arguments (covers --project-ref X, --db-url postgres://...prod...).
[[ "$*" == *"$PROD_REF"* ]] && refuse "the arguments name the production project"

# 2. Connection env vars the CLI may use.
for v in SUPABASE_DB_URL DATABASE_URL SUPABASE_PROJECT_REF SUPABASE_PROJECT_ID; do
  [[ "${!v:-}" == *"$PROD_REF"* ]] && refuse "\$$v points at the production project"
done

# 3. An explicit target in the arguments decides (the prod ref was already refused above).
prev=""
for a in "$@"; do
  case "$a" in
    --local) exit 0 ;;
    --db-url=*) is_local_url "${a#--db-url=}" && exit 0; refuse "a non-local --db-url is not provably non-production" ;;
    --project-ref=*) [ -n "${a#--project-ref=}" ] && exit 0 ;;
  esac
  if [ "$prev" = "--db-url" ]; then is_local_url "$a" && exit 0; refuse "a non-local --db-url is not provably non-production"; fi
  if [ "$prev" = "--project-ref" ] && [ -n "$a" ]; then exit 0; fi
  prev="$a"
done

# 4. No explicit target: the CLI uses the LINKED project. Read it; unreadable, empty, absent or prod = refuse.
LINK="$ROOT/supabase/.temp/project-ref"
[ -e "$LINK" ] || refuse "no explicit target and no linked project; pass --local, a localhost --db-url, or a non-production --project-ref"
ref=$(cat "$LINK" 2>/dev/null) || refuse "the linked-project file exists but cannot be read (a failed read is never 'safe')"
[ -n "$ref" ] || refuse "the linked-project file is empty"
[[ "$ref" == *"$PROD_REF"* ]] && refuse "this checkout is LINKED to the production project (supabase/.temp/project-ref)"
exit 0
