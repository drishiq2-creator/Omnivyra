# 22 - Branch protection readiness: "Auth integrity regression suite (local Supabase)"

Date: 2026-11-27. Read-only assessment. Every call was a `gh api` GET or `gh auth status`, plus `git show` on the local clone
`C:\tmp\omnivyra-c1c2-prep-20261126`. Nothing was changed: no branch protection, no rulesets, no merge, no push, no
dispatch.

Repository: `drishiq2-creator/Omnivyra` (public, owned by a **User** account, not an organization). Default branch `main`,
head `329743df` (merge of PR #466) at the time of reading.

Target check: `Auth integrity regression suite (local Supabase)`. It is the job `auth-integrity-local` in
`.github/workflows/auth-integrity-local.yml` at PR #468's head `fa46417f9296f8d37f2a508da022fc331e0ec800`
(branch `feat/c3-combined-20261127`, PR open, not merged).

## Summary

| Question | Answer |
|---|---|
| Required on `main` today? | **No.** It is not one of the 9 required contexts. |
| What controls the required checks? | **Classic branch protection** on `main`. No repository rulesets exist. Org rulesets cannot exist because the owner is a User account. |
| Is the check-run name exactly the job `name:`? | **Yes**, byte for byte, and it comes from app 15368 (`github-actions`), the same app as the 9 pinned contexts. |
| Can it be made required now? | **No.** The workflow is not on `main` yet, so every other PR would wait forever ("Expected - waiting for status to be reported"). |
| Order | Merge #468 → see the check green on a new or re-pushed PR → admin adds the context (preferably together with `Local Supabase stack validation`, see §4). |
| Who can do it | A repo admin only. The current token (`kulrashm-jpg`) has `push: true, admin: false`. |

## 1. Current state and what controls it

Evidence:

- `gh api repos/drishiq2-creator/Omnivyra --jq .permissions` →
  `{"admin":false,"maintain":false,"pull":true,"push":true,"triage":true}`; `owner.type` = `User`.
- `GET repos/.../branches/main/protection` → **404** for this token. The endpoint needs admin rights, so the 404 means
  "not authorized", not "no protection".
- `GET repos/.../branches/main` → `protected: true`, and `protection.required_status_checks`:
  - `enforcement_level: "everyone"`
  - `checks` (all `app_id: 15368`):
    1. Backend TypeScript certification
    2. Production build
    3. Non-regression TypeScript baseline
    4. Governance baseline & documentation verification
    5. Campaign generation + canonical persistence contracts
    6. Static auth invariants (hermetic, no secrets)
    7. PI unit suites
    8. Snapshot remediation contracts (AI visibility, citations, crawler readiness)
    9. Snapshot dossier consistency (contradiction checks)
  - `contexts` lists the same 9 names.
  - `Auth integrity regression suite (local Supabase)` and `Local Supabase stack validation` are **not** in either list.
- `GET repos/.../rulesets` → `[]`. `GET repos/.../rules/branches/main` → `[]`, so no active ruleset applies to `main`.
- `GET orgs/drishiq2-creator/rulesets` → 404. `GET users/drishiq2-creator` → `type: User`. GitHub has no org rulesets for a
  User-owned repo.

What this token cannot see: the `strict` setting ("require branches to be up to date"), required reviews, admin
enforcement, and the other classic-protection settings. The branch summary does not include them, and the full protection
endpoint needs admin. The admin must not change any of them (§5).

## 2. Does the check-run name match? Duplicate runs

The workflow at `fa46417f` (`git show fa46417f:.github/workflows/auth-integrity-local.yml`):

```yaml
name: Auth integrity (local Supabase)
on:
  pull_request:
  workflow_dispatch:
  push:
    branches:
      - 'ci-only/c3-auth-local/**'
...
jobs:
  local-stack-validation:
    name: Local Supabase stack validation
    timeout-minutes: 30
  auth-integrity-local:
    name: Auth integrity regression suite (local Supabase)
    needs: local-stack-validation
    timeout-minutes: 45
```

There is no matrix, so the job name is not decorated. There is no job-level `if:`. Step-level `if: always()` appears only on
the teardown, redaction and upload steps.

Check runs (`GET repos/.../commits/<sha>/check-runs`), filtered to these jobs:

| SHA | Check-run name | app.id / slug | Conclusion | Check suite | Workflow run / event |
|---|---|---|---|---|---|
| `fa46417f` (PR #468 head) | Auth integrity regression suite (local Supabase) | 15368 / github-actions | success | 124277498857 | 45936416753 / `pull_request` (#468) |
| `fa46417f` | Local Supabase stack validation | 15368 / github-actions | success | 124277498857 | same |
| `20373e8a` (= `ci-only/c3-auth-local/run-4`, and an earlier #468 head) | Auth integrity regression suite (local Supabase) ×2 | 15368 | success ×2 | 124268769186, 124268855705 | 45933035633 `push` (run-4); 45933069357 `pull_request` (#468) |
| `9760e62b` (= `ci-only/c3-auth-local/run-5`, and an earlier #468 head) | Auth integrity regression suite (local Supabase) ×2 | 15368 | success ×2 | 124273930381, 124273930888 | 45935045333 `push` (run-5); 45935045522 `pull_request` (#468) |

Findings:

- The emitted check-run name is **exactly** `Auth integrity regression suite (local Supabase)`, which is the job `name:`.
  The workflow name does not appear in the check-run name. The Actions workflow registry shows the workflow as
  "Auth integrity (local Supabase, advisory)" (workflow id 431617663), but that label only affects the Actions UI.
  Required checks match on the check-run name.
- It is produced by app **15368 (GitHub Actions)**, so it can be pinned the same way as the other 9.
- **Duplicates.** The same SHA gets two check runs with the same name when it is pushed both to a
  `ci-only/c3-auth-local/**` branch (`push` event) and as a PR head (`pull_request` event). This is what happened on
  run-4 and run-5. At `fa46417f` only the `pull_request` run exists.
- **How a required check is evaluated.** GitHub looks at check runs with that name (and that app, when pinned) on the
  **PR head SHA**. A `pull_request` run reports its check run on the head SHA, as confirmed at `fa46417f`. Because the
  match is per SHA rather than per event, a `push` run from a `ci-only/c3-auth-local/**` branch on the *same* SHA would
  also satisfy the requirement. GitHub uses the latest run of that name on that SHA. A failed later run blocks the merge
  again, and a successful later run unblocks it.
- **Is the ci-only path a risk?** It is acceptable. A push run executes the workflow file from that same SHA, so it tests
  the same code. Only repo writers can push those branches. A push run on a *different* SHA never counts for a PR.
- **General caveat, true for every Actions-required check here.** `pull_request` runs use the workflow file from the PR's
  merge ref. A PR that edits `auth-integrity-local.yml` can therefore change what the job does. Review of workflow
  changes (CODEOWNERS or required review on `.github/workflows/**`) is the control for that. Pinning the check does not
  cover it.
- The commit-status API shows nothing for `fa46417f` (`/status` → `total_count: 0`). The check exists only as a check
  run, so it must be required as a check (app 15368), not as a legacy commit status.

## 3. Ordering: adding it before #468 merges blocks every PR

- `GET repos/.../contents/.github/workflows/auth-integrity-local.yml?ref=main` → **404**. The workflow is not on `main`.
- `git diff --stat 329743df fa46417f -- .github/workflows` shows that #468 **adds** `auth-integrity-local.yml` (+284). It
  also rewrites `auth-integrity.yml` (-320 net), which removes the hosted `Auth integrity regression lock` job and the
  preflight but keeps the `Static auth invariants (hermetic, no secrets)` job. That job is still required, and it ran
  green at `fa46417f`.
- A required context that no workflow on a PR's merge ref produces stays "Expected - waiting for status to be reported"
  forever. If the context were added now, all 3 open PRs to `main`, and every new PR whose branch lacks the file, would
  be unmergeable. #468 itself is the exception, because it already produces the check.
- After #468 merges, existing open PRs do **not** re-run automatically. `pull_request` fires on
  opened/synchronize/reopened. Those PRs pick up the new workflow only on their next push, or after a close and reopen.
  Until then they show the new context as Expected. This is a second reason to wait until the check has been seen on a
  post-merge PR.
- The workflow does **not** run on push to `main`. Its `push` trigger covers only `ci-only/c3-auth-local/**`, and the
  recent `main` push runs are Real-Schema CI, PI Verification and Backend TypeScript Certification. So "confirm green
  after merge" means "confirm on a PR opened or updated after #468 merges", not "on `main`". That is the right place,
  because required checks only gate PRs.

Required order:

1. Merge #468, after its own review and approval.
2. Open or update any PR against the new `main` (for example the next routine PR, or a re-push of an open one). Confirm
   that `Auth integrity regression suite (local Supabase)` (and `Local Supabase stack validation`) appear with app
   `github-actions` and conclude `success` on that PR's head SHA.
3. Only then, the admin adds the context(s) (§5).
4. Re-push or reopen the remaining open PRs, so they produce the check instead of sitting at Expected.

## 4. Path filters, `if:` conditions and skipped jobs

- **Triggers at `fa46417f`.** `pull_request:` has **no `paths`/`paths-ignore`/`branches` filter**, so it fires on every PR
  to any base. There is also `workflow_dispatch` and push to `ci-only/c3-auth-local/**`. No PR can leave the check pending
  through a path filter. GitHub semantics for reference: if a path or branch filter stops a workflow from running, it
  reports no check at all, and a required check then stays Pending, which blocks the merge.
- **Job-level `if:`.** None on either job.
- **`needs:` skip. This is a real gap, and it changes the recommendation.** `auth-integrity-local` has
  `needs: local-stack-validation`. If `Local Supabase stack validation` fails, the dependent job is **skipped**. GitHub
  documents that a skipped job reports its check as passing ("skipped"), and a skipped required check does **not** block
  the merge. If only the auth suite were required, a PR that broke the local stack (for example a migration that no
  longer replays) would show the stack job red and the required auth check as "skipped", and the PR would still be
  mergeable.
  - **Recommendation:** require **both** `Local Supabase stack validation` and
    `Auth integrity regression suite (local Supabase)`. Both come from app 15368. The stack job has no `needs:` and no
    `if:`, so it cannot be skipped. A failed stack job then blocks the merge directly. (Alternative, which needs a
    workflow change and its own review: give the auth job `if: always()` plus an explicit step that fails when
    `needs.local-stack-validation.result != 'success'`. Requiring both jobs needs no code change and is simpler.)
- **`concurrency`.** The group is `auth-integrity-local-${{ github.ref }}` with `cancel-in-progress: false`. A second
  push to the same PR queues behind the first instead of cancelling it. When a third run arrives, GitHub replaces an
  already-pending run in the group, and the replaced run ends `cancelled`. A cancelled run fails a required check until
  the newest run on the head SHA completes. The newest head SHA always gets its own run, so this only delays the merge.
- **Fork PRs (the repo is public).** The workflow uses no secrets. First-time-contributor fork PRs still need an
  approval before Actions run, and until then the check is Expected. This is the same for all 9 existing checks.

## 5. The administrator action

Preconditions: §3 steps 1-2 are done. Use an account with **admin** on `drishiq2-creator/Omnivyra`. `kulrashm-jpg` is not
an admin.

### UI path (preferred)

1. Repository → **Settings** → **Branches** → **Branch protection rules** → the rule for `main` → **Edit**.
2. Under **Require status checks to pass before merging**, in the search box, add:
   - `Auth integrity regression suite (local Supabase)`. Set its source to **GitHub Actions** (not "any source"), to match
     the other 9.
   - `Local Supabase stack validation`. Source **GitHub Actions** (recommended, see §4).

   The search only offers checks that ran in this repository in roughly the last week, so do this soon after the
   post-merge PR run in §3 step 2.
3. Leave all 9 existing contexts and every other setting unchanged ("Require branches to be up to date", reviews,
   admin enforcement, push restrictions, force-push/deletion settings, and so on). Click **Save changes**.

### API alternative (admin token)

Read first, so the current settings are known and kept:

```
gh api repos/drishiq2-creator/Omnivyra/branches/main/protection/required_status_checks
```

The two write options below are written down for the admin. **They were not executed in this assessment.**

**Option A: add only, nothing replaced.** "Add status check contexts":

```
gh api -X POST repos/drishiq2-creator/Omnivyra/branches/main/protection/required_status_checks/contexts \
  --input - <<'JSON'
{"contexts":["Auth integrity regression suite (local Supabase)","Local Supabase stack validation"]}
JSON
```

The endpoint appends to the existing list. Its documented body is `{"contexts":[...]}`, and a bare JSON array is also
accepted. It leaves `strict` and all other protection untouched. Limitation: the contexts endpoint takes names only, so the
new entries are expected to be stored **without an app pin** ("any source"). The GET afterwards shows this as `app_id`
null or absent on the new `checks` entries. That is functionally fine, because only GitHub Actions emits these names
today, but it is weaker than the other 9. In the worst case, any integration with checks:write could post a check with
the same name.

**Option B: app-pinned, matching the other 9.** "Update status check protection" (`PATCH .../required_status_checks`).
The `checks` array **replaces** the whole list, so it must contain all 9 existing entries plus the new ones. Omit `strict`
to keep it unchanged, or copy its current value exactly from the GET above:

```
gh api -X PATCH repos/drishiq2-creator/Omnivyra/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{"checks":[
 {"context":"Backend TypeScript certification","app_id":15368},
 {"context":"Production build","app_id":15368},
 {"context":"Non-regression TypeScript baseline","app_id":15368},
 {"context":"Governance baseline & documentation verification","app_id":15368},
 {"context":"Campaign generation + canonical persistence contracts","app_id":15368},
 {"context":"Static auth invariants (hermetic, no secrets)","app_id":15368},
 {"context":"PI unit suites","app_id":15368},
 {"context":"Snapshot remediation contracts (AI visibility, citations, crawler readiness)","app_id":15368},
 {"context":"Snapshot dossier consistency (contradiction checks)","app_id":15368},
 {"context":"Local Supabase stack validation","app_id":15368},
 {"context":"Auth integrity regression suite (local Supabase)","app_id":15368}
]}
JSON
```

Re-read the existing list from the GET immediately before running this. If the GET differs from the 9 listed here, use
the GET's list. A list that is out of date silently drops a required check. The UI path is preferred because it does
Option B's pinning without this replace-the-list risk.

The endpoint shapes and semantics are from the GitHub REST "Branch protection" docs as known at the time of writing. They
were not re-fetched in this session. The verification below is what proves the outcome.

### Verification afterwards (any token with read access)

```
gh api repos/drishiq2-creator/Omnivyra/branches/main \
  --jq '.protection.required_status_checks | {enforcement_level, n:(.checks|length), checks}'
```

Expected: `enforcement_level: "everyone"`, `n: 11` (or 10 if only the auth check is added). All original 9 entries are
present with `app_id: 15368`. The new entries are present, with `app_id: 15368` for the UI or Option B, and null for
Option A. Also open any PR and confirm the new checks show as **Required** in the merge box.

## 6. Side effects, risks, rollback

- **Scope.** Adding contexts to `required_status_checks` changes nothing else in the `main` rule and nothing on any other
  branch. There are no other rules or rulesets to interact with (§1). Only PRs **targeting `main`** are gated. The
  `ci-only/c3-auth-local/**` push runs are not affected.
- **Duration and timeouts.** Observed runs: the stack job takes about 3-4 min (30-min timeout) and the auth job about
  3-4 min (**45-min** timeout, not 30), so about 7-8 min end to end. A hang holds a PR for up to about 75 min before
  failing.
- **Flakiness.** The job starts a full local Supabase stack, a Redis service container and Chromium/Playwright on a
  GitHub-hosted `ubuntu-24.04` runner. Possible failure sources are image or registry pulls, the pinned Supabase CLI
  download, npm install and runner availability. Evidence so far: 5 of 5 observed runs succeeded (`fa46417f`, run-4 ×2,
  run-5 ×2), plus earlier acceptance runs. Mitigation: re-run failed jobs. There is no auto-retry.
- **Runner capacity.** The job uses two hosted-runner jobs in sequence per PR push. On a public repo, standard hosted
  runners cost nothing, but concurrency is limited. A queue makes the merge wait. It does not cause a failure.
- **Branch drift.** If `strict` is on, the check re-runs after every "update branch". That only costs time.
- **Rollback.** Remove the context(s): UI → same rule → remove the entry with the × → Save. API:
  `DELETE .../branches/main/protection/required_status_checks/contexts` with
  `{"contexts":["Auth integrity regression suite (local Supabase)","Local Supabase stack validation"]}`, or PATCH `checks`
  back to the original 9. Then verify with the GET above, which should show `n: 9`. Rollback does not touch the workflow,
  which keeps running as an advisory check.
