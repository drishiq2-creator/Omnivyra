# 01 — E2E activity inventory

Repository baseline: `2bc52db7a` (`main`). Scope: the complete tracked repository, excluding `node_modules`. No `.env*` file was opened; such files were only listed by name. All line references are to that commit.

## Summary

| Category | Count | Activities |
|---|---|---|
| Active, touches the E2E **database** | 3 | ACT-01, ACT-02, ACT-03 |
| Active, E2E-related but **no database access** | 4 | ACT-04, ACT-05, ACT-06, ACT-07 |
| Manual/operator path to E2E (no evidence of current use) | 1 | ACT-08 |
| Could reach E2E only if someone repoints configuration (no evidence it ever did) | 4 | POT-01 to POT-04 |
| Historical operations recorded against E2E | 3 | HIST-01 to HIST-03 |
| **Total** | **15** | |

**Bottom line.** Exactly one live workload uses the E2E project's database: the hosted Auth Integrity regression suite (ACT-01), with its suite runner (ACT-02) and identity cleanup (ACT-03). The application itself cannot select E2E except through environment variables. A search of `pages`, `app`, `backend`, `lib`, `components`, `config`, `shared`, `utils`, `infra` and middleware for the E2E ref, `E2E_SUPABASE*`, `AUTH_E2E*` or `.env.e2e` returned no matches. `backend/db/supabaseClient.ts:31-34` loads `ENV_FILE`, then `.env.cert`, then `.env.local`, never `.env.e2e`.

**Last E2E activity (read-only GitHub metadata):**
- Run 44932032061 of `.github/workflows/auth-integrity.yml`, a `pull_request` on `feat/pi-salesnav-extract-page-20261121` at head `cd705f1a3b4c`.
- Job "Auth integrity regression lock" ran from **2026-11-21T17:52:24Z to 17:56:12Z**. Every step succeeded, including "Assert target is the dedicated E2E project" and "Auth integrity regression suite".
- The 6 most recent runs all executed the live job.
- The 200 most recent workflow runs (2026-10-29 to 2026-11-21) are 199 `success` and 1 `cancelled`.

A replacement now exists. The C3 advisory workflow `.github/workflows/auth-integrity-local.yml` runs the same five specs against a disposable local Supabase stack. Run 45825080632 on 2026-11-26 passed 5/5 with no hosted contact. The workflow is not yet on `main`.

## Live verification (2026-11-26)

The live E2E write statistics, accumulated since the 2026-11-08 refresh ([05](05-live-e2e-inspection-report.md)), **confirm ACT-01 to ACT-03**:

| Table | Inserts | Updates | Deletes |
|---|---|---|---|
| `public.users` | 1,404 | 1,105 | 1,404 |
| `public.auth_sessions` | 1,575 | 1,050 | 1,575 |
| `public.capability_audit_log` | 3,211 | 0 | 0 |
| `auth.users` | 2,796 | 13,623 | 2,796 |
| `auth.sessions` / `refresh_tokens` / `mfa_amr_claims` | 3,137 each | | 3,137 each |
| `auth.one_time_tokens` | 1,038 | | 1,038 |

The cleanup (ACT-03) removes the suite's rows: `public.users` and `auth_sessions` are now empty.

**New finding (count corrected in [07](07-retained-table-disposition.md#2-the-20-versus-19-reconciliation)).** **Twenty-three** other `public` tables show small, balanced writes that no activity in this inventory explains. (An earlier version of this paragraph said "twenty"; that was a miscount.)
- 4 inserts and 4 deletes on `companies`, `user_company_roles`, `engagement_threads` and `engagement_messages`.
- 2 and 2 on 18 others, for example `campaigns`, `reports`, `prospect_accounts` and `unified_persons`.
- `api_idempotency_keys`: 2 inserts and 4 updates, with 2 rows remaining.
- Updates also appear on `companies` (2) and `attested_engagement_identities` (2).

`pg_stat_statements` attributes all of these writes to `service_role` through PostgREST: an ad-hoc or branch-only seed-and-clean harness that is not on `main` (07 §2). Of the 23 tables, 19 are classified HISTORICAL. The other 4 keep a higher class: `companies`, `prospect_accounts` and `unified_persons` are DEPENDENCY, and `user_company_roles` is ACTIVE.

**Correction:** `auth.audit_log_entries` has 0 writes, so it is not touched by ACT-02. `auth.mfa_amr_claims` is.

**Platform resources (live):** no storage buckets or objects, no cron schema, no Edge Functions, and no realtime publication on any `public` table.

---

## Active: touches the E2E database

### ACT-01 — Hosted CI job "Auth integrity regression lock"
- **Where:** `.github/workflows/auth-integrity.yml`, job `auth-integrity` (about lines 148–347).
- **Purpose:** live browser regression of authentication: callback isolation, expired-link fail-closed, logout revocation, org-context isolation and multi-tab isolation.
- **How it reaches E2E:**
  - The job environment binds the app's canonical variables from the `E2E_*` secrets (lines 198–213): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SESSION_COOKIE_SECRET` and `ENCRYPTION_KEY`.
  - The header names the target (lines 31–32).
  - It sets `ALLOW_PROD_DB_WITH_LOCAL_REDIS: '1'` (line 234), so the app accepts a remote Supabase project with a loopback Redis.
- **Steps:**
  1. Hermetic checks.
  2. Assert there is no `.env.local`.
  3. Inline production refusal.
  4. `check:auth-e2e-target` (ACT-04).
  5. Redis health check, then `reset:auth-e2e-rate-limits` (ACT-05).
  6. `npm run dev` bound to E2E.
  7. `npm run test:auth-integrity` (ACT-02).
- **Tables:** everything ACT-02 and ACT-03 touch.
- **Trigger:** `pull_request` (all paths) and `workflow_dispatch`. The job runs only when `e2e-secrets-preflight` outputs `provisioned == 'true'` (line 160). Otherwise it is **skipped, not failed**.
- **Active:** yes (evidence above).
- **Required check:** not shown by the repository. The repository locks only "Static auth invariants (hermetic, no secrets)" as the required context (`tests/auth/authIntegrityWorkflow.spec.ts:28`).
- **Confidence:** HIGH.

### ACT-02 — Live auth suite (`npm run test:auth-integrity`)
- **Where:** `scripts/run-auth-integrity-tests.js` runs these five specs serially: `tests/auth/auth-callback-isolation.spec.ts`, `expired-link-failclosed.spec.ts`, `logout-session-revocation.spec.ts`, `org-context-isolation.spec.ts` and `multitab-auth-isolation.spec.ts`. The shared harness is `tests/auth/authTestHarness.ts`.
- **Purpose:** as for ACT-01.
- **Direct database operations (admin API, harness):**
  - `auth.admin.createUser` with `email_confirm: true` (`authTestHarness.ts:106`).
  - `auth.admin.generateLink({type:'signup'})` (`:118`), which creates an unconfirmed `auth.users` row.
- **Indirect operations:** the browser drives the dev server, which is bound to E2E. Verified at source:

| Table | Operation | Code |
|---|---|---|
| `public.users` | SELECT, INSERT, UPDATE | `pages/api/auth/login.ts:44`; `pages/api/auth/sync-supabase-user.ts:186`, `:356` (insert), `:253`/`:427` (update); `pages/api/auth/verify-email.ts:149`, `:169` (update); `pages/api/company-profile/index.ts:177`; `backend/services/userColumnProjection.ts:161` via `authResolver.ts` |
| `public.auth_sessions` | INSERT, SELECT, UPDATE | `backend/security/SessionAuthorityService.ts:167` (insert), `:220` (select), `:268` (revoke), `:255` (last_seen) |
| `public.capability_audit_log` | INSERT | `backend/security/audit/SecurityAuditService.ts:148`, via `sync-supabase-user.ts:108`, `pages/api/auth/logout.ts:52` and `verify-email.ts:178` |
| `public.stepup_sessions` | SELECT, UPDATE (revoke; normally 0 rows) | `backend/security/stepup/StepUpSessionService.ts:151` via `logout.ts:49`; `backend/security/IdentityResolver.ts:173` |
| `public.signup_intents` | SELECT, UPDATE (normally 0 rows) | `backend/services/signupEventService.ts:156`; `verify-email.ts:198` |
| `public.user_company_roles` | SELECT | `pages/api/auth/post-login-route.ts:122`; `company-profile/index.ts:187`; `IdentityResolver.ts:75`; `backend/security/CapabilityService.ts:60` |
| `public.capability_assignments` | SELECT | `CapabilityService.ts:64` |
| `public.webauthn_credentials` | SELECT | `IdentityResolver.ts:108`; `WebAuthnCredentialRepository.ts:76` |
| `public.totp_factors` | SELECT | `IdentityResolver.ts:113`; `TotpFactorRepository.ts:59` |
| `public.trusted_devices` | SELECT | `IdentityResolver.ts:224` |
| RPC `public.auth_user_confirmed`, `public.auth_user_has_password` | EXECUTE (both read `auth.users`; `SECURITY DEFINER`) | `login.ts:52`, `:82`; `sync-supabase-user.ts:231`; definitions in `baseline.sql:978-1015` |
| `auth.*` (GoTrue) | sign-in, verify, setSession, signOut | `pages/login.tsx:198`; `pages/auth/callback.tsx:121`; `pages/create-account.tsx:57`; `authTestHarness.ts:194` |

- **Conditional paths, not expected to run in CI:**
  - `public.companies`: a one-time schema probe (`limit 0`, `schemaHealthCheck.ts:95-111`); company reads happen only when a user has company roles, and test users have none.
  - `public.auth_audit_logs` and `public.system_anomalies`: only when the login rate limiter cannot reach Redis (`lib/auth/rateLimit.ts:315` → `lib/anomaly/detectionEngine.ts:154`).
- **Storage:** none. Browser-side `.from()` calls: none.
- **Measured residue per run (historical, PHASE 147):** +1 `public.users`, +1 `public.auth_sessions`, +2 `public.capability_audit_log` (`tests/auth/e2eIdentityCleanup.ts:7-9`).
- **Trigger:** ACT-01, or a manual local run (ACT-08).
- **Active:** yes.
- **Confidence:** HIGH for the direct operations and the listed paths; MEDIUM for full branch coverage.

### ACT-03 — Identity cleanup (`tests/auth/e2eIdentityCleanup.ts`, `cleanupIdentity`)
- **Purpose:** remove each test identity after every spec. Called through `cleanupUsersByEmail` (`authTestHarness.ts:135-146`).
- **Operations, in order:**
  1. `auth.admin.listUsers({page:1, perPage:1000})` (`:87`). Only the first 1,000 users are searched.
  2. `public.users` SELECT `id, supabase_uid` by email (`:94-97`).
  3. `public.capability_audit_log` SELECT count (`:120-123`). It is **never deleted**: the table is append-only by trigger.
  4. `public.users` **DELETE** by id (`:130`).
  5. `auth.users` **DELETE** through `auth.admin.deleteUser` (`:137`).
- **Explicit deletes:** only `public.users` and `auth.users`.
- **Database-side effects (from `baseline.sql` foreign keys):**
  - Deleting `public.users` reaches 119 inbound foreign keys:
    - 20 ON DELETE CASCADE: `auth_sessions` → `stepup_sessions`, `user_company_roles`, `user_preferences`, `free_credit_claims`, `free_credit_profiles`, `capability_assignments`, `totp_factors`, `trusted_devices`, `webauthn_credentials`, `webauthn_challenges`, `recovery_codes`, `company_join_requests`, `intelligence_role_assignments`, `opportunity_assignments`, `report_automation_configs`, `report_automation_events`, `report_notification_events`, `strategy_templates`, `super_admin_audit_logs`;
    - 96 SET NULL;
    - **3 NO ACTION:** `block_templates.created_by`, `campaign_cost_breakdown.user_id` and `company_join_requests.reviewed_by`.
  - Deleting `auth.users` cascades to `free_credit_unlocks`, `notifications` and `user_override`, and sets NULL on `access_requests` and `campaign_readiness_leads`.
- **Defect in a code comment, noted rather than fixed:** `e2eIdentityCleanup.ts:13-14` says every foreign key into `users` is CASCADE or SET NULL. Against the baseline that is not strictly true:
  - the 3 NO ACTION keys would block the delete if a test user ever owned such a row;
  - `super_admin_audit_logs` cascades but has an immutable-delete trigger (`super_admin_audit_logs_immutable_delete` → `raise_ledger_immutable()`).

  Test users never create those rows, so the cleanup works today.
- **Active:** yes. **Confidence:** HIGH.

## Active: E2E-related, no database access

| ID | Activity | Where | Purpose | Database effect | Trigger | Confidence |
|---|---|---|---|---|---|---|
| ACT-04 | Target check `npm run check:auth-e2e-target` | `tests/auth/assertE2ETarget.ts`; `package.json:53` | Refuse unless the configured target is the E2E project | None (URL parsing only) | ACT-01 step "Assert target is the dedicated E2E project"; manual | HIGH |
| ACT-05 | Rate-limit reset `npm run reset:auth-e2e-rate-limits` | `scripts/reset-auth-e2e-rate-limits.js`; `package.json:54` | Clear `rl:*` login counters between runs | **Redis only, never Supabase**: SCAN+DEL of 8 `rl:*` prefixes. In CI this is the loopback service container. | ACT-01; manual | HIGH |
| ACT-06 | Secrets preflight job `e2e-secrets-preflight` | `auth-integrity.yml:100-146` | Check that the `E2E_*` secrets are present; refuse production URLs | None | every `pull_request` / `workflow_dispatch` | HIGH |
| ACT-07 | Hermetic guard and lock tests `npm run test:auth-e2e-guard` | `package.json:52`; `tests/auth/*.spec.ts` (guard, authStateKeys, cleanup, workflow lock) | Unit tests; the E2E ref appears only as fixture text | None (a fake client is used) | ACT-01 | HIGH |

## Manual / operator path

| ID | Activity | Where | How it reaches E2E | Tables | Status | Confidence |
|---|---|---|---|---|---|---|
| ACT-08 | Local run of ACT-02 by an operator | `tests/auth/e2eEnvironmentGuard.ts:56-63` loads `AUTH_E2E_ENV_FILE` (default `.env.e2e`) with `override: true`; the dev server is started with `ENV_FILE=.env.e2e` | `.env.e2e` (gitignored; exists only on operator machines, not inspected) | as ACT-02 and ACT-03 | No evidence of current use in the repository; whether `.env.e2e` still exists on any machine is **unknown** | MEDIUM |

## Could reach E2E only through configuration (no evidence it ever did)

| ID | Activity | Where | Condition | Database effect | Trigger | Confidence it does NOT use E2E |
|---|---|---|---|---|---|---|
| POT-01 | `platform-parity.yml` | `.github/workflows/platform-parity.yml`, job `parity` (secrets at lines 48–55, written to `.env.local` at 73–84) | Only if the **plain** `SUPABASE_*` secrets held E2E values. `auth-integrity.yml:20-29` warns about exactly this. | READ `company_integrations` and `websites` (`scripts/ops/integrationAudit.ts` around 246–252); optional Management API read (`scripts/ops/supabaseAuthAudit.ts:55-70`) | `pull_request` (paths), push to `main`, `workflow_dispatch` | MEDIUM (intended target is production; secret values not visible) |
| POT-02 | `npm run db:push` | `scripts/operator/db/db-push.sh` (`package.json:69`); `scripts/guard-no-prod-push.sh` | `--target-env=staging --project-ref=<non-prod>` passes the guard (`guard-no-prod-push.sh:46,49`); also needs `--apply --acknowledge-ledger-desync` | Schema changes | Manual | HIGH (nothing shows use against E2E) |
| POT-03 | Beta seed, reset and verify | `scripts/beta/*.mjs` (`package.json:13-15`) | `BETA_SUPABASE_URL` / `BETA_SUPABASE_SERVICE_KEY` (production denylist only) | Seed inserts `companies`, `credit_cost_config`, `credit_transactions`, `auth.users` and others; reset deletes 21 public tables plus `auth.users` (`reset-beta.mjs:15-20, 39-66`) | Manual | HIGH (no link to E2E) |
| POT-04 | Generic `ENV_FILE` loaders | `backend/db/supabaseClient.ts:31-34`; `scripts/lib/certAwareEnv.cjs:76`; `scripts/env-safety-check.js:24` | `ENV_FILE=.env.e2e` would point any backend script at E2E | Depends on the script | Manual | HIGH (theoretical) |

**Not E2E:**
- **Cert scripts** (`scripts/cert/**`) target a loopback stack. `certAwareEnv.cjs:38-66` refuses non-loopback hosts under `CERT_ENV=1`.
- **PI scripts** have no E2E references. `docs/pmo/prospect-intelligence/PI-ACTIVATION-PHASE-A-B-REPORT-001.md:45-46` states its work was on **production**, "not the E2E project".

## Historical operations against E2E

| ID | Record | What was done | Tables | Evidence | Confidence |
|---|---|---|---|---|---|
| HIST-01 | ENG-004 | One-off read-only row count; no migration applied ("no DB password … PostgREST cannot run DDL") | `engagement_threads` and `engagement_messages`: 0 rows | `docs/pmo/ENG-004-IMPLEMENTATION-REPORT.md:171-173, 407-409`; `ENG-004-CLOSURE-REPORT.md:192` | HIGH |
| HIST-02 | Schema parity and refresh | Schema brought to parity with production (2026-08-30: 830 tables). `public` replaced from a production schema dump on 2026-11-08. | whole `public` schema | **Operator session records, not in the repository**; the cleanup comment `e2eIdentityCleanup.ts:11` ("verified against the live E2E catalog") corroborates catalog work | MEDIUM |
| HIST-03 | PI provider-path probe (041-W1) | Read probe; "404s on ALL 7 Workflow/Email tables" at that time | 7 PI workflow/email tables (names in the session record) | Operator session record, not in the repository | LOW–MEDIUM |

Docs that only mention `.env.e2e` as a scanned file name, with no database operation: `docs/pmo/prospect-intelligence/D22-B4-A2-TENANT-APOLLO-AUTHENTICATION.md:58` and `D22-B4A-APOLLO-DISCOVERY.md:83`.

`docs/AUTH-INTEGRITY-RULES.md:115-122` lists outdated variable names (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and no `E2E_*` names. It is out of date compared with the workflow.

## Items that change when E2E is retired (for later phases; nothing changed here)

- `auth-integrity.yml` jobs `auth-integrity` and `e2e-secrets-preflight`, and the 8 `E2E_*` secrets the workflow reads: `E2E_SUPABASE_URL`, `E2E_NEXT_PUBLIC_SUPABASE_URL`, `E2E_SUPABASE_SECRET_KEY`, `E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY`, `E2E_SESSION_COOKIE_SECRET` and `E2E_ENCRYPTION_KEY`.
- `DEFAULT_EXPECTED_E2E_PROJECT_REF` (`tests/auth/e2eEnvironmentGuard.ts:26`), the `.env.e2e` defaults (`e2eEnvironmentGuard.ts:57`, `reset-auth-e2e-rate-limits.js:27`), and spec fixtures.
- `tests/auth/authIntegrityWorkflow.spec.ts` locks the hosted workflow's shape and will fail on edits to it.
- **Hazard:** deleting the `E2E_*` secrets makes the live job **skip silently**, not fail.
- **Hazard:** repointing the plain `SUPABASE_*` secrets would silently change what `platform-parity.yml` audits.
