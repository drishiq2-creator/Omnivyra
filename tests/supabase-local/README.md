# Disposable CI Supabase stack for the auth E2E suite (C1)

**Status: prepared, not activated.** Only the advisory workflow `.github/workflows/auth-integrity-local.yml` (C3, prepared locally, not pushed) references these files. Running it is a separate, owner-approved step. Nothing here has ever started a container: actual stack start-up, schema restore and migration replay are **pending CI-runner validation**.

## Purpose

The auth E2E suite (`tests/auth/*.spec.ts`, 5 specs, run by `npm run test:auth-integrity`) currently runs against the permanently hosted `omnivyra-e2e` project. This directory lets a CI job create a **throw-away Supabase stack on the runner itself**, run the suite against it with `AUTH_E2E_TARGET=local` (C2), and discard it. That removes the suite's dependency on a hosted test project.

## Files

| File | Role |
|---|---|
| `supabase/config.toml` | Stack configuration (`project_id = "omnivyra-auth-e2e-local"`). Use **only** via `--workdir tests/supabase-local`. |
| `stack-extensions.sql` | The five extensions the schema baseline expects, created in schema `extensions`. |
| `bootstrap.sh` | `plan` / `up` / `down` orchestration (CI runner only, except `plan`). |
| `localStackPlan.ts` | All decisions that need no container (runner gate, hosted-variable gate, config/port check, migration selection, restore-error classification, status export validated by the auth guard). |
| `localStackPlan.spec.ts` | Unit tests for the above. |
| `bootstrapSimulation.spec.ts` | Runs `bootstrap.sh` end to end against **stub** `supabase`/`psql`/`docker`/`curl` in a throw-away sandbox (it refuses to run unless all four resolve to the stubs). Covers error propagation, migration failure, credential capture, validated endpoints and connection hygiene, each with a failing control. Starts nothing. |
| `ciAssertions.ts` / `ciAssertions.spec.ts` | CI result checks (bootstrap result, exact suite result, hosted-marker scans) and `redact-logs`, which strips secret values and URL credentials from evidence files before upload. |
| `logRedaction.spec.ts` | The app's own Redis/connection log redaction (review finding F17). |
| `authIntegrityLocalWorkflow.spec.ts` | Lock test for `.github/workflows/auth-integrity-local.yml`. |
| `supabase/.gitignore` | Keeps the CLI's generated `.temp/` and `.branches/` (and any `.env*`) out of git. |

**Why not the repository-root `supabase/` folder:**
- the Supabase GitHub integration watches the repository root;
- developer checkouts keep `supabase/.temp/` linked to a **hosted** project.

The separate workdir has no link file, and the bootstrap refuses to run if one appears.

## CI runner prerequisites

- A **GitHub-hosted** runner (`ubuntu-24.04`). `up` and `down` refuse unless `GITHUB_ACTIONS=true`, `CI=true`, `RUNNER_ENVIRONMENT=github-hosted` and `GITHUB_RUN_ID` are all set. **They never run on a laptop** (owner rule: no Docker on the laptop).
- Docker (preinstalled on GitHub-hosted Ubuntu runners).
- **Supabase CLI exactly `2.122.0`.** For example, `supabase/setup-cli@v1` with `version: 2.122.0`. Pinned in `bootstrap.sh` and `localStackPlan.ts`; a mismatch is a hard failure.
- `psql`, `curl`, Node 22 and `npm ci` (for `tsx`).
- **No hosted-Supabase variables in the job:** `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`. If any is set, the bootstrap refuses; it never silently unsets them.
- **No other `SUPABASE_*` variable** except `SUPABASE_CLI_VERSION` and the two it exports itself (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, which it strips from the CLI's environment). The CLI reads `SUPABASE_<SECTION>_<KEY>` config overrides.
- **No `PG*` variable.** `psql` also runs with an empty environment (`env -i`), a private `HOME` and `-X`; `curl` ignores proxies and `~/.curlrc` and never follows a redirect.
- The bootstrap uses only the endpoint strings that `export-env` validated (written to a private `stack.env`); a key printed twice by `supabase status` is refused.

## Commands

```bash
bash tests/supabase-local/bootstrap.sh plan        # anywhere; no side effects
bash tests/supabase-local/bootstrap.sh up --env-out "$GITHUB_ENV"   # CI runner only
bash tests/supabase-local/bootstrap.sh down        # CI runner only (use in an `if: always()` step)
```

`--schema-mode baseline-only` skips the migration replay. It is **explicit, recorded in the result line as a warning, and not the default**.

## What `up` does (in order; any failure stops it)

1. **preflight:** runner gate; hosted-variable gate; tools; pinned CLI version; `plan`.
2. **start:** `supabase start --workdir tests/supabase-local`.
3. **status:** `supabase status -o env`.
   - `API_URL` must be `http://<loopback>:54321` and `DB_URL` a loopback Postgres URL on `54322`, validated by the **same** functions as the auth E2E guard.
   - The exported environment is then fed to the guard's `resolveAuthE2ETarget` in local mode; it must be accepted.
4. **extensions:** `stack-extensions.sql` with `ON_ERROR_STOP`.
5. **baseline-restore:**
   - `supabase/_schema/baseline.sql` (schema-only, `ledgerMax 20260916000000`, at least 823 public tables).
   - **Same rule as `scripts/ci/real-schema-ci.sh`:** only "already exists" errors are tolerated, and the table count must reach the baseline's.
   - `scripts/ci/schema-bootstrap.sql` is **deliberately not used**. It is a plain-Postgres scaffold that would replace GoTrue's `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()`.
6. **migration-replay:**
   - every migration with a 14-digit version above `ledgerMax`, in order, with `ON_ERROR_STOP`;
   - 104 files at base `2bc52db7a`, from `20260917000000…` to `20270217000075…`;
   - **the same selection rule as `real-schema-ci`.**
7. **health:** `GET /auth/v1/health` and `GET /rest/v1/` on the validated loopback API URL, for up to 30 s. **There is no fallback target.**
8. **export:** with `--env-out`, appends `AUTH_E2E_TARGET=local`, `E2E_SUPABASE_URL`, `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `E2E_SUPABASE_SECRET_KEY`, `SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keys are registered as GitHub log masks. The database URL is **not** exported.

**Output:** the last line is always `BOOTSTRAP_RESULT {"status":"ok"|"failed","stage":…,"schemaMode":…,"tables":…,"migrationsReplayed":…,"warnings":…}`, including on failure. No key or database URL is ever printed.

## Ports and endpoints

| Service | Endpoint |
|---|---|
| API (Kong) | `http://127.0.0.1:54321` |
| Postgres | `127.0.0.1:54322` |
| App under test | `http://localhost:3000` |
| Redis (CI service container) | `127.0.0.1:6379` |

`tests/auth/e2eEnvironmentGuard.ts` (`LOCAL_STACK_PORTS`) must equal `config.toml`; a unit test enforces it.

## Seed data

None. The suite creates, confirms and deletes its own users through the admin API.

## Cleanup

`bootstrap.sh down` runs `supabase stop --workdir tests/supabase-local --no-backup`. That stops and removes the containers and volumes of **this** project only. Run it in an `if: always()` step. The runner itself is discarded after the job.

## Failure behaviour

Fail-closed at every stage. The trap prints `BOOTSTRAP_RESULT` with `"status":"failed"` and the failing stage, and the job must stop there. A missing prerequisite, a non-loopback or hosted endpoint, an unexpected restore error, a failing migration or an unhealthy stack each stop the run. **Nothing ever falls back to a hosted project.**

## Known limitations (to resolve during CI-runner validation, C3)

1. **Not executed yet.** CLI 2.122.0's acceptance of every `config.toml` key, the `supabase status -o env` variable names (`SECRET_KEY`/`PUBLISHABLE_KEY` vs `SERVICE_ROLE_KEY`/`ANON_KEY`; both handled) and the health endpoints are unverified until a runner executes `up`.
2. **The migration replay inherits `real-schema-ci`'s state.** That job was red on `main` on 2026-11-21/22 (historical). If a migration still fails to replay, `up` fails at `migration-replay` for the same reason. The fix belongs to that workstream, not here. `--schema-mode baseline-only` exists only as an explicit, recorded diagnostic.
3. **Schema fidelity is `main`, not production.** Migrations applied in production but absent from `main` (for example the stranded GD-4 band) are not in this stack.
4. **The app needs other per-run settings** (`SESSION_COOKIE_SECRET`, `ENCRYPTION_KEY`, `OPENAI_API_KEY` placeholder, Redis). These belong in the C3 workflow job (for example random per-run values), not in this bootstrap.
5. `psql` on the runner may be an older major version than the PostgreSQL 17 server. That is expected to work for plain SQL files; to be confirmed in C3.
6. **Not yet answered:** why `.github/workflows/db-replay.yml` has failed since May. It runs `supabase start` at the repository root, which has no `config.toml` [inferred]. This directory does not change that workflow.

## Deliberately deferred (separate approval: C3)

- Adding a CI job (advisory first) that runs `up`, the dev server and `npm run test:auth-integrity` with `AUTH_E2E_TARGET=local`, then `down`.
- Three consecutive passing runs on the same SHA: 5/5 tests per run (5 specs, one test each), 15/15 across the three runs.
- Retiring the hosted job and the `E2E_*` secrets (C4/C5).
