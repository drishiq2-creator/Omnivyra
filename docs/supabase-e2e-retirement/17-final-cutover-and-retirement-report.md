# 17 — Final cutover and retirement report

| | |
|---|---|
| Checkout | `C:\tmp\omnivyra-schema-fix-20261126`, branch `integration/schema-corrections`, HEAD `2bc52db7a` (main), no remote |
| Date | 2026-11-27 |
| State | **Prepared and verified on disposable infrastructure. Nothing committed, pushed, applied to production, redirected, or retired.** |
| Stopped at | Section 4 of the brief, "present the final production migration plan and exact SQL". Every later step needs an explicit owner approval (§9). |

Inputs: 13 (E2E tables), 14 (repository ↔ production reconciliation), 15 (connections and CI), 16 (cutover plan). Earlier: 09–12.

## 1. Tables deleted and retained (detail: 13)

- **No additional E2E table is deleted.** All 850 remaining `public` tables are RETAIN:
  - 809 are created by `baseline.sql`, the production schema the repository treats as canonical;
  - 41 by repository migrations;
  - 0 by neither.
  - Every table has at least two retain reasons. 35 are touched by the hosted auth workflow, which is still active.
- The 14 tables deleted on 2026-11-26 stay deleted and documented (06). Those deletions were not reopened.
  - Note: 13's bar treats any `baseline.sql` table as canonical, and under it none of the 14 would have qualified. Report 06 treated `baseline.sql` only as a recovery source. The difference is recorded in 13 §1 and §5.
- **Residue:** only `capability_audit_log` (3,211 test-identity rows) and `api_idempotency_keys` (2 failed 403 test rows) hold data. Both are test residue. **Do not migrate them to production**; archive them with the final E2E evidence (07 §4 and §8).

## 2. Repository ↔ production reconciliation (detail: 14)

**Bulk map of the 850 retained tables.** All exist in production and in the replay.

| Verdict | Tables |
|---|---|
| ALIGNED | 830 (42 only after removing local-harness noise, each case checked) |
| SAFE FORWARD | 5 |
| PRODUCTION-ONLY | 11 |
| UNRESOLVED | 4 |

**The six tables.**
- `prospect_list_members`: ALIGNED.
- `prospect_lists`: ALIGNED except `icp_id` and `prospect_lists_icp_tenant_fk`. These are **PRODUCTION-ONLY: preserve them.**
  - They come from `20270111100007`, which is stranded `20261231000000` renumbered, applied by EXPAND-35 on 11-21.
  - Their only consumer is `prospectLists/store.ts` on stranded branches.
  - They land canonically only with the stranded-line landing (`cherry-pick -x`). Re-running that file against production is **not** a no-op: it resets the `search_path` pin set by `20270129000004`.
- The 4 content tables: ALIGNED except the client grant drift, which is SAFE FORWARD and handled in §3.

**Ledger: the writer is identified.**
- The rows for `20261127000000` and `20270202000000` were written by EXPAND-35's ledger-only step: `apply-expand35.js:312` (2026-11-21). The previous "writer unknown" is resolved.
- The production ledger has 95 rows, max `20270202000000`.
- None of main's 23 versions after `20270111000003` has a ledger row, although most of their effects are live.
- Production also lacks main `20270112000001/3/4` and `20270115000000` (the `leads` changes).
- About 30 stranded-line migrations are live with no ledger row.
- The established apply runners write **no** ledger rows; applies are recorded in `release-gates/APPLIED-WITHOUT-LEDGER.md` plus proof files.
- **No ledger rows are written by this cutover.** Ledger repair is an owner decision.

**`708f0ac4`.**
- Restored exactly: `applied-boundary.json` blob `d85cf5c9`; the migration-quality gate exits 0.
- The stale `ledger_row:false` note is corrected by `transfer/708f0ac4-provenance-correction.patch`, prepared and not applied. It is a separate commit after the cherry-pick. The gate exits 0 with it, and a one-digit digest change makes it exit 1.

**Trigger compatibility, `20270111000003`: compatible.**
- Production has 75 (74 `public` plus 1 `archive`); the replay has 75.
- The only difference is `content_block`'s function, which is known and documented.
- No pending migration changes either count.

## 3. Production migrations: prepared, NOT applied

**Backups** (read-only GET `database/backups`, 2026-11-27, `phase3/final/prod-backups.json`):
- Daily physical backups, all COMPLETED. The latest is 2026-11-26 19:06:50Z.
- **PITR is disabled.** A restore would lose up to about a day, so each step relies first on its own exact rollback SQL.

**Exact SQL** (files in this checkout; apply method and pre/post SELECTs in 16 §3–§6):

| Step | File | sha256 | Production effect | Rollback |
|---|---|---|---|---|
| 0 | read-only gate: landed bytes, backups, pre-images (16 §3) | — | none | — |
| 1 | `supabase/migrations/20270301000000_prospect_lists_client_privileges_revoked.sql` | `debb8fd9…59c4c` | **no-op**: its postcondition already holds live (14 §6) | none needed |
| 2 | `supabase/migrations/20270301000010_content_learning_client_privileges_revoked.sql` | `95af4c80…0cfb18` | revokes `authenticated=arwdxtm` on the 4 content tables; revokes client EXECUTE on `set_content_updated_at()` and pins its `search_path` | `supabase/migrations/rollbacks/content_learning_client_privileges_revoked_rollback.sql` (`2eb52784…31d32`), the exact pre-image |
| 3 | `supabase/migrations/20270301000001_api_idempotency_keys_updated_at_index.sql` | `3c61e9fd…d2d59` | adds index `(updated_at, id)` on the 90 KB table | `DROP INDEX CONCURRENTLY public.api_idempotency_keys_updated_at_id_idx` |

**Content-grant risk** (16 §8): not exploitable today. The client is refused at `user_company_roles` with 42501. It becomes exploitable after one routine "read own memberships" grant, as shown on a real database. Only the service-role client in 5 backend files uses these tables.

**Method** (the repository's established runner, `apply-*.js` → Management API `database/query`):
- Steps 1 and 2: one call each, with `SET lock_timeout` first, one migration per transaction, never combined.
- Step 3: three separate autocommit calls (DROP, CREATE CONCURRENTLY, verify), as `20270211000007` was applied on 11-21.
- After each step, run the post-SELECTs and add a row to `release-gates/APPLIED-WITHOUT-LEDGER.md`.

## 4. Application connection changes (detail: 15)

- **The application selects its Supabase project from environment variables only.** The E2E ref appears in 7 tracked files, none of them runtime, deploy or worker code.
- **Connection map:** 43 rows: 18 runtime, 18 safety guards (kept), 4 docs/history, 3 dead config. 6 rows still require hosted E2E, all of them the `auth-integrity` hosted job.

**Stage 1: integrated here; no production behaviour change.**
- Files: `scripts/lib/certAwareEnv.cjs`, `backend/tests/setupEnv.ts`, `package.json`, and new `tests/auth/hostedSupabaseConnections.spec.ts` and `backend/tests/unit/testEnvHostedTargetGuard.test.ts`.
- Effects:
  - jest setup now refuses production **and** hosted E2E targets, case-insensitively, over more variables;
  - a static lock pins which workflows may name E2E or production secrets.
- Integrator fix: a `TS2769` type error in the new test (env typed `Record<string,string>` passed as `ProcessEnv`), corrected with a cast. `tsc` now exits 0.

**Stage 2: `transfer/stage2-remove-hosted-e2e.patch`, NOT applied.**
- Deletes the hosted jobs from `auth-integrity.yml`.
- Makes C3's local workflow run on every PR, with stable required-check names.
- Preconditions: §5.

**Not verifiable from here (owner):** Vercel (all environments) and Railway Supabase URLs, because their values cannot be read without exposing them. Also any operator `.env.e2e` files.

## 5. CI replacement

- **Disposable CI** (C3 local stack): Run 1 passed (GitHub run `45825080632`, 11-26).
- C3 now consumes the same gap list as CI step 3b (`transfer/c3-gap-list.patch`).
- **Not done (each needs push approval):**
  - C3 Runs 2 and 3, and a run with the gap-list patch;
  - a CI-faithful real-schema run with pgvector;
  - merging C3 to main.
- **The hosted auth workflow was not disabled.** The brief forbids that until the replacement has passing real CI runs.
- **Required checks on main:** 9 contexts, none of them the hosted E2E jobs. After Stage 2, make "Auth integrity regression suite (local Supabase)" required.
- **GitHub secrets:**
  - `E2E_REDIS_URL` is read by nothing and can be deleted now.
  - The other 6 `E2E_*` secrets go only after Stage 2 is merged and green; deleting them first makes the hosted job skip silently.

## 6. Disposable verification: results (2026-11-26/27, all local)

- **Commands:** `phase3/final/final-verify.sh` under the heavy-job lock. Outputs are in `phase3/final/*.out`.
- **Replay:**
  - Port 55482: bootstrap → baseline → every migration above ledgerMax → gap list once.
  - Result: `RESULT OK replayed=108 public_tables=875 gaps=1`.
  - The one deviation from CI: no pgvector locally.

| Check | Exit | Result |
|---|---|---|
| Replay | 0 | 108 migrations, 875 tables, gaps=1 |
| Catalog | 0 | 6 tables, RLS on, 1 policy each. Prospect and content ACLs are `{postgres, service_role}`, with 0 client privileges. `set_content_updated_at` has no `authenticated` EXECUTE. 75 touch triggers (floor 74). Index valid. Each gap table created exactly once. |
| migration-quality | 0 | OK, 133 new migrations valid |
| no-raw-db-push / tenant-authz / actor-fk static | 0 / 0 / 0 | PASS / PASS / OK |
| actor-fk `--db` | 1 | 9 errors (18 lines), **identical to the clean-main control** |
| Full real-schema suite | 1 | 86/89 suites, 1626/1659 tests. New `pl_client_privileges_revoked` and `cl_client_privileges_revoked` PASS. **The 33 failures are identical, name for name, to the clean-main control:** 28 from no pgvector locally, 5 from the CI-stamp guard refusing an unstamped database. |
| Related unit suites (20) | 0 | 432/432 |
| Auth guard suite (`test:auth-e2e-guard` set, incl. the new lock) | 0 | 56/56 |
| `testEnvHostedTargetGuard` (no disposable test can reach production or E2E) | 0 | 12/12 after the type fix |
| Idempotency purge has no caller | 0 | none |
| billingContract | 0 | 4/4 |
| Targeted `tsc` (8 changed TS files) | 0 | after the fix (first run exit 2: `TS2769`) |
| `eslint` (changed files) | 0 | 0 errors, 2 warnings |
| C3 plan + workflow / bootstrap simulation / other specs | 0 / 0 / 0 | 46/46, 25/25, 32/32 |

**Not run:**
- full `next build` and full-repo typecheck/lint (about 8 GB RAM needed, about 2.6 GB free);
- CI-faithful runs (need a push);
- production and authentication checks against hosted services.

## 7. Authentication and tenant isolation

- **Tenant isolation**, verified on a disposable database:
  - the prospect tables (service-role-only policies) and the content tables (company policy) admit no client role after the migrations;
  - real-DB tests show 42501 for an `authenticated` request;
  - `check-tenant-authz` passes.
- **Production auth flows were not exercised.** That belongs to the gated cutover (§9) and the C3 real-CI runs.

## 8. Remaining hosted E2E dependencies, and retirement status

- **Remaining dependency:** the `auth-integrity` hosted job (6 secrets, preflight, `ALLOW_PROD_DB_WITH_LOCAL_REDIS`), and any operator holding `.env.e2e`.
- **Hosted E2E is NOT retired.** The project is untouched beyond the 14 tables deleted on 11-26. Deleting it now would break the hosted PR job and remove the only live auth coverage on PRs.

## 9. Exact outstanding blockers and approvals, in order

1. **Commit approval** for this checkout. Plan:
   - cherry-pick -x of the originals: `6a6c3d9b8`, partial, with its remainder registered; `708f0ac4`;
   - then the provenance-correction commit;
   - then the new migrations, tests, Stage 1 and the docs.
2. **Push approval** for:
   - CI-faithful real-schema;
   - C3 Runs 2 and 3, and the gap-list patch on the C3 line;
   - merging C3 to main.
3. **Production approval, one per step:** steps 1, 2 and 3 of §3, applied individually by the established runner, with pre- and post-checks. Each must be confirmed separately at the time of apply, given no PITR.
4. **Owner decisions on production state** (14 §10):
   - about 30 stranded migrations live without ledger rows: no `db push` until resolved;
   - whether to accept the two EXPAND-35 ledger rows;
   - landing `20270202000000` via `144de096e`;
   - promoting `rbac_config`'s deferred contract;
   - `omnivyra_pi_inventory_ro` (an undocumented login role with column SELECT on 6 user-id columns);
   - the main migrations production lacks;
   - `signal_excerpt`;
   - the expired `cli_login_postgres` role.
5. **Connection redirect:** verify the Vercel and Railway Supabase URLs point at `klkiseupptzbecbxwrky`. Owner check; nothing in the repository needs redirecting.
6. **Stage 2 removal of hosted E2E from CI**, after 2 passes. Then delete the 6 `E2E_*` secrets and make the local auth suite a required check.
7. **E2E retirement**, after 3, 5 and 6:
   - archive `capability_audit_log` and `api_idempotency_keys` with the evidence (not into production);
   - confirm no workload uses the project;
   - then pause or delete the project as an owner action, and record the outcome here.
8. **Follow-ups:**
   - C3 gap-created content tables keep the Supabase image's default client grants, because the migration runs before the gap step (option: re-run `20270301000010` after the gap step in C3);
   - add version reservations for `20270301000000`, `…01` and `…10`;
   - add production Redis `right-treefrog-90757` to `certAwareEnv.PROD_MARKERS` together with the cert publisher list;
   - the `platform-parity.yml` production audit runs on empty secrets;
   - three admin credit routes de-duplicate only within one minute (10).
