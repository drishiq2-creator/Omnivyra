# 03 — Active table list

The source of truth is [02-table-usage-register.csv](02-table-usage-register.csv), regenerated on 2026-11-26 from the **live E2E catalog** ([05](05-live-e2e-inspection-report.md)). The tables below are generated from it.

## Counts (live)

| Classification | Tables | Detail |
|---|---|---|
| **ACTIVE** | **16** | 10 `public` + 6 `auth` (`users`, `identities`, `sessions`, `refresh_tokens`, `one_time_tokens`, `mfa_amr_claims`) |
| **DEPENDENCY** | **63** | 23 `public` + 40 Supabase platform-managed (`auth`, `storage`, `realtime`, `vault`) |
| **HISTORICAL** | **19** | Past writes by an unknown actor or a documented past E2E operation; includes `api_idempotency_keys` (2 rows) |
| **UNUSED** | **14** | All **deleted** 2026-11-26 (see [06](06-e2e-table-cleanup-report.md)) |
| **UNKNOWN** | **798** | Empty, no writes, but not conclusively unused (see [04](04-unused-table-list.md)) |
| **Total** | **910** | 864 `public` (850 after cleanup) + 46 platform |

## Changes from the static Phase 2 register

- **`auth.audit_log_entries`:** ACTIVE → DEPENDENCY. It has **0 writes**, so auth audit logging does not record in this project.
- **`auth.mfa_amr_claims`:** added as ACTIVE (3,137 inserts and deletes).
- **The 46 post-baseline tables are resolved:** 35 are present and classified; 11 are absent from E2E and removed from the register (listed in 05).
- **6 tables** absent from the baseline and from the post-baseline set are added as UNKNOWN. These were first reported as "E2E-only". [07](07-retained-table-disposition.md) §3 corrects that: all six have repository migrations, 4 on `main` and 2 on the unmerged stranded line.
- **17 tables became HISTORICAL** on live write evidence, joining the 2 ENG-004 tables.
- **Row counts:** exact `count(*)` for every `public` table, and statistics estimates for platform tables.

## Classification rules

- **ACTIVE:** read or written by a current E2E activity on a verified code path, and consistent with the live statistics.
- **DEPENDENCY:** a foreign-key target of an ACTIVE table; a cascade or blocking-FK child of the cleanup deletes; touched on a conditional path; or Supabase platform-managed.
- **HISTORICAL:** live statistics show past writes that no current activity explains, a documented past E2E operation, or retained data of unassessed value.
- **UNUSED:** every condition in [06](06-e2e-table-cleanup-report.md) holds: empty, no writes, no code mention, no view, function or policy dependency, and no foreign key from a retained table.
- **UNKNOWN:** everything else, with the reason given per table.

## ACTIVE tables (16)

| # | Table | Live rows | Writes recorded (ins / upd / del) | E2E activity | Operations | Code evidence | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | `public.auth_sessions` | 0 | 1575 / 1050 / 1575 | ACT-02 suite via app | INSERT, SELECT, UPDATE | SessionAuthorityService.ts:167, :268 | HIGH |
| 2 | `public.capability_assignments` | 0 | 0 / 0 / 0 | ACT-02 (logout) | SELECT | CapabilityService.ts:64 | HIGH |
| 3 | `public.capability_audit_log` | 3211 | 3211 / 0 / 0 | ACT-02 suite via app; ACT-03 cleanup (count) | INSERT (append-only), SELECT count | SecurityAuditService.ts:148; e2eIdentityCleanup.ts:120 | HIGH |
| 4 | `public.signup_intents` | 0 | 0 / 0 / 0 | ACT-02 (verification) | SELECT, UPDATE (normally 0 rows) | signupEventService.ts:156; verify-email.ts:198 | HIGH |
| 5 | `public.stepup_sessions` | 0 | 0 / 0 / 0 | ACT-02 (logout) | SELECT, UPDATE (normally 0 rows) | StepUpSessionService.ts:151; IdentityResolver.ts:173 | HIGH |
| 6 | `public.totp_factors` | 0 | 0 / 0 / 0 | ACT-02 (logout, re-login) | SELECT | IdentityResolver.ts:113 | HIGH |
| 7 | `public.trusted_devices` | 0 | 0 / 0 / 0 | ACT-02 (logout) | SELECT | IdentityResolver.ts:224 | HIGH |
| 8 | `public.user_company_roles` | 0 | 4 / 0 / 4 | ACT-02 | SELECT | post-login-route.ts:122; IdentityResolver.ts:75 | HIGH |
| 9 | `public.users` | 0 | 1404 / 1105 / 1404 | ACT-02 suite via app; ACT-03 cleanup | SELECT, INSERT, UPDATE, DELETE | sync-supabase-user.ts:356; verify-email.ts:169; e2eIdentityCleanup.ts:130 | HIGH |
| 10 | `public.webauthn_credentials` | 0 | 0 / 0 / 0 | ACT-02 (logout, re-login) | SELECT | IdentityResolver.ts:108 | HIGH |
| 11 | `auth.identities` | 1 (statistics estimate) | 2796 / 1032 / 2796 | ACT-02/ACT-03 (auth admin API and GoTrue) | created/removed with each auth user | Supabase Auth (GoTrue) | HIGH |
| 12 | `auth.mfa_amr_claims` | 12 (statistics estimate) | 3137 / 0 / 3137 | ACT-02/ACT-03 (auth admin API and GoTrue) | authentication-method claims recorded per session | Supabase Auth (GoTrue) | HIGH |
| 13 | `auth.one_time_tokens` | 0 (statistics estimate) | 1038 / 0 / 1038 | ACT-02/ACT-03 (auth admin API and GoTrue) | signup links from generateLink(signup) | Supabase Auth (GoTrue) | HIGH |
| 14 | `auth.refresh_tokens` | 12 (statistics estimate) | 3137 / 0 / 3137 | ACT-02/ACT-03 (auth admin API and GoTrue) | issued with each session | Supabase Auth (GoTrue) | HIGH |
| 15 | `auth.sessions` | 12 (statistics estimate) | 3137 / 0 / 3137 | ACT-02/ACT-03 (auth admin API and GoTrue) | GoTrue sessions from sign-in/verify; removed on sign-out/deleteUser | Supabase Auth (GoTrue) | HIGH |
| 16 | `auth.users` | 1 (statistics estimate) | 2796 / 13623 / 2796 | ACT-02/ACT-03 (auth admin API and GoTrue) | admin createUser/generateLink/listUsers/deleteUser; GoTrue sign-in, verify, sign-out | Supabase Auth (GoTrue) | HIGH |

## DEPENDENCY tables (63: 23 public + 40 platform-managed)

| # | Table | Live rows | Why it is a dependency | Confidence |
|---|---|---|---|---|
| 1 | `public.auth_audit_logs` | 0 | Conditional path only (login rate limiter without Redis) | HIGH |
| 2 | `public.block_templates` | 0 | NO ACTION FK to users: a referencing row would block the cleanup delete | HIGH |
| 3 | `public.campaign_cost_breakdown` | 0 | NO ACTION FK to users: a referencing row would block the cleanup delete | HIGH |
| 4 | `public.companies` | 0 | FK target of users(active_company_id) and others; conditional schema probe (limit 0) | HIGH |
| 5 | `public.company_join_requests` | 0 | NO ACTION + CASCADE FKs to users | HIGH |
| 6 | `public.free_credit_claims` | 0 | ON DELETE CASCADE child of users | HIGH |
| 7 | `public.free_credit_profiles` | 0 | ON DELETE CASCADE child of users | HIGH |
| 8 | `public.free_credit_unlocks` | 0 | ON DELETE CASCADE child of auth.users | HIGH |
| 9 | `public.intelligence_role_assignments` | 0 | ON DELETE CASCADE child of users | HIGH |
| 10 | `public.notifications` | 0 | ON DELETE CASCADE child of auth.users | HIGH |
| 11 | `public.opportunity_assignments` | 0 | ON DELETE CASCADE child of users | HIGH |
| 12 | `public.prospect_accounts` | 0 | FK target of unified_persons | HIGH |
| 13 | `public.recovery_codes` | 0 | ON DELETE CASCADE child of users | HIGH |
| 14 | `public.report_automation_configs` | 0 | ON DELETE CASCADE child of users | HIGH |
| 15 | `public.report_automation_events` | 0 | ON DELETE CASCADE child of users | HIGH |
| 16 | `public.report_notification_events` | 0 | ON DELETE CASCADE child of users | HIGH |
| 17 | `public.strategy_templates` | 0 | ON DELETE CASCADE child of users | HIGH |
| 18 | `public.super_admin_audit_logs` | 0 | ON DELETE CASCADE child of users (immutable-delete trigger) | HIGH |
| 19 | `public.system_anomalies` | 0 | Conditional path only (login rate limiter without Redis) | HIGH |
| 20 | `public.unified_persons` | 0 | FK target of users(unified_person_id) | HIGH |
| 21 | `public.user_override` | 0 | ON DELETE CASCADE child of auth.users | HIGH |
| 22 | `public.user_preferences` | 0 | ON DELETE CASCADE child of users | HIGH |
| 23 | `public.webauthn_challenges` | 0 | ON DELETE CASCADE child of users | HIGH |

Platform-managed (Supabase; never cleanup candidates): **auth** (21): `audit_log_entries`, `custom_oauth_providers`, `flow_state`, `instances`, `mfa_challenges`, `mfa_factors`, `mfa_recovery_code_sets`, `mfa_recovery_codes`, `oauth_authorizations`, `oauth_client_states`, `oauth_clients`, `oauth_consents`, `saml_providers`, `saml_relay_states`, `schema_migrations`, `scim_tokens`, `scim_users`, `sso_domains`, `sso_providers`, `webauthn_challenges`, `webauthn_credentials`; **realtime** (8): `messages`, `messages_2026_08_17`, `messages_2026_08_18`, `messages_2026_08_19`, `messages_2026_08_20`, `messages_2026_08_21`, `schema_migrations`, `subscription`; **storage** (10): `bucket_lifecycle_states`, `buckets`, `buckets_analytics`, `buckets_vectors`, `lifecycle_abandoned_artifacts`, `migrations`, `objects`, `s3_multipart_uploads`, `s3_multipart_uploads_parts`, `vector_indexes`; **vault** (1): `secrets`.

## HISTORICAL tables (19)

| # | Table | Live rows | Writes recorded (ins / upd / del) | Evidence | Confidence |
|---|---|---|---|---|---|
| 1 | `public.api_idempotency_keys` | 2 | 2 / 4 / 0 | live statistics show past writes (ins 2, upd 4, del 0) since the 2026-11-08 refresh that no current activity explains (actor unknown); holds 2 rows (retained; value of the data not assessed) | MEDIUM |
| 2 | `public.attested_engagement_identities` | 0 | 2 / 2 / 2 | live statistics show past writes (ins 2, upd 2, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 3 | `public.audit_export_jobs` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 4 | `public.author_identity_links` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 5 | `public.campaign_versions` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 6 | `public.campaigns` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 7 | `public.canonical_leads` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 8 | `public.canonical_users` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 9 | `public.daily_content_plans` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 10 | `public.engagement_messages` | 0 | 4 / 0 / 4 | ENG-004 one-off read-only count on E2E (docs/pmo/ENG-004-IMPLEMENTATION-REPORT.md:171-173); live statistics show past writes (ins 4, upd 0, del 4) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 11 | `public.engagement_threads` | 0 | 4 / 0 / 4 | ENG-004 one-off read-only count on E2E (docs/pmo/ENG-004-IMPLEMENTATION-REPORT.md:171-173); live statistics show past writes (ins 4, upd 0, del 4) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 12 | `public.investigation_workspace_items` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 13 | `public.investigation_workspaces` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 14 | `public.lead_intelligence_profiles` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 15 | `public.lead_signals` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 16 | `public.opportunity_feed_items` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 17 | `public.opportunity_items` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 18 | `public.outreach_tasks` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
| 19 | `public.reports` | 0 | 2 / 0 / 2 | live statistics show past writes (ins 2, upd 0, del 2) since the 2026-11-08 refresh that no current activity explains (actor unknown) | MEDIUM |
