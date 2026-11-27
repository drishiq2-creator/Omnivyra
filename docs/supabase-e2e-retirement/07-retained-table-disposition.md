# 07 — Retained-table disposition

**Scope:** the 850 tables remaining in `lomndxmrpyudaegddpef` after the 14 deletions in [06](06-e2e-table-cleanup-report.md), plus the 46 Supabase platform tables.
**Method:** live read-only queries (no writes) together with repository and git-history evidence. **No deletions, migrations or production access** were made in this task.
**New read-only queries:** `evidence/live-20261126/sql/q13`–`q16`; results are in `evidence/live-20261126/disposition/`.

## 1. Final classification totals

| Classification | Tables | Change from 06 |
|---|---|---|
| ACTIVE | 16 | — |
| DEPENDENCY | 63 | — |
| HISTORICAL | 19 | — |
| UNUSED | 14 (deleted) | — |
| UNKNOWN | 798 | — (origins corrected for 6 tables; see §3) |
| **Total** | **910** | |

| Disposition (new `disposition` column in [02](02-table-usage-register.csv)) | Tables |
|---|---|
| RETAIN schema; EXCLUDE data | 842 |
| RETAIN (platform-managed) | 46 |
| RETAIN (canonical; baseline gap) | 4 |
| RECREATE IN REPOSITORY | 2 |
| ARCHIVE then EXCLUDE | 2 |
| DELETED | 14 |

**No class changes were made.** The evidence supports only *corrections*: origins, the 20-versus-19 count, and two auth-table findings already made in 05. Every UNKNOWN table that is still UNKNOWN lacks evidence for a confident reclassification; see §6.

## 2. The 20-versus-19 reconciliation

The figure "20" in [01](01-e2e-activity-inventory.md) (2026-11-26 live section) was a **miscount**. The live statistics, re-read from `pre-cleanup/q03-public-tables.json`, show:

| Group | Tables | Names | Register class |
|---|---|---|---|
| Recorded writes, **all** | **26** | — | — |
| ...explained by the auth suite | 3 | `users`, `auth_sessions`, `capability_audit_log` | ACTIVE |
| ...**not** explained by any current activity | **23** | the 19 below, plus `companies`, `user_company_roles`, `prospect_accounts`, `unified_persons` | 19 HISTORICAL + 4 others |
| HISTORICAL | **19** | `api_idempotency_keys`, `attested_engagement_identities`, `audit_export_jobs`, `author_identity_links`, `campaign_versions`, `campaigns`, `canonical_leads`, `canonical_users`, `daily_content_plans`, `engagement_messages`, `engagement_threads`, `investigation_workspace_items`, `investigation_workspaces`, `lead_intelligence_profiles`, `lead_signals`, `opportunity_feed_items`, `opportunity_items`, `outreach_tasks`, `reports` | HISTORICAL |
| Unexplained writes but a higher class | 4 | `companies` (DEPENDENCY: FK target), `prospect_accounts` (DEPENDENCY), `unified_persons` (DEPENDENCY), `user_company_roles` (ACTIVE: the suite reads it) | ACTIVE / DEPENDENCY |

So 23 tables have unexplained writes: 19 HISTORICAL plus 4 whose higher classification takes precedence. Every HISTORICAL table has recorded writes; none is HISTORICAL on documentary evidence alone. 01 is corrected accordingly.

### Who made the unexplained writes (new evidence)

`pg_stat_statements` (stats reset 2026-09-13) attributes **every** write to these 23 tables to role **`service_role` through PostgREST**: the `WITH pgrst_source AS (INSERT …)` statement shape. That means a Supabase client using the E2E service key.

The statements form seed-then-clean pairs:
- inserts are matched by deletes such as `DELETE … WHERE id = ANY($1) AND company_id = ANY($2)`;
- there is a name-prefix cleanup, `DELETE FROM companies WHERE id = ANY($1) AND name LIKE $2`.

Calls since 2026-09-13 include, for example: `user_company_roles` 27 inserts / 16 deletes, `companies` 19 / 17, `engagement_messages` 23 / 8, `attested_engagement_identities` 14 inserts and 6 updates. Per-table counts are in `disposition/q13-writers.json`.

**The harness is not on canonical `main`:**
- no `.like('name', …)` cleanup exists anywhere in the tracked repository;
- the realschema suite connects directly to Postgres, not through PostgREST;
- no script or test on `main` inserts into these tables.

It is therefore an ad-hoc or branch-only integration harness. It ran both before and after the 2026-11-08 refresh: `pg_stat_statements` counts exceed the post-refresh table statistics. **Its rows were all cleaned up** except the 2 `api_idempotency_keys` rows (§4). **Confidence:** HIGH on role and mechanism; actor identity UNKNOWN.

## 3. The six formerly "E2E-only" tables: corrected

The label was wrong. All six have repository definitions, and each live column set is **identical** to its migration (`compare-defs.js`). Full live definitions are in `disposition/q14-e2e-only-defs.json`.

| Table | Origin | Live state | Code use | Diagnosis | Decision | Confidence |
|---|---|---|---|---|---|---|
| `content_performance` | `supabase/migrations/20260718000003_content_learning_performance.sql` (on `main`; Writer content platform, commit `a28e56f9`, 2026-07-18) | 0 rows, 0 writes; RLS; 1 company-scoped policy; 4 indexes | 29 files, e.g. `backend/services/content/performanceIntelligence.ts`, `learningEngine.ts` | **Canonical schema, missing from the baseline.** The migration's version is below `ledgerMax 20260916000000`, but `baseline.sql` (a production dump) lacks the table. CI replays apply only migrations above `ledgerMax`, so **CI stacks never create it**. Its sibling `publication_lineage` from the same migration *is* in the baseline. | **RETAIN.** Fix the baseline gap: regenerate the baseline or include this migration in replays. | HIGH |
| `content_prediction` | same migration | 0 rows, 0 writes | 6 files (`backend/services/content/predictionEngine.ts`, …) | same | RETAIN; baseline gap | HIGH |
| `learning_intelligence` | same migration | 0 rows, 0 writes | 13 files | same | RETAIN; baseline gap | HIGH |
| `learning_memory` | same migration | 0 rows, 0 writes; trigger `learning_memory_set_updated_at` | 14 files | same | RETAIN; baseline gap | HIGH |
| `prospect_lists` | `supabase/migrations/20261127000000_pi_prospect_lists.sql`, sha256 prefix `01315600d26291f7`. **Only on the unmerged stranded line** (latest commit `5ce2ced7f`, CI-only branches `ci-push/expand-compat-*`). Table comment "PI LISTS-001". | 0 rows, 0 writes; 1,412 sequential scans are FK checks from the suite's `users` deletes (`created_by_user_id` has no index) | none on `main`; designed in `docs/pmo/prospect-intelligence/PI-MILESTONE-A-CLOSURE-AUDIT-001.md`, which says the migration was "unapplied everywhere (UNVERIFIED)" | **Missing functionality on `main`, applied out of band.** E2E has it, so it was applied to production before the 11-08 refresh or to E2E directly; which one is unknown. | **RECREATE IN REPOSITORY** by landing the stranded line (its owner-approved direction). Retain in E2E. Verify production before migration. | HIGH (origin); MEDIUM (where applied) |
| `prospect_list_members` | same stranded-line migration; comment "PI LISTS-001 … erasure cleanup is an open policy decision" | 0 rows, 0 writes; 2,820 sequential scans are FK checks (two unindexed `users` columns × 1,404 deletes) | `backend/tests/realschema/setup.ts:141` | same | **RECREATE IN REPOSITORY**; retain | HIGH / MEDIUM |

None of the six was deleted.

## 4. `api_idempotency_keys` (2 rows)

Projection (`disposition/q16-idem-rows.json`) shows no secret or payload. Keys and caller IDs are shown only as md5 prefixes; response bodies only as key names.

| Field | Row 1 | Row 2 |
|---|---|---|
| `scope` | `activity-workspace-unschedule` | `activity-workspace-unschedule` |
| `status` / `response_status` | `failed` / 403 | `failed` / 403 |
| idempotency key | same key (md5 `3427a6dc…`, length 21) | same key |
| caller | md5 `7254b340…` | md5 `c43b3bf7…` (a different caller) |
| `request_id`, `request_hash` | present; 64-character hash | present; 64-character hash |
| `last_error` | present (10 characters) | present (10 characters) |
| `response_body` | object with a single key `error` | same |
| `created_at` → `updated_at` | 2026-11-08T15:34:49Z → 15:34:50Z | 2026-11-09T05:06:02Z → 05:06:04Z |
| `locked_at` | null | null |

**Origin:** `pages/api/activity-workspace/[id]/unschedule.ts:333` wraps the handler in `withIdempotency(…, { scope: 'activity-workspace-unschedule' })`. Two different callers reused one key; both were refused with 403. This is consistent with the `service_role` harness exercising the unschedule route's authorisation (2 inserts and 4 updates via PostgREST, per `q13`). The rows appeared just after the 2026-11-08 refresh.

**Expiry and cleanup:**
- `withIdempotency` reclaims only stale `processing` locks (10 minutes, `IDEMPOTENCY_STALE_LOCK_MS`).
- `backend/services/billing/idempotency/apiIdempotencyKeyCleaner.ts` moves stuck `processing` rows to `failed`.
- `idempotencyExpiryJob.ts` runs from `/api/cron/billing-idempotency-expire`. E2E has **no cron**, so it never runs there.
- **Nothing deletes `failed` or `succeeded` rows.** This table has no retention purge in any environment. That is noted as a product gap, not fixed here.

**Value:** none. They are failed, refused test requests carrying no business, audit or operational information beyond what is recorded above.

**Decision:** ARCHIVE then EXCLUDE: keep this record and the projection as the archive; do not migrate the rows. **Confidence:** HIGH.

## 5. HISTORICAL tables (19): decisions

All 19 are now **empty**, except `api_idempotency_keys`. Their past writes came from the `service_role` harness in §2 and were deleted by it. Each is also named by production runtime code, so its schema is canonical and in use in production. "Runtime files" counts production code; "test/script" counts test and script files.

| Table | Rows | Writes (ins / upd / del) | Runtime files | Test/script files | DB dependency | Value of E2E data | Decision |
|---|---|---|---|---|---|---|---|
| `api_idempotency_keys` | 2 | 2 / 4 / 0 | 6 | 15 | none | none (§4) | **ARCHIVE then EXCLUDE** (data); retain schema |
| `attested_engagement_identities` | 0 | 2 / 2 / 2 | 2 | 6 | none | none (deleted test rows) | RETAIN schema; EXCLUDE data |
| `audit_export_jobs` | 0 | 2 / 0 / 2 | 1 | 0 | none | none | RETAIN schema; EXCLUDE data |
| `author_identity_links` | 0 | 2 / 0 / 2 | 2 | 0 | none | none | RETAIN schema; EXCLUDE data |
| `campaign_versions` | 0 | 2 / 0 / 2 | 131 | 93 | none | none | RETAIN schema; EXCLUDE data |
| `campaigns` | 0 | 2 / 0 / 2 | 664 | 258 | view + function | none | RETAIN schema; EXCLUDE data |
| `canonical_leads` | 0 | 2 / 0 / 2 | 49 | 99 | function | none | RETAIN schema; EXCLUDE data |
| `canonical_users` | 0 | 2 / 0 / 2 | 7 | 27 | function | none | RETAIN schema; EXCLUDE data |
| `daily_content_plans` | 0 | 2 / 0 / 2 | 133 | 84 | view + function | none | RETAIN schema; EXCLUDE data |
| `engagement_messages` | 0 | 4 / 0 / 4 | 73 | 40 | function | none (also ENG-004 one-off count) | RETAIN schema; EXCLUDE data |
| `engagement_threads` | 0 | 4 / 0 / 4 | 67 | 48 | view + function | none (also ENG-004 one-off count) | RETAIN schema; EXCLUDE data |
| `investigation_workspace_items` | 0 | 2 / 0 / 2 | 2 | 0 | none | none | RETAIN schema; EXCLUDE data |
| `investigation_workspaces` | 0 | 2 / 0 / 2 | 1 | 0 | none | none | RETAIN schema; EXCLUDE data |
| `lead_intelligence_profiles` | 0 | 2 / 0 / 2 | 3 | 12 | function | none | RETAIN schema; EXCLUDE data |
| `lead_signals` | 0 | 2 / 0 / 2 | 41 | 33 | function | none | RETAIN schema; EXCLUDE data |
| `opportunity_feed_items` | 0 | 2 / 0 / 2 | 25 | 29 | function | none | RETAIN schema; EXCLUDE data |
| `opportunity_items` | 0 | 2 / 0 / 2 | 12 | 7 | none | none | RETAIN schema; EXCLUDE data |
| `outreach_tasks` | 0 | 2 / 0 / 2 | 17 | 30 | none | none | RETAIN schema; EXCLUDE data |
| `reports` | 0 | 2 / 0 / 2 | 449 | 548 | view + function | none | RETAIN schema; EXCLUDE data |

**Confidence:** HIGH that the E2E *data* has no business, audit, security or operational value: the rows no longer exist, apart from §4. HIGH that the *schemas* must be retained: production code uses them.

## 6. The 798 UNKNOWN tables, grouped

Every one is empty in E2E with zero recorded writes. Groupings come from the register's new columns (`canonical_schema`, `runtime_code_files`, `test_or_script_code_files`, `db_dependency`, `functional_family`).

| Dimension | Groups |
|---|---|
| In the canonical schema | **796 yes**; **2 no** (`prospect_lists`, `prospect_list_members`: stranded line only) |
| Required by production functionality (named by runtime code) | **768** named by production runtime code; **13** only by tests or scripts; **17** only by config, SQL or JSON |
| Database dependency | **679** none; **89** mentioned in function bodies; **19** view-dependent; **11** both |
| Migration origin | **758** `baseline.sql`; **34** post-baseline migrations; **4** pre-`ledgerMax` migration absent from the baseline; **2** stranded line only |
| Functional family (name prefix; families of 5 or more) | `company` 45, `campaign` 44, `marketpulse` 38, `content` 32, `creator` 31, `platform` 26, `intelligence` 25, `engagement` 20, `ai` 16, `community` 15, `analytics` 14, `credit` 14, `prospect` 14, … `other` 267. The full mapping is in the CSV. |

**Reclassification:** none was confident enough to make.

- **The 768 runtime-referenced tables** are product schema. For E2E retirement their disposition is clear (RETAIN schema; EXCLUDE data, since every one is empty), but nothing shows E2E *activity* uses them, so the E2E-usage class correctly stays UNKNOWN.
- **The 22 weakest-retention tables** (no production runtime reference and no database dependency) are flagged for a future owner review, **not** for deletion. Each is named by a test, script or configuration file (counts of such files in brackets):

  `active_lead_runs`(4), `ai_model_families`(0; an inbound FK from retained `ai_execution_profile_versions` and `llm_models`), `campaign_strategic_insights`(1), `content_templates_enhanced`(0), `direct_messages`(0), `engagement_insights`(2), `engagement_rules`(0), `expected_event_instances`(3), `free_credit_events`(1), `lead_outreach_plans`(0), `message_replies`(0), `omnivyra_hook_scores`(0), `omnivyra_learning_events`(0), `omnivyra_platform_scores`(0), `omnivyra_trend_rankings`(0), `opportunity_reports`(1), `platform_cost_categories`(0), `prospect_archive_recommendations`(2), `prospect_list_members`(1), `prospect_lists`(0), `seven_days_plan`(0), `whatsapp_media_cache`(0)

  A count of 0 means the name appears only in SQL, JSON, YAML or TOML configuration, not in a test or script.

## 7. Exact retained-table list

All **850** remaining `public` tables and all **46** platform tables are retained in the E2E project until it is decommissioned. The hosted auth job still runs against it on every pull request. The full list with per-table disposition is `02-table-usage-register.csv`, filtered to `live_status = present`. In summary:

| Disposition | Count | Tables |
|---|---|---|
| RETAIN schema; EXCLUDE data | 842 | every present `public` table not listed in the other rows |
| RETAIN (canonical; baseline gap) | 4 | `content_performance`, `content_prediction`, `learning_intelligence`, `learning_memory` |
| RECREATE IN REPOSITORY | 2 | `prospect_lists`, `prospect_list_members` |
| ARCHIVE then EXCLUDE | 2 | `capability_audit_log` (3,211 rows), `api_idempotency_keys` (2 rows) |
| RETAIN (platform) | 46 | `auth` 27, `storage` 10, `realtime` 8, `vault` 1 |

## 8. Recommended future archival or exclusion

| Item | Recommendation | Why | Confidence |
|---|---|---|---|
| `capability_audit_log` data (3,211 rows) | **Archive** (export with a hash) before E2E is decommissioned; **exclude** from any import | Append-only security audit of **test** identities only. Never mix into the production audit log. | HIGH |
| `api_idempotency_keys` data (2 rows) | **Archive** (this record) and **exclude** | Failed test requests (§4) | HIGH |
| `auth` data (1 seed user, 12 sessions and refresh tokens, 1 identity, 12 AMR claims) | **Exclude** | Test identity material | HIGH |
| All other `public` data | **Nothing to migrate** | Every other table is empty | HIGH |
| The 22 weakest-retention tables (§6) | Owner review of whether the *product* still needs them, in **production** and the repository, outside this programme | No production runtime reference and no database dependency; not evidence of non-use in production | MEDIUM |
| `api_idempotency_keys` retention | Product follow-up: add a TTL purge for `failed`/`succeeded` rows | No component deletes them | HIGH |
| Baseline gap (4 tables) | Regenerate `supabase/_schema/baseline.sql` or include `20260718000003` in CI replays | CI and C3 stacks currently lack these tables | HIGH |

## Decision

**No E2E table should be carried into production as data.** After the cleanup, only `capability_audit_log` (test audit) and `api_idempotency_keys` (2 failed test requests) hold any rows. Both should be archived and excluded; every other table is empty.

**No E2E schema needs to be copied either.** E2E's `public` schema is a production clone. Production and the repository remain the source of truth, with two exceptions to resolve **in the repository** before the migration relies on them:
1. `prospect_lists` and `prospect_list_members` (RECREATE IN REPOSITORY): their only definition is on the unmerged stranded line, and whether production has them must be verified.
2. `content_performance`, `content_prediction`, `learning_intelligence` and `learning_memory` (RETAIN; baseline gap): canonical on `main`, but absent from the baseline used by CI replays.

**Retained in the E2E project until decommission:** all 850 `public` tables and 46 platform tables. The hosted auth regression job still uses 16 ACTIVE and 23 DEPENDENCY tables, and the remainder are canonical product schema whose E2E copies are empty.
