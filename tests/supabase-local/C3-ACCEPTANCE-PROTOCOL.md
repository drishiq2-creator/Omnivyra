# C3 acceptance protocol: three consecutive runs of the advisory local-Supabase auth workflow

**Status:** prepared. **Nothing here has been executed.** Pushing and running CI each need explicit owner approval.

## 0. Correction to the stated target: 5 tests per run, not 15

`scripts/run-auth-integrity-tests.js` runs **5 spec files**, and each contains **exactly one** `test(...)`. The suite therefore executes **5 tests per run**. The historical "15/15" was **5 specs × 3 consecutive runs**.

The acceptance gate is:
- **Run 1: 5/5. Run 2: 5/5. Run 3: 5/5.**
- **Aggregate: 15/15 across three independent runs.**

Each run must **independently** show, in its own logs: stack start-up, baseline restore, replay of all planned migrations (104 at `2bc52db7a`), health checks, app start-up, the 5 auth tests, and teardown. A result carried over from another run never counts.

The workflow asserts exactly 5 spec runs, 5 tests and 5 passes, with 0 failed, skipped, todo or cancelled (`EXPECTED_AUTH_SPECS=5`, `EXPECTED_AUTH_TESTS=5`). The workflow lock test derives both numbers from the runner and the specs, so they cannot silently drift.

## 1. What gets run

Workflow: `.github/workflows/auth-integrity-local.yml` ("Auth integrity (local Supabase, advisory)").

| Job | Purpose |
|---|---|
| `local-stack-validation` ("Local Supabase stack validation (advisory)") | Offline unit tests, then `bootstrap.sh plan` and `up`. Records the status variable **names**, verifies `BOOTSTRAP_RESULT` (status ok, stage complete, schema mode full, migrations replayed = the planned count, at least 823 tables, no warnings), runs final read-only schema queries, and always runs `down`. |
| `auth-integrity-local` ("Auth integrity regression suite (local Supabase, advisory)", needs the job above) | Same stack exported with `AUTH_E2E_TARGET=local`, per-run random app secrets, local-only and no-hosted-marker assertions, the target preflight, loopback Redis, the app server, the suite, the exact-result assertion, the hosted-marker scan of the server log, and always `down`. |

## 2. Trigger and branch procedure (needs owner approval at each push)

- `workflow_dispatch` is unavailable until the file is on the default branch. So acceptance uses **branch pushes**: the workflow runs on pushes to `ci-only/c3-auth-local/**`.
- **No other workflow** in the repository triggers on such a push: all push triggers are `main`-only, verified at `2bc52db7a`.
- Because no pull request is opened, the hosted `auth-integrity.yml` (`pull_request`/`workflow_dispatch`) does **not** run.

Procedure, from the isolated working copy `C:\tmp\omnivyra-c1c2-prep-20261126`, only after approval:

1. **Approval 1: commit.** Create one commit containing the change set on a local branch; it must be the C1+C2+C3 files only. Record its full SHA `S`.
2. **Approval 2: push run 1.** Push commit `S` to a new branch `ci-only/c3-auth-local/run-1` on `https://github.com/drishiq2-creator/Omnivyra.git`. The working copy has no configured remote, so the push names the URL explicitly. No other ref is pushed.
3. Wait for completion and collect the evidence (section 3). **If run 1 fails, the sequence resets.** Report; any fix makes a new commit `S'`, and the count restarts at run 1 on new branch names.
4. **Approvals 3 and 4: push runs 2 and 3.** Push the **same commit `S`** to `ci-only/c3-auth-local/run-2`, and after it passes, to `…/run-3`. Each branch creation is a new `push` event, so each run gets a **distinct run ID** with **attempt 1** on the same SHA.
5. **Re-runs:** a "Re-run jobs" keeps the run ID and increments `run_attempt`. It does **not** count as an independent run unless you explicitly approve that interpretation in advance. It is recorded with its attempt number either way.
6. **Afterwards:** the three `ci-only/c3-auth-local/run-*` branches can be deleted (separate approval). Merging the workflow to `main` (advisory, not required) is a separate decision.

## 3. Evidence to record per run

| Field | Required evidence | Source |
|---|---|---|
| Source SHA | Full 40-character SHA, equal to `S` for all three | run metadata `head_sha` |
| GitHub run ID | Unique per run | run metadata `id` |
| Attempt | `1`, unless an approved re-run | run metadata `run_attempt` |
| Stack start-up | PASS | job 1 step "Start, restore and replay…" success, and `BOOTSTRAP_RESULT` `status ok`, `stage complete` |
| Baseline restore | PASS | `BOOTSTRAP_RESULT.tables` ≥ 823, with no unexpected restore errors (`classify-restore` exit 0) |
| Migration replay | PASS | `BOOTSTRAP_VERIFIED … "migrationsReplayed": N` with N = planned count (104 at `2bc52db7a`), `schemaMode full` |
| Health checks | PASS | bootstrap health stage passed (auth `/auth/v1/health` and REST `/rest/v1/`); schema verification output in the artefact |
| App start-up | PASS | job 2 step "Start app server" success |
| Auth tests | **5/5** | `AUTH_SUITE_RESULT {"status":"pass","specs":5,"tests":5,"pass":5,"fail":0,"skipped":0,"todo":0,"cancelled":0}` |
| Hosted target contact | **NONE** | the workflow references no secret; `AUTH_LOCAL_ENV ok`; `HOSTED_TARGET_CONTACT NONE` for the server log; `npm run check:auth-e2e-target` printed `validated (local)` |
| Teardown | PASS | both jobs' "Tear down the disposable stack" steps succeeded |
| Status variable names | recorded | artefact `status-variable-names.txt` (names only) |
| Offline guard and bootstrap tests | PASS | job 1 step "Guard and bootstrap unit tests (offline)": guard suite, plan, CI assertions, workflow lock, log redaction and the stubbed bootstrap simulation, all with `# fail 0` |
| Evidence redaction | PASS | both jobs' "Redact credentials from the evidence before upload" steps succeeded (`REDACT_TOTAL` is printed). They redact the step's secret variables, every value the bootstrap masked with `::add-mask::`, encoded forms of those values, and URL user-info. Each upload runs only if its redaction succeeded, so a missing artefact after a redaction failure is expected, not a leak. |

**Evidence retrieval:** once approved, use read-only GitHub access, either `gh run view <id> --json headSha,databaseId,attempt,conclusion,jobs` and `gh run download <id>`, or the equivalent REST reads. **No GitHub request is made by this preparation.**

## 4. Pass/fail criteria

- **C3 acceptance passes only if** three runs on the same SHA `S`, each with a distinct run ID and attempt 1 (or an owner-approved interpretation), each satisfy **every** field in section 3, consecutively.
- **Any failed field fails that run and resets the sequence.**
- **Advisory status:** the workflow is not a required check, and passing it changes no branch protection. Making it required, removing the hosted job, or deleting `E2E_*` secrets are **C4**, separately approved.

## 5. Runner capabilities relied on

GitHub-hosted `ubuntu-24.04` with:
- Docker;
- `psql`, `curl` and `openssl`;
- `supabase/setup-cli@v1` with CLI `2.122.0`;
- Node 22;
- Chromium through Playwright;
- a Redis 7 service container;
- outbound network for image and package downloads only. No Supabase-hosted endpoint is used.
