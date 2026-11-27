# Supabase E2E project retirement

Retirement programme for the hosted E2E Supabase project.

| | |
|---|---|
| Source (to retire) | `lomndxmrpyudaegddpef` ("omnivyra-e2e") |
| Destination | `klkiseupptzbecbxwrky` (production) |
| Repository | `https://github.com/drishiq2-creator/Omnivyra.git` |
| Baseline commit | `2bc52db7a4027c1cf0276017719c821b537f48bf` (`main`, verified with a read-only `git ls-remote` on 2026-11-26) |
| Status | Phases 1–2 complete. **Live verification and safe cleanup done 2026-11-26:** E2E catalog inspected, register reconciled from live data, **14 empty, conclusively unused tables deleted from the E2E project and verified**. Stopped at the migration boundary: nothing migrated to production. |

## Documents

| File | Contents |
|---|---|
| [01-e2e-activity-inventory.md](01-e2e-activity-inventory.md) | Every repository activity that uses, could use, or once used the E2E project, with file, purpose, tables, operations, trigger, activity status, evidence and confidence. |
| [02-table-usage-register.csv](02-table-usage-register.csv) | One row per known or possible E2E table (875 rows): structure, references, E2E activity, classification, reason and confidence. |
| [03-active-table-list.md](03-active-table-list.md) | ACTIVE, DEPENDENCY and HISTORICAL tables with evidence. |
| [04-unused-table-list.md](04-unused-table-list.md) | The 14 UNUSED tables (deleted) with evidence, and why the other 798 empty tables are retained as UNKNOWN. |
| [05-live-e2e-inspection-report.md](05-live-e2e-inspection-report.md) | Live E2E catalog: access method, schemas, exact row counts, write statistics, foreign keys, triggers, functions, views, policies, auth, storage, cron, Edge Functions, migration history, and differences from the baseline. |
| [06-e2e-table-cleanup-report.md](06-e2e-table-cleanup-report.md) | Deletion criteria, the 14 deleted tables, the exact SQL, recovery export, post-cleanup verification, and retained or unresolved tables. |
| [07-retained-table-disposition.md](07-retained-table-disposition.md) | Disposition of the retained tables before migration: the 20-versus-19 reconciliation, the six formerly "E2E-only" tables, the 19 HISTORICAL tables, `api_idempotency_keys`, the UNKNOWN groups, the exact retained list and the final decision. |
| `evidence/live-20261126/` | Raw catalog snapshots (`pre-cleanup/`, `post-cleanup/`), every SQL file executed, the drop result, the recovery export of the deleted tables, and SHA-256 manifests. |

## Method and limits

**Update 2026-11-26:**
- The owner lifted the hosted CLI database-command pause for E2E-only work. The live E2E catalog was then read through the Supabase Management API query endpoint, which creates no login role (see 05).
- Every count and classification in 02–04 now comes from that **live** data.
- The paragraph below describes the original Phase 1–2 method and is kept for history.

- **Phase 1–2 (original): no database was queried.** The hosted Supabase CLI database-command pause is in force, and these phases forbid any connection to, SQL against, or Management API call on either project. Every row count is therefore `UNAVAILABLE`.
- **Table universe.** The E2E project has no catalog export in the repository. The register uses:
  1. `supabase/_schema/baseline.sql`: a schema-only `pg_dump` of **production** (823 `public` tables, `ledgerMax 20260916000000`). E2E's `public` schema was replaced from a production schema dump on 2026-11-08 (operator session record, not in the repository), so this baseline is a strong **proxy**, not the E2E catalog.
  2. 46 tables created by the 104 migrations after the baseline. Whether each exists in E2E depends on whether it existed in production at the 2026-11-08 refresh: **unknown**. (Baseline plus these 104 migrations yields 869 `public` tables: C3 Run 1, GitHub Actions run 45825080632, `schema-verification.txt`.)
  3. 6 Supabase-managed `auth` tables used by the E2E activities.
- **Activity evidence** comes from the source code (each claim checked at the cited `file:line`) and read-only GitHub Actions run metadata.
- **Classification rules** are in [03-active-table-list.md](03-active-table-list.md#classification-rules). No table is UNUSED merely because it is empty, quiet or not named in code.
