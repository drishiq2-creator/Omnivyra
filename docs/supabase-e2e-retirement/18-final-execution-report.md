# 18 — Final execution report: consolidation into Drishiq2 and hosted E2E retirement

| | |
|---|---|
| Date | 2026-11-27 (all times UTC) |
| Destination (authoritative) | Drishiq2 production Supabase `klkiseupptzbecbxwrky` |
| Source (retired) | hosted Omnivyra E2E Supabase `lomndxmrpyudaegddpef` |
| Repository | `github.com/drishiq2-creator/Omnivyra`, `main` |
| Executed by | session virality-38, under the owner's "complete consolidation and retire hosted E2E" directive |
| Plan and evidence | docs 01–17 in this folder; doc 17 lists what was prepared, this document lists what was done |

## 1. Repository commits and merge

**PR #466** (supersedes #465, which was closed unmerged):
- merged 2026-11-27 02:52:08Z as merge commit `329743dfaec40e61848d7f1c23447cff67843b84`;
- confirmed on the remote with `git ls-remote`;
- required checks: all 9 passed.

| Commit | Content | Provenance |
|---|---|---|
| `50478250` | `supabase/migrations/20261127000000_pi_prospect_lists.sql` | **Partial** pick of `6a6c3d9b8`, byte-identical (blob `2968f493`); remainder register in §1.1 |
| `2f95ed55` | `scripts/migrations/applied-boundary.json` pins `20261127000000` | `cherry-pick -x 708f0ac4`, whole, unchanged |
| `6a3f3107` | provenance fix: `ledger_row` true; writer identified as `apply-expand35.js` (2026-11-21 03:02Z) | new |
| `f018bade` | real-schema CI step 3b: baseline-gap migrations applied once, after the replay | new |
| `373d5c93` | `20270301000000` (prospect tables: client-role privileges revoked) + unit and real-schema tests | new |
| `7109577a` | `20270301000001` (idempotency age index) + inert `purgeExpiredApiIdempotencyKeys` + 16 tests | new |
| `05576880` | `20270301000010` (content tables: client-role privileges revoked) + exact rollback + tests | new |
| `6e939129` | test environments refuse production and hosted E2E (`certAwareEnv`, `setupEnv`, hosted-connection lock) | new |
| `5d2ea1c4` | docs 01–17, evidence (metadata only, identifiers hashed), transfer patches | new |

Original commits landed: 2 (`6a6c3d9b8` partial, `708f0ac4` whole). Hunks rewritten: none.

### 1.1 Register: the part of `6a6c3d9b8` not landed

**Not landed** (21 files):
- `backend/services/prospectLists/{audience,index,store}.ts`;
- `pages/api/prospect-lists/{index,members}.ts`;
- the ranked prospect read (`prospectIntelligenceRead.ts`, `scoreEvaluationStore.ts`, `pages/api/prospects/index.ts`, `pages/prospects/index.tsx`);
- their unit and real-schema tests;
- `jest.realschema.config.js` and `backend/tests/realschema/setup.ts` changes.

**Why not landed:**
- They depend on the stranded line (`consolidate/pi-arbitration-relationships`). Production already runs their schema.
- `prospect_lists.icp_id` / `prospect_lists_icp_tenant_fk` (production-only) belong to `20270111100007` on the same line. Re-running that file would reset the `search_path` pin from `20270129000004`.

**Lands with:** the stranded-line landing (owner: land `integration/s-wa-combined`), by `cherry-pick -x` of the original.

### 1.2 PR #468: disposable auth CI and hosted-job removal

The PR combines three things:
- C3, the disposable local Supabase auth E2E;
- the round-26 Redis identity guard, handed over by Control Tower;
- Stage 2, which removes the hosted E2E jobs.

It supersedes #467 (closed unmerged).

| Commit | Content | Provenance |
|---|---|---|
| `90dd3049` | disposable local Supabase auth workflow, environment guard, bootstrap | `cherry-pick -x f237b92f` |
| `2de7ffb8` | C3 review gap closure: restore checks, both production Redis hosts, target validated before any client | new |
| `58c2636b` | round-26 fail-closed Redis identity guard (owner decision) | delta of `cd320b4cc` over `2de7ffb8`. Guard files byte-identical; `package.json` hunk rewritten as the union of both lists |
| `7acc9b93` | local stack applies the same baseline-gap manifest as CI step 3b | new |
| `7559e391` | Stage 2: `auth-integrity.yml` keeps only the required static job and reads no secret; local workflow runs on every PR | new. Hunks rewritten over the guard: hosted seed step and hosted sha pin removed with the hosted job; local seed step and its order rule kept |
| `20373e8a`, `9760e62b`, `fa46417f` | placeholder fixture (check-secrets); independent-review fixes F-1, F-2, F-3, F-6 | new |
| `bbbca00e` | `.gitleaksignore`: 4 exact fingerprints for verified synthetic fixtures (owner instruction 11-27); `.gitleaks.toml` unchanged | new |
| `6f5d3501` | merge of `main` `4a957d29` (round 28) into the PR branch; only `.gitleaksignore` overlapped, resolved as main's 15 entries unchanged + these 4 | merge, no rebase (fingerprints pin commit ids) |

Merge result: **MERGED** 2026-11-27 05:10:39Z as merge commit `130ce223b15a9e2738e1f588a1df090af8b20fc2` (parents `4a957d29` + `6f5d3501`), merged by the owner's account. The tree of `130ce223` equals the tree of the reviewed head `6f5d3501`. Details in §11.

## 2. Files consolidated

From the integration checkout, all 32 uncommitted paths:
- They are committed byte-identical. The comparison was against a tarball taken before any commit (`phase4/pre-commit-worktree-backup.tgz`, sha256 `9f3e2168…234b`).
- The one deliberate exception is `applied-boundary.json`, which got the provenance fix.

From the retirement checkout:
- docs 01–07, the table register and the evidence: 63 files, byte-identical.
- Every file was secret-scanned twice (repository-pattern scan and gitleaks 8.30.1). The only hits were synthetic test values, which were replaced with placeholders.

Kept **outside** the public repository, in `C:/omnivyra-archive/e2e-retirement-20261127/` (with `SHA256SUMS`):
- the final E2E inventory;
- the full row export of the two residue tables.

## 3. Production migrations applied

**Runner:** `C:/omnivyra-archive/tools/apply-e2econs-20261127/apply-e2econs.js`, driven by `run-apply.ps1`. It follows the established `apply-*.js` pattern:
- **Pinned bytes:** the runner applies the file bytes from main `329743dfa`, after checking their sha256.
- **Identity and quiet-window checks before any write:**
  - identity and system identifier `7550817586112808987` on every read;
  - a write-path probe;
  - the ledger, locks and transaction age.
- **One migration per call,** each preceded by `SET lock_timeout = '5s'`. Step 3 is three separate autocommit calls (CREATE INDEX CONCURRENTLY).
- **No ledger rows,** and a lost response stops the run.
- **Token:** taken from the Windows credential store, never printed.

**Backup before applying:**
- the latest physical backup completed 2026-11-26 19:06:50Z, 7 daily backups in all, all COMPLETED;
- **PITR is disabled**, so recovery relies on each step's own rollback;
- a daily backup is not treated as point-in-time recovery.

| Step | Version | Applied (UTC) | Result | Record |
|---|---|---|---|---|
| 1 | `20270301000000` prospect tables | 02:52:36–02:52:41 | POSTCONDITIONS PASS. Exact no-op: c01 identical before and after (`{postgres, service_role}`) | `records/APPLY-E2ECONS-step1-2026-11-27T02-52-41-154Z.json` |
| 2 | `20270301000010` content tables | 02:52:49–02:52:54 | POSTCONDITIONS PASS: 4 tables now `{postgres=arwdDxtm, service_role=arwdDxtm}` (was also `authenticated=arwdxtm`); `set_content_updated_at()` EXECUTE postgres and service_role only, `search_path=pg_catalog, public` | `…step2-2026-11-27T02-52-54-579Z.json` |
| 3 | `20270301000001` idempotency index | 02:53:12–02:53:17 | POSTCONDITIONS PASS: `api_idempotency_keys_updated_at_id_idx` valid; no invalid index | `…step3-2026-11-27T02-53-17-058Z.json` |

**After every step:**
- the ledger was unchanged (`rows=95 distinct=95 max=20270202000000`, no `20270301*` row);
- web `/api/health/version` returned 200 and worker `/health` returned 200.

**Records:**
- rows appended to `release-gates/APPLIED-WITHOUT-LEDGER.md`;
- proof `release-gates/apply-proofs/E2E-CONSOLIDATION-20261127.applied`;
- broadcast to the peer session.

**Rollbacks (not used):**
- step 2: `supabase/migrations/rollbacks/content_learning_client_privileges_revoked_rollback.sql`, the exact production pre-image;
- step 3: `DROP INDEX CONCURRENTLY IF EXISTS public.api_idempotency_keys_updated_at_id_idx`;
- step 1: none needed.

**Application compatibility of step 2:** all 5 services that use the content tables import `backend/db/supabaseClient.ts`, which uses the secret (service-role) key (`requireSupabaseSecretKey()`, line 56). No client-role path uses those tables, so no behaviour changed.

The idempotency purge stays **uncalled and unscheduled**.

## 4. Production schema verification and ledger reconciliation

**Table map** (doc 14, not repeated; there was no new contradiction):
- 830 ALIGNED, 5 SAFE FORWARD, 11 PRODUCTION-ONLY, 4 UNRESOLVED (detailed below).
- The forward items are handled:
  - the content-grant drift by step 2;
  - the prospect grants verified, by step 1.
- The remaining SAFE FORWARD items are repository-side only and need no production write (doc 14 §4).

**Ledger**, accounted for, with no artificial rows written:
- **`20261127000000` and `20270202000000`:** written by EXPAND-35's ledger-only step on 2026-11-21 03:02Z. Now recorded in `applied-boundary.json`.
- **About 30 stranded-line migrations:** live without ledger rows. Recorded in `APPLIED-WITHOUT-LEDGER.md` through the runners' records. They land in the repository with the stranded-line landing.
- **Never use `db push`**, bulk or otherwise.

**The 4 UNRESOLVED decisions (doc 14 §10), and what was done:**

| Item | Disposition |
|---|---|
| `leads`: main's person-erasure migrations `20270112000001/3/4` and `20270115000000` are not in production | **Not applied: a separate feature rollout, not drift.** Applying them also needs `20270112000000` and `…02`, which production lacks too. `…04`/`…05` are owner-selectable privacy policies. The only consumer, the admin erasure API, fails closed today with 503 `ERASURE_SCHEMA_NOT_READY` (`personErasureRequests.ts:295-305`), and the worker cannot reach it. Order when rolled out: `…000000 → …01 → …02 → …03 → [04] → [05] → 20270115000000`. Never re-run `…03` after `…04`/`…05`. |
| `rbac_config` | Production `service_role=r`, from the deferred `rbac_config_contract_legacy_insert.sql` applied out of band. The repository keeps its file in `supabase/deferred/`. Preserved; promoting it is an owner decision. |
| `prospect_lists.icp_id` and `prospect_lists_icp_tenant_fk` | **Preserved.** Represented in the repository by `20270111100007` on the stranded line (§1.1). It is not re-run against production. |
| `signal_excerpt` | Preserved as production-only (doc 14). |

**Production-only objects preserved:** all 11 from doc 14 §8, plus the roles `omnivyra_pi_inventory_ro` and `cli_login_postgres` (expired 2026-11-22). Their removal is an owner decision: no step touched them.

## 5. Application environment verification

Only classifications were printed, never values. Script: `C:/omnivyra-archive/tools/env-target-audit-20261127/env-target-audit.js` (self-test PASS).

| Runtime | Variable | Resolves to | Matches intent |
|---|---|---|---|
| Railway worker (`production/Omnivyra`) | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | `klkiseupptzbecbxwrky` (production) | yes |
| Railway worker | `REDIS_URL` | `right-treefrog-90757` (production Redis) | yes |
| Railway worker | service-role, secret, anon and publishable keys | present | — |
| Vercel production (browser bundle, live `www.omnivyra.com`) | public Supabase URL compiled into the client | `klkiseupptzbecbxwrky.supabase.co` | yes |
| Vercel production, server side | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `REDIS_URL` | **unreadable**: stored as Vercel "sensitive" variables; present | not verifiable by API (§10) |
| Vercel preview | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, anon key | **unreadable** ("sensitive"); present | not verifiable by API; preview deploys are off (`vercel.json deploymentEnabled:false`) |
| GitHub Actions | repository secrets | only the 7 `E2E_*`; deployment environments hold 0 secrets | E2E-only (§8) |
| CI (after #468) | — | disposable local stack only: no secret, loopback targets, hosted markers refused | yes |
| Local tests | jest `setupEnv` | refuses production and hosted E2E (12/12 with paired loopback controls) | yes |

**Deploys after the merge:**
- Railway deployed `329743dfa` (deployment `39df5eb2`, SUCCESS).
- The previous worker build was `2bc52db7a`, so the deploy added only #466. #466 adds no worker runtime code except the uncalled cleaner.
- Vercel did not deploy (by design).

## 6. CI and C3 results

**Real-schema CI, CI-faithful (GitHub, pgvector):**

| Run | Ref | Result |
|---|---|---|
| `45929069039` | PR #466 | **89/89 suites, 1659/1659 tests** |
| `45930844559` | main `329743dfa` | same as PR #466 |

- The gap migration was applied once.
- The job's "Actor-FK" step fails with the **same 9 errors as main before this change** (main run `44926112215`). It adds one advisory INFO finding, `prospect_lists.created_by_user_id`: an ownership column with `ON DELETE SET NULL`. Its governance classification is left to the GOV-H owner.

**C3 disposable stack** (local Supabase on the runner, Redis service container, no repository secret):

| Run | ID | Commit | Result |
|---|---|---|---|
| 1 | `45825080632` | `f237b92f` | pass |
| 2 | `45928703068` | `ffaad4de` | pass: 5/5 auth specs (exact count asserted), guard 158/158, gap step, no hosted marker in env or app log, teardown |
| 3 | `45929472417` | `ffaad4de` | pass |
| 4 | `45933035633` | `20373e8a` (combined with guard + Stage 2) | pass, including the Redis identity seed before the rate-limit reset |
| 5 | `45935045333` | `9760e62b` | pass |

**Independent review of the combined line** (the owner's round-26 acceptance criterion 5):
- First verdict: PASS WITH CONDITIONS. The conditions F-1, F-2, F-3 and F-6 were fixed and re-verified by the same reviewer with mutation proofs; each control fails when its rule is removed.
- F-4 is documented: the Redis health step is a read-only PING with its own loopback check.
- F-5 is documented: if the CLI preflight fails, teardown relies on the discarded hosted runner.

**Local runs of the combined line:**
- `test:auth-e2e-guard`: 183/183;
- `tests/supabase-local`: 127/127;
- `check-secrets`: PASS.

## 7. Application functionality results

| Area | Evidence | Result |
|---|---|---|
| Build | "Production build" (#466 and #468) | pass |
| Typecheck | "Backend TypeScript certification", "Non-regression TypeScript baseline", "Backend test typecheck baseline" | pass |
| Auth and session, roles, API authorization | "Static auth invariants", "Auth integrity regression lock" (#466: the hosted suite still ran then), C3 local suite 5/5 (runs 2–5), `check-tenant-authz` | pass |
| Tenant isolation | real-schema TI suites inside the 1659/1659; new `pl_`/`cl_client_privileges_revoked` real-DB tests (42501 for `authenticated`) | pass |
| Prospect Intelligence, ICP and prospect lists | "PI unit suites"; real-schema suite | pass |
| Content and learning intelligence | writers verified service-role only (§3); real-schema suite | pass |
| Orchestration, outreach, email and other integrations | "Campaign generation + canonical persistence contracts", "Runtime observability gate (120 scenarios)", "Stability regression lock", "Strategic narrative regression lock", "Platform parity validators" | pass |
| Idempotency and retry | 16 retention tests + related unit suites (432/432 locally); purge has no caller | pass |
| Database functions and triggers | 75 touch triggers (74 floor) on the replay and in production; real-schema suite | pass |
| Background jobs and worker | worker deployed `329743dfa` SUCCESS; `/health` `{"status":"ok","cron_status":"ok"}` | pass |
| Billing and credits | billingContract 4/4; stability suite | pass |
| Health and deployment | web `/api/health/version` 200 (`environment=production`); worker 200, after every production step | pass |
| Snapshot and report contracts | "Snapshot remediation contracts", "Snapshot dossier consistency", "Report Consistency" | pass |

**Failures, all pre-existing, none a regression:**
- Actor-FK step (above).
- The "Supabase Preview" check: the preview branch replays every migration from empty and hits the known duplicate-version problem (`20260320`, SQLSTATE 23505).
- `gitleaks` on #468: three synthetic fixtures inside the original reviewed C3 commit, which is history. Not a required check.

**Observation outside this change:** web `/api/health/config` reports `redis.connected=false`. This is unchanged by this work; flagged in §10.

## 8. Hosted E2E workflow removal and secrets

- **Workflow:** on `main` `130ce223`, `auth-integrity.yml` holds only the static job; the disposable-stack workflow `auth-integrity-local.yml` runs on every PR. `git grep` for `secrets.E2E_` under `.github` on `main`: 0 hits.
- **Secrets:** at 06:43:00Z all 7 `E2E_*` repository secrets returned 404 and the repository secret count was 0; the 4 environments and Dependabot hold 0. They were removed before this executor's step; **this executor deleted nothing**. The deletion time and actor are not visible to this account (the audit log needs admin).
- **Last hosted run:** `45939076841`, finished 04:20:38Z. Auth Integrity runs since then contain only the static job.

## 9. E2E project retirement

**In progress.** Baseline S0 taken 2026-11-27 06:44:11–06:44:21Z (§11). Observation window open; pause not yet performed; deletion not performed.

**Recovery archive, pass 1 (2026-11-27 ~08:05–08:45Z):** `C:/omnivyra-archive/e2e-retirement-20261127/archive-20261127T0801Z/`
- `MANIFEST.json` + `SHA256SUMS` (93 files, all verify) and `RESTORE.md` (steps, dependencies, known gaps).
- Database: `pg_dump` 17.11 custom-format full dump, **encrypted** (`db/full.dump.gpg`, gpg AES-256; key in Windows Credential Manager `omnivyra-e2e-archive-20261127`, decrypt-and-compare verified), plus plain `schema.sql`, `roles.sql` (no passwords), per-table row counts, extension list, TOC.
- Configuration (GET-only, secret fields redacted): project, auth, database, pooler, PostgREST, realtime, storage, functions (none), secrets (names only), buckets (none), migration history (empty), network, SSL, branches, add-ons.
- Integrity: `pg_restore --list` 9,699 entries; full data read PASS; 895/896 data entries (the missing one is the partitioned parent `realtime.messages`, 0 rows).
- **Restore test (local throwaway PostgreSQL 17.11, no Docker):** 890/896 tables restored with identical row counts; not restored: the 5 tables with pgvector columns and `vault.secrets` (all 0 rows), because pgvector and supabase_vault are not installed locally; 0 unexplained errors. A Supabase local-stack restore was **not performed** (Docker prohibited).
- Secret scan: gitleaks (default and repo config) and a credential-pattern grep over the archive: clean.
- Access: temporary read-only CLI login roles (Management API `cli/login-role`), each deleted after use; `h01` shows no `cli_login` role left.
- A complete rehearsal of the final pass (`archive-rehearsal-20261127T0818Z/`) produced the same result. The **final pass** (`final-pass.sh`) runs after 2026-11-30 06:43Z, before the pause.

**Final inventory (read-only, 2026-11-27 ~02:45Z):**
- 850 public tables, of which 2 hold rows: `capability_audit_log` 3,247 (it grows only while the hosted job runs) and `api_idempotency_keys` 2;
- 1 auth user; 0 storage buckets or objects; no cron; no migration ledger table; database about 69 MB.

**Residue handling:**
- archived outside production and outside the public repository: `C:/omnivyra-archive/e2e-retirement-20261127/` (`f01`–`f03` + `SHA256SUMS`);
- **nothing was copied into production.**

## 10. Unresolved exceptions

1. **Vercel server-side and preview Supabase URLs** (RESOLVED 2026-11-27: USER VERIFIED PASS; the user confirmed on 2026-11-27 (~08:45Z) that all four Vercel entries (`SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`, Production and Preview) hold the same Supabase URL. One of them, Production `NEXT_PUBLIC_SUPABASE_URL`, is compiled into the live browser bundle, which was verified as `https://klkiseupptzbecbxwrky.supabase.co` (18 §5). Therefore all four are the canonical production URL. No value was read, exposed or changed.) Original note: they are Vercel "sensitive" variables, so no API can read them back.
   - The production browser bundle is verified as production.
   - Owner check: in the Vercel project's Environment Variables page, confirm that `SUPABASE_URL` (Production and Preview) contains `klkiseupptzbecbxwrky`.
2. **Required checks:** add both "Local Supabase stack validation" and "Auth integrity regression suite (local Supabase)" to `main`'s branch protection (doc 22: both, because the auth job `needs` the stack job). This needs repository admin; this account has push only. **Still outstanding at 06:43Z: 9 checks required, neither local check among them.**
3. **Owner decisions still open** (preserved, untouched): erasure rollout (§4), `rbac_config` promotion, `omnivyra_pi_inventory_ro` and `cli_login_postgres` roles, ledger repair policy, Supabase automatic branching on production (preview noise).
4. **Follow-ups:**
   - in C3 the gap-created content tables keep the image's default client grants, because `20270301000010` runs before the gap step;
   - version reservations for `20270301000000/01/10`;
   - `platform-parity.yml` production audit runs on empty secrets;
   - web `redis.connected=false`;
   - the Railway Config-as-Code cutoff on 2026-12-01 (`RAILWAY_DOCKERFILE_PATH` already set).

## 11. Completion log

| UTC (2026-11-27) | Step | Result | Evidence |
|---|---|---|---|
| 05:10:39 | #468 merged (merge commit, not squash/rebase) | MERGED by the owner's account | `gh pr view 468`: state MERGED, mergeCommit `130ce223`; `main` HEAD = `130ce223`; tree `30d14bad` = tree of `6f5d3501` |
| ~06:40 | post-merge content check | PASS | 34 files vs `4a957d29`; `.gitleaks.toml` unchanged; `.gitleaksignore` 19 unique fingerprints, all 15 of `4a957d29` present, 0 removed lines |
| 05:10:41 | Railway worker deploy of `130ce223` | SUCCESS | deployment `4edc8198` (previous `90c925ed` REMOVED) |
| 06:41 | health | ok | worker `/health` 200 `status ok, cron_status ok`; web `/api/health/version` 200 (`dpl_E55G…`, unchanged: Vercel auto-deploy is off, so this merge did not redeploy web); log scan: no ERROR/FATAL, only pre-existing direct-`process.env` WARNs, redis `commands_failed=0` |
| ~06:42 | `main` push CI on `130ce223` | 11/11 success | runs `45944221580`–`45944221845` |
| 06:43:00 | 7 `E2E_*` secrets | ABSENT (removed earlier by someone else; not by this executor) | each `GET …/actions/secrets/<name>` 404; total_count 0; environments and Dependabot 0 |
| 06:43 | branch protection | NOT DONE, admin action outstanding | 9 required checks; account `admin:false` |
| 06:43:00 | **T0** | set to the first observed absence of the secrets (conservative; actual deletion time unknown) | grace already satisfied: last hosted run ended 04:20:38Z, none in flight |
| 06:44:11–06:44:21 | **S0** baseline: exact prepared `g01`–`g07` via the E2E read-only endpoint | taken; guard ACCEPT ×7, selftest PASS (read-only user, `transaction_read_only on`) | `C:/omnivyra-archive/e2e-retirement-20261127/s0-20261127/` + `SHA256SUMS` |
| 04:28 → 06:44 | pre-window comparison (`g07_E` vs S0) | no write activity | `capability_audit_log` 3,301 (max `occurred_at` 04:20:29Z), auth/idem/storage counts and timestamps, all write counters and client-role call totals unchanged; only `xact_commit` (+4,017, read-only/monitoring transactions), client backends 4→1 and `newest_client_state_change` (idle connections closed) moved |

| ~08:05–08:45 | recovery archive pass 1 + rehearsal | PASS (see §9) | `C:/omnivyra-archive/e2e-retirement-20261127/archive-20261127T0801Z/`, `archive-rehearsal-20261127T0818Z/` |
| 08:18–08:27 | client-role counter movement after S0 investigated | attributed to this executor's archive calls, except `supabase_auth_admin` +2 and `supabase_storage_admin` +1 (single reads, no data change) | 21 §7 |
| 08:27:17 | **S1** (role-call comparison point after all pass-1 archive actions) | taken | `s1-20261127/` + `SHA256SUMS` |

Still pending: observation window (C1: ≥ 72 h from S0 while the Vercel check is NOT YET VERIFIED, i.e. not before 2026-11-30 06:44Z; 24 h if it becomes USER VERIFIED), pause (C4), paused period (C5), deletion (C7, separate final verification).
