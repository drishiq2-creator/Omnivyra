# 16 — Production cutover plan (pending forward migrations)

| | |
|---|---|
| Author / date | phase-3 Agent D, 2026-11-27 (prod reads 2026-11-26 19:08–19:25 UTC) |
| Worktree | `C:\tmp\omnivyra-p3-D`, branch `p3-D/e2e-consolidation` (main `2bc52db7a` + the integration files), uncommitted |
| Production | `klkiseupptzbecbxwrky`, `system_identifier 7550817586112808987`, PostgreSQL 17.6 |
| Status | **PLAN ONLY. Nothing here has been applied. Every write step needs its own owner approval.** |
| Evidence root | `C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/D/` (`sql/`, `out/`, `runs/`, `controls/`); abbreviated `EV/` |

Inputs: 09 (production facts), 10 (index), 11 (C3 gap list), 12 (integration), 14 (Agent B: repository/production reconciliation, `C:\tmp\omnivyra-p3-B\docs\supabase-e2e-retirement\14-repository-production-schema-reconciliation.md`, results relayed and verified by the integrator), 15 (Agent C: connection redirect — later phase).

---

## 1. How production applies are done in this repository (found, not invented)

Read in the archive, verified one layer down (file and line read, not only a summary):

| Fact | Source |
|---|---|
| Since 2026-11-10 production Postgres refuses network connections; DDL goes through the Management API `POST /v1/projects/<ref>/database/query`. | memory `project_prod_access_facts_20261110.md` §2 |
| Applies are run by a per-change-set Node runner (`apply-*.js`, owner-approved flag `--owner-approved-in-cb`), with pinned file bytes (sha256 checked before any network call), read-only PRE (identity + pinned `system_identifier`), a write-path probe, the write calls, a POST read and a JSON record. | `C:/omnivyra-archive/programme-20261103/completion-20261108/final-20261108/apply-pildb7-20261121/apply-pildb7.js` lines 1–30, 55–70, 195–235 |
| A transactional file is sent **as-is in ONE call** (one transaction per file), prefixed by a session `SET lock_timeout`. | same, lines 9–10 and `send(\`apply_${f.v}\`, "SET lock_timeout = '10s';\n" + body[f.v])` |
| `CREATE INDEX CONCURRENTLY`: "never inside a transaction, so EACH statement is its own call (a multi-statement call is one implicit transaction, where CIC errors)". `20270211000007` was applied that way on 2026-11-21: 12 calls `cic_0..cic_11` (DROP/CREATE pairs), then the `$verify$` block as its own call. | same, lines 12–16 and 217–224; record `APPLY-PILDB7-RECORD-2026-11-21T08-09-58-146Z.json`; `APPLIED-WITHOUT-LEDGER.md` row 20270211000007 |
| **Ledger: runners write NO `schema_migrations` row** (R23/070/071 practice). The apply is recorded by appending a row to `release-gates/APPLIED-WITHOUT-LEDGER.md` and an apply-proof file under `release-gates/apply-proofs/`. POST treats any new ledger row as a failure. | `APPLIED-WITHOUT-LEDGER.md` lines 1–12; `apply-pildb7.js` POST (`if (Q.ledger && Q.ledger.length) fail.push('ledger rows appeared…')`) |
| The only ledger write found is a separate ledger-only "D-step" of `apply-expand35.js` (2026-11-21 03:02Z): `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (…'pi_prospect_lists'), (…'pi_contact_governance_read_at') ON CONFLICT (version) DO NOTHING RETURNING version`. | `apply-expand35-20261121/apply-expand35.js` ~line 312; `APPLIED-WITHOUT-LEDGER.md` row "LEDGER ROWS WRITTEN 2026-11-21 03:02Z" |

Two consequences for 09/12's "out-of-band, writer unknown" items (they are **recorded** applies, not unknown ones):
- The ledger rows `20261127000000` + `20270202000000` (one xmin, empty `statements`, NULL `created_by`) match the EXPAND-35 D-step exactly (two rows, `version`+`name` only, one call).
- The removal of `authenticated` from `prospect_lists` / `prospect_list_members` between the 11-10 D1 read (06:41Z) and today is consistent with R23 `20270205000001_public_schema_client_privileges_revoked` (stranded, commit `97acfc66a`), applied 2026-11-10 09:08Z by `run-23.js` (`closure-r23-apply-20261110/R23-EXECUTION-RECORD.json`). That file revokes client roles on every public table **without** a client-admitting policy and deliberately excludes 53 tables whose policies admit clients — the four content tables are in that exclusion list (its lines 99–110). This is why the drift survived.
- `prospect_lists.icp_id` + `prospect_lists_icp_tenant_fk`: the stranded `20261231000000` was renumbered by GD-4 to `20270111100007_orchestration_campaign_targeting.sql` (14; checked: `5ce2ced7f:supabase/migrations/20270111100007_orchestration_campaign_targeting.sql` line 62 `ALTER TABLE public.prospect_lists ADD COLUMN IF NOT EXISTS icp_id uuid;`). `APPLIED-WITHOUT-LEDGER.md` records `20270111100007` as applied 2026-11-21 by `apply-expand35.js` @406c7fa67 (resume run, owner-approved). So it is a recorded apply too, under its new number.

No runner, doc or record mentions a PITR/backup check before an apply; the only references are checklists (`docs/audit/migration-ledger-reconciliation-plan.md:144` "PITR / on-demand backup taken", `docs/audit/billing-activation-runbook.md:38`). Step 0 below adds it explicitly.

**Ledger desync (14).** The production ledger has 95 rows, max `20270202000000`. None of main's 23 versions after `20270111000003` has a ledger row although most of their effects are live; B judges main `20270112000001/3/4` and `20270115000000` NOT applied; about 30 stranded-line migrations are applied with no ledger row. Therefore: **no `supabase db push` (bulk or otherwise), ever; no ledger reconciliation in this cutover; each pending migration is applied individually.**

**Method used by this plan:** the same runner pattern (cb owns the runner; a new `apply-*.js` for this change set, reviewed by 7c, as for every earlier set). One migration per transaction, never two files in one call. **Ledger recording = the established practice: NO `schema_migrations` row**; one `APPLIED-WITHOUT-LEDGER.md` row + one apply-proof per file, and the runner's POST fails if any ledger row appears. Writing a ledger row for these versions is **not** part of this plan: with the desync above, a row at `20270301*` would sit above ~23 unrecorded main versions (the reason `APPLY-PLAN-CLIENT-ROLE-REVOKES.md:15` gives for skipping rows: it would force `db push --include-all`). Any ledger write is an **OWNER DECISION** (§11).

---

## 2. Order and approval points

| # | Step | Writes prod? | Approval |
|---|---|---|---|
| 0 | Gate: landed bytes, backup/PITR, pre-images, quiet window | no | integrator (backup check), owner informed |
| 1 | `20270301000000` prospect lists revoke (expected **no-op**) | catalog only | **owner approval #1** |
| 2 | `20270301000010` content/learning revoke + function hardening | catalog only | **owner approval #2** (security change) |
| 3 | `20270301000001` idempotency index (CONCURRENTLY, 3 calls) | index build | **owner approval #3** |
| 4 | Record: `APPLIED-WITHOUT-LEDGER.md` rows, apply-proofs, broadcast to all sessions | no (repo/archive) | — |

From 14 there is no step to insert: B prepared no forward migration, ledger reconciliation is out of this cutover, and the icp_id objects are preserved, not touched (§7).

Each numbered write step is approved separately (memory: "every public push / prod apply: owner approval, never carries over"). Steps 1–3 are independent of each other; the order puts the no-op first (proves the runner path), the security fix second, and the one step with build time last.

None of these needs an application deploy: no code path changes behaviour (the purge in `apiIdempotencyKeyCleaner.ts` has no caller). The files must nevertheless be **landed on main first** and applied from the landed bytes (pinned sha), per deploy discipline. A merge to main deploys the Railway worker; that deploy is separate from these applies.

---

## 3. Step 0 — gate (read-only)

1. **Landed bytes.** `git show origin/main:<file> | sha256sum` equals the sha256 in steps 1–3. If not, STOP.
2. **Backup / PITR** (integrator): via the Management API (dashboard or `GET /v1/projects/<ref>/database/backups`) confirm the latest physical backup is < 24 h old and, if PITR is enabled, note the earliest recovery point. Record the timestamp in the apply record. If no backup in the last 24 h: STOP (or take an on-demand backup first, owner decision). This plan's agent did not call that endpoint.
3. **Pre-images** — run read-only and archive the JSON:
   - `EV/sql/c00_identity_and_activity.sql` — identity, ledger summary, invalid indexes, locks on target tables, backends.
   - `EV/sql/c01_prospect_acl_pre_post.sql`, `EV/sql/c02_content_acl_pre.sql`, `EV/sql/c03_idem_index_pre_post.sql`.
4. **Quiet window:** `c00` must show `locks_on_targets = 0` and no transaction older than 60 s (`oldest_xact_s`).

14 independently confirmed (integrator relay): `20270301000000` is a no-op (all 32 ACL entries on the two tables are grantor postgres, none grantable; its postcondition already holds live); for `20270301000001` no index of that name exists, the table has no triggers and is 90 KB.

Results recorded now (2026-11-26, via the read-only endpoint, HTTP 201 each, `prod-ro/audit.log`):

| Query | Result |
|---|---|
| c00 | `supabase_read_only_user ro=on recovery=false version=17.6`, sysid `7550817586112808987`; ledger `rows=95 distinct=95 max=20270202000000`, no `20270301*` row; invalid indexes none; `locks_on_targets 0`; 13 backends, 1 active, 0 idle-in-tx |
| c01 | both prospect tables: exist, RLS on, `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`, 0 column ACLs, no publication, one `*_service_role` policy; **pass=true** |
| c02 pre | four tables `pass=true`, `equals_reviewed_pre_image=true` (`{postgres=arwdDxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}`); function `pass=true`, pre-image `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} config=NULL`; no same-named relation in another schema |
| c02 post (run now as its own failing control) | all five rows **pass=false** (not applied yet — the query detects the drift) |
| c03 | target index ABSENT (`pre_pass=true`, `post_pass=false`); no invalid index on the table; `reltuples=41 total_bytes=90112 live=41` |

---

## 4. Step 1 — `20270301000000_prospect_lists_client_privileges_revoked.sql`

- **Purpose:** bring the repository to production's state for the two prospect tables (no client-role privilege). Production already equals the end state (R23, see §1), so this is a **no-op** there.
- **File / sha256:** `supabase/migrations/20270301000000_prospect_lists_client_privileges_revoked.sql`, `debb8fd97b178507356ced0872e52a68be34e727ef3adbaf3b607ab0b3559c4c` (byte-identical to the integration checkout).
- **Preconditions (read-only):** c00 identity + quiet window; `c01` both rows `pass=true`. Roles `anon, authenticated, authenticator, service_role` exist (09 q14 / d02).
- **Apply:** runner, ONE call: `SET lock_timeout = '5s';\n` + file bytes (the file carries its own `BEGIN … COMMIT`). Run by cb's runner on owner approval #1.
- **Ledger:** none. Append an `APPLIED-WITHOUT-LEDGER.md` row + apply-proof.
- **Postconditions:** the file's own `$post$` (RAISEs → whole transaction rolled back); then `c01` again: identical output, `pass=true`; `c00` ledger unchanged.
- **Rollback:** none needed; pre-image = post-image (`{postgres, service_role}`). Do not re-grant any client privilege.
- **Stop:** identity/sysid mismatch; c01 `pass=false` before apply (drift since 2026-11-26 — re-plan, a REVOKE could then be non-trivial); HTTP error or `NO RESPONSE` (outcome unknown → re-read c01, never blind retry); any ledger row appears.

## 5. Step 2 — `20270301000010_content_learning_client_privileges_revoked.sql`

- **Purpose:** close the latent client write path on `content_performance`, `content_prediction`, `learning_intelligence`, `learning_memory` (`authenticated=arwdxtm`) and harden `public.set_content_updated_at()` (SEC-B class T: no client EXECUTE, `search_path=pg_catalog, public`). Verdict and design: §8.
- **File / sha256:** `supabase/migrations/20270301000010_content_learning_client_privileges_revoked.sql`, `95af4c8054eb962e82368710b81d5090909a7c0a5122caadda8e4ab1f00cfb18`. Rollback companion `supabase/migrations/rollbacks/content_learning_client_privileges_revoked_rollback.sql`, `2eb52784dd79e2be729fc0ce9b8e877d4307772c9dc17c137b311ffafc031d32`.
- **Preconditions:** c00; `c02_content_acl_pre.sql` all rows `pass=true` **and** `equals_reviewed_pre_image=true` (the rollback restores exactly that pre-image; if it changed, re-plan the rollback first).
- **Apply:** runner, ONE call: `SET lock_timeout = '5s';\n` + file bytes (own `BEGIN … COMMIT`). Expected server messages: one `NOTICE: CL-ACL: verified (tables: present) …`, **no** `WARNING` (a WARNING means the absent branch was taken → STOP and investigate; in production that is impossible unless the tables vanished). Owner approval #2.
- **Ledger:** none; `APPLIED-WITHOUT-LEDGER.md` row + apply-proof.
- **Postconditions:** the file's `$post$` (two-way: no client table/column privilege, no PUBLIC; service_role keeps S/I/U and its full entry; RLS, policies, owner unchanged; function no client/PUBLIC EXECUTE, pinned, body/definer/owner/non-client ACL unchanged; `learning_memory_set_updated_at` enabled). Then `c02_content_acl_post.sql`: all five rows `pass=true`. Application smoke: `/api/health/version` (web) and the worker `/health` (as the runners do); the writers are service-role only, so no functional change is expected.
- **Rollback (re-opens the exposure; owner instruction only):** one call with the rollback file bytes. It runs `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE <four> TO authenticated; GRANT EXECUTE ON FUNCTION public.set_content_updated_at() TO authenticated; ALTER FUNCTION public.set_content_updated_at() RESET search_path;` and verifies the client ACL equals the pre-image as a set. Afterwards `c02_content_acl_pre.sql` must show `equals_reviewed_pre_image=true` again (aclitem order may differ; the rollback's own check compares sets).
- **Stop:** as step 1, plus: any `WARNING` from the file; `equals_reviewed_pre_image=false`; a publication or client-readable view appeared on a table.

## 6. Step 3 — `20270301000001_api_idempotency_keys_updated_at_index.sql` (CONCURRENTLY)

- **Purpose:** age index `(updated_at, id)` for the not-yet-enabled purge (10). Index only.
- **File / sha256:** `supabase/migrations/20270301000001_api_idempotency_keys_updated_at_index.sql`, `3c61e9fdeb9f99a38579b5c2e9b65b5082c98abf4176debcf7232909421d2d59`.
- **Preconditions:** c00 (no invalid index); `c03` `index pre_pass=true`, `invalid_indexes_on_table pre_pass=true`. Size gate: table 41 rows / 90 kB today; STOP if `reltuples > 2,000,000` or > 2 GB (the runners' size gate) → owner chooses an off-peak window.
- **Apply — THREE calls, autocommit, NO `BEGIN`, NO prefix combined in the same call** (a multi-statement call is one implicit transaction, where CONCURRENTLY errors; §1):
  1. `DROP INDEX CONCURRENTLY IF EXISTS public.api_idempotency_keys_updated_at_id_idx;`
  2. `CREATE INDEX CONCURRENTLY IF NOT EXISTS api_idempotency_keys_updated_at_id_idx ON public.api_idempotency_keys (updated_at, id);`
  3. the file's `DO $verify$ … $verify$;` block.
  The runner splits the file bytes into exactly these three statements and refuses any other shape (`splitCic` precedent in `apply-pildb7.js` lines 138–150). A session `SET lock_timeout` is its own preceding call or omitted; never prepended in the same call as a CONCURRENTLY statement. Owner approval #3.
- **Ledger:** none; `APPLIED-WITHOUT-LEDGER.md` row + apply-proof.
- **Postconditions:** call 3 passes; `c03` `index post_pass=true` (valid, ready, non-unique, non-partial, `btree (updated_at, id)`), `invalid_indexes_on_table post_pass=true`.
- **Recovery / rollback:** a failed build leaves an INVALID index (maintained on writes, never read) → STOP, report; on a new owner instruction re-send calls 1–3 (self-healing by design). Rollback: one call `DROP INDEX CONCURRENTLY IF EXISTS public.api_idempotency_keys_updated_at_id_idx;`, then `c03` shows ABSENT.
- **Stop:** any call not 2xx; `NO RESPONSE` on call 2 (outcome unknown: read `c03` before anything else); post_pass=false.

## 7. Items from 14 (Agent B) — none is a step of this cutover

- **icp_id preservation:** production has `prospect_lists.icp_id` + `prospect_lists_icp_tenant_fk` and the campaign objects from stranded `20261231000000`, renumbered by GD-4 to `20270111100007` (applied 2026-11-21 by EXPAND-35, §1). **PRESERVE.** Re-running that file against production is NOT a no-op (14: it would reset the search_path pin set by `20270129000004`). It belongs only to the stranded-line landing via `cherry-pick -x` (repo only), outside this cutover. Steps 1–3 do not touch these objects (step 1 changes table privileges only and asserts the non-client ACL entries, policies and RLS unchanged).
- **Ledger reconciliation:** not in this cutover (desync, §1). No step writes `supabase_migrations.schema_migrations`.
- **Forward migrations from B:** none.

## 8. Content-grant verdict and migration design (Task 1)

**Who uses the tables.** `git grep` on `origin/main` and `git log --remotes=origin -G "(from\(|TABLE *= *)['\"\`](content_performance|content_prediction|learning_intelligence|learning_memory)['\"\`]"` over all 1016 remote refs: only five files ever access them — `backend/services/content/{learningEngine,learningMemoryService,performanceIntelligence,performanceService,predictionEngine}.ts`, all introduced in `a28e56f91` and all importing `supabase` from `backend/db/supabaseClient.ts` (the service-role client, `requireSupabaseSecretKey()`); operations SELECT/INSERT/UPDATE/UPSERT, no DELETE. No browser-client file performs any `.from()`/`.rpc()`. `scripts/cert/e2e-runtime-cert.ts` also uses the service-role client. **No legitimate client-side (user-JWT) access exists.**

**Exploitable today: NO (latent).** Production (d01–d03): the four tables grant `authenticated=arwdxtm`, but every client statement hits the `*_company_rw` policy's sub-select on `user_company_roles`, on which no client role has any table or column privilege (one policy, `service_role_full_access TO service_role`; no client-readable dependent view; no client-executable SECURITY DEFINER function reading it). The real-DB test reproduces it: `42501 permission denied for table user_company_roles`. With one routine "read own memberships" grant + policy on `user_company_roles` the same test shows `SELECT` and `DELETE` on the tables succeed — a direct member read/write path. `MAINTAIN/REFERENCES/TRIGGER` are not reachable through PostgREST.

**Least-privilege target:** four tables `{postgres=arwdDxtm, service_role=arwdDxtm}` (REVOKE ALL FROM PUBLIC, anon, authenticated, authenticator; service_role untouched); `set_content_updated_at()` `{postgres=X, service_role=X}`, `search_path=pg_catalog, public` (SEC-B class T, which omitted it only because its header wrongly said no migration creates it).

**Replay design.** In CI/C3 the tables appear only in the gap step after all migrations. The file has three modes decided by its preflight before any change: all four absent from every schema → table part skipped with a `WARNING` (function still hardened if present); some but not all → RAISE; all present → revoke + two-way verification. A same-named relation in another schema also RAISEs. The gap-created tables in CI receive the bootstrap's default ACL (service_role only); the real-schema test asserts that end state, so a change to CI defaults that granted clients would fail CI rather than be masked.

**Tests and evidence** (all local, 127.0.0.1:55493, cluster stopped and data dir deleted afterwards):
- Replay (`pg-replay.sh --gaps`, under `heavy.sh`): `RESULT OK replayed=108 public_tables=875 extra=0 gaps=1` (`EV/runs/r1.log`). The migration ran in the replay with the tables absent; the server log records the skip: `WARNING: CL-ACL: content_performance, … are ALL absent - table REVOKE skipped …` (`EV/runs/r1-server.log` line 7).
- Static contract `backend/tests/unit/contentLearningClientPrivilegesMigration.test.ts`: 11/11.
- Real-DB `backend/tests/realschema/cl_client_privileges_revoked.test.ts` (12 tests: scenario exists; CI end state; production shape; exploitability today/latent/after; trigger still fires; idempotent; replay shape WARNING; partial refuses; moved-elsewhere refuses; unreviewed body refuses; postcondition trips on 12 perturbations; rollback restores the pre-image) + `pl_client_privileges_revoked.test.ts` (7): 19/19 (`EV/t-rs1.log`).
- Failing controls `EV/failing-controls.js`: 9 real-DB mutants (copies, injected by env) + 4 static in-place mutants: **13/13 red**; the migration restored byte-identical after each, final sha256 `95af4c80…fb18` == original (`EV/t-controls.log`, `EV/failing-controls.json`).
- Gates: `check-migration-quality.js` OK (133 new valid), `check-no-raw-db-push.js` PASS, `check-tenant-authz.js` PASS; 16 migration-scanning unit suites 396/396.
- Not run: the full real-schema suite, a CI run with pgvector, a C3 stack run.

## 9. Production-only objects to preserve (no step may drop or alter them)

| Object | Origin | Action |
|---|---|---|
| `prospect_lists.icp_id`, `prospect_lists_icp_tenant_fk` | stranded `20261231000000` = GD-4 `20270111100007`, applied 2026-11-21 (EXPAND-35), no ledger row | preserve; land only via the stranded-line `cherry-pick -x`; never re-run against prod (14) |
| `prospect_campaigns.{targeting_mode, icp_id, icp_version, min_icp_score}`, `prospect_campaign_targets`, `prospect_campaign_lists` | same | preserve (14) |
| login role `omnivyra_pi_inventory_ro`, column-level SELECT on 6 user-id columns | production only, not in the repo (14) | **owner decision**; preserve |
| ~30 stranded-line migrations applied without ledger rows; main `20270112000001/3/4`, `20270115000000` judged NOT applied (14) | — | not touched here; separate per-migration decisions |
| `cron.job` 2 `domain-reminder-cron`, 3 `recover-stale-reports-cron` (`*/5`, postgres) | production | preserve; no step touches `cron` |
| role `cli_login_postgres` (login, `rolvaliduntil 2026-11-22`, expired, member of postgres) | Supabase CLI temp login role | **owner decision** (drop or keep); not part of this cutover |
| `content_block_set_updated_at → set_content_updated_at()` (CI: `omnivyra_touch_updated_at()`) | production divergence (09 §2) | preserve; step 2 keeps the trigger working (pin does not change behaviour; test 4) |
| R23 objects: `public.client_privilege_revoke_snapshot`, `postgres` default ACL without anon/authenticated | `20270205000000/01`, applied 11-10 | preserve; not re-applied (presence of the snapshot table not re-queried by this agent) |

## 10. Not in this cutover

- Connection redirect (Agent C, doc 15) — later gated phase, after this cutover is recorded.
- Hosted E2E retirement (docs 01–07) — later gated phase.
- Enabling the idempotency purge or any scheduler (10: stays disabled).
- Narrowing `service_role` on any table; anon/authenticated on views (R23 out-of-scope list).
- Re-running `20270111000003` or `20260718000003` (note: a re-run of `20260718000003`'s `CREATE OR REPLACE FUNCTION` would reset step 2's pinned `search_path`; its ACL would survive).
- Baseline regeneration (`baseline-gap-migrations.txt` removal).
- `cli_login_postgres` removal (owner decision).
- Raising `ledger_max` in `applied-boundary.json` (12 §2).
- Any ledger write / reconciliation and any `supabase db push` (14).
- Re-running `20270111100007` (old `20261231000000`) or any other applied stranded file against production; the stranded-line landing itself.
- Applying main's `20270112000001/3/4` and `20270115000000` (14: not applied) — separate decisions, not in this cutover.
- `omnivyra_pi_inventory_ro` changes.

## 11. Owner decisions and unresolved

Owner decisions:
1. Approvals #1, #2, #3 (steps 1–3), each separately.
2. **Ledger recording.** This plan writes none (established runner practice). Whether `20270301000000/01/10` ever get ledger rows is an owner decision, to be taken together with the reconciliation of 14, never in this cutover.
3. `cli_login_postgres` (expired login role): drop or keep.
4. `omnivyra_pi_inventory_ro` (production-only login role, column SELECT on 6 user-id columns): keep, document or drop.
5. Backup gate: proceed only with a backup < 24 h old, or take an on-demand backup first.

Unresolved:
1. **C3 local stack:** its tables are created by the gap step under Supabase's default privileges (`postgres` defaults grant anon/authenticated in a stock Supabase image, R23's default-ACL change is not on main), so after `bootstrap.sh up` the four tables there will carry client grants that `20270301000010` cannot reach (it runs before the gap). Local throw-away stack, no data; options for the integrator: assert/accept it, or re-run `20270301000010` after the gap step in the C3 workflow. Not measured (no C3 run).
2. The CI-created `set_content_updated_at()` keeps stock `PUBLIC` EXECUTE (created after this migration). Same root cause; documented divergence.
3. `scripts/migrations/version-reservations.json` has no entry for `20270301000000/01/10`; the file says "claim one by adding it here in the same change as the migration" — integrator.
4. Backup/PITR state not checked by this agent (endpoint not called).
5. Doc 14 itself was not read by this agent; its items above come from the integrator's relay plus the spot check of `20270111100007` noted in §1.
