# 10 — `api_idempotency_keys` retention readiness

Worktree `C:\tmp\omnivyra-p2-C`, branch `p2-C/schema-corrections`, base `2bc52db7a` plus the uncommitted integration patch. Nothing is committed, pushed, scheduled or enabled. The only database touched was a throw-away local PostgreSQL 17 cluster on `127.0.0.1:55472`. It has been stopped and its data directory deleted.

Evidence directory: `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/C/` (scripts in `pg/`, outputs in `out/`). Production facts come from Agent A's read-only outputs in `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/A/out/` (`q12_idempotency.json`, `q13_extensions.json`, `q20_cron_jobs.json`, `q10_touch_trigger_tables.json`).

## 0. Verdicts

| question | verdict |
|---|---|
| Is a 7-day retention for terminal rows safe? | **Safe for every client in this repository** (evidence in §2). The two things that stay open are outside the repo: the Chrome extension (§2.4, out of scope) and API callers outside the UI. There is also one small, non-financial behaviour change: re-approving a lead mapping (§2.3). It is not a proven universal guarantee. |
| Does the stale-`processing` cleaner / `/api/cron/billing-idempotency-expire` run in production? | **Nothing in the repo schedules it, and prod `pg_cron` does not schedule it either.** Vercel dashboard crons and external schedulers are **unknown** (§3). |
| Is the age index needed? | It is needed only when the table grows. Prod has 41 live rows (`q12_idempotency.json`), so a sequential scan costs nothing today. The migration `20270301000001` is delivered. Land it before, or together with, any wiring of the purge (§4). |
| Purge implementation | It is correct on real PostgreSQL. It uses the right clock and keeps processing and re-claimed rows. It is bounded and repeatable. It stays **unwired** (§5–§6). |
| Ready for integration? | **Yes**, for the migration and the tests (inert). **No** for enabling cleanup until the prerequisites in §8 are met. |

## 1. Table facts

- Repo: `supabase/_schema/baseline.sql:6538-6553`. The columns include `status text NOT NULL CHECK IN ('processing','completed','failed')`, `created_at` and `updated_at` (`timestamptz NOT NULL DEFAULT now()`), and `locked_at timestamptz`. There are two indexes: the PK `(id)` and UNIQUE `(scope, caller_id, idempotency_key)` (`baseline.sql:34065`).
- Prod (`q12_idempotency.json`): 13 columns with the same CHECK. The only indexes are the PK and the unique index. `n_live_tup=41`, `n_dead_tup=11`, never vacuumed or analysed. RLS is on. The ACL is postgres and service_role only.
- **Triggers.** Replayed schema: 0 non-internal triggers and 0 rules on the table (`out/00-table-facts.out`). A probe shows that an UPDATE which does not set `updated_at` leaves it unchanged (`updated_at_unchanged = t`), so nothing in the database bumps it. Prod: `q10_touch_trigger_tables.json` lists every table carrying `omnivyra_touch_updated_at()`, and `api_idempotency_keys` is not among them. A's `q07_triggers.json` did not cover this table, so other triggers in prod are not covered by A's output. Integrator check I-4.

## 2. Lifecycle (C1)

Source: `backend/middleware/withIdempotency.ts`. It is the sole lifecycle writer. 39 `pages/api` routes use `withIdempotency(`.

### 2.1 States

| state seen by a request | behaviour | line |
|---|---|---|
| no row, caller-scoped | legacy lookup `caller_id IS NULL AND status='completed'`. A hash match replays; otherwise `createRecord` inserts `processing` and the handler runs | :293-310 |
| any row, different `request_hash` | 409 `IDEMPOTENCY_CONFLICT` | :316 |
| `completed` | **replayed**; the handler is NOT run | :320 |
| `processing`, own `request_id` | runs | :333 |
| `processing`, lock fresh | 409 `IDEMPOTENCY_IN_PROGRESS` | :345 |
| `processing`, lock stale (> `IDEMPOTENCY_STALE_LOCK_MS` or 10 min) | guarded takeover (re-asserts `status='processing'` AND `locked_at < cutoff`), then **re-executes** | :359-396 |
| `failed` | guarded resume `failed→processing` (`.eq('status','failed')`), then **re-executes** | :399-419 |
| finalize | `markRecord`: `completed`, or `failed` for status ≥ 500 or 401/403/429 | :432-442 |
| thrown handler error | `failed` | :447-454 |

Only a `completed` row changes behaviour when it is deleted: a same-key retry re-executes instead of replaying. A `failed` row is re-executed anyway. Deleting it loses only the hash-conflict 409 and the forensic history.

### 2.2 The last-activity clock is `updated_at`, set only by application code

Every writer stamps `updated_at = new Date().toISOString()`:
- `createRecord` :208
- `markRecord` :227 (start-of-run and finalize)
- takeover :366
- resume :405
- the stale-processing cleaner `apiIdempotencyKeyCleaner.ts:101`

No path changes `status` without setting it. No trigger sets it (§1). `created_at` is never updated after insert, so it is the wrong clock. The real-PG sequential proof keeps a row created 90 days ago and finalised 1 h ago (`old-created-recent-update`, `out/01-sequential.*.out`). The unit test "the clock is updated_at" plus control N2 cover the same case.

### 2.3 Who can retry with the same key, and for how long

How clients mint `Idempotency-Key` (grep `'Idempotency-Key'` across components, pages, lib, hooks, backend, scripts, .github):

| client | key lifetime | can it present the same key after more than 7 days? |
|---|---|---|
| `lib/security/superAdminWrite.ts:110` `freshIdempotencyHeaders` | new UUID per call | no |
| `lib/idempotency.ts:39` `makeIdemKey`, used per click in `CreditsBillingTabMain.tsx:567` and `CreditsBillingTabPanels.tsx:68,80,334,354,380,528` | new UUID per request | no |
| `CompanyUsersTab.tsx`, `pages/team-management.tsx` `newIdempotencyKey()` | per request | no |
| `pages/company/billing/index.tsx:186` | `cbexport-<company>-<uuid>` per request | no |
| `hooks/useIdempotencyKey.ts` (TopUpPanel, blog, scheduler, campaign plan, …) | React ref: stable while the inputs are unchanged, lost on reload or unmount | only if a tab stays open for more than 7 days and the user resubmits identical inputs. Within 7 days that replays; after a purge it re-executes, which is arguably a deliberate new operation |
| **`components/prospects/import/importClient.ts:151` `mappingApprovalKey`** | **deterministic** from (companyId, schema fingerprint, mapping entries) | **yes.** Re-importing the same file shape with the same decisions after a purge re-runs `/api/lead-ingestion/mapping-approval` and creates a new profile **version** (`mapping-approval.ts:72-77`). It is not financial and leaves no duplicate side effect beyond a version bump. Today the same decision replays the old 201 forever. |

The key is never persisted on the client. There is no `localStorage`, `sessionStorage` or IndexedDB use for idempotency keys (grep: 0 hits). There are no server-side or worker HTTP callers: `backend/queue`, `backend/scheduler`, `scripts` and `.github` contain no `Idempotency-Key` header sends. There are no machine principals: `resolveCallerId` → `resolvePrincipal` accepts only Supabase users, auth_session and the legacy bridge, and an unresolved caller gets 401 before any row access (:269-272). So no offline queue, webhook or scheduled re-submit in this repo reuses a key.

### 2.4 Second guards against duplicate side effects (when a purged `completed` key is re-executed)

| route (scope) | second guard | strength |
|---|---|---|
| `super-admin/credits/grant` | `manual_credit_grants` UNIQUE `idempotency_key` = the request key (`grant.ts:131-155`; `baseline.sql:45601`) | independent of retention |
| `credits/claim-action` | ledger key `makeIdempotencyKey(user, earn:<category>, org)` (`claim-action.ts:123`); `credit_transactions` UNIQUE (`baseline.sql:28564,34464,38132`) | independent |
| `campaigns/[id]/release` | `scheduled_posts` UNIQUE `idempotency_key` (`release.ts:26`; `baseline.sql:43137`) | independent |
| `social/publish` | `platform_post_id` short-circuit (`publish.ts:183-191`) | independent for single-row posts |
| **`admin/credits` (legacy grant), `admin/credits/grant` without `clientKey`, `admin/credits/revoke`** | ledger key is **minute-bucketed** (`consumptionAnalyticsService.ts:481-497`, `creditAdminGrantService.ts:119-126`, `creditRevoke.ts:~101`) | **only within the same minute.** For a same-key retry after more than one minute, `api_idempotency_keys` is the only replay guard. The UI mints a new key per click (above), so this holds at 7 days for every in-repo client. A non-UI caller that retries a grant with the same key after more than 7 days would grant twice. That caller does not exist in the repo. |

The middleware comment "ledger UNIQUE idempotency_key is the real double-settlement guard" (`withIdempotency.ts:28,357`) is **not true for the three minute-bucketed admin routes**. This is a pre-existing gap and does not depend on retention, but retention widens it from "never" to "after N days". It is recorded here; nothing was changed.

### 2.5 Other effects of a purge
- `pages/api/admin/credits/idempotency/trace.ts:47-52` loses middleware history for older keys. That is incident lookback.
- Legacy `caller_id IS NULL` completed rows (the D-1 replay, `withIdempotency.ts:151-184`) are aged out. That removes the documented cross-caller replay residual, which is desirable, but a pre-OR-09 key retried later re-executes.
- Concurrency with a live request: a request that loaded a `failed` row, then has it purged before its resume UPDATE, gets 0 rows and a 409 IN_PROGRESS. That is safe, and the next retry creates a fresh row. A purged key can be re-inserted, because the unique slot is free (`out/01-sequential.*.out`, last step).

**C1 conclusion: 7 days is safe for all clients in this repository. It is undetermined for callers outside the repo** (Chrome extension at `C:/omnivyra-extension`, out of scope; the only extension route in this repo, `pages/api/extension/action-result.ts`, does **not** use `withIdempotency`; also any external or operator script hitting the admin credit routes with a reused key). Accepted behaviour change: deterministic mapping-approval keys create a new version after purge.

## 3. Scheduler (C2)

### Established from the repo

| mechanism | finding |
|---|---|
| `vercel.json` `crons` | 15 entries. `/api/cron/billing-idempotency-expire` is **not** among them. `scripts/ci/check-vercel-crons.js` only validates listed entries, so it never sees this route. |
| Railway worker (`backend/scheduler/cron.ts`, `backend/queue`, `backend/workers`) | no reference to `runIdempotencyExpiryJob`, `cleanStaleApiIdempotencyKeys` or the route (grep). `ALWAYS_RUN_JOBS` (`backend/services/intentExecutionService.ts:151`) gates worker job names in the inactive-company gate. It does not list or apply to this HTTP route. |
| BullMQ repeatable jobs | none reference it |
| GitHub Actions `schedule:` | only `.github/workflows/governance-nightly.yml` (governance verification). It does not call the route. |
| Supabase `pg_cron` in migrations | only `20260617_domain_reminders_pg_cron_schedule.sql` (`domain-reminder-cron`). Its URL comes from vault secret `domain_reminder_cron_url`, which is documented as `/api/internal/process-reminders`. |
| Code callers | `idempotencyExpiryJob.ts` is called only by the cron route. The admin route `admin/credits/idempotency/reconcile.ts` calls `reconcileStuckOperations` only, **not** the api-key cleaner. The operator scripts `scripts/operator/billing/flush-stale-idempotency.ts` and `scripts/audit/idempotency-health-report.ts` are manual. |
| Docs | `docs/audit/idempotency-recovery-remediation.md:70,303` says "every 5 minutes" and lists "Schedule the cron …" as a to-do. That is a recommendation, not configuration. |

### Production (Agent A, read-only)
- `q13_extensions.json`: pg_cron 1.6.4 and pg_net 0.19.5 are installed.
- `q20_cron_jobs.json`: there are exactly 2 active jobs, `domain-reminder-cron` and `recover-stale-reports-cron`, both `*/5`. **There is no idempotency expire or purge job.** The repo has the function `trigger_recover_stale_reports_cron()` (it appears in `baseline.sql` and `20261026000000_close_anon_rls_exposure.sql`). No migration calls `cron.schedule` for `recover-stale-reports-cron`; only `domain-reminder-cron` is scheduled by a migration. That job was registered outside the migrations.

### Unknown (not visible from the repo or the database)
- U-1: Vercel project crons configured in the dashboard, and whether the deployed `vercel.json` differs from the repo.
- U-2: external schedulers (Railway cron service, uptime pingers, GitHub schedules in another repo) calling the route with `CRON_SECRET`.
- U-3: the pg_net target URLs held in vault (`domain_reminder_cron_url`, and whatever `trigger_recover_stale_reports_cron()` reads). They are named for other endpoints but are configurable.

The best single prod fact to settle U-1 to U-3 is **I-1**: the route runs through `runJob({ jobName: 'cron:billing-idempotency-expire', … })` (`pages/api/cron/billing-idempotency-expire.ts:37-45`). On every outcome, `runJob` calls `auditOutcome` (`backend/services/jobRunner.ts:331-348`), which writes through `logSecurityEvent` into `capability_audit_log` (`backend/security/audit/SecurityAuditService.ts:148`) with `reason` like `jobrunner status=… job=cron:billing-idempotency-expire trigger=cron|admin …`. That write is fail-soft, so a missing row is strong evidence but not proof. If any scheduler calls the route, those rows exist, and `trigger=cron` identifies a `CRON_SECRET` caller. Also check Vercel or Railway request logs for the path.

**C2 verdict:** in-repo and in prod pg_cron, the stale-`processing` cleaner is **not scheduled**. Stale locks are recovered only lazily, by the middleware takeover on the next same-key request. Whether it runs in production depends on U-1 to U-3. Until I-1 is answered, the purge has no scheduler to piggy-back on.

## 4. Index (C3)

Migration: `supabase/migrations/20270301000001_api_idempotency_keys_updated_at_index.sql`. It is an index only, with no BEGIN/COMMIT. It contains `DROP INDEX CONCURRENTLY IF EXISTS`, then `CREATE INDEX CONCURRENTLY IF NOT EXISTS api_idempotency_keys_updated_at_id_idx ON public.api_idempotency_keys (updated_at, id)`, then a postcondition `DO` block that checks the index exists and `indisvalid`. This follows the self-healing convention of `20270211000007_pi_ldb_lead_intelligence_indexes_concurrently.sql`. `real-schema-ci.sh` applies each file with `psql -v ON_ERROR_STOP=1 < file` in autocommit, so CONCURRENTLY is legal there.

### Why a full index and not the partial one first proposed
Both were measured on 300k synthetic rows (96% completed, 3% failed, 1% processing, spread over 60 days; `pg/07-seed-volume.sql`):

| plan | no index (`out/06-explain.noindex.out`) | partial `WHERE status IN (…)` (`out/06-explain.with-partial-index.out`) | **full `(updated_at, id)`** (`out/06-explain.withindex.out`) |
|---|---|---|---|
| A literal | Parallel Seq Scan + top-N sort, 5494 buffers, 215 ms | Index Scan, 9 buffers, 0.30 ms | Index Scan, 0.30 ms |
| B prepared, custom plan | Seq Scan, 194 ms | Index Scan, 0.19 ms | Index Scan, 0.11 ms |
| **C prepared, generic plan** | Seq Scan, 208 ms | **Seq Scan, 222 ms (index unusable)** | **Index Scan, 0.14 ms** |
| D prepared, auto (8th execution) | Seq Scan | Index Scan (8 custom plans) | Index Scan (8 custom plans) |
| E guarded DELETE of one batch (rolled back) | Seq Scan + sort, 467 ms | Index Only Scan, 4.5 ms | Index Scan, 4.1 ms |
| index size | — | 12 MB | 12 MB (`out/10-index-state.out`) |

The partial index cannot serve a generic plan, because `status = ANY($1)` does not prove the index predicate. PostgREST issues parameterised statements, so whether a cached generic plan is ever chosen is outside our control. The full index serves every plan kind at the same size; `out/09-alt-nonpartial.out` was the comparison, and the final migration was re-measured. The cost of the full index is that it visits and filters old `processing` rows. Those are few unless the stale cleaner never runs (§3), which is integrator check I-3.

Migration replay: applied twice in a row; both runs returned rc=0 (`out/10-migration-apply1.out`, `out/10-migration-apply2.out`), and the index is `indisvalid = t`. `node scripts/check-migration-quality.js` (`out/11-migration-quality.out`) reports no violation for `20270301000001`. Its only violation is the integration patch's `20261127000000_pi_prospect_lists.sql` (pre-existing, not this track).

Write cost: `updated_at` changes on every middleware transition, about 3 UPDATEs per request. Today no indexed column changes, so those UPDATEs can be HOT. With an index on `updated_at` they cannot, so each one also writes entries into all three indexes. This is negligible at prod volume, and it applies equally to the partial index.

Full replay: `pg-replay.sh --repo C:/tmp/omnivyra-p2-C --port 55472 --run …/phase2/C/runs/replay1 --gaps --keep` gave `RESULT OK replayed=105 public_tables=875 gaps=1` (`replay1.console.txt`). The index was applied afterwards by hand from the migration file, so that "before" EXPLAINs could be captured. The cluster was stopped with `pg_ctl stop -m fast` and `runs/replay1/data` was deleted. Port 55472 has been verified down.

## 5. Purge correctness on real PostgreSQL

Scripts: `pg/01-sequential.sql`, `pg/race.sh` (+ `02`–`05`). Outputs were saved this time. The results with and without the index are identical: `diff` showed `SEQ_SAME` and `RACE_SAME`.

**Sequential** (`out/01-sequential.noindex.out`, `.withindex.out`). The clock was fixed at NOW = 2026-11-26T12:00Z, cutoff = NOW − 7 d.
- The scan returned `legacy, old-b, old-c, old-f` in `updated_at, id` order.
- The guarded DELETE was given an id list that also named the stale and fresh processing rows, `new-c` (6 d), the `boundary-c` row (exactly at the cutoff) and `old-created-recent-update`. Result: `DELETE 4`, exactly the 4 expired terminal rows.
- Survivors: `boundary-c, fresh-p, new-c, new-f, old-created-recent-update, stale-p`.
- A repeat run gave `DELETE 0`. A purged key could be re-inserted.

**Concurrency** (`out/race.noindex.out`, `out/race.withindex.out`, and per-session files in `out/race-*/`). Session R held one transaction for 4 s. In it, `resume-*` rows went `failed→processing`, and `complete-*` rows went `failed→processing→completed`, each with `updated_at = now()`. During the hold, the guarded DELETE (ids from the earlier scan) and an id-only control DELETE were issued. Both blocked until R committed: issued 17:55:22, returned 17:55:25. Then:
- guarded: **`DELETE 0`**. `resume-guarded` survives as `processing`, and `complete-guarded` survives as `completed`.
- control (failing control, predicate not re-asserted): **`DELETE 2`**. It deleted a live `processing` row and a freshly `completed` row. This is the replay-protection loss that the predicate re-assertion prevents.

One mistake on my side, recorded for transparency: the first with-index run of `01-sequential.sql` ran while the 300k-row volume set was still loaded. Its output was discarded and the script re-run on an empty table. The file kept is that re-run, and it is byte-identical to the no-index run.

## 6. Code and tests

Changes in the worktree:
- `backend/services/billing/idempotency/apiIdempotencyKeyCleaner.ts`: the earlier track's +139 lines are **unchanged** by this track (sha256 `1d13c79e…21f5` before and after). The function is still called by nothing (grep `purgeExpiredApiIdempotencyKeys` finds only the module and its test).
- `backend/tests/unit/apiIdempotencyKeyRetention.test.ts`: 12 → **16 tests**. The table double gained `lte` (so the N1 mutant runs instead of crashing), `created_at`, and a delete-error switch. New tests:
  1. non-finite retention (NaN or Infinity) is not configured;
  2. strict cutoff (a row at exactly the cutoff survives);
  3. the clock is `updated_at`, not `created_at`;
  4. a delete error yields `errors:1, deleted:0, skipped:0`, with rows intact.
  
  The existing tests already covered: concurrent retry or re-claim mid-purge, concurrent completion refresh, expired completed, expired failed, unexpired (including failed within the window), processing stale (365 d) and fresh, caller/scope/legacy-NULL independence, only this table touched, repeat no-op, batch bound and order, clamp, dry-run, and scan error. sha256 is `fd869a23…b578`.
- `supabase/migrations/20270301000001_api_idempotency_keys_updated_at_index.sql` (new), sha256 `3c61e9fd…2d59`.
- Not changed: `idempotencyExpiryJob.ts`, the cron route, `vercel.json`, env defaults, the worker, and any scheduler.

### Test runs
Every heavy command ran through `phase2/heavy.sh`. Jest ran through `phase2/C/jest.sh`, which uses the placeholder env from the brief and `node node_modules/jest/bin/jest.js --runInBand`.

| command | exit | result |
|---|---|---|
| `jest.sh backend/tests/unit/apiIdempotencyKeyRetention.test.ts backend/tests/unit/apiIdempotencyKeyCleaner.test.ts backend/tests/unit/withIdempotencyStaleLock.test.ts` (`out/13-jest-backend.out`) | 0 | 3 suites; **28 passed**, 0 failed: retention 16, cleaner 6, stale-lock 6 |
| `jest.sh --config jest.stability.config.js tests/stability/billing/billingContract.test.ts` (`out/14-jest-stability.out`; it reads the cleaner source) | 0 | 1 suite; **4 passed**, 0 failed |
| targeted `tsc -p tsconfig.p2c-check.json` (extends `./tsconfig.json`; files = cleaner + retention test; `noEmit`, `skipLibCheck`, `incremental:false`, `types:["node","jest"]`; deleted afterwards) (`out/16-tsc.out`) | 0 | 0 errors |
| `node scripts/check-migration-quality.js` (`out/11-migration-quality.out`) | 1 | no finding for 20270301000001; the only violation is the pre-existing `20261127000000_pi_prospect_lists.sql` from the integration patch |

Grep for tests importing the changed module (`apiIdempotencyKeyCleaner`, `idempotencyExpiryJob`, `billing-idempotency-expire` across `backend/tests` and `tests`) returned exactly the cleaner test, the retention test and `billingContract.test.ts`. All three were run. `withIdempotency.ts` is unchanged; its stale-lock suite was run as a lifecycle sanity check.

### Failing controls
Script `phase2/C/controls.sh` with `mutate.js`. Each mutation is an exact-anchor edit that aborts if the anchor count is wrong. After each run the file is restored, and its sha256 is checked against the original. The final `cmp` was byte-identical (`out/15-controls.out`, logs in `out/control-*.log`).

| id | mutation of the cleaner | red tests (of 16) |
|---|---|---|
| N1 | `.lt('updated_at')` → `.lte` (scan + delete) | 2: strict-cutoff; scan-error as collateral (its mock lacks `lte`) |
| N2 | clock `updated_at` → `created_at` (scan + delete) | 11, including "the clock is updated_at" |
| N3 | delete error not counted | 1: delete-error |
| N4 | `Number.isFinite` gate removed | 1: non-finite retention |
| M1 (re-run of the earlier track's control) | DELETE without predicate re-assertion | 2: concurrent retry, concurrent completion refresh |

The earlier track's controls M2–M12 were not re-run. Its report and logs are in `C:/tmp/omnivyra-schema-fix-20261126-tools/track-C/`.

## 7. Recommendation

- **Retention: 7 days (604800 s)**, one value for `completed` and `failed`, measured on `updated_at`. Keep the 24 h refusal floor. Use 30 d instead if more forensic lookback in `trace.ts` is wanted; the only cost is table size.
- Keep the purge **disabled** until §8 is satisfied. The function has no default and nothing calls it.

## 8. Rollout prerequisites (in order)

1. **I-1 (prod, read-only):** find out whether anything calls `/api/cron/billing-idempotency-expire`. Check `capability_audit_log` for `reason LIKE 'jobrunner status=% job=cron:billing-idempotency-expire %'` (read-only, see §3), the Vercel dashboard crons, and the Vercel and Railway request logs. If nothing calls it, scheduling it is a **separate, reviewed change**. For example, add `{ "path": "/api/cron/billing-idempotency-expire", "schedule": "*/5 * * * *" }` to `vercel.json`; the `check-vercel-crons` gate then applies, and the route already checks `CRON_SECRET`. Do that first for the existing stale-processing cleaner alone, and observe it.
2. **I-2 (prod, read-only):** `SELECT status, count(*), min(updated_at), max(updated_at) FROM api_idempotency_keys GROUP BY 1` to size the backlog. A's stats show 41 live rows.
3. **I-3:** count old `processing` rows (`status='processing' AND updated_at < now()-interval '7 days'`). The purge never deletes them, and the index scan filters past them.
4. **I-4:** confirm there are no triggers on `public.api_idempotency_keys` in prod (`pg_trigger`, non-internal). A's `q07` did not include this table.
5. **I-5 (owner):** confirm that no out-of-repo client reuses an `Idempotency-Key` after more than 7 days. That covers the Chrome extension, operator scripts and any API integration, especially for `admin/credits`, `admin/credits/grant` (without `clientKey`) and `admin/credits/revoke`, whose ledger dedup is minute-bucketed (§2.4).
6. Land `20270301000001` (CONCURRENTLY, via the normal migration review and apply path; it is safe to re-run).
7. Wiring (a separate reviewed patch): in `runIdempotencyExpiryJob`, call `purgeExpiredApiIdempotencyKeys({ retentionSec: Number(process.env.API_IDEMPOTENCY_RETENTION_SEC) || undefined, limit, dryRun })`. Unset means disabled, so rollback is a config flip. Deploy with it unset, then run `?dryRun=true` for 1–2 days and compare with I-2. Then enable it. Watch the `api_idempotency_purge_completed` logs (`deleted`, `skipped`, `errors`), and the 409 and replay rates.
8. Rollback: unset the env var. Deleted rows come back only from PITR. Snapshot them with `COPY … WHERE status IN ('completed','failed') AND updated_at < cutoff` first if a no-loss rollback is required.

## 9. Unresolved

- U-1 to U-3 (§3): external, dashboard and vault scheduler configuration.
- Out-of-repo key reuse (I-5).
- The pre-existing gap in §2.4: the middleware comment overstates the ledger guard for three minute-bucketed admin credit routes. It does not depend on retention and is not fixed here.
- `trace.ts` looks rows up by `idempotency_key` alone. No index leads with that column, so it seq-scans. This is a pre-existing finding, out of scope.
