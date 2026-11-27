# 05 — Live E2E inspection report

**Project:** `lomndxmrpyudaegddpef` ("omnivyra-e2e"), status `ACTIVE_HEALTHY`, PostgreSQL 17.6, region ap-southeast-1, created 2026-08-17.
**Inspected:** 2026-11-26, 14:33–14:44 UTC. **Production (`klkiseupptzbecbxwrky`) was not accessed.**

## Access method

| Item | Value |
|---|---|
| Endpoint | Supabase Management API: `GET /v1/projects/lomndxmrpyudaegddpef`, `GET …/functions`, and `POST /v1/projects/lomndxmrpyudaegddpef/database/query` |
| Credential | The Supabase CLI's stored account token (Windows credential store, target `Supabase CLI:supabase`). It was passed only to the child process's environment, never printed or written. |
| Safety pins | The client (`evidence/live-20261126` scripts) refuses any URL outside `https://api.supabase.com/v1/projects/lomndxmrpyudaegddpef`, and refuses any request whose URL or SQL contains the production ref. |
| Why not the CLI | `supabase db query` / `--linked` commands mint a temporary login role on the target. The raw query endpoint does not. **No role was created.** |
| Session | `current_user = postgres`, `session_user = postgres`, database `postgres` |
| Statistics | `stats_reset` = never; postmaster started 2026-11-10T04:46:36Z; 910 tables tracked in `pg_stat` |

All inspection queries are read-only `SELECT`s. The exact SQL is in `evidence/live-20261126/sql/q01`–`q10` and `q12`. Raw results are in `evidence/live-20261126/pre-cleanup/` (before the drop) and `post-cleanup/` (after).

## Schemas and platform resources

| Schema | Tables | Views | Functions |
|---|---|---|---|
| `auth` | 27 | 0 | 4 |
| `extensions` | 0 | 2 | 173 |
| `graphql`, `graphql_public`, `pgbouncer` | 0 | 0 | 0 / 1 / 1 |
| **`public`** | **864** (850 after cleanup) | **37** | **171** |
| `realtime` | 8 | 0 | 19 |
| `storage` | 10 | 0 | 24 |
| `vault` | 1 | 1 | 5 |

| Resource | Finding |
|---|---|
| Extensions | `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`, `vector` |
| Storage | **0 buckets, 0 objects** |
| Cron | **no `cron` schema**, so no scheduled jobs |
| Edge Functions | **none** (`GET /functions` returned `[]`) |
| Realtime | `supabase_realtime` publication has **no tables**; `supabase_realtime_messages_publication` covers only `realtime.messages_2026_08_17…21` |
| Event triggers | 6 platform triggers: `issue_graphql_placeholder`, `pgrst_ddl_watch`, `pgrst_drop_watch`, `issue_pg_cron_access`, `issue_pg_net_access`, `issue_pg_graphql_access` |
| Migration history | **no `supabase_migrations` schema**. E2E was never CLI-migrated; its `public` schema came from a production dump. `auth.schema_migrations` (8 rows), `storage.migrations` (17) and `realtime.schema_migrations` (16) are platform ledgers. |

## Supabase Auth

`auth.users` holds 1 row (the seed user). The other non-zero tables: `identities` 1, `sessions` 12, `refresh_tokens` 12, `mfa_amr_claims` 12. All other auth tables are empty, including `audit_log_entries`, `one_time_tokens`, `flow_state` and the MFA, SSO, SAML, OAuth and SCIM tables.

Write statistics confirm the suite's auth traffic:

| Table | Inserts | Deletes | Updates |
|---|---|---|---|
| `auth.users` | 2,796 | 2,796 | 13,623 |
| `auth.identities` | 2,796 | 2,796 | |
| `auth.sessions` | 3,137 | 3,137 | |
| `auth.refresh_tokens` | 3,137 | 3,137 | |
| `auth.mfa_amr_claims` | 3,137 | 3,137 | |
| `auth.one_time_tokens` | 1,038 | 1,038 | |

`auth.audit_log_entries` shows **0 writes**. This corrects the Phase 2 inference that it was ACTIVE.

Public tables with foreign keys to `auth.users`: 5 (3 CASCADE, 2 SET NULL). The 11 auth and storage triggers are all platform triggers on `storage.buckets` and related tables; there are none on `auth`.

## `public` schema

| Measure | Live E2E | Repository baseline (production, `ledgerMax 20260916`) |
|---|---|---|
| Tables | **864** | 823 |
| Present from the baseline | 823 of 823 (none missing) | — |
| From the 46 post-baseline migrations | **35 present; 11 absent** | — |
| Not in the baseline and not in the post-baseline set | **6**. **Corrected in [07](07-retained-table-disposition.md) §3:** `content_performance`, `content_prediction`, `learning_intelligence` and `learning_memory` come from `main` migration `20260718000003` (below `ledgerMax`, absent from the baseline). `prospect_lists` and `prospect_list_members` come from `20261127000000_pi_prospect_lists.sql` on the unmerged stranded line. They were wrongly reported here as "in neither the baseline nor any migration". | — |
| Views | 37 (32 with table dependencies, 52 view-to-table edges) | 37 |
| Functions | 171 | 147 |
| Triggers (non-internal) | 270 | 245 |
| RLS-enabled tables | **864 (all)** | 646 |
| Policies | 616 on 553 tables | 580 |
| Foreign keys touching `public` | 877: 503 CASCADE, 295 SET NULL, 41 RESTRICT, 33 NO ACTION (`public`→`public`); 5 to `auth` | 791 |
| Table owner | `postgres` for all 864 | — |
| Total size | 33.4 MB | — |

The 11 post-baseline tables absent from E2E are `pi_erasure_authorizations`, `person_erasure_requests`, `person_erasure_inventories`, `person_erasure_verifications`, `prospect_import_review_items`, `source_mapping_profiles`, `source_mapping_profile_entries`, `salesnav_member_owner`, `salesnav_member_bindings`, `salesnav_extraction_runs` and `salesnav_daily_quota`. They were created in production after the 2026-11-08 E2E refresh.

### Exact row counts

Exact `count(*)` for every `public` table, through `query_to_xml`, as a single statement:

- **862 of 864 tables are empty.**
- `capability_audit_log`: **3,211** (append-only audit; grows with every suite run).
- `api_idempotency_keys`: **2**.
- **Total: 3,213 rows.**

### Write activity (`pg_stat_user_tables`; never reset; tables recreated at the 2026-11-08 refresh)

**26 `public` tables have recorded writes.** Explained by the auth suite:

| Table | Inserts | Updates | Deletes |
|---|---|---|---|
| `users` | 1,404 | 1,105 | 1,404 |
| `auth_sessions` | 1,575 | 1,050 | 1,575 |
| `capability_audit_log` | 3,211 | 0 | 0 |

**Not explained by any current activity** (actor unknown; classified HISTORICAL):

| Tables | Inserts / deletes |
|---|---|
| `companies`, `user_company_roles`, `engagement_threads`, `engagement_messages` | 4 / 4 |
| `campaigns`, `campaign_versions`, `reports`, `prospect_accounts`, `unified_persons`, `canonical_users`, `canonical_leads`, `lead_signals`, `lead_intelligence_profiles`, `opportunity_items`, `opportunity_feed_items`, `outreach_tasks`, `daily_content_plans`, `investigation_workspaces`, `investigation_workspace_items`, `audit_export_jobs`, `author_identity_links`, `attested_engagement_identities` | 2 / 2 |
| `api_idempotency_keys` | 2 inserts, 4 updates, 2 rows remain |

`companies` also has 2 updates, and `attested_engagement_identities` has 2.

## Grants

Per-table grants are recorded in `pre-cleanup/q03-public-tables.json` (`grants`). The deleted tables' grants are in `recovery-export-deleted-tables.json`.

## Exact commands executed (in order)

| # | Command / SQL file | Result |
|---|---|---|
| 1 | `GET /v1/projects/lomndxmrpyudaegddpef` | HTTP 200, `ACTIVE_HEALTHY` |
| 2 | `GET …/functions` | HTTP 200, `[]` |
| 3 | `q01`–`q09` (session, schemas/extensions/publications/event triggers, public tables with exact counts/stats/PK/grants, FKs, triggers, view dependencies, function-body mentions, policies, auth/storage/cron) | All HTTP 201. The first attempt's results were not saved: an output-folder error occurred after the queries had run. The queries are read-only and were re-run. |
| 4 | `q10-export-delete-set.sql` (full definitions of the 14 candidate tables) | HTTP 201 |
| 5 | `q11-drop-delete-set.sql` (the cleanup; see 06) | HTTP 201 |
| 6 | `q01`–`q09` again into `post-cleanup/`, and `q12-platform-tables.sql` | All HTTP 201 |
