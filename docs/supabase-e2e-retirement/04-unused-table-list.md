# 04 — Unused table list

**Result (live, 2026-11-26):** 14 tables were classified UNUSED, and all 14 have been **deleted** from `lomndxmrpyudaegddpef`. The post-cleanup catalog confirms their absence; the 15 verification checks are in [06](06-e2e-table-cleanup-report.md).

A table was classified UNUSED only when **both** levels were checked:
- **Application level:** the name appears nowhere in tracked code or config, and the table is not ACTIVE, DEPENDENCY or HISTORICAL.
- **Database level:** an exact count of 0, zero recorded writes, no view or function dependency, no policy mentioning it, and no foreign key from a retained table.

Absence from code alone was never enough.

The Phase 2 candidate list of 429 tables is superseded. Live evidence showed that most of those names still appear in tracked code or configuration, or are referenced by functions and views, so they are retained below as UNKNOWN.

## Deleted UNUSED tables (14)

| # | Table | Prior exact rows | Writes recorded | Origin (recovery source) | Evidence | Action |
|---|---|---|---|---|---|---|
| 1 | `public.activity_class_economics` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 2 | `public.ai_model_versions` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 3 | `public.attribution_summary_cache` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 4 | `public.content_generation_budget` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 5 | `public.credential_rotation_attempts` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 6 | `public.expected_event_definitions` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 7 | `public.external_api_usage_logs` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 8 | `public.incident_events` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 9 | `public.ip_org_creations` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 10 | `public.job_idempotency_keys` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 11 | `public.orchestration_attempts` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 12 | `public.pending_invite_unlocks` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 13 | `public.sync_jobs` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |
| 14 | `public.webhook_events` | 0 | 0 / 0 / 0 | repo baseline.sql | Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository. | DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json |

## Retained as UNKNOWN (798): empty, no recorded writes, but not conclusively unused

Every one of these E2E tables is empty and shows no write activity. Each is retained because at least one of the following holds; one table can match several.

| Retention reason | Tables |
|---|---|
| named in N tracked code/config file(s) | 795 |
| mentioned in function body | 100 |
| view dependency | 30 |
| inbound FK from a retained table | 1 |

The per-table reasons are in `02-table-usage-register.csv` (`classification_reason`).
