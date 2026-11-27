# 19 - PR #468 merge readiness (read-only assessment)

Date: 2026-11-27 (evidence gathered ~04:10Z). Repo: drishiq2-creator/Omnivyra.
Scope: read-only. No merge, push, rebase, PR edit, workflow re-run or deploy was performed.
Only `gh` / `gh api` GET calls, `git ls-remote`, `git fetch` (by explicit URL, no checkout) and
`git log/diff/show/merge-tree` against the clone `C:/tmp/omnivyra-c1c2-prep-20261126` were used.

## Verdict: READY EXCEPT HOLD

PR #468 is ready on its own terms: open, mergeable, no conflicts, all 9 required checks green on
head `fa46417f9`, and the real disposable-stack CI passed on the head itself. Do not merge yet,
for two reasons:

1. **Control Tower hold (blocking).** Main is still `329743dfa`. The release (`release/r28-consolidation`,
   PR #469, head `a8a67515`, which contains `d02938674`) has not landed, and nobody has said main is free.
2. **Rebase and re-check after the release lands (procedural).** The release has no file overlap with
   #468 and a trial merge is clean, but the required checks have to run again on the post-release
   base before the merge.

There is one non-required failure, `gitleaks` (secret-scan), with 4 findings. As far as the evidence
shows, all 4 are synthetic test-fixture URLs (details in section 3b). They do not block a release
under the owner rule, since they are not safety, money or sending, but they need fixing or an
allowlist entry. Record them as a finding rather than silently accepting a red check.

## Summary table

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | PR state / head / mergeability | OK | OPEN, not draft; head `fa46417f9296f8d37f2a508da022fc331e0ec800` (= expected); base sha `329743dfa`; `mergeable: true`, `mergeable_state: unstable` (caused by the non-required gitleaks failure); no conflicts |
| 2 | Main advanced past `329743dfa`? | NO (not yet) | `git ls-remote` refs/heads/main = `329743dfaec40e61848d7f1c23447cff67843b84`; `gh api commits/main`: "Merge pull request #466", 2026-11-27T02:52:07Z. Pending release `a8a67515` is 27 ahead / 0 behind main; 130 files changed, **0 overlap** with #468's 33 files; `git merge-tree --write-tree a8a675159 fa46417f9` is clean (tree `0784bddc`) |
| 3 | Required checks on head | 9/9 SUCCESS | protection contexts (below) all `completed/success` on `fa46417f9` |
| 3b | Non-required failures | 1: gitleaks (4 findings, synthetic fixtures) | run 45936416714 / job 140300551910: "8 commits scanned ... leaks found: 4". Not run on main pushes (PR-only workflow). Also red on #469 (run 45937649274) and on the earlier Stage 2 PR heads |
| 4 | Disposable auth stack CI | PASSED on the PR head | run 45936416753 (pull_request, `fa46417f9`) success; run-1..run-5 all success (table below) |
| 5 | Files / workflows at head | CONFIRMED | Redis guard files are present; seed step comes before the rate-limit reset; auth-integrity.yml has a single job `auth-invariants-static` with zero `${{ secrets.* }}`; no `secrets.E2E_` / `lomndxmrpyudaegddpef` anywhere in .github/ at head |
| 6 | Worker deploy on merge | WILL DEPLOY; small runtime change | Any push to main triggers the Railway worker deploy (railway.json -> Dockerfile.worker, CMD `node dist/backend/workers/main.js`). 4 runtime lib files change log/error text only (redaction). `lib/env/namespace.ts` and `lib/redis/client.ts` are worker-reachable |
| 7 | Control Tower hold | ACTIVE | main does NOT contain `d02938674` (`git merge-base --is-ancestor d02938674 329743dfa` false; compare `329743dfa...d02938674` = ahead_by 24, behind_by 0). PR #469 open, `mergeable_state: blocked` |

## 1. PR state

```
gh pr view 468 --json state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,isDraft
  state=OPEN isDraft=false headRefName=feat/c3-combined-20261127
  headRefOid=fa46417f9296f8d37f2a508da022fc331e0ec800 baseRefName=main
  mergeable=MERGEABLE mergeStateStatus=UNSTABLE
gh api repos/.../pulls/468
  mergeable=true mergeable_state=unstable merged=false base.sha=329743dfaec40e61848d7f1c23447cff67843b84
git ls-remote ... refs/heads/feat/c3-combined-20261127 -> fa46417f9296f8d37f2a508da022fc331e0ec800
```
Title: "ci(auth): disposable local Supabase auth E2E (C3) + round-26 Redis guard replace the hosted E2E job (Stage 2)".

PR commits (`git log --no-merges 329743dfa..fa46417f9`, 8 commits):
`90dd3049` feat(ci) prepare disposable local Supabase auth E2E; `2de7ffb8` fix(ci) C3 review gap closure;
`58c2636b` test(e2e) fail-closed Redis identity guard (round 26); `7acc9b93` ci(c3) baseline-gap manifest;
`7559e391` ci(auth) retire hosted E2E job (Stage 2); `20373e8a` test(c3) placeholder in redaction fixture;
`9760e62b` test(c3) close independent review F-1/F-2/F-3/F-6; `fa46417f` test(c3) seed-ORDER rule load-bearing (F-2).

## 2. Has main advanced?

No. Main is `329743dfa` (merge of #466, 02:52:07Z), the same as the PR's base sha, so **no rebase is needed
today** and there are no new main commits to review.

What is expected next is the Control Tower release. `release/r28-consolidation` is at `a8a675159657c7c70a2b4aac8c08d7576368553b`
(PR #469 "Round 28 consolidation release (rounds 22-26 + round 12)", open). The top of its log:
`a8a67515`, `5adf9748`, `1be1936e`, `d0293867` (Merge origin/main 329743dfa into release/r28), `329743df`.
- `gh api compare/main...a8a67515`: ahead_by 27, behind_by 0, so it can fast-forward main.
- `git diff --name-only 329743dfa a8a675159` (130 files) intersected with `git diff --name-only 329743dfa fa46417f9`
  (33 files) gives **empty**. The release does not touch .github/ or package.json.
- `git merge-tree --write-tree --name-only a8a675159 fa46417f9` gives a clean tree `0784bddcf41b`, so there are no textual conflicts.

After the release lands, main will be past #468's base. The PR then has to be rebased or updated and its
checks re-run on the new base. The new main content (the release) is reviewed under its own PR #469.
For #468 the obligation is only to show that the rebase is a pure replay (range-diff) and that checks are green on the new head.

## 3. Required status checks

Source: `gh api repos/drishiq2-creator/Omnivyra/branches/main --jq .protection` gives `enabled: true`,
`enforcement_level: everyone`, and 9 contexts (app_id 15368 = GitHub Actions). Results on the PR head `fa46417f9`
come from `gh api commits/fa46417f9.../check-runs`:

| Required context | Result on `fa46417f9` | check-run id |
|---|---|---|
| Backend TypeScript certification | success | 140300550998 |
| Production build | success | 140300551331 |
| Non-regression TypeScript baseline | success | 140300551596 |
| Governance baseline & documentation verification | success | 140300551684 |
| Campaign generation + canonical persistence contracts | success | 140300551524 |
| Static auth invariants (hermetic, no secrets) | success | 140300551579 |
| PI unit suites | success | 140300551414 |
| Snapshot remediation contracts (AI visibility, citations, crawler readiness) | success | 140300551903 |
| Snapshot dossier consistency (contradiction checks) | success | 140300551537 |

Non-required checks on the head: Auth integrity regression suite (local Supabase) success; Local Supabase stack
validation success; Backend test typecheck baseline success; Platform parity validators success; Runtime
observability gate success; Stability regression lock success; Strategic narrative regression lock success;
Supabase Preview skipped; **gitleaks failure**.

The legacy commit-status API (`/commits/<sha>/status`) reports `pending` with 0 statuses. That is the
empty default, not a pending check. Required contexts are check-runs.

### 3b. Non-required failures

**gitleaks (secret-scan.yml, `on: pull_request` only).** Run 45936416714, job 140300551910. It scans
`--no-merges 329743dfa..fa46417f9` with `.gitleaks.toml --redact`: "8 commits scanned", "leaks found: 4". The
run output does not list the findings (no `--verbose`/report). I re-implemented the repo's
`postgres-url-with-password` rule, including its host/password allowlists and the global placeholder allowlist,
in an offline node script over the PR diff (script at
C:\Users\lenovo\AppData\Local\Temp\claude\87c6f0df7243d0ac\dc5c3958-2672-4286-85f2-3709eb819b81\scratchpad\pgscan.js;
it prints only commit, file, host and password length, never values). It finds **exactly 4** added lines that the rule would flag:

| commit | file | host | password |
|---|---|---|---|
| 20373e8a | tests/supabase-local/ciAssertions.spec.ts | `h` | 7 lowercase chars (fixture) |
| 90dd3049 | tests/auth/e2eEnvironmentGuard.spec.ts | `db.example.net` | 1 char |
| 90dd3049 | tests/auth/e2eEnvironmentGuard.spec.ts | `x.example` | 1 char |
| 90dd3049 | tests/supabase-local/ciAssertions.spec.ts | `h` | 5 chars (fixture) |

**Integrator correction (2026-11-27 09:42 local, gitleaks 8.30.1 binary, checksum-verified, same config and range,
`--report-format json`):** the emulation above has the count right but two files wrong. The binary's 4 findings are:

| commit | file:line | rule |
|---|---|---|
| 90dd3049 | tests/supabase-local/bootstrapSimulation.spec.ts:46 | generic-api-key (`PUBLISHABLE_KEY=sim-pu…` simulation fixture) |
| 90dd3049 | tests/supabase-local/bootstrapSimulation.spec.ts:282 | generic-api-key (a regex string in an assertion) |
| 90dd3049 | tests/supabase-local/ciAssertions.spec.ts:213 | postgres-url-with-password (`user:pa/ss@h`) |
| 20373e8a | tests/supabase-local/ciAssertions.spec.ts:213 | postgres-url-with-password (`user:fake/pw@h`) |

`tests/auth/e2eEnvironmentGuard.spec.ts` produces no finding. The binary result replaces the emulation table.

The count matches and all four are synthetic test fixtures on non-routable or example hosts. No
Supabase JWT (`eyJ...eyJ`), `sb_secret_`, `sbp_` or `sk-` value appears in any added line: grep over the PR diff
shows only the literal prefixes, used as deny-list strings in tests. This is an emulation, not the gitleaks binary.
The binary was not downloaded, so treat the identification as strong but not certain.

Comparison with main: the secret-scan workflow does not run on pushes to main, so there is no main baseline. The
same check is red on #469 (run 45937649274, `a8a67515`) and on the earlier Stage 2 heads (`d1bad50e4`, `f582c5db5`,
`20373e8aa`, `9760e62b8`). #466 (`5d2ea1c48`, run 45929069017) was green.

Note that commit `20373e8a` ("use an obvious placeholder") still trips the rule, and gitleaks scans every commit
in the range, so the `90dd3049` findings stay even if a later commit fixes the lines. To clear the check:
change the fixtures to an allowlisted password form (e.g. `:password@`/`:${PW}@`, or a value containing `testonly`/`example`),
then either squash-rebase or add a narrowly scoped path allowlist for these two spec files. Squash-rebasing
conflicts with "land original reviewed commits", which makes the scoped allowlist the better choice.

**Main's own red (pre-existing, not on the PR).** `Migration replay + canonical invariants` (Real-Schema CI) failed on
main `329743dfa` (run 45930844559, job 140282844357, step "Actor-FK / CHECK compatibility (replayed catalog)").
It is also red on the previous main runs 44926112215, 44884584030, 44861810421 and 44860242247. Real-Schema CI is
path-filtered and did not run on #468, which touches no migration. It is not required and not caused by #468.

## 4. Disposable auth stack CI (auth-integrity-local.yml, "Auth integrity (local Supabase, advisory)")

`gh run list --workflow auth-integrity-local.yml`:

| run id | branch | head sha | event | conclusion | relation to PR head `fa46417f9` |
|---|---|---|---|---|---|
| 45825080632 | ci-only/c3-auth-local/run-1 | `f237b92f0` | push | success | NOT an ancestor; pre-cherry-pick original of `90dd3049` (range-diff shows "cherry picked from f237b92f") |
| 45928703068 | ci-only/c3-auth-local/run-2 | `ffaad4de7` | push | success | NOT an ancestor; earlier line (merge-base `05576880`); original of `7acc9b93` |
| 45929472417 | ci-only/c3-auth-local/run-3 | `ffaad4de7` | push | success | same SHA as run-2 |
| 45933035633 | ci-only/c3-auth-local/run-4 | `20373e8aa` | push | success | ancestor (head minus 2 commits) |
| 45935045333 | ci-only/c3-auth-local/run-5 | `9760e62b8` | push | success | ancestor (head minus 1; `9760e62b..fa46417f` = +30 lines in tests/supabase-local/authIntegrityLocalWorkflow.spec.ts only) |
| 45931177152 | feat/c3-auth-local-stage2-20261127 (PR) | `d1bad50e4` | pull_request | success | superseded line |
| 45932221787 | feat/c3-auth-local-stage2-20261127 (PR) | `f582c5db5` | pull_request | success | superseded line |
| 45933069357 | feat/c3-combined-20261127 (#468) | `20373e8aa` | pull_request | success | ancestor |
| 45935045522 | feat/c3-combined-20261127 (#468) | `9760e62b8` | pull_request | success | ancestor |
| **45936416753** | **feat/c3-combined-20261127 (#468)** | **`fa46417f9`** | pull_request | **success** | **the PR head itself** |

The real disposable stack has passed on the exact head (its jobs show up on the head as "Local Supabase stack
validation" and "Auth integrity regression suite (local Supabase)"). run-4 and run-5 validated its two nearest ancestors.
The only change after run-5 is a test-file addition.

## 5. File confirmation at PR head (`git show fa46417f9:<path>`)

- `scripts/lib/e2eRedisIdentityRule.cjs` is present (441 lines). `scripts/seed-auth-e2e-redis-identity.js` is present (135 lines).
  package.json adds `"seed:auth-e2e-redis-identity": "node scripts/seed-auth-e2e-redis-identity.js"` and adds
  `tests/auth/e2eRedisIdentity.spec.ts` to `test:auth-e2e-guard`.
- `.github/workflows/auth-integrity-local.yml` is present (284 lines, new file). Triggers: `pull_request`, `workflow_dispatch`,
  `push` on `ci-only/c3-auth-local/**`. Step order in the auth job: "Verify ephemeral Redis is healthy" (l.213),
  then **"Seed the disposable Redis identity marker (per-run token)"** (l.239,
  `npm run seed:auth-e2e-redis-identity -- --env-out "$GITHUB_ENV"`), then **"Reset auth rate-limit counters"** (l.242),
  then "Start app server". The seed comes before the reset.
- `.github/workflows/auth-integrity.yml` (64 lines) has exactly one job: `auth-invariants-static`, named
  `Static auth invariants (hermetic, no secrets)`. There are 0 occurrences of `${{ secrets`. The word "secrets" appears only in comments.
- `git grep -E 'secrets\.E2E_|lomndxmrpyudaegddpef' <ref> -- .github/`:
  main `329743dfa` has 20 hits, all in `.github/workflows/auth-integrity.yml` (the hosted E2E jobs, l.32, 110-115, 198-213).
  Head `fa46417f9` has **0 hits**. `git diff --name-status 329743dfa fa46417f9 -- .github/` shows only
  `A auth-integrity-local.yml` and `M auth-integrity.yml`. No other workflow lost or gained E2E references.
  auth-integrity-local.yml also has 0 `${{ secrets` expressions.

## 6. Worker deployment impact

- railway.json: `builder: DOCKERFILE`, `dockerfilePath: Dockerfile.worker`. Dockerfile.worker builds with `tsc -p tsconfig.worker.json`
  (include `backend/**/*.ts`, which pulls in imported `lib/` modules) and runs `CMD ["node", "dist/backend/workers/main.js"]`.
  Every push to main auto-deploys, so **merging #468 will trigger a Railway worker deploy**, and presumably the web deploy
  too, since lib files are shared.
- PR changed files (33), classified:

| class | files |
|---|---|
| workflow (2) | .github/workflows/auth-integrity-local.yml (A), .github/workflows/auth-integrity.yml (M) |
| runtime (4), log/error-message redaction only | lib/config/verification.ts (REDIS_URL_INVALID message no longer echoes the value); lib/env/namespace.ts (FATAL env-isolation message prints scheme+host only; imported by backend/db/supabaseClient.ts, **worker-reachable**); lib/redis/client.ts (parse-failure log prints `<redacted>`; imported by backend/services/billing/creditEconomyObservability.ts, **worker-reachable**); lib/redis/sanitizer.ts (`maskRedisUrl` also drops query/hash, and an unparseable value returns a fixed redacted string; callers are config/index.ts:72 and pages/api/health/config.ts:65, display only) |
| build/config (1) | package.json (scripts only: one new script, one test list extended; no dependency change) |
| script (3), CI-only | scripts/lib/e2eRedisIdentityRule.cjs, scripts/reset-auth-e2e-rate-limits.js, scripts/seed-auth-e2e-redis-identity.js |
| test (23) | tests/auth/* (8: assertE2ETarget.ts, authIntegrityWorkflow.spec.ts, authTestHarness.ts, e2eEnvironmentGuard.spec.ts, e2eEnvironmentGuard.ts, e2eIdentityCleanup.ts, e2eRedisIdentity.spec.ts, hostedSupabaseConnections.spec.ts); tests/supabase-local/* (15, incl. bootstrap.sh, stack-extensions.sql, supabase/config.toml, .gitignore, README.md, C3-ACCEPTANCE-PROTOCOL.md) |

  Runtime effect: 17 insertions / 7 deletions in lib + package.json. Only log and error strings change; no
  control flow, queue, sending or money path is touched. It is still a worker deploy, and it runs
  concurrently with or right after the release deploy. Sequence the two deploys rather than overlap them (see the procedure below).

## 7. Control Tower hold

Hold: the "Control Tower" session (releasing `release/r28-consolidation`) asked that nothing be merged or pushed to
main until it reports main is free. It will fast-forward main once. The release head was `d02938674` on top of
`329743dfa` and is now `a8a67515` (3 commits on top of `d02938674`).

Current state: **hold active.**
- `git ls-remote` main = `329743dfa`. `gh api commits/main` = the #466 merge.
- `git merge-base --is-ancestor d02938674 329743dfa` is false. `gh api compare/329743dfa...d02938674` gives `ahead_by 24, behind_by 0`.
  Main does **not** contain `d02938674`.
- PR #469 (head `a8a67515`) is open, `mergeable_state: blocked`.

Observable "main is free" signals. Both are needed; neither one alone is enough:
- (a) An explicit message from the Control Tower that main is free. The peer was not contacted.
- (b) `refs/heads/main` has advanced to a commit that contains `d02938674` (or its successor, currently `a8a67515`).
  Check with `git ls-remote <repo> refs/heads/main` + `git merge-base --is-ancestor d02938674 <main>` or
  `gh api repos/drishiq2-creator/Omnivyra/compare/d02938674...main --jq .behind_by` (=0 and status ahead/identical).
  **And** the Railway worker deploy for that main sha has finished successfully (Railway dashboard / deployment status
  for the new sha). Until then a second main push would queue a second deploy on top of an unverified one.

## Merge procedure once released

Run this only after both signals in section 7. Each push and the merge needs separate owner approval (push # + branch).

1. Record the new main: `git ls-remote https://github.com/drishiq2-creator/Omnivyra.git refs/heads/main` gives `<M>`. Confirm
   `git merge-base --is-ancestor d02938674 <M>` and that the release deploy has finished.
2. Re-check overlap: `git diff --name-only 329743dfa <M>` intersected with the 33 PR files. Expected empty, as with `a8a67515`.
   If anything overlaps, review those main changes before continuing.
3. Rebase in the clone (no stash, no shared worktree):
   `git fetch https://github.com/drishiq2-creator/Omnivyra.git main` then
   `git rebase --onto <M> 329743dfa feat/c3-combined-20261127`.
   Prove it is a pure replay: `git range-diff 329743dfa..fa46417f9 <M>..HEAD`, where every pair should be `=`.
   If a conflict occurs, use a two-sided proof (every main line kept; only my `-` lines removed).
4. Optionally fix gitleaks first: change the 4 fixture URLs to allowlisted forms and/or add a path-scoped allowlist for
   `tests/auth/e2eEnvironmentGuard.spec.ts` and `tests/supabase-local/ciAssertions.spec.ts` in `.gitleaks.toml`, as a
   new commit with its own review. It is not required for the merge.
5. Push the rebased branch, with approval and `--force-with-lease=feat/c3-combined-20261127:fa46417f9296f8d37f2a508da022fc331e0ec800`
   to the explicit URL. The PR's `pull_request` workflows then re-run automatically on the new head `<H>`. No manual dispatch.
6. Wait for all 9 required contexts to succeed on `<H>`, and for "Auth integrity regression suite (local Supabase)" and
   "Local Supabase stack validation" to succeed on `<H>`. Note the gitleaks result.
7. Merge with a merge commit, pinned to the verified head:
   `gh pr merge 468 -R drishiq2-creator/Omnivyra --merge --match-head-commit <H>`.
8. Post-merge: confirm main = merge commit with parents `<M>` and `<H>` (`git merge-base --is-ancestor <H> main`), and
   watch the Railway worker deploy for the merge sha to complete with a healthy `/health`.

If main has not advanced when the hold lifts (the Control Tower abandons the release), skip steps 2-6. The current head
`fa46417f9` is already green on base `329743dfa`, so merge with `--match-head-commit fa46417f9296f8d37f2a508da022fc331e0ec800`.

## Reasons for the verdict

- READY on content: mergeable, no conflicts, 9/9 required checks green on the exact head, real disposable-stack CI green on the
  exact head (run 45936416753), E2E secret references fully removed from .github/, guard files present and correctly ordered.
- EXCEPT HOLD: the Control Tower hold is active (main = `329743dfa`, no `d02938674`). Once the release lands, the PR
  must be rebased and its checks re-run on the new main before the merge.
- Open finding (non-blocking under owner rule #11-11, not release-holding): 4 gitleaks findings in synthetic test fixtures
  (emulated identification; binary output does not list them).
- Merging deploys the worker. The runtime change is log/error redaction only, in 4 lib files (2 of them worker-reachable).
