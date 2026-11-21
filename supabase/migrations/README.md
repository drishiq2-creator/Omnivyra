# supabase/migrations — read before running anything against a database

## NEVER `supabase db push` or `supabase migration up` against PRODUCTION

Production's migration ledger (`supabase_migrations.schema_migrations`) does **not** match reality:

- **38+ versions are applied in production WITHOUT ledger rows** (owner-approved apply runners, 2026-11-10 onward:
  R23, 070/071, the Apollo own-key slice, the stranded-line EXPAND set, ...). They are recorded only in the release
  registry and `release-gates/APPLIED-WITHOUT-LEDGER.md` (archive). `db push` decides what to run from the ledger,
  so it would try to **re-run applied migrations** against objects that already exist.
- This folder has **duplicate version prefixes and invalid calendar dates**; the CLI orders by version, so it would
  also **skip** files silently (see `docs/migration-discipline.md`).

### What enforces this (mechanisms, not just this note)

| Layer | What it does |
|---|---|
| `scripts/operator/db/db-push.sh` (`npm run db:push`) | Refuses `--target-env=production` outright; no override flag exists. `--target-env=local` passes `--local` to the CLI. |
| `scripts/guard-no-prod-push.sh` | Refuses if the target COULD be production: the prod ref in the args or connection env, or a checkout **linked** to the prod project with no explicit target. Passes only a target proven non-production. |
| `scripts/ci/check-no-raw-db-push.js` (CI) | Fails CI if any script, workflow or npm script invokes `supabase db push` / `migration up` outside the wrapper. |

### How production migrations are applied

Only through an **owner-approved apply runner** (release lead), per file, with pinned file hashes, a read-only
precondition, a postcondition after each file, and a read-only presence check, then an apply-proof that the
merge gate (`migration-applied-gate.sh`) checks before code that needs the objects can merge.

**An applied migration file is immutable.** Remediate forward with a new migration.
