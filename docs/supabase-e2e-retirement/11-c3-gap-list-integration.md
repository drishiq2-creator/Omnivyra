# 11 — C3 local stack consumes the baseline-gap manifest

Date: 2026-11-26. Workspace: `C:\tmp\omnivyra-p2-D`, branch `p2-D/c3-gap-list` (local clone, no remote), base C3 checkpoint `f237b92f` + the 9 uncommitted C3 files (pending owner commit approval) + `supabase/_schema/baseline-gap-migrations.txt` from the schema-correction integration. Nothing committed, nothing pushed, Docker not used.

## Problem

`tests/supabase-local/bootstrap.sh up` replays `localStackPlan.ts migrations`, which was `selectMigrations()`: 14-digit versions above `baseline.json` `ledgerMax`. `20260718000003_content_learning_performance.sql` is at or below `ledgerMax` and absent from `baseline.sql`, so the C3 stack never had `content_performance`, `content_prediction`, `learning_intelligence`, `learning_memory` or `public.set_content_updated_at()`. `real-schema-ci.sh` now has step 3b, which applies the manifest entries after the >ledgerMax replay.

## Implementation (extends `localStackPlan.ts`; no second source of truth)

- `BASELINE_GAP_MANIFEST = 'supabase/_schema/baseline-gap-migrations.txt'`.
- `parseBaselineGapManifest(text | null, ledgerMax, exists)` uses the same rules as `real-schema-ci.sh` step 3b, checked in the same order and with the same wording. It drops `#…` comments, removes every CR, trims POSIX `[[:space:]]` and skips blank lines. An entry is refused when:
  - it contains `/`, `\` or whitespace (it must be a bare migration file name);
  - it does not end in `.sql`;
  - the text before the first `_` is not all digits (no numeric version prefix);
  - that version is not exactly 14 digits;
  - the version is above `ledgerMax` (the replay already applies it);
  - it is listed twice;
  - it is not an existing regular file in `supabase/migrations/`.

  `null` (manifest absent) means no gaps. Every violation throws a `LocalStackPlanError` that names the manifest and the entry.
- `planReplay(files, ledgerMax, manifestText, exists)` returns `{ aboveLedgerMax, baselineGaps, ordered }`. `ordered` is `[...selectMigrations(...), ...gaps in manifest order]`, the same order CI uses. No name can appear twice: every gap version is ≤ ledgerMax, and every selected version is above it. The ledger rule is the guard, so a name that the normal selection also picks is refused as "above ledgerMax".
- `readReplayPlan(root)` (CLI) reads the manifest. Only `ENOENT` counts as "absent"; any other read error throws, because a read failure is not an absence. The `migrations` and `migration-count` commands now print `ordered`, and `plan` reports `migrationsToReplay` (total), `aboveLedgerMax` and `baselineGapMigrations`.
- **`bootstrap.sh` and `.github/workflows/auth-integrity-local.yml` are unchanged.** `bootstrap.sh` already applies each line of `migrations` from `supabase/migrations/` with `ON_ERROR_STOP` and checks the count against `migration-count`. The workflow's expected count is `migrations | grep -c .`, so `assert-bootstrap-result` now expects 105. `up` runs `plan` before `supabase start`, so a bad manifest stops the run before any container starts (the simulation confirms this).
- There is one deliberate difference from CI. CI validates each entry just before applying it. C3 validates the whole manifest before anything runs, so a bad entry never produces a partial replay.
- `README.md`: one bullet under "migration-replay".

Plan on this checkout (`node node_modules/tsx/dist/cli.mjs tests/supabase-local/localStackPlan.ts plan`): `migrationsToReplay 105, aboveLedgerMax 104, baselineGapMigrations ["20260718000003_content_learning_performance.sql"], lastMigration 20260718000003_content_learning_performance.sql`. The 104 matches C3 Run 1 (run 45825080632).

## Files changed (vs the C3 state)

| File | Change |
|---|---|
| `tests/supabase-local/localStackPlan.ts` | `BASELINE_GAP_MANIFEST`, `parseBaselineGapManifest`, `planReplay`, `readReplayPlan`; `plan` / `migrations` / `migration-count` use it |
| `tests/supabase-local/localStackPlan.spec.ts` | 10 `GAP …` tests |
| `tests/supabase-local/bootstrapSimulation.spec.ts` | 4 `SIM GAP …` tests (1 is an in-spec CONTROL) |
| `tests/supabase-local/README.md` | 1 bullet |

## Tests run (all under `phase2/heavy.sh`; logs in `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/D/`)

| Command | Exit | Result |
|---|---|---|
| `node node_modules/tsx/dist/cli.mjs --test tests/supabase-local/localStackPlan.spec.ts` | 0 | tests 29, pass 29, fail 0 (19 existing + 10 new) — `t1-localStackPlan.log` |
| `node node_modules/tsx/dist/cli.mjs --test tests/supabase-local/bootstrapSimulation.spec.ts` | 0 | tests 25, pass 25, fail 0 (21 existing + 4 new; 632 s) — `t2-bootstrapSimulation.log` |
| `node node_modules/tsx/dist/cli.mjs --test tests/supabase-local/localStackPlan.spec.ts tests/supabase-local/authIntegrityLocalWorkflow.spec.ts` (final, after the controls) | 0 | tests 46, pass 46, fail 0 — `t7-final-units.log` |
| `node node_modules/typescript/bin/tsc -p <temp tsconfig: the 3 changed .ts files, extends tsconfig.json>` | 0 | no diagnostics — `t6-tsc.log` (temp tsconfig deleted) |

Changed-module consumers (grep for `localStackPlan` / `baseline-gap-migrations`): `localStackPlan.spec.ts`, `bootstrapSimulation.spec.ts`, `bootstrap.sh` and the workflow (both exercised through the simulation and the workflow lock spec). All of them were run.

New tests:
- **Valid manifest:** comments, CRLF, padding, no final newline, an entry at exactly `ledgerMax`, manifest order kept.
- **Empty manifest** (comments and blanks only, or `''`) and **missing manifest** (`null`) give no gaps.
- **Duplicate entry**, paired with a positive case that has the single entry.
- **Invalid names:**
  - a path, a backslash, inner whitespace;
  - no `.sql`, or `.sql.bak`;
  - `gap_a.sql`, `20260101000000.sql`, `2026010100000x_…`, 8-digit and 15-digit versions;
  - above `ledgerMax`, with the scenario asserting that the name *is* selected by the normal replay;
  - a nonexistent file.
- **Malformed `ledgerMax`.**
- **Order:** every migration above `ledgerMax` first, then the gaps in manifest order, each exactly once; with no manifest the plan is unchanged.
- **The real repository:** the manifest is valid and `content_learning_performance` comes last, after all 104.
- **Simulation:**
  - a gap is applied third, after `sim_a` and `sim_b`, and `migrationsReplayed` is 3;
  - an invalid manifest (above ledgerMax, duplicate, missing file, path) fails with no `supabase start` and no migration call;
  - a failing gap migration fails at `migration-replay` with 2 replayed.

## Failing controls

**Script.** `phase2/D/failing-controls.js` ran under one `heavy.sh` lock; log in `t3-failing-controls.log`. For each guard it edits `localStackPlan.ts` in place, runs the matching test with `--test-name-pattern`, requires a non-zero exit with `fail > 0`, writes the original bytes back and checks sha256.

**Result.** All 11 controls went red (`fail 1` each). The file sha256 was `1d3b12dd…63da` before and after every control.

| Guard broken | Test that went red |
|---|---|
| bare-name check → `if (false)` | GAP … not a bare file name |
| `.sql` check | GAP … without .sql |
| numeric-prefix check | GAP … without a 14-digit version |
| 14-digit length check | GAP … without a 14-digit version |
| `<= ledgerMax` check | GAP … above ledgerMax |
| duplicate check | GAP a duplicate entry |
| file-exists check | GAP … does not exist |
| `null` manifest → `[]` removed | GAP an empty manifest … and a missing manifest |
| comment stripping removed | GAP an empty manifest … |
| order swapped (gaps first) | GAP replay order |
| CLI: ENOENT no longer counts as absent | SIM baseline (bootstrapSimulation.spec.ts; the sandbox has no manifest) |

There is also an in-spec control, `SIM GAP CONTROL`: with `ordered` reduced to `aboveLedgerMax`, the gap is never applied and `migrationsReplayed` is 2. It passes, so the mutation is observed.

## Local PostgreSQL 17 evidence (no Docker)

**Same list as the plan.** The C3 plan's ordered output (`localStackPlan.ts migrations`, 105 lines) is byte-identical to the harness's order (its >ledgerMax glob rule followed by the manifest entries). Both files have sha256 `34922aa0…d35a` (`c3-migrations.txt`, `harness-order.txt`). The harness therefore applies exactly the C3 list.

**Run.** Command:

```
bash phase2/heavy.sh D-pgreplay -- bash C:/tmp/omnivyra-schema-fix-20261126-tools/pg-replay.sh --repo C:/tmp/omnivyra-p2-D --port 55473 --run phase2/D/runs/r1 --gaps --keep
```

It exited 0 (`t4-pgreplay.log`):
- baseline restore: 1 error, 0 unexpected; 823 public tables (floor 823);
- `RESULT OK replayed=104 public_tables=873 extra=0 gaps=1`;
- `20260718000003_content_learning_performance.sql ok`.

20270111000003 ran with `ON_ERROR_STOP`, so its trigger postcondition (at least 74) passed during the replay.

**Read-only queries** (`verify.sql`, output `t5-verify.txt`) on 127.0.0.1:55473:

```
table content_performance=true
table content_prediction=true
table learning_intelligence=true
table learning_memory=true
set_content_updated_at=1
touch_trigger_count=74
content_block_trigger_fn=omnivyra_touch_updated_at
learning_memory_triggers=learning_memory_set_updated_at:set_content_updated_at
```

After the gaps, the trigger count is still 74 and content_block stays on `omnivyra_touch_updated_at`.

**Cleanup.** The cluster was stopped with `pg_ctl -D …/runs/r1/data stop -m fast`, the data dir was deleted, and port 55473 was confirmed closed.

## Limitations

- The harness turns pgvector types into `real[]` (its only stated deviation) and uses `scripts/ci/schema-bootstrap.sql`. The real C3 stack uses the Supabase CLI image plus `stack-extensions.sql`. **The real C3 stack has not been run with this change.** That needs a CI run, which needs owner push approval (runs 2 and 3 are each separately approved).
- The workflow's "Final schema verification" step does not query the four tables. Adding them is an option; it was not done, to keep the change minimal.
- The `GAP … repository manifest` test reads `supabase/_schema/baseline-gap-migrations.txt`. The patch below must land **together with or after** that manifest. Without it, that test fails, and `migrations` silently falls back to 104, which is CI's "absent manifest = no gaps" rule.

## Transfer

The patch is `C:/tmp/omnivyra-schema-fix-20261126-tools/phase2/D/c3-gap-list.patch`, sha256 `6c129c92266914f0f9b0d6b6e5bc9bef30ac538ef337b622337ca9c6e7cbd50e`. It was built by `phase2/D/make-patch.sh` (log `t8-patch.log`).

**Contents:** only the 4 files in the table above (219 insertions, 10 deletions). It is relative to `f237b92f` plus the 9 uncommitted C3 files.

**Excluded:** `supabase/_schema/baseline-gap-migrations.txt` (transferred by the schema-correction integration) and this document.

**Verification.**
1. The script reconstructed the base: a fresh clone at `f237b92f`, with the 9 files copied read-only from `C:/tmp/omnivyra-c1c2-prep-20261126`.
2. It checked those 9 files (plus the committed README) against my clone's pre-change state with `cmp`: all the same.
3. On a second fresh reconstruction, `git apply --check` passed. Applying the patch produced files byte-identical to my clone.
4. The patch was not applied to the real C3 checkout.

To apply, from the C3 checkout root after the manifest is in place: `git apply --check <patch> && git apply <patch>`.
