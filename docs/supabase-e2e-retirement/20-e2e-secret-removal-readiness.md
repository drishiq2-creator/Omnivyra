# 20 — Hosted-E2E GitHub secret removal: readiness

Date: 2026-11-27. Read-only inventory. Nothing was deleted, set, pushed, merged, dispatched or re-run.
No secret value was read or printed. Only names, timestamps and repository text were inspected.

Code states compared:

| State | SHA | How read |
|---|---|---|
| current `main` | `329743dfaec40e61848d7f1c23447cff67843b84` | `git fetch https://github.com/drishiq2-creator/Omnivyra.git main` → FETCH_HEAD, `git show`/`git grep` (no checkout) |
| PR #468 head (`feat/c3-combined-20261127`, base `main`, OPEN, MERGEABLE) | `fa46417f9296f8d37f2a508da022fc331e0ec800` | `C:\tmp\omnivyra-c1c2-prep-20261126`, `git show`/`git grep fa46417f` |

`git merge-base 329743df fa46417f` = `329743df`: #468 is based on current main (8 commits ahead,
0 behind). #468 changes exactly two workflow files: `auth-integrity.yml` (hosted jobs removed) and
`auth-integrity-local.yml` (new, disposable local stack).

## 1. Secret scopes, re-verified

| Scope | Result |
|---|---|
| Repository Actions secrets (`gh secret list`, `GET /actions/secrets`) | **7**, all `E2E_`-prefixed, all last updated 2026-08-30 (table below) |
| Environment secrets: `authentic-nature / production`, `Production`, `Production – omnivyra`, `Production – virality` | **0** in each (`GET /environments/{name}/secrets`, total_count 0) |
| Environment variables (same 4 environments) | **0** in each |
| Repository Actions variables (`gh variable list`, `GET /actions/variables`) | **0** |
| Dependabot secrets (`GET /dependabot/secrets`) | **0** |
| Codespaces secrets (`gh secret list --app codespaces`) | none |
| Organization secrets / variables | N/A: the owner `drishiq2-creator` is a **User** account (the org-secrets endpoint returns 422). No org scope exists. |

So the 7 E2E secrets are the **only** Actions secrets in the repository. Every other name a workflow
reads resolves to an empty string today.

## 2. Inventory

Line numbers are `file:line`. "Runtime read" means code that reads `process.env.<NAME>` or a workflow
expression `secrets.<NAME>` when it executes. "Lock/fixture" means a test or static check that only
mentions the name, either as input fixture text or to pin its absence.

| # | Secret | Scope | main @329743df: workflow refs | main: other runtime reads (env var, not the GitHub secret) | PR #468 @fa46417f: workflow refs | #468 removes last workflow ref? |
|---|---|---|---|---|---|---|
| 1 | `E2E_SUPABASE_URL` | repo | `auth-integrity.yml:110` (S1), `:112` (S3 fallback), `:198`, `:200` (fallback), `:202`; comments `:35,:36`; `:280` checks the job env var | `tests/auth/assertE2ETarget.ts:16`, `tests/auth/authTestHarness.ts:27` (harness URL precedence); `scripts/lib/certAwareEnv.cjs:51` (refusal scan list) | **none** | **YES** |
| 2 | `E2E_NEXT_PUBLIC_SUPABASE_URL` | repo | `auth-integrity.yml:112`, `:200` (both `… \|\| secrets.E2E_SUPABASE_URL`); comment `:36` (marked optional) | `assertE2ETarget.ts:17`, `authTestHarness.ts:28`; `certAwareEnv.cjs:51` | **none** | **YES** |
| 3 | `E2E_SUPABASE_SERVICE_ROLE_KEY` | repo | `auth-integrity.yml:111` (S2), `:199`, `:203` (all as fallback after unset `E2E_SUPABASE_SECRET_KEY`); comment `:37` | `assertE2ETarget.ts:25`, `authTestHarness.ts:36` | **none** | **YES** |
| 4 | `E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY` | repo | `auth-integrity.yml:113` (S4), `:201` (fallback after unset `E2E_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`); comment `:38` | none | **none** | **YES** |
| 5 | `E2E_SESSION_COOKIE_SECRET` | repo | `auth-integrity.yml:114` (S5), `:204`; comment `:39` | none | **none** | **YES** |
| 6 | `E2E_ENCRYPTION_KEY` | repo | `auth-integrity.yml:115` (S6), `:213`; comment `:40` | none | **none** | **YES** |
| 7 | `E2E_REDIS_URL` | repo | **none** — only the comment `auth-integrity.yml:41` "E2E_REDIS_URL is no longer read" | `scripts/reset-auth-e2e-rate-limits.js:50` reads `process.env.E2E_REDIS_URL \|\| process.env.REDIS_URL`, but the hosted job (`:346 npm run reset:auth-e2e-rate-limits`) never binds the secret into env, and sets `REDIS_URL: redis://127.0.0.1:6379` (`:212`). `certAwareEnv.cjs:51` (refusal scan list) | **none** | n/a — already unreferenced on main |

Notes on the table:

- `E2E_SUPABASE_SECRET_KEY` and `E2E_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are referenced by main's
  `auth-integrity.yml` but **do not exist** as secrets; the hosted job runs on the legacy fallbacks
  (#3 and #4). They need no deletion.
- **`E2E_REDIS_URL` is a dead secret on main.** No workflow on main, on #468, or in the four
  off-main workflow files (section 4) contains `secrets.E2E_REDIS_URL`. The only runtime read of the
  *environment variable* is the reset script, and in CI that variable is never populated from the
  secret. Deleting it has no effect today, before or after #468.
- The non-workflow runtime reads (`assertE2ETarget.ts`, `authTestHarness.ts`, `reset-auth-e2e-rate-limits.js`,
  `certAwareEnv.cjs`, and on #468 `tests/auth/e2eEnvironmentGuard.ts:291-306`,
  `scripts/lib/e2eRedisIdentityRule.cjs:51,53,435`, `tests/supabase-local/localStackPlan.ts:259`)
  read **process environment variables** of the same names, set by a developer's `.env.e2e` or by
  the local-stack plan. They never read GitHub secrets, and none of them is affected by deleting a
  GitHub secret.

### PR #468 non-workflow mentions (all locks, fixtures, or env-var reads; none is a GitHub-secret read)

- `tests/auth/hostedSupabaseConnections.spec.ts:35` — `HOSTED_E2E_SECRET_WORKFLOWS = []` (on main:
  `['auth-integrity.yml']`, `:34`). Any workflow containing `secrets.E2E_*` (dot or bracket form,
  `:66-69`, classified by `/^E2E_/` at `:74`) is a violation (`:109`). Fixture text only at
  `:146,147,154,176,182,193,201`. **Pins absence of workflow reads.**
- `tests/auth/authIntegrityWorkflow.spec.ts:101,110` — the hosted-job snippet used as a red control.
  The spec header (`:16-18`) fails if "ANY repository secret" is reintroduced into
  `auth-integrity.yml`. **Pins absence.** (On main, `:129,181,183` instead *require* the hosted job
  env to be bound from `E2E_` secrets. That is why the secrets must not be deleted while main still
  has the hosted job, although that main-side spec checks the YAML text, not the secrets.)
- `tests/supabase-local/authIntegrityLocalWorkflow.spec.ts:189` — control: a `secrets.E2E_SUPABASE_URL`
  line injected into the local workflow is detected. **Pins absence.**
- `tests/auth/e2eEnvironmentGuard.spec.ts` (E2E_SUPABASE_URL ×29, E2E_REDIS_URL ×4), `tests/auth/e2eRedisIdentity.spec.ts`,
  `tests/supabase-local/{resetRateLimits,resetRedisIdentity,ciAssertions,localStackPlan}.spec.ts`,
  `backend/tests/unit/testEnvHostedTargetGuard.test.ts:48,66,118-125` — env-var fixtures for the refusal guards.
- `tests/supabase-local/README.md:69`, `docs/supabase-e2e-retirement/{01,15,17}*.md`,
  `docs/supabase-e2e-retirement/transfer/*.patch` — documentation only.

**No test or static lock anywhere (main or #468) expects any of the 7 secrets to EXIST.** No code calls
`gh secret` or the `/actions/secrets` API (`git grep` outside `docs/`: 0 hits on both commits).

## 3. How main behaves if a secret is missing (silent-skip analysis)

`auth-integrity.yml` on main has three jobs. `pull_request` + `workflow_dispatch` only, so there is no
`push`/`schedule` trigger:

1. `auth-invariants-static` → "Static auth invariants (hermetic, no secrets)". It is a **required**
   check, uses no secrets, and is unaffected.
2. `e2e-secrets-preflight` counts empties among S1..S6 (`:133-145`). If any is empty, it writes
   `provisioned=false` and logs "N of 6 E2E secrets absent — auth E2E will SKIP (not fail)".
3. `auth-integrity` → "Auth integrity regression lock" has `if: needs.e2e-secrets-preflight.outputs.provisioned == 'true'`
   (`:159-160`). **This is the silent skip.** If any of #1, #3, #4, #5 or #6 is deleted while
   this file is still in effect, the hosted job is reported as *skipped*, not failed. It is not in the
   required-check list, so merges are not blocked and nothing turns red.
   Deleting only #2 changes nothing because S3 falls back to `E2E_SUPABASE_URL`. Deleting #7 changes nothing.

Today the hosted job is still live and green. Auth Integrity run 45937649047 on #469
(`release/r28-consolidation`, 2026-11-27 04:03Z) shows preflight success and "Auth integrity
regression lock" success. So the E2E secrets are still consumed by open PRs that run main's
workflow version.

Under #468, `auth-integrity.yml` has only `auth-invariants-static` (job ids `auth-integrity` and
`e2e-secrets-preflight` are banned by the lock). `auth-integrity-local.yml` generates per-run random app
secrets (`:194`) and reads no `secrets.*`. After #468 is on main, no `if:` anywhere depends on an
E2E secret.

## 4. Other workflows

`secrets.*` references across all 17 workflow files on main and all 18 on #468:

- `auth-integrity.yml` (main only) is the only reader of `E2E_*`.
- `platform-parity.yml` (identical on both) reads only the plain names `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `RAILWAY_TOKEN`, `SUPABASE_MANAGEMENT_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`/`_SERVICE_ROLE_KEY`,
  `SESSION_COOKIE_SECRET`, `NEXT_PUBLIC_APP_URL`. **None of these exists as a secret**, so all are empty
  today. Its Vercel/Railway steps are gated `if: env.VERCEL_TOKEN != ''` / `env.RAILWAY_TOKEN != ''`
  and already skip. It never reads an `E2E_` name, so it is unaffected by the deletion.
- `real-schema-ci.yml`, `db-replay.yml`, `governance-nightly.yml` (the only scheduled-style workflow
  on main), `typecheck-*`, `secret-scan.yml`, and the rest have **zero** `secrets.*` references. There are
  no `toJSON(secrets)` and no `secrets: inherit` anywhere.
- Four workflows are registered in Actions but are absent from main: `monitoring-rules.yml`,
  `pi-contact-governance-postgrest.yml`, `round14-immutable-validation.yml`, `t2-full.yml`. I read their latest-run
  branch versions via the contents API. None contains `secrets.` or `E2E_`.
- **Non-E2E secret holding an E2E role:** none possible. Only the 7 E2E secrets exist, and no workflow
  maps a non-`E2E_` secret into an E2E role. On main the hosted job binds the *plain env names*
  (`SUPABASE_URL`, `SESSION_COOKIE_SECRET`, …) **from** `E2E_` secrets, which is the reverse direction.

**Production impact: none.** No workflow on main or #468 runs `vercel deploy`, `vercel env add`,
`railway up`, `railway variables`, `supabase secrets` or `supabase db push`. The only Vercel/Railway steps
are the read-only audits in `platform-parity.yml`, and those are skipped. Vercel, Railway and the Supabase
GitHub integration read their own stored env/config and never read GitHub Actions secrets. Merging to
main deploys the Railway worker through Railway's own GitHub hook, which does not involve Actions secrets.

## 5. Other open PRs that still run main's hosted job

| PR | Base | Touches `auth-integrity.yml`? | Effect of deleting the secrets |
|---|---|---|---|
| #469 `release/r28-consolidation` (a8a67515) | main | no | **Before #468 merges:** the hosted job silently SKIPS. **After #468 merges:** its next `synchronize` builds a merge ref with the new file, so there is no hosted job. Re-running an *old* run reuses the old merge SHA and shows a skip, not a failure. |
| #368 `ci/actions-optimisation-20261104` (2e8674bf, stale since 11-04) | main | **yes** (edits 16 workflows) | Will conflict with #468. If it is ever rebased and keeps a hosted job, the job silently SKIPS for lack of secrets. The #468 locks (`authIntegrityWorkflow.spec.ts`, `hostedSupabaseConnections.spec.ts`) then flag it, provided the job that runs those specs runs on that PR. |

## 6. Preconditions (all must hold before any `gh secret delete`)

1. **#468 is merged into `main`.** Confirm with `gh pr view 468 -R drishiq2-creator/Omnivyra --json state,mergeCommit`, then:
   - `git grep -n -E 'secrets(\.|\[.)E2E_' <new-main-sha> -- .github` → **no output**;
   - `git show <new-main-sha>:.github/workflows/auth-integrity.yml` contains only `auth-invariants-static`.
2. **main CI is green at the merge SHA.** All 9 required contexts must pass: Backend TypeScript certification, Production build,
   Non-regression TypeScript baseline, Governance baseline & documentation verification, Campaign
   generation + canonical persistence contracts, Static auth invariants (hermetic, no secrets), PI unit
   suites, Snapshot remediation contracts (…), Snapshot dossier consistency (…). The `push`-triggered
   `Auth integrity (local Supabase, advisory)` run on main must also pass (jobs "Local Supabase stack
   validation" and "Auth integrity regression suite (local Supabase)"), as must `Platform Parity`.
   - Known pre-existing red: `secret-scan / gitleaks` fails on **every** current PR (#468 and #469).
     It is not a required check and is unrelated to the E2E secrets. It needs an explicit
     owner ack ("green except gitleaks, by design / pre-existing") rather than being read as green.
3. **#469 has re-synced after #468 merged**, so its latest Auth Integrity run shows only the static job.
   Otherwise accept and record that #469's hosted job will report "skipped" from now on.
4. The owner approves the deletion explicitly, naming these 7 secrets. Approval does not carry over.
5. Optional, recommended: the hosted E2E project `lomndxmrpyudaegddpef` keeps no further consumer
   (doc 17/18). The secrets are its last CI credential holders, and the service-role key should also be
   rotated/revoked on the Supabase side, because deleting a GitHub secret does not invalidate the key.

## 7. Deletion list (run ONLY after every precondition in section 6 holds)

Ordered from zero-risk to load-bearing-on-old-main:

```sh
# 1. Dead on main already: no workflow reads it.
gh secret delete E2E_REDIS_URL -R drishiq2-creator/Omnivyra
# 2. Fallback-only on old main (S3 falls back to E2E_SUPABASE_URL).
gh secret delete E2E_NEXT_PUBLIC_SUPABASE_URL -R drishiq2-creator/Omnivyra
# 3-6. Non-credential / app secrets of the hosted job.
gh secret delete E2E_ENCRYPTION_KEY -R drishiq2-creator/Omnivyra
gh secret delete E2E_SESSION_COOKIE_SECRET -R drishiq2-creator/Omnivyra
gh secret delete E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY -R drishiq2-creator/Omnivyra
# 7. Hosted-project credentials last.
gh secret delete E2E_SUPABASE_SERVICE_ROLE_KEY -R drishiq2-creator/Omnivyra
gh secret delete E2E_SUPABASE_URL -R drishiq2-creator/Omnivyra
```

No environment, Dependabot, Codespaces or organization deletions are needed, because those scopes are empty.

## 8. Post-deletion verification

1. `gh secret list -R drishiq2-creator/Omnivyra` → **empty**. Also confirm
   `gh api repos/drishiq2-creator/Omnivyra/actions/secrets --jq .total_count` → `0`.
2. Re-run the scope checks from section 1. Environments, Dependabot and variables should still be 0.
3. For each of the 7 names on the new main SHA:
   `git grep -n -w <NAME> <main-sha> -- .github` → **no output**;
   `git grep -n -w <NAME> <main-sha> -- ':!docs'` → only the lock/fixture/env-var files listed in
   section 2 ("PR #468 non-workflow mentions" plus `certAwareEnv.cjs`, `reset-auth-e2e-rate-limits.js`,
   `e2eRedisIdentityRule.cjs`, `e2eEnvironmentGuard.ts`, `localStackPlan.ts`). There must be no
   `secrets.` or `secrets[` form.
4. The next PR's CI and the next push-to-main CI must pass:
   - the 9 required contexts (section 6.2);
   - "Static auth invariants (hermetic, no secrets)" (Auth Integrity), with **no** "E2E provisioning
     preflight" and **no** "Auth integrity regression lock" job in the run. If either appears, an
     old workflow version is still in effect: stop and investigate;
   - "Local Supabase stack validation" + "Auth integrity regression suite (local Supabase)" (Auth
     integrity (local Supabase, advisory));
   - Platform Parity ("Platform parity validators") on push to main.
5. Missing-secret check: GitHub does not log a warning for a missing secret. It substitutes `''`. So
   "the deleted names do not appear as missing" is verified by absence, using three checks:
   (a) step 3 shows no workflow references them;
   (b) no run on main or on a re-synced PR contains an `e2e-secrets-preflight` job, so the
   "N of 6 E2E secrets absent — auth E2E will SKIP" line cannot be printed;
   (c) for any remaining old-version run (#469 before re-sync, #368), a "skipped" Auth integrity
   regression lock is the expected, recorded outcome and not a regression.
   To check one run: `gh run view <run-id> -R drishiq2-creator/Omnivyra --json jobs --jq '.jobs[].name'`.
