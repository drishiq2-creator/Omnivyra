# 12 — Final integration and verification

| | |
|---|---|
| Checkout | `C:\tmp\omnivyra-schema-fix-20261126`, branch `integration/schema-corrections`, HEAD `2bc52db7a` (main), no remote |
| Date | 2026-11-26/27 |
| State | **Uncommitted.** Nothing committed, pushed, merged or deployed. No production or hosted-E2E change. |
| Inputs | 09 (production, read-only), 10 (idempotency retention), 11 (C3 gap list), and the grants work summarised in §3 |

## 1. Pre-state and preservation

Recorded before any work: `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/00-pre-state.txt` (branch, HEAD, status, sha256 of the 6 uncommitted files).

- Each of the 4 agent workspaces was hash-checked against it at creation (6/6; the C3 clone 9/9 against the C3 checkout).
- The 6 files were re-checked before integration (6/6 intact).
- The only pre-existing file that changed afterwards is `backend/tests/unit/apiIdempotencyKeyRetention.test.ts`, which went from 12 to 16 tests (§5). That was an intended extension.
- The C3 checkout `C:\tmp\omnivyra-c1c2-prep-20261126` was only read; its 9 uncommitted files are hash-identical to before.

## 2. Production compatibility and `708f0ac4` (detail: 09)

**Inspection method.**
- A client pinned to `klkiseupptzbecbxwrky` that calls only the Management API `database/query/read-only` endpoint. It creates no login role.
- Self-test: the session ran as `supabase_read_only_user`, `transaction_read_only=on`, not a superuser, with no CREATE on `public`.
- A SQL guard allows a single SELECT/WITH only and rejects write keywords (9/9 offline guard tests).
- 22 logged calls in `phase2/prod-ro/audit.log`. One query was refused locally and never sent. Catalog metadata only; no row values.

**Six tables.** All six exist in production, and the column definitions match the repository (65/65). Differences:
- `prospect_lists.icp_id` and its FK come from the stranded `20261231000000`, applied out of band.
- The four content tables grant `authenticated=arwdxtm`: security drift, see §9.
- The prospect tables grant `postgres` and `service_role` only.

**`20261127000000` / `708f0ac4`: substance supported, provenance note stale.**
- Every object the migration creates is live and identical.
- The file digest equals `708f0ac4`'s attested digest (`01315600…c734`).
- A production ledger row now exists, written after 2026-11-10 in the same transaction as `20270202000000`. Its writer is unknown.
- `708f0ac4`'s `"ledger_row": false` was true on 11-10 and is stale now. The gate reads only `ledger_max` and `digests`, never the provenance text.

**Decision.** `708f0ac4` is restored exactly, uncommitted:
- `applied-boundary.json` is now blob `d85cf5c9`, identical to `708f0ac4:scripts/migrations/applied-boundary.json`. Its parent blob `fb6de02bf` equalled main's.
- On commit it should land as `git cherry-pick -x 708f0ac4`.
- Follow it with a separate forward commit that corrects `digests_provenance` ("ledger row observed 2026-11-26").
- Do not raise `ledger_max`: 8 main migrations (`20270111000004`…`20270115000000`) have no ledger row below it.
- The migration was not renumbered.

**Trigger compatibility, `20270111000003`: compatible.**
- Already applied in production; all postconditions hold.
- Production has 75 enabled `omnivyra_touch_updated_at` triggers: 74 in `public` (including `prospect_lists`) and 1 in `archive`. Without `prospect_lists` the count is exactly 74. Production does not depend on the stranded table, but the margin is zero.
- Divergence, already recorded in the manifest: in production `content_block_set_updated_at` executes `set_content_updated_at()`. In CI and C3 it stays on `omnivyra_touch_updated_at()`, because the gap migration runs last.

## 3. Grants migration `20270301000000_prospect_lists_client_privileges_revoked.sql`

**Finding.**
- `20261127000000` contains no GRANT or REVOKE, so the tables' ACLs come from each database's default privileges.
- `20270111000002` revokes client roles only on its fixed list of 50 tables, and the prospect tables are not on it.
- Production had an `authenticated` grant on 11-10. It was removed out of band, with no migration recording it.

**Change.**
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, authenticator` on both tables. It grants nothing, and leaves `service_role`, RLS and policies unchanged.
- It runs in one transaction.
- The preflight fails closed if a role or table is missing, RLS is off, or a table is in a publication.
- The postcondition checks both directions:
  - no client table or column privilege, and no PUBLIC entry;
  - `service_role` keeps SELECT, INSERT and UPDATE;
  - RLS, policies and the owner/`service_role` ACL entries are unchanged.
- Production's ACL already equals the end state, so the migration is a no-op there.
- Tenant isolation is unchanged: the policies still require `auth.role() = 'service_role'`.

**Tests.**
- Static contract: 8/8.
- Real database: 7/7, starting from seeded client grants, including the 11-10 production shape.
- Failing controls: 5 mutants and 2 in-place mutations, each red, with the file restored byte-identically.
- Idempotent when re-run.

## 4. C3 gap-list integration (detail: 11)

- `tests/supabase-local/localStackPlan.ts` reads `supabase/_schema/baseline-gap-migrations.txt` with the same rules and order as CI step 3b. Gap migrations come after the normal replay.
- A missing manifest means no gaps. Any other read error, or a malformed, duplicate, above-`ledgerMax` or nonexistent entry, fails the run before any container starts.
- The C3 code is not in this checkout. It is delivered as `docs/supabase-e2e-retirement/transfer/c3-gap-list.patch` (sha256 `6c129c92…d50e`): 4 files, +219/−10, relative to C3 `f237b92f` plus its 9 uncommitted files.
- It must land with or after the manifest.

## 5. Idempotency retention (detail: 10)

**7 days: safe for every client in the repository; undetermined for clients outside it.**
- The clock is `updated_at`, stamped by application code on every transition; there are no triggers.
- UI keys are fresh per attempt and never persisted.

**Scheduler: not established.**
- `/api/cron/billing-idempotency-expire` and the stale-processing cleaner are absent from `vercel.json`, the worker, `ALWAYS_RUN_JOBS`, BullMQ, GitHub schedules and migrations.
- Production `cron.job` has only `domain-reminder-cron` and `recover-stale-reports-cron` (09, `q20`).
- **Cleanup therefore stays disabled.** `purgeExpiredApiIdempotencyKeys` has no caller, verified by grep.

**Index `20270301000001_api_idempotency_keys_updated_at_index.sql`.**
- A full index `(updated_at, id)` on `api_idempotency_keys`, created with drop-then-`CREATE INDEX CONCURRENTLY`, plus a validity postcondition. The same pattern is used in `20270211000007`.
- A partial index was rejected: generic plans do not use it.
- With 300k synthetic rows, the purge scan went from a sequential scan to an index scan, and the guarded delete from 467 ms to 4.1 ms.

**Concurrency.** Real PostgreSQL, saved outputs:
- the guarded DELETE removes 0 rows that a retry re-claims mid-purge;
- the id-only control DELETE removes 2 live rows.

**Pre-existing gap, out of scope.** Three admin credit routes de-duplicate the ledger only within one minute. A purge would remove their only longer replay guard, which is one more reason cleanup stays off.

## 6. Final disposable verification (all local, 127.0.0.1)

**Commands.**
- Script: `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/final/final-verify.sh`, run under the shared heavy-job lock.
- Per-step output: `phase2/final/NN-*.out`. Summary: `phase2/final/summary.txt`.

**Replay.**
- Fresh PostgreSQL 17 cluster on port 55480.
- Order: bootstrap → baseline (823 tables) → every migration above `ledgerMax` in version order → gap list applied once.
- Result: `RESULT OK replayed=107 public_tables=875 gaps=1`. 107 is main's 104 plus `20261127000000`, `20270301000000` and `20270301000001`.
- Only deviation from CI: no pgvector locally, so `vector` becomes `real[]` and HNSW/IVFFlat indexes are skipped.

| # | Check | Exit | Result |
|---|---|---|---|
| 1 | Replay | 0 | `replayed=107 public_tables=875 gaps=1` |
| 2 | Catalog (`verify-final.sql`) | 0 | all 6 tables, RLS on, 1 policy each; prospect ACL `{postgres,service_role}` with 0 client privileges and service_role S/I/U; 75 touch triggers (floor 74); `content_block` on `omnivyra_touch_updated_at`; `set_content_updated_at` ×1; new index valid; each gap table exactly once |
| 3 | `check-migration-quality.js` | 0 | OK, 132 new migrations valid, 353 historical frozen |
| 4 | `check-no-raw-db-push.js` | 0 | PASS |
| 5 | `check-tenant-authz.js` | 0 | PASS, no new violations |
| 6 | `check-actor-fk-compatibility.js` (static) | 0 | OK, 0 errors |
| 7 | `check-actor-fk-compatibility.js --db` | 1 | 9 errors, **identical on clean main** (control, 18/18 lines); none on a changed table |
| 8 | Full real-schema jest suite (`jest.realschema.config.js`) | 1 | 85/88 suites, 1614/1647 tests. **The 33 failures are identical, name for name, on clean main** (control). 28 are `type "extensions.vector" does not exist` (local harness), 5 are R1-HIST's guard refusing an unstamped database (local harness). |
| 9 | Related unit suites (17) | 0 | 17/17 suites, 399/399 tests, including both migration-quality mirrors (red before `708f0ac4`) |
| 10 | `billingContract` (stability config) | 0 | 4/4 |
| 11 | Targeted `tsc` of the 4 changed TS files | 0 | 0 errors |
| 12 | `eslint` of the 4 changed TS files | 0 | clean |
| 13 | `bash -n scripts/ci/real-schema-ci.sh` | 0 | OK |
| 14 | C3: `localStackPlan.spec` + `authIntegrityLocalWorkflow.spec` (C3 clone + patch) | 0 | 46/46 |
| 15 | C3: `bootstrapSimulation.spec` | 0 | 25/25 |
| 16 | C3: `ciAssertions`, `logRedaction`, `resetRateLimits` specs | 0 | 32/32 |
| 17 | C3 plan `migration-count` | 0 | 105 in the C3 clone (main's 104 plus 1 gap). It becomes 108 once the three new migrations are present. |

- **Control** (`phase2/final/control-main.sh`, port 55481): a clean main `2bc52db7a` replay (`replayed=104 public_tables=869`) with the same 3 suites and actor-FK `--db`. Same 33 failing tests, same 9 actor-FK errors.
- **Not run:**
  - full `next build` and full-repo `typecheck`/`lint`: about 8 GB RAM against about 2.3 GB free; targeted checks were run instead;
  - a CI-faithful real-schema run with pgvector and the CI stamp;
  - a real C3 stack run (Docker in CI).

  The last two need a push, which needs approval.
- Every cluster was stopped and its data deleted; ports 55443, 55460, 55471–55473, 55480 and 55481 are closed.

## 7. Migration ordering and collisions

- The new versions are `20270301000000` and `20270301000001`. Each occurs once in this checkout and is unused on every local and remote branch (scan of 2026-11-26). They sort after main's highest, `20270217000075`.
- The duplicate-version count is unchanged from HEAD (57 by this count): no new collision.
- `20261127000000_pi_prospect_lists.sql` is byte-identical to its source: blob `2968f493` = `6a6c3d9b8:supabase/migrations/20261127000000_pi_prospect_lists.sql`.
- Gap-list handling is the same in CI (`real-schema-ci.sh` step 3b) and C3 (`localStackPlan.ts`). Both apply gaps after the normal replay, with identical validation rules.

## 8. Final changed-file list (uncommitted)

| Status | File | Origin |
|---|---|---|
| M | `backend/services/billing/idempotency/apiIdempotencyKeyCleaner.ts` | earlier Track C (purge function, no caller) |
| M | `docs/database/real-schema-ci.md` | earlier Track B |
| M | `scripts/ci/real-schema-ci.sh` | earlier Track B (step 3b) |
| M | `scripts/migrations/applied-boundary.json` | exact restore of `708f0ac4` |
| A | `supabase/migrations/20261127000000_pi_prospect_lists.sql` | earlier Track A (original blob) |
| A | `supabase/_schema/baseline-gap-migrations.txt` | earlier Track B |
| A | `supabase/migrations/20270301000000_prospect_lists_client_privileges_revoked.sql` | grants (§3) |
| A | `supabase/migrations/20270301000001_api_idempotency_keys_updated_at_index.sql` | index (§5) |
| A | `backend/tests/unit/apiIdempotencyKeyRetention.test.ts` | earlier Track C; now 16 tests |
| A | `backend/tests/unit/prospectListsClientPrivilegesMigration.test.ts` | grants |
| A | `backend/tests/realschema/pl_client_privileges_revoked.test.ts` | grants |
| A | `docs/supabase-e2e-retirement/09-production-readonly-compatibility.md` | production check |
| A | `docs/supabase-e2e-retirement/10-idempotency-retention-readiness.md` | retention |
| A | `docs/supabase-e2e-retirement/11-c3-gap-list-integration.md` | C3 |
| A | `docs/supabase-e2e-retirement/12-final-integration-and-verification.md` | this file |
| A | `docs/supabase-e2e-retirement/transfer/c3-gap-list.patch` | C3 transfer patch (not for this tree's code) |

`node_modules` is a git-ignored junction to `C:/tmp/main-align-deps/node_modules`; it is not part of the change. Docs 01–07 of this programme are in `C:\tmp\omnivyra-e2e-retirement-20261126`, also uncommitted.

## 9. Remaining blockers and owner decisions before commit/push

1. **Approval to commit**, with the commit plan: the original commits land via `cherry-pick -x` (`6a6c3d9b8` partial, for the one migration, with the remainder registered; `708f0ac4` whole), plus the provenance-correction commit.
2. **Approval to push**, for a CI-faithful real-schema run (pgvector, CI stamp) and a C3 run with the transfer patch. Local evidence cannot replace these.
3. **Out-of-band production writes, writer unknown:**
   - ledger rows for `20261127000000` and `20270202000000`;
   - the effects of `20261231000000` (`prospect_lists.icp_id` and the campaign objects);
   - the revoked `authenticated` grant on the prospect tables.

   These need an owner or MIG-2R decision.
4. **Security drift, not fixed here (out of scope).** The four content tables grant `authenticated=arwdxtm` in production. It is inert today only through the `user_company_roles` policy. A forward revoke needs its own design: in CI these tables appear only in the gap step, after every migration, so a fail-closed guard would break CI.
5. **Idempotency rollout** (all before enabling cleanup):
   - schedule the existing cleaner first;
   - confirm I-1 to I-5 in 10;
   - fix the admin credit routes' 1-minute ledger window;
   - wire the purge behind an unset env var;
   - dry-run.
6. **Expired `cli_login_postgres` role** in production (valid until 2026-11-22). The owner decides removal; it was not touched.
7. **Housekeeping after landing:**
   - mark the manifest's "Production presence today: unverified" line as verified (2026-11-26, 09);
   - update main docs still calling `20261127000000` UNVERIFIED (`PI-C1-IMPLEMENTATION-GATE-001.md:79`, `PI-MILESTONE-A-CLOSURE-AUDIT-001.md:226`);
   - correct `20270111000003`'s header claim that `set_content_updated_at()` "exists in production only".
