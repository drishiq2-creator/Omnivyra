# 23 — Final retirement execution checklist

| | |
|---|---|
| Date | 2026-11-27 |
| State | **Updated 2026-11-27 06:45Z: #468 MERGED 05:10:39Z as `130ce223`; worker deploy `4edc8198` SUCCESS; 7 secrets absent; S0 taken 06:44Z; observation window open; branch protection awaits admin.** Earlier state, ~05:00Z: **Control Tower released `main`**: #469 merged at 04:45:40Z as `4a957d29` (worker `90c925ed` SUCCESS, web promoted). PR #468 is at `6f5d3501`: MERGEABLE, CLEAN, all checks green including gitleaks. **Not merged; the merge waits for the owner's go.** |
| Inputs | 19 (PR #468 readiness), 20 (secret removal), 21 (E2E traffic), 22 (branch protection); executed work in 18 |
| Rule | Nothing in groups B or C runs while the Control Tower hold is active. Each step records its UTC time and evidence in 18 §11 |

## A. Can be done now, without merging

- [x] **A1. USER VERIFIED: PASS (2026-11-27).** Basis: the user confirmed on 2026-11-27 (~08:45Z) that all four Vercel entries (`SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`, Production and Preview) hold the same Supabase URL. One of them, Production `NEXT_PUBLIC_SUPABASE_URL`, is compiled into the live browser bundle, which was verified as `https://klkiseupptzbecbxwrky.supabase.co` (18 §5). Therefore all four are the canonical production URL. No value was read, exposed or changed. The owner approved the 24 h observation route as a result. Earlier status: **A1. Vercel check: owner only.** Status: **NOT YET VERIFIED.**
  - **Why owner only:** the API cannot read Vercel "sensitive" variables. The browser bundle is verified as production (18 §5).
  - **Where:** Vercel → project `omnivyra` (team `rawats-projects-5fb9f1f3`) → Settings → Environment Variables.
  - **What to check:** for `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`, in **Production** and in **Preview**, confirm that the project reference inside the URL is `klkiseupptzbecbxwrky`.
  - **What to report:** only "matches" or "does not match" per scope. Never the URL or any key.
  - **Record:** USER VERIFIED, with time.

- [ ] **A2. Branch protection: admin only, run in B5** (22). The current account has push, not admin. Neither local-stack check is required today.
  - **Add both checks, not one:**
    - `Local Supabase stack validation`
    - `Auth integrity regression suite (local Supabase)`
  - **Why both:** the auth job has `needs: local-stack-validation`. A failed stack job skips the auth job, and a skipped required check counts as passing.
  - **UI:** Settings → Branches → `main` rule → Edit → Require status checks. Add both names with source GitHub Actions. Keep the existing 9 checks and every other setting.
  - **API alternative:** described in 22 §5.
  - **Verify:** `gh api repos/drishiq2-creator/Omnivyra/branches/main --jq '.protection.required_status_checks'` shows 11 checks.
  - **Rollback:** remove the two entries.
  - **Do it only after B1–B3:** the workflow does not exist on `main` yet. Required now, it would leave every PR waiting at "Expected".

- [x] **A3. PR #468 readiness** (19). Verdict: **READY EXCEPT HOLD**.
  - No conflicts; all 9 required checks green on `fa46417f`. No shared files with #469; `git merge-tree` is clean.
  - Disposable stack green on the exact head: run `45936416753`, plus runs 1–5.
  - Redis guard and local workflow present. The hosted jobs are gone, with 0 `secrets.E2E_` references at the head.
  - Merging deploys the worker. Its runtime change is log/error redaction only.

- [x] **A4. gitleaks: resolved by exact fingerprints (`.gitleaksignore`), per the owner's 11-27 instruction.** Details:
  - the 4 fingerprints are listed in 19 §3b;
  - verification: the PR range is clean; with the file removed, all 4 return; 3 deliberate synthetic secrets, including a new value on an ignored line, are still detected;
  - #469 used the same method for its 15.

  Original note: Not a required check, but red on #468 (4 findings) and on #469 (15 findings).
  - All 4 findings on #468 are synthetic fixtures (exact binary output in 19 §3b).
  - They live in commit history, so a new commit cannot clear them. Choose one:
    - **(a)** accept the red, non-required check as pre-existing;
    - **(b)** approve a fingerprint-pinned `.gitleaksignore` for the listed findings.
  - This is the same decision the Control Tower is waiting on for #469. Rewriting history is not used, because force-pushes are refused here.

- [x] **A5. Secret inventory** (20). The 7 `E2E_*` are the only secrets in the repository, at repository scope, last updated 2026-08-30.
  - Environments, variables, Dependabot and Codespaces scopes hold none.
  - On `main`, only `.github/workflows/auth-integrity.yml` reads them. On #468, nothing does.
  - `E2E_REDIS_URL` is already unread.
  - No production system reads GitHub secrets.

- [x] **A6. E2E traffic monitoring prepared** (21). Read-only queries `g01`–`g07` are in `C:/omnivyra-archive/e2e-retirement-20261127/sql/`.
  - **Live control:** one hosted run (`45939076841`, 04:17:34–04:20:37Z) produced the predicted signature: +18 audit rows, +35 public and +46 auth inserts, and client-role statement growth.
  - **Pre-merge reference:** `capability_audit_log` 3,301 rows at 04:28:14Z. The 3,247-row figure in 18 §9 is older.
  - **The real baseline S0** is taken after T0 (B6).

## B. Executable once the Control Tower releases `main`

**"Released" means both of these:**
- the Control Tower's explicit message;
- `main` contains its release head (`d02938674`, now in #469 `4a957d29`), and that commit's Railway worker deploy has finished SUCCESS.

- [x] **B1. Done by merging `main` into the PR branch** (`6f5d3501`), not by rebasing, so the commit-pinned gitleaks fingerprints stay valid. The only shared file was `.gitleaksignore`, resolved as main's 15 entries unchanged plus this PR's 4. The notes below are the original plan.
  - Command: `git rebase --onto <new-main> 329743dfa feat/c3-combined-20261127` in `C:/tmp/omnivyra-c1c2-prep-20261126`.
  - `git range-diff` must show `=` for every commit.
  - Push **without force**: publish to a new branch (`feat/c3-combined-20261127-r2`), open the replacement PR, and close #468.
  - **Alternative:** if branch protection does not require "up to date", merge #468 as is. A merge commit needs no rebase, and there is no shared file. 19 shows a clean `merge-tree` against #469.
  - Either way, re-run and confirm the 9 required checks and both local-stack jobs on the head being merged.

- [x] **B2. Done 05:10:39Z by the owner's account: merge commit `130ce223` (parents `4a957d29` + `6f5d3501`); tree equals the reviewed head (18 §11).** Planned: with `gh pr merge <pr> --merge --match-head-commit <head>`. Confirm with `git ls-remote` and record the merge SHA.

- [x] **B3. Done 06:41Z: Railway `4edc8198` SUCCESS, worker and web health ok, 11/11 `main` push runs green; the first PR after the merge is still to come (re-check then).** Plan:
  - Railway deployment SUCCESS (`railway-deploys.js`), worker `/health` ok, web `/api/health/version` 200;
  - `main`'s push workflows green, except the known actor-FK step;
  - **the first PR after the merge:**
    - Auth Integrity shows only the static job;
    - both local-stack jobs are green;
    - #469 (if still open) and other open PRs re-synced, so they no longer run the hosted job.

- [x] **B4. Found already done at 06:43:00Z: all 7 return 404, total 0. Not deleted by this executor; time and actor unknown. T0 = 06:43:00Z (conservative).** Planned: **Delete the 7 secrets** (20; after B3, owner gitleaks decision A4 recorded). Order:

  ```
  gh secret delete E2E_REDIS_URL -R drishiq2-creator/Omnivyra
  gh secret delete E2E_NEXT_PUBLIC_SUPABASE_URL -R drishiq2-creator/Omnivyra
  gh secret delete E2E_ENCRYPTION_KEY -R drishiq2-creator/Omnivyra
  gh secret delete E2E_SESSION_COOKIE_SECRET -R drishiq2-creator/Omnivyra
  gh secret delete E2E_NEXT_PUBLIC_SUPABASE_ANON_KEY -R drishiq2-creator/Omnivyra
  gh secret delete E2E_SUPABASE_SERVICE_ROLE_KEY -R drishiq2-creator/Omnivyra
  gh secret delete E2E_SUPABASE_URL -R drishiq2-creator/Omnivyra
  ```

  - **Do not delete before B2.** On old-workflow branches the hosted job would then skip silently, instead of failing.
  - **T0** = the later of the merge (B2) and the last deletion. From T0, re-runs and old-branch dispatches can no longer reach E2E.

- [ ] **B5. Partly done 06:43Z: secrets 0, `.github` on `main` has 0 `secrets.E2E_` refs, no hosted job since 04:20:38Z. Open: admin A2 (still 9 required checks).** Plan:
  - `gh secret list` is empty (total_count 0);
  - `git grep -nE 'secrets(\.|\[.)E2E_|lomndxmrpyudaegddpef' <main> -- .github` returns nothing;
  - the next PR and `main` runs pass, and no run contains the "E2E provisioning preflight" or "Auth integrity regression lock" jobs (`gh run view <id> --json jobs`);
  - then the admin performs A2.

- [x] **B6. S0 taken 06:44:11–06:44:21Z (exact `g01`–`g07`, read-only endpoint; `s0-20261127/` + `SHA256SUMS`). Grace was already met at T0 (last hosted run ended 04:20:38Z).** Planned: **Take S0** (21 §4). Run `g07_snapshot_all.sql` after T0 plus the grace period:
  - the grace period ends at the latest `completedAt` of a hosted run created before T0, at most T0 + 35 min;
  - record S0 as the real baseline.

## C. Requires green replacement CI and verified zero traffic

- [ ] **C1. In progress.** S0 06:44Z; S1 08:27:17Z (role-call point after the archive pass; 21 §7). Checkpoints 11-28 ~06:47Z and the final pass after 11-30 06:43Z. **Observation window:** at least 24 h after S0 (72 h if A1 is still open). It must include at least one full PR check set and one `main` push run.
  - **Zero activity** = all seven criteria in 21 §3 hold against S0:
    - `capability_audit_log` count and max `occurred_at` are unchanged;
    - auth, idempotency and storage counts and timestamps are unchanged;
    - public/auth/storage write counters and `tup_*` are unchanged;
    - client-role statement totals do not rise;
    - no new client backend appears;
    - `postmaster_start` and `stats_reset` are unchanged (otherwise only the count and timestamp criteria decide).
  - Any later event outside the grace rule is real: stop, identify it, and do not pause.

- [ ] **C2. No other E2E access remains:**
  - A1 is USER VERIFIED;
  - operators are told that `.env.e2e` hosted mode is retired (hosted mode is still the guard's default when `AUTH_E2E_TARGET` is unset);
  - recommended: rotate or revoke the E2E service-role key in the E2E project, because deleting the GitHub secret does not invalidate it.

- [ ] **C3. Pass 1 done 2026-11-27** (`C:/omnivyra-archive/e2e-retirement-20261127/archive-20261127T0801Z/`: encrypted full dump, schema, roles, config, manifest, checksums, local restore test; 18 §9). The final pass (`final-pass.sh`: re-export, final g07, final dump + restore test, manifest, checksums) runs after the window. **Before pausing:**
  - re-export `capability_audit_log` (it is now beyond the archived 3,247 rows) as a new file in the archive, and update `SHA256SUMS`;
  - take a final `g07` snapshot (a paused project cannot be queried);
  - re-check the archive checksums.

- [ ] **C4.** Tool ready: `run-pause.ps1 --confirm lomndxmrpyudaegddpef <final archive dir>`. It refuses before the window ends, without a verified final manifest, or if the project id or name does not match. **Pause the E2E project** `lomndxmrpyudaegddpef` (reversible; Supabase dashboard or Management API pause). Record the time.

- [ ] **C5. While paused, 7–14 days:**
  - `main` and PR CI stay green;
  - no workflow log mentions the E2E ref, `E2E_` secrets, the preflight, or Supabase connection errors;
  - production health stays ok;
  - no operator reports a broken run.
  - If anything breaks: resume the project, find the dependency, and restart the observation from C1.

- [ ] **C6. Final validation:** C5 was clean, the retention decision is recorded, and docs 18 §9 and §11 are updated.

- [ ] **C7. Not before the C5 pause period, and only on the user's explicit confirmation.** **Delete the hosted E2E project.** This is irreversible. The data is test residue, archived outside production and outside the public repository. Record the time and the confirmation.

- [ ] **C8. Publish the final report** as a documentation PR:
  - contents: docs 18–23 plus the doc 17 status update;
  - procedure: branch `docs/e2e-retirement-final-20261127`, secret-scan the files, and merge only when `main` is not under a hold.

## Blocking summary

| Blocker | Owner | Unblocks |
|---|---|---|
| ~~Control Tower merge hold on `main`~~ released 04:45Z; #468 merged 05:10Z | — | done |
| ~~gitleaks decision for #468 (A4)~~ resolved by fingerprints | — | done |
| Observation window from S0 06:44Z | time | C1–C4: earliest pause 2026-11-30 06:44Z (72 h), or 11-28 06:44Z if A1 is USER VERIFIED |
| ~~Vercel check (A1)~~ USER VERIFIED PASS 2026-11-27 | — | C1 is 24 h: earliest pause 2026-11-28 06:44:21Z (24 h after the end of S0) |
| Branch protection admin action (A2) | repository admin | B5 completion |
