# 21 — Hosted E2E traffic retirement readiness (shutdown verification)

| | |
|---|---|
| Project to retire | `lomndxmrpyudaegddpef` ("omnivyra-e2e") |
| Production | `klkiseupptzbecbxwrky`: **not queried** for this report |
| Date | 2026-11-27 |
| State | **Method and queries prepared; PRE-MERGE reference snapshot recorded.** #468 is OPEN (head `fa46417f`), the 7 `E2E_*` secrets still exist, and the hosted job still runs on PRs. Nothing was paused, deleted, written, committed or pushed. |
| Inputs | 05 (live inspection), 07 and 13 (table disposition), 15 (connection transition), 17 (cutover), 18 §5 (runtime environments), §9 (inventory) |

**The true baseline is NOT the snapshot in this report.** It is the snapshot taken right after #468 merges **and** the `E2E_*` secrets are deleted (T0, §3.1). The values in §4 are the PRE-MERGE reference. They prove that the queries work, show what one hosted run leaves behind, and show the background noise level.

## 1. Access method and its own footprint

**Client.** `C:\tmp\omnivyra-schema-fix-20261126-tools\phase3\e2e-ro\run-e2e-ro.ps1 sql <file> <out.json>`:
- It reads the CLI credential from the Windows credential store and gives it only to the child `e2e-ro-api.js`.
- The child calls only `POST /v1/projects/lomndxmrpyudaegddpef/database/query/read-only`.
- The selftest result is `current_user = session_user = supabase_read_only_user`, `transaction_read_only = on`, not a superuser, no CREATE.

**Guard** (`guardSql`):
- Comments and literals are stripped first.
- The statement must be a single SELECT or WITH.
- Write, DDL and session keywords are refused, including `into`, `set`, `pg_stat_reset*` and `pg_advisory*`.
- Any project ref inside the SQL is refused.
- Every call is logged to `audit.log` with the sha256 of its SQL.

**Negative controls** (offline `guardtest`, 2026-11-27 ~04:11Z):

| Input | Result |
|---|---|
| `select 1 as x into t` | refused `"into"` |
| `select pg_stat_reset()` | refused |
| `select 1; select 2` | refused: more than one statement |

**Does monitoring change what it measures?** Measured by running g02–g06 twice, 20 s apart (A at 04:09:09Z, B at 04:09:28Z), with no CI run in between:

| Counter | A → B | Use as a zero-activity criterion? |
|---|---|---|
| Every `n_tup_ins/upd/del` (all schemas) | unchanged | **yes** |
| `pg_stat_database.tup_inserted/updated/deleted` | unchanged (113,136 / 57,680 / 101,360) | **yes** |
| All row counts and max timestamps (audit, auth, idempotency, storage) | unchanged | **yes** |
| `xact_commit` | +44 | no: every probe is a transaction |
| `tup_returned`, `tup_fetched` | rising | no |
| `sessions` | +6 | no |
| `pg_stat_statements` calls | `postgres` +18, `supabase_admin` +6, `supabase_read_only_user` +5 | no for these three roles. **Yes** for the client roles (`service_role`, `authenticator`, `supabase_auth_admin`, `anon`, `authenticated`, `pgbouncer`, `supabase_storage_admin`): unchanged |
| `pg_stat_activity` | each call briefly adds remote backends `postgres` / `supabase/dashboard` (×2) and `supabase_admin` / `mgmt-api` (×1), plus the probe's own pid (excluded by `pid <> pg_backend_pid()`) | exclude these application names |

**Conclusion.** The read-only probes do not touch any write counter, auth table, audit table or client-role statement counter. They do move transaction, session and read counters, and the `postgres` / `supabase_admin` / `supabase_read_only_user` statement totals. Those are therefore **not** used as zero-activity criteria.

**Management API logs and analytics.**
- Not called. The pinned client refuses every URL except the read-only query endpoint.
- The documented GET endpoints are read-only by method: `GET /v1/projects/{ref}/analytics/endpoints/logs.all` (SQL over edge, Postgres and auth logs, bounded time window) and `…/usage.api-counts`, `…/usage.api-requests-count`.
- They would also catch **read-only HTTP traffic that never reaches a write counter**, for example a GoTrue settings fetch or a PostgREST GET that is served without a query.
- Using them needs a separately reviewed GET-only client pinned to the E2E ref. Log retention is plan-dependent and short, so pull them at each snapshot rather than once at the end.
- Until then, client-role `pg_stat_statements` calls (g06/g07) stand in for read traffic that reaches Postgres.
- **Status: UNVERIFIED, optional.**

## 2. Which sources can still reach E2E

| Source | Evidence (read 2026-11-27) | Reaches E2E today | After #468 + secret deletion |
|---|---|---|---|
| `auth-integrity.yml` hosted job "Auth integrity regression lock" on main `329743dfa` | `secrets.E2E_*` at `.github/workflows/auth-integrity.yml:110-115,198-213`; `ALLOW_PROD_DB_WITH_LOCAL_REDIS` at `:234`; triggers `pull_request` + `workflow_dispatch` only (`:52-57`), **not push**; job timeout 30 min (`:166`), preflight 3 min (`:102`) | **yes**, every PR whose merge ref uses this file. Latest: run `45937649047` (PR `release/r28-consolidation`), job 04:03:12–04:07:18Z | the file no longer exists in that form on main; old runs/refs: see the next 2 rows |
| Re-run of a pre-merge run, or `workflow_dispatch --ref <old branch>`; open PRs #469 (`release/r28-consolidation`, the source of today's runs) and #368 (stale, edits `auth-integrity.yml`), see 20 §5 | A re-run uses the old commit's workflow file. A PR's next `synchronize` after the merge builds a merge ref with the new file | yes | **no once the secrets are deleted**: the preflight yields `provisioned=false` and the job is skipped (`:95-96,141-144,160`). This is why T0 is the secret deletion, not the merge |
| PR head `fa46417f` (#468) | `git grep 'secrets(.|[)E2E_' fa46417f -- .github`: **0 hits**. `auth-integrity.yml` holds only `auth-invariants-static`; `auth-integrity-local.yml` uses loopback only and `AUTH_E2E_ENV_FILE=/nonexistent/...` (`:154-159,186`). Its own PR runs (`45936416617`, `45935045477`, `45933069454`) took 12–15 s: static job only | no | no |
| Tracked code naming the E2E ref, main and PR head | Non-doc hits are only tests and guards: `scripts/lib/certAwareEnv.cjs:40` (refusal marker), `backend/tests/unit/testEnvHostedTargetGuard.test.ts:27`, `tests/auth/e2eEnvironmentGuard.ts` (`DEFAULT_EXPECTED_E2E_PROJECT_REF`), `authStateKeys.spec.ts`, `hostedSupabaseConnections.spec.ts`, `authIntegrityWorkflow.spec.ts`, the `tests/supabase-local/*` specs (refusal fixtures). No app, worker, API route or deploy config (15 §1) | no | no |
| Railway worker | 18 §5: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` → `klkiseupptzbecbxwrky` (classification only, values not printed) | no | no |
| Vercel production browser bundle | 18 §5: `klkiseupptzbecbxwrky.supabase.co` | no | no |
| Vercel server-side and preview env | 18 §5 and §10.1: "sensitive" variables, unreadable by API. Preview deploys are off (`vercel.json deploymentEnabled:false`) | **unknown** (owner check O-4, 15 §5) | unknown until the owner confirms |
| Operator machines with `.env.e2e` | The hosted mode is still the default: `e2eEnvironmentGuard.ts:381-384` @ `fa46417f` ("Unset -> hosted"). `scripts/reset-auth-e2e-rate-limits.js:136` and `scripts/seed-auth-e2e-redis-identity.js:125` default to `.env.e2e` | **residual unknown** | still possible: deleting GitHub secrets does **not** revoke the keys. Only pause, deletion or key rotation stops a holder of the key |
| Any other copy of the E2E service-role key, anon key or DB password (logs, other repos, history) | Not inventoried here | unknown | same as above: pause is the hard stop |
| Supabase platform | `supabase_admin` `postgres_exporter` (scrapes about every 60 s), an idle `supabase_admin` loopback connection (last state change 2026-11-26 19:00:05Z, the daily maintenance or backup window), pg_cron launcher (no `cron` schema, so no jobs), pg_net worker, PostgREST pool (4 `authenticator` backends) | yes, internal | yes, internal: excluded from the criteria (§3.3) |

`E2E_REDIS_URL` exists but no workflow reads it (15 §1). The repository secret list on 2026-11-27 has exactly 7 names, all `E2E_*`, all dated 2026-08-30.

## 3. Observation design

### 3.1 Cut-over time T0

- **T0 = the later of:** the #468 merge time, and the deletion time of the last of the 6 read `E2E_*` secrets (`gh secret list` shows no `E2E_*` name).
- Delete `E2E_REDIS_URL` with them.
- Until the secrets are gone, a re-run or an old-ref dispatch can still run the hosted job (§2).

### 3.2 Snapshots

| Snapshot | When | Queries |
|---|---|---|
| **S0 (true baseline)** | T0 + grace (§3.4), after `gh run list --workflow auth-integrity.yml` shows no run still in progress whose jobs include "Auth integrity regression lock" | g07, then g03, g05, g06 |
| S1 … Sn (interim) | every 6–8 h, and right after each CI cycle event below | g07 (+ g05) |
| **S_end** | at least 24 h after S0, and after the CI coverage below is complete | g07, g03, g05, g06 |

Record for each snapshot: the UTC time from `server_now` and the `audit.log` line. Keep the outputs next to the SQL in `C:/omnivyra-archive/e2e-retirement-20261127/g-out/`.

**Minimum window: 24 h of wall clock AND one complete normal CI cycle:**
- **At least one PR run of the full check set** after T0, opened or synchronised after T0. Its "Auth Integrity" run must list only "Static auth invariants (hermetic, no secrets)", and the "Auth integrity (local Supabase)" jobs must be green.
- **At least one `push` run on main** after T0: every workflow that triggers on main.

**Why 24 h.**
- It covers one daily platform maintenance or backup cycle (the idle `supabase_admin` connection last changed at 19:00Z), so platform noise is characterised in S0→S_end.
- It covers any once-a-day job anyone runs by hand or from an operator machine.
- It covers one full set of working hours in each timezone in which PRs are opened (today's hosted runs were 02:22–04:07Z).
- Note: auth-integrity has **no schedule trigger**. No workflow here runs E2E on a schedule.
- **Extension:** if no PR is opened in that 24 h, the window extends until one is.
- **Recommended 72 h** if any owner check in §2 (Vercel server or preview env, operator `.env.e2e`) is still open at T0. That spans a weekend-or-weekday boundary and catches weekly manual habits.

### 3.3 Definitive zero-activity result

Compare S_end with S0. **Zero activity** means every line below holds:

1. **No reset.** `postmaster_start` is identical, and `db_stats_reset` is still `null`. If either changed (restart, crash, platform upgrade, pause/resume), the `pg_stat` deltas are void. Decide on lines 2–4 (timestamps and row counts only) and restart the window from a new S0 for lines 5–6.
2. **Audit.** `cal_n` and `cal_max_occurred_at` are identical. The column is `occurred_at`; the table has no `created_at`.
3. **Auth.**
   - `auth.users`, `auth.sessions` and `auth.refresh_tokens`: counts identical, and `greatest(created_at, updated_at[, last_sign_in_at])` identical.
   - `auth.audit_log_entries`, `auth.one_time_tokens` and `auth.flow_state` stay at 0.
   - Background: the hosted suite creates and deletes its users within each run, so counts alone are blind to it. Lines 5 and 6 catch the churn.
4. **Idempotency and storage.**
   - `api_idempotency_keys`: `idem_n = 2` and `idem_max_updated_at = 2026-11-09T05:06:04.061Z`.
   - `storage.objects = 0` and `storage.buckets = 0`.
5. **Write counters.**
   - `writes_public`, `writes_auth` and `writes_storage` `ins/upd/del` identical, and `db_tup_inserted/updated/deleted` identical.
   - Allowed exception: a delta that g03 attributes entirely to platform ledgers (`auth.schema_migrations`, `storage.migrations`, `realtime.schema_migrations`, or new `realtime.messages_*` partitions). That is a Supabase upgrade, and it must coincide with a `postmaster_start` change or a platform notice.
   - Any delta on a `public` table, or on `auth.users/identities/sessions/refresh_tokens/mfa_amr_claims/one_time_tokens`, is activity.
6. **Client-role statements** (`client_role_calls`): `service_role`, `authenticator`, `supabase_auth_admin`, `anon`, `authenticated`, `pgbouncer` and `supabase_storage_admin` totals identical, unless S0→S1 proves a steady platform drift for a role (§4.5). Caveats:
   - `pg_stat_statements` can evict entries, so a total can fall. A fall is not activity, and it is not proof of silence: lines 2–5 decide then.
   - **Any rise** is activity.
7. **Backends.** `client_backends` is the same, or lower (PostgREST pool idling). No backend appears whose role is `service_role`, `anon`, `authenticated`, `supabase_auth_admin`, `pgbouncer` or a login role, and none with an unknown `application_name` (g05). `newest_client_state_change` is ≤ S0's `server_now`.

**Excluded as monitoring or platform:**
- the probe's own pid;
- `postgres` / `supabase/dashboard` and `supabase_admin` / `mgmt-api` (created by each Management API call);
- `supabase_admin` / `postgres_exporter`;
- the idle `supabase_admin` loopback connection;
- the background workers (archiver, checkpointer, walwriter, background writer, autovacuum, logical replication launcher, pg_cron launcher, pg_net worker);
- `xact_commit`, `sessions` and `tup_returned/fetched`.

Any single failed line, outside the grace rule below, is a **NOT ZERO** result. Identify the source before pausing.

### 3.4 Genuine new events vs delayed or unrelated activity

**Hosted-run signature** (measured from the 4 hosted runs between the 05 snapshot of 11-26 and this one):
- `capability_audit_log` 3,211 → 3,283 = **+18 rows per run**;
- `auth.users` and `auth.identities` +8 inserts and +8 deletes per run;
- `auth.sessions`, `refresh_tokens` and `mfa_amr_claims` +9 / +9;
- `auth.one_time_tokens` +3 / +3;
- `public.users` +8, `public.auth_sessions` +9.

The 4 runs: `45927939880`, `45929069137`, `45935358697`, `45937649047`. Each lasted about 3–4 min; static-only runs last about 15 s. The latest audit row (`occurred_at` 04:07:06.884Z) falls inside run `45937649047`'s job window, 04:03:12–04:07:18Z.

A 5th run, `45939076841`, was then observed live between two snapshots, with the exact predicted sizes (§4.6):
- +18 audit rows, +35 public and +46 auth inserts;
- client-role calls: `service_role` +727, `supabase_auth_admin` +413, `authenticator` +12.

**Grace rule.**
1. List the runs that could still contact E2E:
   `gh run list -R drishiq2-creator/Omnivyra --workflow auth-integrity.yml --limit 50 --json databaseId,createdAt,updatedAt,status,event,headBranch,headSha`
   For each run with `createdAt < T0`, list its jobs with `gh run view <id> --json jobs` and keep those that contain "Auth integrity regression lock" with `conclusion != skipped`.
2. An event is **attributable (not a failure)** only when all of these hold:
   - its timestamp lies inside such a job's `[startedAt, completedAt]`;
   - its size fits the signature: multiples of 18 audit rows, 8 users and 9 sessions;
   - the run's `createdAt < T0`.
3. Grace end = max(`completedAt` of those jobs), and at the latest T0 + 35 min (job timeout 30 min + preflight 3 min + queueing). **S0 is taken after the grace end.**
4. **Genuine new event:**
   - any audit row with `occurred_at` > grace end;
   - any `auth.*` `created_at/updated_at/last_sign_in_at` > grace end;
   - any write-counter or client-role delta between S0 and S_end;
   - or any auth-integrity run with `createdAt ≥ T0` whose job list contains the hosted job.
5. Then name the source from `gh run list` across all workflows (event, branch, actor) and from the backend's `application_name` and `backend_start` in g05. With the logs client (§1), add the edge-log path and user agent.
6. **Unrelated platform activity:** see §3.3 line 5's exception and the excluded set. A Supabase maintenance event shows up as `postmaster_start` / ledger-table changes with no client-role statement increase.

## 4. Query files and the PRE-MERGE reference snapshot

Directory `C:\omnivyra-archive\e2e-retirement-20261127\sql\`. `f01`–`f03` are unchanged. The outputs are in `..\g-out\`. Every file passed the offline guard (`GUARD ACCEPT`) and returned HTTP 201 through the client.

| File | sha256 | Purpose | Rows returned |
|---|---|---|---|
| `g01_column_discovery.sql` | `b699cc1b…a7de2d4` | timestamp columns from `information_schema.columns` | 12 tables |
| `g02_activity_counters.sql` | `ee229914…c33723` | counts and min/max timestamps: audit, idempotency, `public.users/auth_sessions`, 8 auth tables, storage | 1 |
| `g03_table_write_stats.sql` | `05a516ee…01b43` | `pg_stat_all_tables` totals per schema, plus every table with a non-zero write counter | 1 |
| `g04_database_stats.sql` | `1db41c4a…f9501` | `pg_stat_database`, `pg_stat_wal`, postmaster start, size | 1 |
| `g05_backends.sql` | `fb0a1e8c…dab65` | `pg_stat_activity` grouped by role, application, type, state and client kind (no query text, no addresses) | 11–13 |
| `g06_statement_calls_by_role.sql` | `1d212b23…a489` | `pg_stat_statements` totals per role (no query text) | 8 |
| `g07_snapshot_all.sql` | `cce6c3a6…f811f8e` | **the one-call comparison snapshot** for S0, Sn and S_end (§3.3 lines 1–7) | 1 |

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\tmp\omnivyra-schema-fix-20261126-tools\phase3\e2e-ro\run-e2e-ro.ps1 sql C:\omnivyra-archive\e2e-retirement-20261127\sql\g07_snapshot_all.sql C:\omnivyra-archive\e2e-retirement-20261127\g-out\g07_<label>.json`

### 4.1 Discovered timestamp columns (g01, 04:08:24Z)

| Table | Timestamp columns |
|---|---|
| `public.capability_audit_log` | **`occurred_at`**, `mfa_last_verified_at` (no `created_at`) |
| `public.api_idempotency_keys` | `created_at`, `updated_at`, `locked_at` |
| `auth.users` | `created_at`, `updated_at`, `last_sign_in_at`, `confirmed_at`, `email_confirmed_at`, `deleted_at`, and 8 more |
| `auth.identities` | `created_at`, `updated_at`, `last_sign_in_at` |
| `auth.sessions` | `created_at`, `updated_at`, `refreshed_at` (timestamp without time zone), `not_after` |
| `auth.refresh_tokens`, `auth.mfa_amr_claims`, `auth.flow_state` | `created_at`, `updated_at` |
| `auth.one_time_tokens` | `created_at`, `updated_at` (timestamp **without** time zone), `expires_at` |
| `auth.audit_log_entries` | `created_at` |
| `storage.objects` | `created_at`, `updated_at`, `last_accessed_at`, `archived_at` |

### 4.2 Row counts and timestamps (g02, server time 2026-11-27T04:09:09Z; identical at 04:09:28Z and in g07 at 04:11:29Z)

| Measure | Value |
|---|---|
| `capability_audit_log` | **3,283** rows. `occurred_at` min 2026-11-08T14:06:21Z, **max 2026-11-27T04:07:06.884Z** (f01, 02:56Z: 3,247; 05, 11-26: 3,211) |
| `api_idempotency_keys` | 2; max `created_at` 2026-11-09T05:06:02Z, max `updated_at` 2026-11-09T05:06:04.061Z, `locked_at` null |
| `public.users` / `public.auth_sessions` | 0 / 0 |
| `auth.users` | 1; max `created_at` 2026-08-17T22:34:33Z, `updated_at` 2026-08-18T05:26:08.82Z, `last_sign_in_at` 2026-08-18T05:26:08.79Z |
| `auth.identities` | 1; max timestamps 2026-08-17T22:34:33Z |
| `auth.sessions` / `refresh_tokens` / `mfa_amr_claims` | 12 / 12 / 12; max `created_at` = `updated_at` = 2026-08-18T05:26:08Z (seed user); `refreshed_at` null |
| `auth.one_time_tokens` / `flow_state` / `audit_log_entries` | 0 / 0 / 0 |
| `storage.buckets` / `storage.objects` | 0 / 0 |

### 4.3 Write counters (g03, 04:09:10Z; identical at 04:09:30Z)

| Schema | Tables | ins | upd | del |
|---|---|---|---|---|
| `public` | 850 | 6,384 | 2,210 | 3,099 |
| `auth` | 27 | 16,233 | 14,823 | 16,225 |
| `storage` | 10 | 17 | 3 | 0 |
| `realtime` | 8 | 16 | 0 | 0 |
| `vault` | 1 | 0 | 0 | 0 |

**Per-table.** 35 tables have non-zero counters (full list in `g-out/g03_table_write_stats_A.json`). The moving ones, with their change since 05 (11-26):

| Table | ins / upd / del now | Since 05 |
|---|---|---|
| `public.capability_audit_log` | 3,283 / 0 / 0 | +72 ins |
| `public.users` | 1,436 / 1,128 / 1,436 | +32 ins |
| `public.auth_sessions` | 1,611 / 1,074 / 1,611 | +36 ins |
| `auth.users` | 2,828 / 13,779 / 2,828 | +32 ins |
| `auth.identities` | 2,828 / 1,044 / 2,828 | +32 ins |
| `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_amr_claims` | 3,173 / 0 / 3,173 each | +36 ins |
| `auth.one_time_tokens` | 1,050 / 0 / 1,050 | +12 ins |

The other 26 are static: HISTORICAL rows (05, 07) and the platform ledgers.

**Stats caveat.**
- `stats_reset` is null (never reset); the postmaster started 2026-11-10T04:46:36Z.
- PG17 keeps statistics across a clean restart, but loses them on a crash, failover, restore, upgrade or pause/resume.
- `n_live_tup` is an estimate (`auth.users` shows 0 live while `count(*)` is 1). Use `count(*)` for rows and the `n_tup_*` counters for writes.

### 4.4 Database counters (g04, 04:09:12Z → 04:09:32Z)

| Counter | Values |
|---|---|
| `postmaster_start` | 2026-11-10T04:46:36.617Z |
| `stats_reset` | null |
| `xact_commit` | 3,453,728 → 3,453,772 (g07 at 04:11:29Z: 3,453,830) |
| `xact_rollback` | 500 |
| `tup_inserted` / `tup_updated` / `tup_deleted` | **113,136 / 57,680 / 101,360**, unchanged through 04:11:29Z |
| `sessions` | 156,256 → 156,262 |
| `sessions_abandoned` / `sessions_fatal` / `sessions_killed` | 135 / 0 / 8 |
| `numbackends` | 9 |
| WAL | `wal_records` 1,120,030, `wal_bytes` 186,834,181 (WAL `stats_reset` 2026-09-13T19:20:55Z; informational only, because platform maintenance writes WAL too) |
| Database size | 69,160,083 bytes |

### 4.5 Backends and statement totals (g05 and g06, 04:09:11–04:09:33Z)

**Background shape** (g05 A):

| Group | Backends |
|---|---|
| Server processes, started 2026-11-10T04:46:36Z | archiver, autovacuum launcher, background writer, checkpointer, walwriter, logical replication launcher (`supabase_admin`), pg_cron launcher (`supabase_admin`; no `cron` schema, so it runs no jobs), pg_net worker (`postgres`, idle since start) |
| `supabase_admin` / `postgres_exporter` | 1, loopback, idle, started 11-12; state change about every 60 s (04:08:20Z → 04:09:20Z) |
| `supabase_admin`, blank application name | 1, loopback, idle, started 11-24 19:22Z; last state change 2026-11-26T19:00:05Z |
| `authenticator` / `PostgREST 14.5` | 4, loopback, idle. Newest `backend_start` 2026-11-27T04:04:49Z and newest `state_change` 04:07:15Z, **both inside hosted run `45937649047`** |
| Monitoring (g05 B) | `postgres` / `supabase/dashboard` ×2 and `supabase_admin` / `mgmt-api` ×1, remote, started 04:09:32Z: created by the probe call itself |

**`pg_stat_statements` calls per role** (g06 A at 04:09:13Z; g07 at 04:11:29Z):

| Role | Calls | Note |
|---|---|---|
| `service_role` | 270,746 | client |
| `supabase_auth_admin` | 145,241 | GoTrue |
| `authenticator` | 16,109 | PostgREST |
| `pgbouncer` | 421 | pooler auth queries |
| `supabase_storage_admin` | 175 | |
| `supabase_admin` | 28,611 → 28,617 | platform and monitoring |
| `postgres` | 7,292 → 7,310 | Management API |
| `supabase_read_only_user` | 37 → 42 | these probes |

In g07 at 04:11:29Z, all 5 client-role totals are identical to 04:09:13Z.

### 4.6 Quiet-interval drift (no CI run, g07 C → D)

**Quiet interval: g07 C (04:11:29Z) → D (04:14:01Z).** No workflow run was created in between (`gh run list`).

- Every §3.3 line was identical: row counts, timestamps, `ins/upd/del`, `tup_inserted/updated/deleted`, all 5 client-role call totals, `client_backends = 4`, and `newest_client_state_change` 04:07:15Z.
- Only `xact_commit` moved (+117), which is probe and exporter traffic.
- Including A, B and C, the quiet span runs from the end of the hosted job (04:07:18Z) to 04:14:01Z, about 7 min.
- That is too short to rule out a slow platform drift, for example a GoTrue periodic task on `supabase_auth_admin`. **S0 → S1 (6–8 h) must confirm the client-role totals stay flat** before line 6 of §3.3 is applied strictly.

**Live control: a hosted run inside the window, g07 D (04:14:01Z) → E (04:28:14Z).**

Run `45939076841` (Auth Integrity, `pull_request`, PR #469 `release/r28-consolidation`, created 04:17:28Z) ran "Auth integrity regression lock" from 04:17:34Z to 04:20:37Z.

| Measure | D | E | Delta |
|---|---|---|---|
| `cal_n` | 3,283 | **3,301** | **+18** (the signature) |
| `cal_max_occurred_at` | 04:07:06.884Z | **04:20:29.977Z** | inside the job window |
| `writes_public` ins / upd / del | 6,384 / 2,210 / 3,099 | 6,419 / 2,223 / 3,116 | +35 / +13 / +17. Inserts = 18 audit + 8 `users` + 9 `auth_sessions` |
| `writes_auth` ins / upd / del | 16,233 / 14,823 / 16,225 | 16,279 / 14,865 / 16,271 | +46 / +42 / +46. Inserts = 8 users + 8 identities + 9 sessions + 9 refresh tokens + 9 amr claims + 3 one-time tokens |
| `db_tup_inserted` / `updated` / `deleted` | 113,136 / 57,680 / 101,360 | 113,217 / 57,813 / 101,423 | +81 / +133 / +63 |
| `client_role_calls` | `service_role` 270,746; `supabase_auth_admin` 145,241; `authenticator` 16,109 | 271,473; 145,654; 16,121 | +727 / +413 / +12. `pgbouncer` and `supabase_storage_admin` unchanged |
| `newest_client_state_change` | 04:07:15Z | 04:20:34Z | inside the job window |
| Row counts of auth, idempotency and storage | unchanged | unchanged | the suite deletes its own users and sessions: counts alone are blind |

**This is the failing control for §3.3:**
- one real hosted run trips lines 2, 5, 6 and 7 at once, with the exact predicted sizes;
- lines 3 (counts) and 4 do not trip, which is why lines 5 and 6 are required;
- the grace rule of §3.4 attributes this run correctly: the timestamps lie inside `[04:17:34Z, 04:20:37Z]` and the sizes are multiples of the signature.

**Latest PRE-MERGE reference values are g07 E** (2026-11-27T04:28:14Z): `capability_audit_log` 3,301, max `occurred_at` 2026-11-27T04:20:29.977Z. Every other value is as in the table above.

## 5. Pause, then delete

### 5.1 Before pausing (all must hold)

1. #468 is merged. Its first PR and first main push after the merge are green, and the "Auth Integrity" runs list only the static job.
2. All 7 `E2E_*` secrets are deleted (`gh secret list`), and T0 is recorded.
3. The window of §3.2 is complete: at least 24 h (72 h if §2's owner checks are open), at least one full PR check set and at least one main push run after T0.
4. S0 → S_end is a **zero-activity** result under §3.3, with any grace-window events explained under §3.4.
5. Owner check O-4 is done: Vercel server-side and preview `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` contain `klkiseupptzbecbxwrky`, and no variable names `lomndxmrpyudaegddpef`. Operators confirm `.env.e2e` is deleted (O-5), or accept that pause is the stop for them.
6. The archive is intact: `sha256sum -c` in `C:/omnivyra-archive/e2e-retirement-20261127/SHA256SUMS` passes for `f01`–`f03`.
   - If rows were added after the f02 export (3,247 at 02:56Z; 3,301 at 04:28Z), re-export `capability_audit_log` to a **new** file (g08, not f02) after S_end and add its hash.
   - The data stays out of production (07 §8).
7. Take a final g07 + g03 + g05 snapshot immediately before pausing. A paused project cannot be queried.

### 5.2 While paused (minimum 7 days, recommended 14; it must cover at least one release train and one weekly cycle)

- Main CI on every push and at least one PR run of the full check set stay green, with the same required contexts as before the pause.
- No workflow log or annotation references `lomndxmrpyudaegddpef`, `E2E_` secrets, "E2E provisioning preflight", or a Supabase connection or DNS error. Check with `gh run list` over the pause window, plus `gh run view <id> --log-failed` for any failure.
- Production health is unchanged: web `/api/health/version` returns 200 with `environment=production`; worker `/health` reports `ok`.
- No owner, operator or support report of a failing local auth run or script that depended on the hosted project. If one appears, resume the project, fix the caller, and restart §3.
- Why 7–14 days: pausing is reversible and deletion is not. The pause has to outlast the slowest caller that §2 could not rule out (operator `.env.e2e`, Vercel server or preview env), and those run on human schedules rather than CI schedules.
- After a resume, `pg_stat` counters are void (§4.3 caveat). Compare by row counts and timestamps only.

### 5.3 Before deleting (owner action, irreversible)

1. Every item of §5.2 holds for the whole pause.
2. A final decision on what to keep. The repository already holds the schema (`baseline.sql` + migrations, 13/14). The data residue is archived (f01–f03, plus g08 if made). No production-bound data exists (07, 13).
3. Remove the remaining references as follow-ups, not blockers:
   - O-7: make `e2eEnvironmentGuard` refuse or default away from hosted mode; it is still the default at `fa46417f`;
   - drop `DEFAULT_EXPECTED_E2E_PROJECT_REF`;
   - keep the refusal markers (`HOSTED_E2E_MARKERS`, `LEGACY_E2E_PROJECT_REFS`) as guards.
4. Record pause time, deletion time and the final snapshot in 18 §9 and §11.
5. After deletion, the project's keys are void. Any surviving copy of them, for example in public history, stops working. Production keys are unaffected.

## 6. Limits

- Management API logs and analytics were not called (§1). Read-only HTTP traffic that never reaches Postgres is not covered by the DB-side criteria.
- `pg_stat_statements` eviction can hide a statement whose entry was evicted before S_end. Lines 2–5 of §3.3 do not depend on it.
- The read-only user sees `pg_stat_activity` rows for other roles (role, application, type, state, timestamps), but no query text was selected.
- Vercel server-side and preview values, and operator `.env.e2e` files, are unverifiable from here (18 §10.1).
- This report and the `g0*` files are uncommitted.

## 7. Observation execution log (added 2026-11-27)

- **T0** 06:43:00Z (first observed absence of the 7 secrets). **S0** 06:44:11–06:44:21Z. The last hosted run ended 04:20:38Z, so the grace rule was already met.
- **04:28Z → S0:** no data or write change (18 §11).
- **S0 → 08:18Z (rehearsal observation):** all row counts, timestamps and write counters unchanged; `capability_audit_log` still 3,301 (max `occurred_at` 04:20:29Z). `client_role_calls` rose: `supabase_storage_admin` +3, `supabase_auth_admin` +1, `service_role` +3, `pgbouncer` +17.
- **Controlled attribution** (`attribution-20261127T0824Z/`, `attribution2-20261127T0826Z/`; g07 before and after each single action, with no-action controls):

  | Action (this executor) | Role-call delta | Data/write change |
|---|---|---|
  | none, 20 s (×3 controls) | none, except `pgbouncer` +1 shortly after a pooler login | none |
  | Management API `GET storage/buckets` | `supabase_storage_admin` +1, `service_role` +3, `pgbouncer` +1 | none |
  | `GET health` (all services) | `supabase_storage_admin` +1, `pgbouncer` +1 | none |
  | `GET config/auth` | none | none |
  | temporary login role create + delete | none | none |
  | one pooler login attempt | `pgbouncer` +4 | none |

  The pass-1 archive made one `storage/buckets` GET, one `health` GET and about five pooler login attempts, which accounts for `service_role` +3, two of the three storage-admin calls and the `pgbouncer` growth. **Not attributed:** `supabase_auth_admin` +1 by 08:18Z (+2 by 08:27Z) and one `supabase_storage_admin` call; single statements with no data or write change. They will be judged against the S1 checkpoints.
- **S1** 08:27:17Z, after all pass-1 archive actions: the comparison point for the role-call criterion (§3.3 line 4). The data, write and timestamp criteria still run from S0.
- **Checkpoints:** `checkpoint.sh` (g07 + g05 only, diffed against S0 and S1) at 2026-11-28 ~06:47Z; the final pass at 2026-11-30 after 06:43Z (72 h, because the Vercel check is NOT YET VERIFIED). No archive or Management API action is taken between S1 and the final pass.
