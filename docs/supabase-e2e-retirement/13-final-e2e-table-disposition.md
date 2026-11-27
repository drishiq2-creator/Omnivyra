# 13 — Final E2E table disposition

**Project:** `lomndxmrpyudaegddpef` ("omnivyra-e2e") only. **Production was not accessed.**
**Observed:** 2026-11-26 18:52–18:53 UTC (server clock), repository scans to 19:45 UTC.
**Access:** read-only. Two `SELECT` statements via `run-e2e-ro.ps1` (Management API `database/query/read-only`, role `supabase_read_only_user`, `transaction_read_only = on`). No writes, no CLI, no psql.

**Result: no additional table qualifies for deletion.** All 850 remaining `public` tables are RETAIN. `drop-candidates.sql` contains no statement to run.

## 1. Method

### Deletion bar

A table is a DELETE-CANDIDATE only if **all** of the following hold. This is the report 06 bar, tightened in one respect (see the last paragraph of this subsection).

| # | Condition | How checked |
|---|---|---|
| 1 | 0 rows now | exact `count(*)` (`query_to_xml`) per table |
| 2 | No writes | `pg_stat_user_tables` `n_tup_ins = n_tup_upd = n_tup_del = 0`. `pg_stat_database.stats_reset` is **null** (never reset). Postmaster started 2026-11-10T04:46:36Z. The tables were recreated at the 2026-11-08 refresh (05). |
| 3 | Not referenced by any repository code, test, CI file or script | (a) Whole-word token match over every tracked and untracked, non-ignored file in the integration working tree `C:/tmp/omnivyra-schema-fix-20261126` (13,974 text files scanned; 280 binary or oversize files skipped). Hits are counted overall and excluding `supabase/migrations` and `supabase/_schema`. (b) Batched `git grep -w` over all 1,015 `refs/remotes/origin/*` refs of `C:/virality`. This was done only for tables with no non-schema hit in (a), since any other table already fails this condition. |
| 4 | Not created by any migration (main or branch), and not in `supabase/_schema/baseline.sql` | The `CREATE TABLE` / `ALTER TABLE … RENAME TO` parser was run over: every `.sql` blob reachable from the 1,015 origin refs (1,267 unique blobs); the working tree's `.sql` files, which include the 16 uncommitted integration files; and `baseline.sql` on `origin/main` (`2bc52db7a`, identical in the working tree). A table in `baseline.sql` is production schema and is canonical, so it is **never** an E2E candidate. |
| 5 | No inbound or outbound FK; no view, matview, function, policy, publication, inheritance or other `pg_depend` dependency | Live catalog: `pg_constraint`, `pg_depend`/`pg_rewrite`, whole-word match on `prosrc`, `pg_policy` expressions on other tables, `pg_publication_rel`, `pg_inherits`, and other normal `pg_depend` rows. Triggers and policies **on** the table are recorded but are owned by it. |
| 6 | Not platform-managed | Only `public` is in scope. The 46 `auth`/`storage`/`realtime`/`vault` tables are excluded. |
| 7 | Not touched by the hosted auth workflow | Register classes ACTIVE and DEPENDENCY (03), plus any table named in `.github/workflows/auth-integrity.yml`, `tests/auth/*` or `scripts/*e2e*` (18 files). |

Empty or inactive is never sufficient on its own.

**Difference from 06.** Report 06 counted a table defined in `baseline.sql` as *recoverable*. This bar counts it as *canonical*, which disqualifies it. All 14 tables deleted on 2026-11-26 were `baseline.sql` tables, so none of them would qualify under this bar. They are **not** reopened; see §5.

### Parser and grep controls

- `scripts/selftest-parse.js`: 8 positive and negative cases pass. These cover the `public.`, quoted, unqualified, `UNLOGGED`, `IF NOT EXISTS` and `RENAME TO` forms, and reject `auth.` tables, `SELECT` statements and `CREATE INDEX`.
- On `baseline.sql` the parser finds 824 names. A plain line grep finds 823. The one extra name is `_claim_batch`, a temporary table inside a function body, which is not an E2E table.
- **Branch-grep control.** A first `xargs git grep` run returned **0** lines for a table that `origin/main` demonstrably contains. That run was discarded as a failed control. The batched rerun (`scripts/branch-grep.sh`) hits `origin/main` in 3 files and is the one used.

## 2. Reconciliation of counts

| Measure | Value | Source |
|---|---|---|
| `public` tables now (live) | **850**, all `relkind r` | `a02` / `a01` |
| Expected | 864 before cleanup − 14 deleted = 850 | 05, 06 |
| `public` views / matviews / functions | 37 / 0 / 171 (unchanged from 06) | `a02` |
| Non-public tables | 46 (`auth` 27, `storage` 10, `realtime` 8, `vault` 1) | `a02` |
| Register classes of the 850 | UNKNOWN 798, HISTORICAL 19, DEPENDENCY 23, ACTIVE 10 | 02 CSV |
| Tables with rows | 2: `capability_audit_log` 3,211, `api_idempotency_keys` 2 (unchanged since 05) | `a01` |
| Tables with recorded writes | 26 (same set and counts as 05) | `a01` |
| Created by `baseline.sql` | **809** | `repo-scan.json` |
| Not in baseline but created by a repository migration | **41**: 39 by a migration on `origin/main`; 2 (`prospect_lists`, `prospect_list_members`) by `20261127000000_pi_prospect_lists.sql`, which is on origin branches and in the integration working tree. 09 and 12 showed that production has both. | `repo-scan.json` |
| Created by neither | **0** | |

## 3. Classification

Each table has one primary class, taken in the order below, plus every other reason that applies. **No table has fewer than two retain reasons.**

| Class | Primary (exclusive) | Any (non-exclusive) |
|---|---|---|
| HAS_ROWS | 2 | 2 |
| WRITES_RECORDED | 24 | 26 |
| AUTH_WORKFLOW (03 ACTIVE/DEPENDENCY, or named by the auth workflow files) | 27 | 35 |
| HISTORICAL (07) | 0 | 19 |
| CANONICAL_BASELINE (in `baseline.sql`) | 757 | 809 |
| MIGRATION_CREATED (a repository migration creates it) | 40 | 603 |
| DB_DEPENDENCY | 0 | 555 (FK out 461, FK in 171, function body 120, view 38, policy on another table 1; publication / inheritance / other 0) |
| CODE_REFERENCED (non-schema working-tree file) | 0 | 849 |
| BRANCH_REFERENCED (checked only where the working tree had none) | 0 | 1 |
| **RETAIN total** | **850** | |
| **DELETE-CANDIDATE** | **0** | |

Most common combinations:

| Reasons | Tables |
|---|---|
| CANONICAL_BASELINE + MIGRATION_CREATED + DB_DEPENDENCY + CODE_REFERENCED | 352 |
| CANONICAL_BASELINE + MIGRATION_CREATED + CODE_REFERENCED | 163 |
| CANONICAL_BASELINE + DB_DEPENDENCY + CODE_REFERENCED | 124 |
| CANONICAL_BASELINE + CODE_REFERENCED | 117 |
| MIGRATION_CREATED + DB_DEPENDENCY + CODE_REFERENCED | 29 |

Per table: `phase3/A/out/e2e-table-disposition.csv` (850 rows) and `classification.json`.

### Closest-to-candidate tables

These are recorded because they come nearest to the bar. None qualifies.

- **"Quiet" tables:** empty, no writes, no database dependency, not auth or historical. There are **291** (280 in the baseline, 11 created by a main migration). Every one fails condition 4, and all but one also fail condition 3.
- **`community_ai_execution_metrics_daily`** is the only table with no non-schema hit in the working tree. Its only working-tree hits are `baseline.sql` and 2 migrations (`20260525_community_ai_execution_phase4.sql`, `20260526_phase5_product_hardening.sql`). It still fails three conditions:
  - it is in `baseline.sql`;
  - 1 E2E function body mentions it;
  - it is named in `backend/db/tenantTables.ts` on 36 origin branches (`integration/tenancy-seam-s1*`, `integration/s2-55-content-creator*`, `integration/s2-e1*`, `integration/rel-*`), which is stranded-line code.
- **`free_credit_events`** is the only quiet table with no runtime-code hit. It is named by 1 test, by `baseline.sql` and by 4 migrations.

## 4. Candidate list

**None.** No recovery export was needed, so no definition was exported. `phase3/A/drop-candidates.sql` records the result. It keeps the 06-style atomic `DO` block (lock in `ACCESS EXCLUSIVE` mode, re-count, abort on any non-empty table, `DROP … RESTRICT`) commented out and with an empty array.

## 5. The 14 tables deleted on 2026-11-26

`activity_class_economics`, `ai_model_versions`, `attribution_summary_cache`, `content_generation_budget`, `credential_rotation_attempts`, `expected_event_definitions`, `external_api_usage_logs`, `incident_events`, `ip_org_creations`, `job_idempotency_keys`, `orchestration_attempts`, `pending_invite_unlocks`, `sync_jobs`, `webhook_events`.

They were deleted 2026-11-26T14:36:56Z and are confirmed absent: the live count is 850. Criteria, SQL, recovery export and verification are in [06](../../../omnivyra-e2e-retirement-20261126/docs/supabase-e2e-retirement/06-e2e-table-cleanup-report.md) (`C:/tmp/omnivyra-e2e-retirement-20261126/docs/supabase-e2e-retirement/`).

They are not reopened. Note for the record: under this report's stricter condition 4 they would have been RETAIN, because they are `baseline.sql` tables and therefore canonical production schema. Their recovery source remains `baseline.sql` plus `evidence/live-20261126/recovery-export-deleted-tables.json`.

## 6. Retained-table classes (summary)

| Group | Tables | Disposition (07) |
|---|---|---|
| Hold rows | 2 | ARCHIVE then EXCLUDE (data); retain schema |
| Auth workflow (ACTIVE 10 + DEPENDENCY 23 + named-by-workflow) | 35 | RETAIN until the hosted auth job is replaced |
| HISTORICAL (service_role seed-and-clean harness, 07 §2) | 19 | RETAIN schema; EXCLUDE data |
| Canonical schema, empty, no E2E activity | the remainder (UNKNOWN 798, of which 796 are baseline or main-migration tables and 2 are on the 20261127000000 line) | RETAIN schema; EXCLUDE data |
| Platform (`auth`, `storage`, `realtime`, `vault`) | 46 | out of scope; RETAIN |

The groups overlap. For example, `api_idempotency_keys` is both a row-holder and HISTORICAL, and `capability_audit_log` is both a row-holder and ACTIVE.

## 7. Residue relevant to production

Only 2 E2E `public` tables hold rows. Observed counts are unchanged since the 05 inspection, so the hosted auth suite has not run since 14:33 UTC.

| Table | Rows | Writes (ins/upd/del) | Content | Production action |
|---|---|---|---|---|
| `capability_audit_log` | 3,211 | 3,211 / 0 / 0 | append-only audit of **test** identities from the hosted auth suite | **Do NOT migrate.** Archive (export with hash) before decommission, then exclude (07 §8). Mixing it into the production audit log would corrupt the real audit trail. |
| `api_idempotency_keys` | 2 | 2 / 4 / 0 | two `failed`/403 `activity-workspace-unschedule` test requests (07 §4) | **Do NOT migrate.** The 07 record is the archive; exclude. |

Every other `public` table is empty. Nothing in E2E `public` is a source for production data or schema; production and the repository remain the source of truth (07 Decision; 09/12 confirm production has the six formerly "E2E-only" tables). No row values were read in this phase.

## 8. Limitations

- **Branch coverage.** The branch scan covers the `refs/remotes/origin/*` refs present in `C:/virality` (remote `kulrashm-jpg/Omnivyra`) at scan time. It was not fetched first. Refs that exist only on `drishiq2-creator/Omnivyra`, or local-only branches in other worktrees, are not covered. This cannot create a candidate: every table already fails condition 4 on `origin/main` or the working tree.
- **Word matching.** Tokens are `[A-Za-z0-9_]+`. Table names built dynamically (string concatenation) would be missed, but that could only lower hit counts, and the decision does not rest on them.
- **Write statistics.** These cover only the period since the tables were recreated at the 11-08 refresh (05). Statistics were never reset.
- **Sequential scans.** Scans include this and earlier inspections' `count(*)` and are not evidence of use.
- **Scope.** Platform schemas were not classified.

## Evidence (scratch, not in the repository)

`C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/A/`:

| Kind | Files |
|---|---|
| SQL | `sql/a01-public-tables.sql`, `sql/a02-session-stats.sql` |
| Live results | `out/a01-public-tables.json` (sha256 `c9b0b2df…`), `out/a02-session-stats.json` (`8fe5d77d…`) |
| Repository evidence | `out/repo-scan.json`, `out/auth-workflow-mentions.json`, `out/branch-hits.json`, `out/branch-grep-community_ai_execution_metrics_daily.txt`, `out/main-migrations.txt` |
| Classification | `out/classification.json`, `out/e2e-table-disposition.csv` |
| Scripts | `scripts/repo-scan.js`, `scripts/selftest-parse.js`, `scripts/branch-grep.sh`, `scripts/classify.js` |
| Candidate SQL | `drop-candidates.sql` (no executable statement) |
| Audit log | `phase3/e2e-ro/audit.log`, entries `a02-session-stats.sql` (HTTP 201) and `a01-public-tables.sql` (HTTP 201) |
