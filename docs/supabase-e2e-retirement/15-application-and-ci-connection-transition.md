# 15 — Application and CI connection transition (hosted E2E → disposable)

Worktree `C:\tmp\omnivyra-p3-C`, branch `p3-C/e2e-consolidation`, base `main` `2bc52db7a` (plus 16 uncommitted integration files, untouched here). Nothing was committed, pushed, dispatched or changed on GitHub, Supabase, Vercel or Railway. No `.env*` file was read.

Target architecture:

| Consumer | Destination |
|---|---|
| Production app (Vercel web, Railway worker) | main project `klkiseupptzbecbxwrky` |
| Local development | an explicitly configured local environment (`.env.local` / `.env.cert` / `ENV_FILE`; for the auth suite `AUTH_E2E_TARGET=local` + `tests/supabase-local/bootstrap.sh`) |
| CI / automated tests | a disposable Supabase stack (C3, `tests/supabase-local`) or hermetic placeholders |
| Hosted E2E `lomndxmrpyudaegddpef` | nothing, after Stage 2 |

## 1. Connection map

Full map: `C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/C/connection-map.csv` (43 rows, CM-01 to CM-43, file:line on `2bc52db7a` unless marked C3). It starts from [01](../../../omnivyra-e2e-retirement-20261126/docs/supabase-e2e-retirement/01-e2e-activity-inventory.md) and re-verifies each item one layer down (the workflow bodies, the harness, the app clients, the jest setup, and read-only GitHub metadata).

Counts by classification (a row counts once, by its primary class):

| Classification | Rows | Still needs hosted E2E today |
|---|---|---|
| RUNTIME CONNECTION | 18 (CM-01, 02, 04, 07, 10, 12, 15, 19, 20, 22, 23, 29, 30, 33, 35, 36, 39, 40) | 6: CM-01, 02, 04, 07, 10 (hosted auth job, its preflight, bypass flag, secrets, hosted-mode harness), CM-12 (only if an operator still holds `.env.e2e`) |
| SAFETY GUARD (keep) | 18 (CM-03, 06, 11, 13, 14, 17, 18, 21, 24, 25, 26, 27, 28, 31, 32, 37, 38, 43) | 0 |
| DOCUMENTATION-HISTORY (keep) | 4 (CM-05, 16, 41, 42) | 0 |
| DEAD CONFIG | 3 (CM-08, 09, 34) | 0 |
| **Total** | **43** | **6** |

(Counted by the primary class in the CSV "classification" column; where a row is both a guard and a connection, the CSV says so.)

### Facts verified (2026-11-27, read-only)

- **The ref appears in exactly 7 tracked files on main**: `.github/workflows/auth-integrity.yml:32` (comment), `tests/auth/e2eEnvironmentGuard.ts:26` (allowlist constant), `tests/auth/e2eEnvironmentGuard.spec.ts:107`, `tests/auth/authStateKeys.spec.ts:22,23,70,71` (fixtures), and three `docs/pmo` reports (history). No app runtime, worker, API route, deployment config or package script names it.
- **The app selects a Supabase project only from the environment**: `backend/db/supabaseClient.ts:31-35,47` (`ENV_FILE` > `.env.cert` > `.env.local`, then `SUPABASE_URL`), `lib/supabaseBrowser.ts:32` and `lib/anomaly/*`, `lib/auth/auditLog.ts:22` (`NEXT_PUBLIC_SUPABASE_URL`). `vercel.json`, `railway.json` and both Dockerfiles carry no Supabase value (the Dockerfiles delete `.env*`).
- **Repository secrets** (`gh secret list`, names only): `E2E_ENCRYPTION_KEY`, `E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY`, `E2E_NEXT_PUBLIC_SUPABASE_URL`, `E2E_REDIS_URL`, `E2E_SESSION_COOKIE_SECRET`, `E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_SUPABASE_URL`. Nothing else. The 4 environments (`Production`, `Production – omnivyra`, `Production – virality`, `authentic-nature / production`) list no secrets. No repository variables. The repo is user-owned, so there are no organisation secrets.
  - `E2E_REDIS_URL` is read by no workflow (DEAD CONFIG).
  - The workflow also names `E2E_SUPABASE_SECRET_KEY` and `E2E_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which do not exist; the legacy-name fallbacks are what run.
- **POT-01 resolved**: `platform-parity.yml` reads plain `SUPABASE_*` / `NEXT_PUBLIC_SUPABASE_*` secrets, and **none exist** at repository level, so that job runs with empty values and cannot reach E2E (or production) through them. Its last 5 runs on `main` succeeded. This is a separate finding for the owner: the parity audit is not seeing production values.
- **Branch protection on `main`** (`GET repos/.../branches/main`, `protection` field; the dedicated `/protection` endpoint returns 404 for this token, which has push but not admin): 9 required contexts. The only auth one is **"Static auth invariants (hermetic, no secrets)"**. Neither "Auth integrity regression lock" nor "E2E provisioning preflight" is required. Rulesets: none.
- **Last hosted E2E activity**: `auth-integrity.yml` runs 44932032061 … 44870409933, all `pull_request`, all `success`, latest 2026-11-21T17:48Z. The C3 workflow "Auth integrity (local Supabase, advisory)" is already registered on GitHub (id 431617663) from its `ci-only/c3-auth-local/**` pushes; run 1 passed (45825080632).

## 2. What still requires hosted E2E today, and why

Exactly one live consumer: **the `auth-integrity` job of `.github/workflows/auth-integrity.yml`** (CM-01), with its preflight (CM-02), the bypass flag it sets (CM-04), the 6 secrets it reads (CM-07) and the harness running in hosted mode (CM-10). It runs on every `pull_request` because the secrets are provisioned.

Why it cannot be cut yet:

1. The replacement (C3 `auth-integrity-local.yml`, `tests/supabase-local/*`, the mode-aware `e2eEnvironmentGuard.ts`) is **not on main**. It lives in checkpoint `f237b92f` plus 12 pending files.
2. C3 acceptance needs 3 consecutive green runs. Run 1 passed; runs 2 and 3 each need separate owner approval.
3. Removing the secrets first would not fail anything: the preflight would report `provisioned=false` and the hosted job would **skip silently**, leaving PRs with no live auth coverage. The order must be: C3 lands → Stage 2 merges → secrets are deleted.

One manual path (CM-12, ACT-08) can still reach the hosted project: an operator machine holding `.env.e2e` and running `npm run test:auth-integrity` without `AUTH_E2E_TARGET=local`. Even with C3, hosted mode stays the default when `AUTH_E2E_TARGET` is unset. See §5 for the option.

## 3. Stage 1 — safe now (applied in this worktree)

No production behaviour change: every change is in test setup, a test-only guard or a test. The only shared module touched, `scripts/lib/certAwareEnv.cjs`, gains exports. `assertCertIsolationInProcess` remains inert unless `CERT_ENV=1`, and `loadCertAwareEnv` (used by `scripts/start-all.js`) is unchanged.

| File | Change |
|---|---|
| `scripts/lib/certAwareEnv.cjs` | New `HOSTED_E2E_MARKERS = ['lomndxmrpyudaegddpef']`. It is kept separate from `PROD_MARKERS` because `closure014CertFakePublisher.test.ts` mirrors that list and the E2E project is not production. New `TEST_TARGET_VARS` = `CONNECTION_VARS` + `SUPABASE_DB_URL` + `E2E_SUPABASE_URL`, `E2E_NEXT_PUBLIC_SUPABASE_URL`, `E2E_DATABASE_URL`, `E2E_REDIS_URL`. New pure `scanHostedTargets(env)`: refuses production AND hosted-E2E markers, case-insensitive, and never echoes values. `scanCertEnv` also names the hosted E2E ref. |
| `backend/tests/setupEnv.ts` | The jest setup refuses production **and the hosted E2E project** through `scanHostedTargets`, across more variables than before. Before this change it checked production markers only, case-sensitively, over `CONNECTION_VARS`. |
| `tests/auth/hostedSupabaseConnections.spec.ts` (new) | Static lock with pure rules and failing controls. (a) Only allowlisted workflows read `E2E_*` secrets (Stage 1: `auth-integrity.yml`). (b) Only `platform-parity.yml` reads production-valued secrets, in both `secrets.X` and `secrets['X']` forms. (c) The E2E ref is named only in allowlisted workflows. (d) `ALLOW_PROD_DB_WITH_LOCAL_REDIS` is set only where allowlisted. (e) Every literal `*SUPABASE_URL` in any workflow env (workflow, job or step level) is `https://placeholder.supabase.co`, `dry-run` or loopback. (f) App runtime dirs (`pages lib backend components config utils shared hooks middleware store platform modules features infra types`, test files excluded) and deploy/root runtime files never contain the E2E ref, `E2E_SUPABASE`, `.env.e2e` or `AUTH_E2E_`. The scan is non-vacuous: it asserts that it covers `supabaseClient.ts`, `supabaseBrowser.ts`, `namespace.ts`, `vercel.json` and `railway.json`, and more than 1,000 files. |
| `backend/tests/unit/testEnvHostedTargetGuard.test.ts` (new) | Jest: pure-scan cases, plus **the real `setupEnv.ts` executed in a child process** (empty cwd, so no env file is read). A loopback control must load cleanly; the hosted E2E ref in `SUPABASE_URL`, `E2E_SUPABASE_URL` or `SUPABASE_DB_URL`, and the production ref, must be refused; a password in a refused URL must never be printed. |
| `package.json` | `test:auth-e2e-guard` also runs `tests/auth/hostedSupabaseConnections.spec.ts`. That script runs in the hosted job today and in both C3 jobs, so the lock runs in CI before and after Stage 2. |

Already fail-closed and kept as they are: `backend/tests/realschema/setup.ts:25-29` refuses any `supabase.co/.com` DB URL (both refs); the C3 guard's local mode refuses production and `LEGACY_E2E_PROJECT_REFS`; C3's `ciAssertions.ts` `HOSTED_MARKERS` includes both refs plus `.supabase.co/.in/.com` and `.upstash.io`; the inline production refusals in `auth-integrity.yml` stay until Stage 2 deletes the job they protect.

### Stage 1 results

All runs used the placeholder env from the task brief (loopback URLs, placeholder keys); jest ran through `heavy.sh`. Logs are in `C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/C/`.

| Run | Result |
|---|---|
| jest `testEnvHostedTargetGuard` + `closure014CertIsolationGuard` + `closure014CertFakePublisher` + `phase2RouteWiring.entryConsumption` (every jest suite that greps for `certAwareEnv` / `setupEnv`, plus the new one) | **4 suites, 63/63 passed** (new suite: 12 tests) |
| jest `testRunnerManualIsolation` (the remaining `setupEnv` hit) | **10/10 passed** |
| `npm run test:auth-e2e-guard` (main + Stage 1; now includes the new spec) | **56/56 passed**, 0 skipped (new spec: 11 tests) |
| Targeted `tsc` (temp tsconfig extending root, deleted afterwards) of `setupEnv.ts`, `testEnvHostedTargetGuard.test.ts`, `hostedSupabaseConnections.spec.ts` | exit 0 |
| js-yaml validation of all 17 workflows | 0 problems |

Failing controls on the real repository (`failing-controls.sh`): each one breaks something, runs the suite, expects RED, then restores the file and checks it is byte-identical by sha256.

| Control | Broken | Result | Restored sha256 |
|---|---|---|---|
| FC-1 | `scanHostedTargets` stops checking `HOSTED_E2E_MARKERS` | RED (jest 4 failed / 12) | `a77941cf…6f34` = current |
| FC-2 | `setupEnv.ts` stops throwing on violations | RED (3 failed / 12: the child-process refusals) | `a09f8712…37ac` = current |
| FC-3 | `stability.yml` gains `${{ secrets.E2E_SUPABASE_URL }}` | RED (workflow allowlist test) | `94f002bc…0cff` (= HEAD; `git diff` clean) |
| FC-4 | `lib/supabaseBrowser.ts` mentions `.env.e2e` | RED (runtime scan test) | `beaafa52…584c` (= HEAD) |
| FC-5 | `report-consistency.yml` placeholder URL becomes the E2E project | RED (workflow allowlist test) | `41aa777b…7fc0d` (= HEAD) |

Post-change sha256 of the Stage 1 files: `stage1-post-hashes.txt` (same folder).

## 4. Stage 2 — remove the hosted E2E dependency (NOT applied; owner-gated)

Patch: `C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/C/stage2-remove-hosted-e2e.patch` (sha256 `a140c397ffca7679fccfb3958f5d97e48a05f14d612ee412600e1f88d9d53471`), 5 files, +149 / −499:

| File | Change |
|---|---|
| `.github/workflows/auth-integrity.yml` | Deletes `e2e-secrets-preflight` and `auth-integrity` (the hosted live job, its 8 secret references, `ALLOW_PROD_DB_WITH_LOCAL_REDIS`, the E2E-ref comment). Keeps `auth-invariants-static` **unchanged**, so the required context "Static auth invariants (hermetic, no secrets)" is untouched. The workflow then reads no secret at all. |
| `.github/workflows/auth-integrity-local.yml` (C3) | Adds `pull_request` (no filter, like the job it replaces) next to `workflow_dispatch` and the `ci-only/c3-auth-local/**` push. Drops "advisory" from the workflow and job names, pinning the contexts **"Local Supabase stack validation"** and **"Auth integrity regression suite (local Supabase)"**. Header rewritten. No step changes. |
| `tests/auth/authIntegrityWorkflow.spec.ts` | Rewritten to lock the retired shape. Only the static job may exist, with its required name, no install, the checker step and the `pull_request` trigger. No secret in either form, no bypass flag, no hosted marker. 6 failing controls (hosted job re-added, secret in bracket form, rename, trigger dropped, hosted marker, `npm ci`). |
| `tests/auth/hostedSupabaseConnections.spec.ts` | All three hosted-E2E allowlists become `[]`, so any `E2E_*` secret, E2E-ref mention or bypass flag in any workflow fails. |
| `tests/supabase-local/authIntegrityLocalWorkflow.spec.ts` (C3) | Triggers must be exactly `pull_request` + `push` + `workflow_dispatch`, with `pull_request` unfiltered. Job names are pinned. The "auth-integrity.yml byte-identical to HEAD" check becomes "auth-integrity.yml holds only the static job". New controls: `pull_request` dropped, `pull_request` path-filtered, pinned name changed. The context-reuse control now targets the required static name. |

**Base**: the patch is written against **main + C3 (checkpoint `f237b92f` + its 12 pending files) + Stage 1**. It does not apply to main alone, because it edits two C3 files that are not on main yet (proved below). Built in an isolated copy, `C:/tmp/omnivyra-p3-C3`, cloned from `C:/tmp/omnivyra-p2-D` with origin removed. All 12 pending files were copied and sha256-verified identical. Stage 1 was applied with `git apply --check` first, then the base was staged (`git add -A`, no commit).

### Stage 2 proof

| Check (in `C:/tmp/omnivyra-p3-C3`) | Result |
|---|---|
| `git apply --cached --check` against the staged base (main + C3 + Stage 1) | OK. Repeated after the controls: OK; worktree diff sha256 = patch sha256 |
| `git apply -R --check` on the patched worktree | OK |
| `git apply --check` on the main worktree alone | fails as expected: `auth-integrity-local.yml` and `authIntegrityLocalWorkflow.spec.ts` do not exist there (C3 precondition) |
| `authIntegrityWorkflow.spec` + `hostedSupabaseConnections.spec` + `authIntegrityLocalWorkflow.spec` | **37/37 passed** |
| Full `npm run test:auth-e2e-guard` with Stage 2 applied | **156/156 passed**, 0 skipped |
| All 6 C3 offline specs (`localStackPlan`, `ciAssertions`, `authIntegrityLocalWorkflow`, `logRedaction`, `bootstrapSimulation`, `resetRateLimits`) with Stage 2 applied | **105/105 passed**, 0 skipped |
| Targeted `tsc` of the 3 changed specs | exit 0 |
| js-yaml validation, incl. both auth workflows | 0 problems |
| **Control S2-1**: the hosted `auth-integrity.yml` restored from the base | RED, 5 failed (incl. "holds only the hermetic static job" and "every workflow obeys the hosted-connection allowlists"); restored byte-identical `29b0126e…f7a2` |
| **Control S2-2**: `pull_request` removed from the local workflow | RED, 3 failed (incl. "every rule holds on the proposed workflow"); restored byte-identical `bb59dcf4…5c54` |

### Preconditions (all must hold before applying Stage 2)

1. C3 accepted: 3 consecutive green runs of the C3 workflow at the same SHA (run 1 = 45825080632 passed; runs 2 and 3 need separate owner approval).
2. C3 merged to `main` (workflow, `tests/supabase-local/*`, mode-aware guard, harness, reset script), followed by a green "Auth integrity (local Supabase, advisory)" `workflow_dispatch` on main.
3. Stage 1 merged (or carried in the same PR).
4. The owner accepts the CI cost: the C3 workflow then runs on every PR, roughly 2 jobs × (npm ci + Supabase stack + 104+ migrations), up to 30 + 45 minute timeouts.

## 5. Owner actions

| # | Action | When |
|---|---|---|
| O-1 | Delete repo secret `E2E_REDIS_URL` (read by nothing on main) | any time |
| O-2 | After Stage 2 is merged and its first PR shows the local suite green: delete `E2E_SUPABASE_URL`, `E2E_NEXT_PUBLIC_SUPABASE_URL`, `E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY`, `E2E_SESSION_COOKIE_SECRET`, `E2E_ENCRYPTION_KEY`. Never before Stage 2: the hosted job would skip silently. | after Stage 2 |
| O-3 | Branch protection: add **"Auth integrity regression suite (local Supabase)"** (and optionally "Local Supabase stack validation") as required contexts once Stage 2 has run green on `main`. Nothing to remove: no hosted-E2E context is required today. Keep "Static auth invariants (hermetic, no secrets)". (This token cannot read `/protection`; the contexts above come from `branches/main`.) | after Stage 2 |
| O-4 | Vercel (Production **and Preview/Development**) and Railway (worker + cron): confirm `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` / pooler URLs point at `klkiseupptzbecbxwrky`, and that no variable contains `lomndxmrpyudaegddpef`. Not checked here: values are not readable without exposing them, and Railway's CLI prints values. | before deleting the E2E project |
| O-5 | Operator machines: delete any `.env.e2e`; use `AUTH_E2E_TARGET=local` + `tests/supabase-local/bootstrap.sh up` for local auth runs. | after Stage 2 |
| O-6 | Separate finding: `platform-parity.yml` reads plain `SUPABASE_*` secrets that do not exist at repo level, so its production audit runs on empty values. Decide whether to provision them (production values) or narrow the job. Do NOT fill them with E2E values. | independent |
| O-7 | Option, not in the patch (C3-owned file): after retirement, make `e2eEnvironmentGuard` refuse hosted mode (or default to `local`), so `npm run test:auth-integrity` can no longer reach a hosted project from an operator machine. | after O-5 |
| O-8 | Only after O-2/O-4/O-5: pause or delete the hosted E2E project (separate retirement step; out of scope here). | last |

## 6. Verification that PRs no longer contact hosted E2E (after Stage 2)

1. **Static, every PR**: `npm run test:auth-e2e-guard` (run by both C3 jobs) fails if any workflow reads an `E2E_*` secret, names the E2E ref or sets the bypass, or if app runtime code or deploy config names the E2E project. `tests/auth/authIntegrityWorkflow.spec.ts` fails if the hosted job returns.
2. **Runtime, every PR**: the C3 job refuses non-loopback targets (`assert-env-local`, `check:auth-e2e-target` in local mode) before the app starts, and fails if the app server log mentions any hosted marker (`assert-no-hosted-in-log`). It prints `HOSTED_TARGET_CONTACT NONE` on success.
3. **GitHub metadata**: on the first PR after merge, `gh run list --workflow auth-integrity.yml` shows only the static job; `gh run view <id> --json jobs` lists exactly one job. `gh run list --workflow auth-integrity-local.yml --event pull_request` shows the PR run.
4. **Secret consumption**: `git grep -n "secrets\.E2E_" -- .github` returns nothing. After O-2, `gh secret list` shows no `E2E_*` name.
5. **Hosted side (owner, optional)**: auth-log / `pg_stat` write counters on the E2E project stop moving after the merge (compare with [05](../../../omnivyra-e2e-retirement-20261126/docs/supabase-e2e-retirement/05-live-e2e-inspection-report.md)). Not done here: no Supabase contact was permitted.

## 7. Not done / limits

- `actionlint` is not installed. The workflows were validated with js-yaml (parse, `on`, jobs, `runs-on`/steps, no tabs) in both trees.
- The full `npm test` and the backend-tests tsc baseline were not run. Only suites touching the changed modules, plus a targeted tsc of the changed TS files, were run.
- The current production Redis host `right-treefrog-90757.upstash.io` is still missing from `certAwareEnv.PROD_MARKERS` (the jest/cert guards name only `noble-dane-77325`). C3 adds it to the auth guard and the reset script. Adding it here means changing the mirrored cert fake-publisher list, so it is left as a recommendation, not a Stage 1 change.
- `docs/AUTH-INTEGRITY-RULES.md:115-122` still lists outdated variable names. Not edited.
