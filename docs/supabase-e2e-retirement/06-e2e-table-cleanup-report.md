# 06 — E2E table cleanup report

**Project:** `lomndxmrpyudaegddpef` only. **Executed:** 2026-11-26T14:36:56Z–14:36:58Z. **Result:** 14 empty, conclusively unused `public` tables were dropped. The post-cleanup catalog confirms their absence, and all 15 verification checks pass.

## Selection

A table was dropped only if **every** condition held. Each was evaluated per table (`evidence/live-20261126/pre-cleanup/deletion-candidates-evaluation.json`).

| # | Condition | How it was checked |
|---|---|---|
| 1 | Empty | Exact `count(*)` = 0, and checked again under `ACCESS EXCLUSIVE` lock inside the drop transaction |
| 2 | No write activity | `pg_stat_user_tables` `n_tup_ins` = `n_tup_upd` = `n_tup_del` = 0 |
| 3 | No application, test, CI or script dependency | The table name appears **nowhere** in tracked code or config (whole-word search of all `.ts`/`.tsx`/`.js`/`.cjs`/`.mjs`/`.sql`/`.sh`/`.ps1`/`.py`/`.yml`/`.json`/`.toml` files, excluding only `supabase/migrations` and `supabase/_schema`, which define schema rather than use it) |
| 4 | Not ACTIVE, DEPENDENCY or HISTORICAL | Register classification |
| 5 | No view dependency | `pg_depend` / `pg_rewrite` |
| 6 | No function or trigger dependency | Not mentioned in any function body in any schema (`prosrc` whole-word match) |
| 7 | No policy dependency | Not mentioned in any other table's policy `USING` / `WITH CHECK` |
| 8 | No retained-table foreign key into it | Inbound foreign keys only from other deletion candidates (there were none) |
| 9 | No Auth, Storage or platform dependency | `public` only. No publication membership. No cron, Edge Functions or storage exist. |
| 10 | Recoverable | Definition present in the repository baseline or a migration, plus a full live definition exported |

**Result:** of 864 `public` tables, **14** met every condition. The other 850 were retained. Reasons recorded per table; most tables have more than one:

| Reason | Tables |
|---|---|
| Named in tracked code/config | 847 |
| Mentioned in a function body | 120 |
| View dependency | 38 |
| Static ACTIVE/DEPENDENCY/HISTORICAL | 35 |
| Recorded write activity | 26 |
| Not recreatable from the repository | 6 |
| Has rows | 2 |
| Referenced by a policy on another table | 1 |
| Inbound FK from a retained table | 1 |

**Non-empty tables were not dropped and nothing was exported as data.** Only two `public` tables hold rows:
- `capability_audit_log` (3,211 rows): ACTIVE, append-only audit;
- `api_idempotency_keys` (2 rows): HISTORICAL, retained because the value of its data was not assessed.

## Tables deleted (14)

| # | Table | Prior exact rows | Writes (ins / upd / del) | Scans (seq / idx) | Cols | Constraints | Indexes | Triggers | Policies | FKs out | Recovery source |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `activity_class_economics` | 0 | 0/0/0 | 3/0 | 7 | 3 | 1 | 0 | 0 | — | baseline.sql + export |
| 2 | `ai_model_versions` | 0 | 0/0/0 | 7/0 | 10 | 4 | 4 | 0 | 0 | `llm_models` (CASCADE) | baseline.sql + export |
| 3 | `attribution_summary_cache` | 0 | 0/0/0 | 6/4 | 10 | 3 | 2 | 0 | 1 | `companies`, `websites` (CASCADE) | baseline.sql + export |
| 4 | `content_generation_budget` | 0 | 0/0/0 | 5/0 | 11 | 2 | 3 | 1 | 1 | — | baseline.sql + export |
| 5 | `credential_rotation_attempts` | 0 | 0/0/0 | 4/0 | 6 | 1 | 2 | 0 | 0 | — | baseline.sql + export |
| 6 | `expected_event_definitions` | 0 | 0/0/0 | 5/4 | 8 | 6 | 2 | 0 | 1 | `companies` (CASCADE) | baseline.sql + export |
| 7 | `external_api_usage_logs` | 0 | 0/0/0 | 5/0 | 11 | 4 | 2 | 0 | 0 | `external_api_connections` (SET NULL) | baseline.sql + export |
| 8 | `incident_events` | 0 | 0/0/0 | 6/0 | 8 | 3 | 3 | 0 | 0 | `incidents` (CASCADE) | baseline.sql + export |
| 9 | `ip_org_creations` | 0 | 0/0/0 | 5/0 | 5 | 1 | 3 | 0 | 0 | — | baseline.sql + export |
| 10 | `job_idempotency_keys` | 0 | 0/0/0 | 4/0 | 4 | 1 | 2 | 0 | 0 | — | baseline.sql + export |
| 11 | `orchestration_attempts` | 0 | 0/0/0 | 5/0 | 7 | 1 | 3 | 0 | 0 | — | baseline.sql + export |
| 12 | `pending_invite_unlocks` | 0 | 0/0/0 | 6/0 | 6 | 3 | 4 | 0 | 0 | — | baseline.sql + export |
| 13 | `sync_jobs` | 0 | 0/0/0 | 11/0 | 16 | 5 | 2 | 0 | 1 | `companies` (CASCADE), `website_connections`, `websites` (SET NULL) | baseline.sql + export |
| 14 | `webhook_events` | 0 | 0/0/0 | 12/0 | 13 | 5 | 3 | 0 | 1 | `companies`, `website_connections`, `websites` (SET NULL) | baseline.sql + export |

**Scans are not application use.**
- The sequential scans include this inspection's own exact-count queries (3 per table) plus earlier inspection passes.
- The index scans on `attribution_summary_cache` and `expected_event_definitions` match foreign-key enforcement when 4 `companies` rows were deleted: both reference `companies` ON DELETE CASCADE.
- None of these tables had owned sequences or other dependent objects.

**Recovery:**
- `evidence/live-20261126/recovery-export-deleted-tables.json` holds, for every dropped table, the full live definition: columns with types, defaults, identity and generated flags; constraints (`pg_get_constraintdef`); indexes (`pg_get_indexdef`); triggers (`pg_get_triggerdef`); policies; grants; RLS flags; owner; comment; statistics.
- The original DDL is also in `supabase/_schema/baseline.sql`.
- The tables were empty, so no data needed preserving.
- Hashes: `evidence/live-20261126.pre-drop.sha256` (taken before the drop) and `evidence/live-20261126.final.sha256`.

## Exact SQL executed (the only write)

`evidence/live-20261126/sql/q11-drop-delete-set.sql`, a single atomic `DO` block. It drops in dependency order; there are no foreign keys between candidates. `RESTRICT` makes PostgreSQL refuse any drop that would break a dependent object.

```sql
DO $cleanup$
DECLARE
  t text;
  n bigint;
  tbls text[] := ARRAY['activity_class_economics', 'ai_model_versions', 'attribution_summary_cache', 'content_generation_budget', 'credential_rotation_attempts', 'expected_event_definitions', 'external_api_usage_logs', 'incident_events', 'ip_org_creations', 'job_idempotency_keys', 'orchestration_attempts', 'pending_invite_unlocks', 'sync_jobs', 'webhook_events'];
BEGIN
  SET LOCAL lock_timeout = '10s';
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'table % is not empty (% rows); aborting, nothing dropped', t, n;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TABLE public.%I RESTRICT', t);
  END LOOP;
END
$cleanup$;
-- followed by a read-only check of which of the 14 still exist
```

**Response:** HTTP 201, `{"still_present": [], "public_tables_now": 850}`.

**Removed together with the tables (expected):**
- 12 foreign keys owned by them;
- 1 trigger: `content_generation_budget.trg_content_generation_budget_updated_at` (its function was not dropped);
- 5 policies, all `service_role` full access, on `attribution_summary_cache`, `content_generation_budget`, `expected_event_definitions`, `sync_jobs` and `webhook_events`;
- their indexes and grants.

**Not dropped:** no schema, extension, function, role or platform-managed object.

## Verification (catalog re-queried after the drop)

`evidence/live-20261126/post-cleanup/verification.json`; script `verify.js`.

| Check | Result |
|---|---|
| Exactly the 14 deletion-set tables are gone; no table added | PASS |
| `public` tables 864 → 850 | PASS |
| Every ACTIVE, DEPENDENCY, HISTORICAL and non-empty table is present (36 required tables checked by name) | PASS |
| Row counts of all retained tables unchanged | PASS |
| Foreign keys: 877 → 865 = pre minus the 12 owned by dropped tables. No dropped table was the target of any foreign key. | PASS |
| Triggers: 282 → 281 (only the dropped table's trigger) | PASS |
| Policies: 616 → 611 (only the 5 on dropped tables) | PASS |
| View dependencies identical; function-to-table mentions identical | PASS |
| Function and view counts unchanged in every schema (`public` still 171 functions, 37 views) | PASS |
| Non-public schemas untouched; extensions, publications and event triggers unchanged | PASS |
| Auth, storage and cron state unchanged | PASS |

The first run of the last check reported FAIL. The cause was the verifier comparing an unordered `json_agg` list (11 storage triggers) as an ordered array. Compared as sets, the lists are identical. The comparison was corrected to be order-insensitive and the check re-run; no database state differed.

**The auth regression workflow's tables are all retained:**
- the 10 ACTIVE `public` tables;
- the 23 DEPENDENCY `public` tables;
- the 6 ACTIVE `auth` tables;
- the 2 RPCs (`auth_user_confirmed`, `auth_user_has_password`), since `public` function count is unchanged.

None of the dropped tables is on any traced suite path.

## Unresolved (retained, not deleted)

| Group | Tables | Why not deleted |
|---|---|---|
| UNKNOWN | 798 | Empty with no writes, but named in tracked code (795), mentioned in a function body (100), view-dependent (30), or FK-referenced by a retained table (1, `ai_model_families`). Not conclusively unused. |
| HISTORICAL | 19 | Past writes by a `service_role` seed-and-clean harness (see 07 §2), or a documented past E2E operation. `api_idempotency_keys` holds 2 rows, assessed in 07 §4. |
| Formerly "E2E-only" tables | 6 | **Corrected in [07](07-retained-table-disposition.md) §3:** all six have repository definitions. 4 are in `main` migration `20260718000003` (absent from the baseline); 2 are in `20261127000000_pi_prospect_lists.sql` on the unmerged stranded line. Retained. |

Nothing was migrated to production. No connection string, CI secret, workflow, Supabase setting or production resource was changed.
