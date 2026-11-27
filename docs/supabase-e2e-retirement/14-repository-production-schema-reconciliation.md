# 14 — Repository-to-production schema reconciliation

| | |
|---|---|
| Worktree | `C:\tmp\omnivyra-p3-B`, branch `p3-B/e2e-consolidation`, base main `2bc52db7a` + the 16 uncommitted integration files (unchanged by this task except this document) |
| Date | 2026-11-27 (production reads 2026-11-26 18:53–19:27 UTC) |
| Production | `klkiseupptzbecbxwrky`, **read-only**, authoritative |
| State | Nothing committed, pushed, applied or written anywhere. No forward migration written (§9). |
| Evidence root (`EV/` below) | `C:/tmp/omnivyra-schema-fix-20261126-tools/phase3/B/` — `sql/`, `out/`, `table-map.csv`, `708f0ac4-provenance-correction.patch`, `gatecheck/`, `stranded/`, `runs/r1.log` |
| Builds on | 09 (production facts 2026-11-26), 12 §2/§3/§9, 10, 11; E2E 05/07 and `evidence/live-20261126/post-cleanup/q03-public-tables.json` |

## 0. Verdicts at a glance

| # | Item | Verdict |
|---|---|---|
| 1 | Bulk map, 850 tables retained in E2E | **830 ALIGNED** (42 of them only after excluding named harness artifacts), **5 SAFE FORWARD CORRECTION**, **11 PRODUCTION-ONLY**, **4 UNRESOLVED**. All 850 exist in production and in the repo replay. |
| 2 | The six tables | `prospect_list_members` ALIGNED. `prospect_lists` ALIGNED except `icp_id` + FK = PRODUCTION-ONLY (preserve). The four content tables ALIGNED except the `authenticated=arwdxtm` grant = SAFE FORWARD CORRECTION (owned by Agent D). |
| 3 | `prospect_lists.icp_id` / `prospect_lists_icp_tenant_fk` | **PRODUCTION-ONLY — preserve.** Byte-identical to the original reviewed migration (`72e827b54`+`b30bbddfc`, renumbered by GD-4 `ed7448c4e` to `20270111100007`). Land it with its dependency band through the stranded-line landing, never alone; a re-run against prod is **not** a no-op (§3.5). |
| 4 | Ledger rows `20261127000000` / `20270202000000` | **UNRESOLVED (owner).** Unchanged since 09 (re-read). `20270202000000` is **not on main**; its prod effect is **complete and exact** vs its file. The row contradicts the owner's 2026-11-10 instruction "Do not write a ledger row before the GD-4 band applies". No row to add or remove from the repo side. |
| 5 | `708f0ac4` provenance note | Patch prepared, **not applied**; gate exit 0 with it, `ledger_max`/`digests` unchanged, failing control red. |
| 6 | Preconditions of `20270301000000` and `20270301000001` | **All hold in production.** `20270301000000` is a no-op there (its postcondition already holds, evaluated live). The index name is unused; the table is 90 KB. |
| 7 | Trigger compatibility `20270111000003` | **COMPATIBLE, unchanged.** 75 in prod (74 public + 1 archive), 75 in the replay (75 public). No pending forward migration changes either count. |
| + | New, larger finding (§8) | Production carries **27 tables and several column/constraint/function changes from at least ~30 stranded-line migrations** (matching the 36-migration EXPAND set of `5ce2ced7f`) **with no ledger rows**, and lacks **4 tables + leads changes from main** migrations. |

## 1. Method

### 1.1 Production (read-only)

Client: `phase2/prod-ro/run-prod-ro.ps1` (Management API `database/query/read-only`, `supabase_read_only_user`, single SELECT/WITH, write-keyword guard). Catalog metadata only; no application row values were selected. Audit log `phase2/prod-ro/audit.log`:

| SQL (`EV/sql/`) | HTTP | Output (`EV/out/`) | Purpose |
|---|---|---|---|
| `b01_tables_bulk.sql` | 400 | — | `text \|\| "char"` type error (`polcmd`); fixed with `::text`, tested on the local replay first, then re-sent |
| `b01_tables_bulk.sql` | 201 | `b01_tables_bulk.prod.json` (1.1 MB, 898 tables) | one query, every `public` table: owner, RLS/forced, relacl, column list (name, type, not-null, default), column-ACL count, policies (name/cmd/permissive/roles/md5 of qual+check), triggers (name/enabled/function/md5 of def), indexes (name/md5 of def), constraints (name/type/md5 of def), publications |
| `b03_diff_detail.sql` | 201 | `b03_diff_detail.prod.json` | full text of every differing constraint/index and every column ACL (generated from the diff) |
| `b02_preconditions.sql` | 201 | `b02_preconditions.prod.json` | §6, §4 (`read_at`), §7 |
| `b04_stranded_objects.sql` | 201 | `b04_stranded_objects.prod.json` | §3 / §4: functions (md5 of body, config, ACL, md5 of description), constraints, the `icp_id` column comment |
| `b05_ledger.sql` | 201 | `b05_ledger.prod.json` | §4 (no `rollback` column selected) |
| `b06_effective_privileges.sql` | 201 | `b06_effective_privileges.prod.json` | §6: `has_table_privilege` / `has_any_column_privilege` for the client roles, role memberships |

No CLI, no psql to a hosted host, no `.env*` read, no hosted-E2E call (the E2E table list came from the post-cleanup evidence JSON).

### 1.2 Repository reference (disposable local replay)

`bash heavy.sh B-replay -- bash pg-replay.sh --repo C:/tmp/omnivyra-p3-B --port 55491 --run EV/runs/r1 --gaps --keep` → `RESULT OK replayed=107 public_tables=875 extra=0 gaps=1` (`EV/runs/r1.log`). The same `b01` query was run against it (`EV/out/b01_tables_bulk.local.json`). A copy database `w6s` was used for §3/§4 (stranded files applied there only). The cluster was stopped with `pg_ctl … stop -m fast`, its data directory deleted, port 55491 confirmed closed.

Comparison: `EV/compare.js` → `EV/out/compare.json`; classification and CSV: `EV/map.js` → `EV/table-map.csv` (902 rows: the 850 E2E tables plus prod-only and repo-only tables).

### 1.3 Harness artifacts, identified and excluded

Each is excluded only where the detail proves it (`map.js` checks each case, not by table name):

| Artifact | Why it is not drift | Tables (E2E set) |
|---|---|---|
| `vector(N)` → `real[]` | no pgvector locally (`xform.js`); normalised before comparing columns | (silent) |
| 5 HNSW indexes missing locally | skipped by `xform.js`; all 5 are in repo source (3 in `baseline.sql`, `platform_fp_embedding_idx` in `20260919000000`, `platform_topic_node_embedding_idx` in `20260922000000`) | content_memory, intelligence_signals, signal_clusters, platform_content_fingerprint, platform_topic_node |
| `DEF extensions.uuid_generate_v4()` vs `DEF uuid_generate_v4()` | deparse depends on the session `search_path` (the replay DB has `extensions` on it; the read-only API session does not) | 9 (auth_sessions, capability_*, recovery_codes, stepup_sessions, totp_factors, trusted_devices, webauthn_*) |
| CHECK definitions with a different md5 | dump/restore re-parse: `(ARRAY['a'::varchar,…])::text[]` vs `ARRAY[('a'::varchar)::text,…]`, and `(A AND B) AND C` vs `A AND B AND C`. Equal after removing casts and parentheses (`b03` full text) | 33 constraints on 25 tables |
| `anon=r, authenticated=r` on 5 public-content tables | `baseline.sql` carries **no privileges at all** (0 GRANT lines) and the bootstrap grants clients nothing; prod is the state `20270111000002` deliberately leaves ("Kept: SELECT on public_blogs …, content_type — intentional public") | public_blogs, blog_relationships, blog_series, blog_series_posts, content_type |
| Default ACLs | bootstrap: `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role` only; for the tables in both, relacl still matched in 840 of 850 cases. Function ACLs differ (§3.4) | — |

Consequence: **relacl of a baseline-created table is not a repository fact** (the baseline drops privileges). Where relacl matches, it is because prod's post-hardening state equals the bootstrap default, not because the repo asserts it.

## 2. Task 1 — bulk map (`EV/table-map.csv`)

CSV columns: table, e2e_retained, canonical_source, source_files, refs_{backend,pages,lib,components,hooks,scripts,tests} (files containing the identifier), quoted_refs_total, prod_exists, repo_replay_exists, cols, rls, policies, relacl, col_acl, triggers, indexes, constraints, harness_excluded, classification, note.

**E2E-retained tables: 850.** All exist in prod (prod has 898 `public` tables; 48 are not in E2E) and all in the replay.
- Canonical source: `baseline.sql` 809, a main migration 39 (e.g. the 4 content tables from `20260718000003`, via the gap manifest), stranded-origin integration file 2 (`prospect_lists`, `prospect_list_members` ← `20261127000000`).
- 27 E2E tables have **no reference** in backend/pages/lib/components/hooks/scripts/tests (listed in the CSV; e.g. `ai_content_analysis`, `direct_messages`, `seven_days_plan`, `webhook_logs`). Not a schema finding; recorded for the retention track.

| Classification | E2E tables | Detail |
|---|---|---|
| ALIGNED | 830 | 788 identical on every compared fact; 42 identical after the §1.3 exclusions |
| SAFE FORWARD CORRECTION | 5 | `api_idempotency_keys` (pending index `20270301000001`, §6); `content_performance`, `content_prediction`, `learning_intelligence`, `learning_memory` (`authenticated=arwdxtm` in prod — **Agent D owns the REVOKE migration; not written here**) |
| PRODUCTION-ONLY (preserve) | 11 | `prospect_lists` (§3); `community_ai_actions` (+`acting_member_urn`, `pre_submit_evidence`, `post_submit_evidence`, `submit_attempted_at` ← stranded `20270207000000`; +`uq_community_ai_actions_id_org` ← stranded `20270111100010`); `engagement_message_intelligence`, `engagement_thread_classification` (+`canonical_code`, `classification_vocabulary_version`, `governance_codes` + 3 CHECKs ← stranded `20270125000000`); `community_ai_action_logs` (event_type CHECK widened with `skipped_due_to_platform_policy`, `sent_unverified` ← `20270217000071`, commits `7e7b73b3b`/`df9dc12e7` on `integration/rel-community-ai-action-log-recorded-b/c`, not on main); 6 tables with a **column SELECT for role `omnivyra_pi_inventory_ro`** (`users.id`, `reports.user_id`, `source_assertions.asserted_by_user_id`, `prospect_archive_recommendations.reviewed_by_user_id`, `prospect_lifecycle_transitions.actor_user_id`, `prospect_problem_observations.recorded_by_user_id`) — prod role exists, `LOGIN`, no repo source anywhere (archive: owner-authorised PI inventory role, 2026-11-01) |
| UNRESOLVED | 4 | `rbac_config`: prod `service_role=r` (SELECT only) = the **deferred** `supabase/deferred/rbac_config_contract_legacy_insert.sql` applied out of band; the repo stops at `20261211000001` (SELECT, INSERT). `leads`: repo is **ahead** — main `20270112000001/3/4`, `20270115000000` (person erasure) are not applied in prod (prod `unified_person_id NOT NULL`, no `person_erased_at`, no `trg_leads_person_erasure_guard`, no `leads_person_or_erased`). `opportunity_feed_items.signal_excerpt`: in prod, from **main** `20260818_opportunity_signal_excerpt.sql` — an 8-digit file CI never replays and the baseline lacks; the gap manifest accepts only 14-digit versions, so only a baseline regeneration fixes it. `content_block`: the documented gap-ordering divergence (prod trigger → `set_content_updated_at()`, replay → `omnivyra_touch_updated_at()`; both bodies set `updated_at = now()`). |

Not in E2E: 21 ALIGNED, 27 PRODUCTION-ONLY tables (§8), 4 repo-only tables (`person_erasure_inventories`, `person_erasure_requests`, `person_erasure_verifications`, `pi_erasure_authorizations` — main migrations not applied in prod).

## 3. Task 2 — the six tables

Source: `b01` prod vs replay, `b02`, `b06`.

| Table | Columns | RLS / forced | Policies | relacl | Col ACL | Triggers | Indexes | Constraints | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| prospect_lists | 8 same **+ `icp_id uuid` prod-only** | on / off, same | 1, identical | `{postgres=arwdDxtm, service_role=arwdDxtm}` both | 0 / 0 | 1, identical (`omnivyra_touch_updated_at`) | 3, identical | 5 same **+ `prospect_lists_icp_tenant_fk`** | ALIGNED except the PRODUCTION-ONLY icp column/FK (§3.x below) |
| prospect_list_members | 11 same | on / off | 1, identical | same as above | 0 / 0 | 0 / 0 | 4, identical | 9, identical | **ALIGNED** |
| content_performance | 17 same | on / off | 1, identical | **prod +`authenticated=arwdxtm`** | 0 / 0 | 0 / 0 | 4, identical | identical | ALIGNED except the grant → SAFE FORWARD (Agent D) |
| content_prediction | 11 same | on / off | 1, identical | **prod +`authenticated=arwdxtm`** | 0 | 0 | 3, identical | identical | same |
| learning_intelligence | 9 same | on / off | 1, identical | **prod +`authenticated=arwdxtm`** | 0 | 0 | 3, identical | identical | same |
| learning_memory | 9 same | on / off | 1, identical | **prod +`authenticated=arwdxtm`** | 0 | 1, identical (`set_content_updated_at`) | 1, identical | identical | same |

### 3.x `prospect_lists.icp_id` + `prospect_lists_icp_tenant_fk` (task 3)

**3.1 Origin.** Original reviewed commits (author date 2026-10-28): `72e827b54` "feat(orchestration): canonical lists and campaign targets feed enrollment" (adds `20261231000000_orchestration_campaign_targeting.sql`) + `b30bbddfc` "fix(orchestration): defects found by real-PostgreSQL verification of 72e827b5" (final blob `408f6f82`). Rebased copies: `b2932bf1e`/`b55b52af5`, `ceb8585c7`/`ff0fa1c41`, `549930d2b`/`5836e9cb8`, `10121f83c`/`2ecda1981`, `dab7b966e`/`0fb8f5bfe`. GD-4 renumber `ed7448c4e` (2026-11-10, "owner GO", pure byte-identical moves) turned it into **`20270111100007_orchestration_campaign_targeting.sql`**; on `origin/integration/s-wa-combined` that file is blob `408f6f82`, identical to `b30bbddfc`'s. The commit message records "D1 … none of the 17 is applied, their effects are absent" on 2026-11-10. Not on main. No ledger row for `20261231000000` or `20270111100007` (`b05`).

**3.2 Everything the migration creates is live in prod and identical to applying the file.** Applied `20270111100000`, `…01`, `…02`, `…07` (from `s-wa-combined`) to the copy DB `w6s` (all exit 0; postconditions passed), then compared with prod (`b01` + `b04`):
- `prospect_lists`, `prospect_campaigns`, `prospect_campaign_lists`, `prospect_campaign_targets`, `execution_instances`, `workflows`, `workflow_versions`: **every compared fact identical** (columns, RLS, policies, relacl, triggers, indexes, constraints).
- 46 of 50 object facts byte-equal, including every constraint text (`prospect_lists_icp_tenant_fk` = `FOREIGN KEY (icp_id, organization_id) REFERENCES prospect_icps(id, organization_id)`, NO ACTION, validated, not deferrable), the `icp_id` column comment (md5 `c13203ac…`), `read_at`.
- The 4 differences are function attributes, not the file: prod `prospect_campaigns_targeting_guard()` and `prospect_campaign_targets_guard()` carry `search_path=public, pg_temp` (set by stranded **`20270129000004_guard_functions_search_path.sql`**, also applied out of band), and four guard functions carry `authenticated=X, service_role=X` from prod's postgres default function ACL (harness: the replay has no such default). Bodies (md5) identical.
- No index on `icp_id` exists in prod or in the file.

**3.3 Consumers on every branch** (`git grep -l icp_id` over all 1,015 distinct `refs/remotes/origin` tips, `EV/out/icp_id-files-alltips.txt`): the only code reading or writing `prospect_lists.icp_id` is `backend/services/prospectLists/store.ts` `getListIcp`/`setListIcp` (one blob, `876e5e08d`, on 37 tips: `integration/s-wa-combined*`, `integration/stranded-line-stage0-*`, `integration/s-wa-transport*`, `integration/computed-field-transport*`, `integration/dryrun-preflight`, `integration/s-integration-3`, `integration/s-whatsapp-port-counts`, `integration/stranded-line-trial-merge`, `outreach/whatsapp-governance-integration`), called by `backend/services/prospectLists/icpListEvaluator.ts:83` and `pages/api/prospect-lists/icp.ts:60`. Both map `42703`/`PGRST204` to `targeting_schema_missing`, so they degrade where the column is absent. Other `icp_id` hits (`prospectCampaignStore`, `campaignTargetStore`, `orchestration/icpEvidence.ts`, D1 ICP code on 1,014 tips) are other tables' `icp_id`. **Main has no consumer** (no main app file references `prospect_lists`).

**3.4 Recommendation: PRESERVE.** Dropping it would break the stranded line's list-ICP path and the FK's tenant guarantee; nothing on main is affected by keeping it.

**3.5 How the repo should become canonical.** Per the owner rule (land originals with `cherry-pick -x`; no replacement migration when the original is recoverable — it is):
- Land `72e827b54` + `b30bbddfc` (partial picks: the migration; register the remainder) followed by the GD-4 renumber `ed7448c4e`, **as part of the stranded-line landing** (owner: land `integration/s-wa-combined` before launch; cb leads; MIG-2R), not alone. Its preflight **requires** `prospect_campaigns` (`20270111100000`) and `execution_instances` (`20270111100002`), and its postcondition requires `execution_instances` to have exactly 5 FKs; `…00 → 01 → 02 → 07` is the minimal closure proven on `w6s`.
- **Safe against prod?** Partly. Every preflight object exists in prod (`uq_prospect_lists_id_org`, `uq_prospect_campaigns_id_org`, `uq_prospect_icps_id_org`, `uq_prospect_icp_versions_identity`, `uq_prospect_score_evaluations_id_org`, `idx_canonical_leads_id_company`; no `prospect_list_memberships`), the postcondition counts hold in prod today (5 and 6 FKs), and every DDL is guarded, so a re-run **succeeds**. It is **not a no-op**: `CREATE OR REPLACE FUNCTION` without a `SET` clause **resets** the `search_path` pin that `20270129000004` put on the two guard functions. Proven on `w6s`: pinned before, `proconfig NULL` after the re-run (`EV/stranded/rerun07.out`). It also drops/recreates two triggers and two policies (brief exclusive locks). **So the file must never be re-applied to prod on its own**; because it has no ledger row, any tool that treats "no row" as "pending" (a bulk `db push`) would re-run it. The ledger decision (§4) has to come with the landing.

## 4. Task 4 — ledger rows `20261127000000` and `20270202000000`

**Re-read 2026-11-26 19:19 UTC (`b05`):** ledger **95 rows, 95 distinct, max `20270202000000`** — unchanged from 09. Both rows: `statements` empty, `created_by`/`idempotency_key` NULL, `xmin 3772597`, no later row. No row exists for any `20270111100000…16`, `2027012*`, `2027020[17]*`, `2027021*` version.

**Is `20270202000000` on main?** No. Original commit `144de096e` (2026-11-09, "fix(governance): judge each governance read at its own database instant": the migration + `contactGovernance*` code, tests, a PostgREST CI workflow), blob `a6bd7171e`; on `origin/fix/pi-contact-governance-clock` and 35 `integration/*` tips (incl. `s-wa-combined`); also in `5ce2ced7f` (ci-only). Main's `version-reservations.json` has no entry for it; the GD-4 branch's registry records it as `production_applied: true`, "Applied out-of-band 2026-11-09 via the Management API … DELIBERATELY NO LEDGER ROW … **Do not write a ledger row before the GD-4 band applies.** (owner, 2026-11-10)".

**Is its prod effect complete vs its file?** **Yes, exactly.** The file creates one function and its privileges. Prod `public.read_at(contact_governance_records)` (`b02`/`b04`) vs the file applied to `w6s`: `LANGUAGE sql`, `STABLE`, `SECURITY INVOKER`, not set-returning, returns `timestamptz`, `proconfig {search_path=pg_catalog, pg_temp}`, body md5 `09b8908e…`, description md5 `41d01d20…`, ACL `{postgres=X, service_role=X}` (no PUBLIC/anon/authenticated) — **all equal**. A re-run on `w6s` exits 0 (idempotent).

**Recommendation (no fabricated rows):**
- Do not add, delete or edit any ledger row from this track. The two rows describe migrations that are, in fact, fully applied, so they are not false; what is unknown is who wrote them, and that they went against the 2026-11-10 owner instruction.
- Make the repo hold the files those rows name: `20261127000000` lands via the integration patch (`6a6c3d9b8` partial, 12 §9); `20270202000000` lands by `cherry-pick -x 144de096e` with the stranded-line landing. It sorts above `ledger_max` (`20270111000003`), so the digest gate does not need an attestation for it.
- Owner/MIG-2R decides, once the band's effects are verified one by one, whether the ~30 applied-without-row stranded migrations get repair rows. Until then **no bulk `db push`** (it would re-run them; §3.5 shows one is not a no-op).

## 5. Task 5 — `708f0ac4` stale provenance note

`EV/708f0ac4-provenance-correction.patch` (against the restored file, blob `d85cf5c9`, which the worktree still holds — **not applied**; `git apply --check` passes). It changes only `digests_provenance["20261127000000_pi_prospect_lists.sql"]`: `"ledger_row": false` → `true`, plus a two-entry `ledger_row_history` (2026-11-10 false per D1; 2026-11-26 true per 09 §3(a) q09/q16/q18b, re-read 2026-11-27 `b05`). Every other provenance field is kept.

Built by `EV/make-provenance-patch.js`, which refuses unless the parsed JSON differs **only** in that entry and `ledger_max` and `digests` are unchanged: output `ledger_max 20270111000003, digests 458, digest 01315600…c734`.

Gate (`scripts/check-migration-quality.js`, scratch copies of `scripts/` + `supabase/`; the default path uses no git):

| Copy | Exit | Result |
|---|---|---|
| unpatched (control) | 0 | `OK — 132 new migration(s) valid; 353 historical frozen` |
| patched | 0 | same; full output identical to the unpatched run |
| failing control: patched + one digest hex digit of `20261127000000` changed | **1** | the `20261127000000` immutability error |

Scratch copies deleted; kept: `EV/gatecheck/applied-boundary.patched.json`, `gate-*.out`. Land after `cherry-pick -x 708f0ac4` as its own forward commit.

## 6. Task 6 — preconditions in production

### `20270301000000_prospect_lists_client_privileges_revoked.sql` (12 §3 / B4)

| Precondition | Prod (`b02`, `b06`) | Holds |
|---|---|---|
| Roles anon, authenticated, authenticator, service_role exist | all four; authenticator is a member of all three with `inherit=false`; anon/authenticated/service_role belong to nothing | yes |
| Both tables exist, owner postgres | yes | yes |
| relacl exactly `{postgres, service_role}` | `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}` on both; 32 ACL items, all grantor `postgres`, none grantable | yes |
| No column ACLs | 0 on both | yes |
| RLS on, not forced | on / off on both | yes |
| Both policies | `prospect_lists_service_role`, `prospect_list_members_service_role`: ALL, permissive, `{public}`, qual and check `(auth.role() = 'service_role'::text)` | yes |
| Not in a publication | no `pg_publication_tables` row; publications `supabase_realtime`, `supabase_realtime_messages_publication`, both `puballtables=false` | yes |
| PG ≥ 17 (MAINTAIN in the check list) | `server_version_num 170006` | yes |
| **Postcondition evaluated live** | `has_table_privilege` false for anon/authenticated/authenticator × 8 privileges × 2 tables (48/48); `has_any_column_privilege` false (24/24); service_role true for all 8 on both (16/16) | yes |

Verdict: every precondition holds and the postcondition already holds → **no-op on prod**, as 12 §3 says.

### `20270301000001_api_idempotency_keys_updated_at_index.sql`

No relation named `api_idempotency_keys_updated_at_id_idx` in any schema. Existing indexes: `api_idempotency_keys_pkey (id)`, `api_idempotency_keys_caller_scoped_key (scope, caller_id, idempotency_key)`, both valid and ready. No triggers on the table (closes 09's limitation). Size: heap 24 KB, total 90 KB, indexes 32 KB, `reltuples 41`, `n_live 41`, `n_dead 11`. Not in a publication. Verdict: **safe**; `CREATE INDEX CONCURRENTLY` on 41 rows is instant; the leading `DROP INDEX CONCURRENTLY IF EXISTS` drops nothing.

## 7. Task 7 — trigger compatibility `20270111000003`

- Prod (`b02`): 75 enabled non-internal `omnivyra_touch_updated_at()` triggers = **74 in `public` + 1 in `archive`** (same as 09).
- Replay (`b02` local): **75, all in `public`**. The sets differ by exactly one: the replay has `content_block.content_block_set_updated_at` (gap step runs last), which in prod runs `set_content_updated_at()`; prod has the `archive` one, which the replay does not. No prod-only table (§8) uses the touch function.
- Floor 74: met in both. Without `prospect_lists` prod would be exactly 74 (zero margin, as 09).
- **Pending forward migrations:** `20270301000000` (grants) and `20270301000001` (index) create no triggers; no main migration above `20270111000003` references `omnivyra_touch_updated_at` (grep, 0 files); the stranded files in §3 use their own guard functions. Agent D's content-table REVOKE is grants-only by scope. **None changes the 75/74.**

Verdict: **COMPATIBLE**, no new risk.

## 8. Additional finding — production is ahead of and behind main

**Ahead (no ledger rows):** 27 prod tables are created by neither the baseline nor main (`table-map.csv`, PRODUCTION-ONLY, not in E2E). 25 come from `origin/integration/s-wa-combined` migrations: `20270111100000/01/02/03/05/06/07/10/14`, `20270120000000/01`, `20270125000005`, `20270127000001–04`, `20270128000002/03`, `20270129000002`, `20270207000000`. Two others: `client_privilege_revoke_snapshot` (`8cc471294`, "#23 Part 1 … (not applied)", `integration/dryrun-preflight`) and `outreach_quota_reservations` (`f0fbb9a95`, `s-wa-combined-4/10/11`). With §2's column changes (`20270125000000`, `20270207000000`, `20270217000071`) and `20270129000004` (§3.2), the pattern matches the **36 EXPAND migrations of `5ce2ced7f`** ("ci-only … compatibility proof; NOT for merge", 2026-11-18), plus at least `20270111100010` (`community_action_journey_links`, `uq_community_ai_actions_id_org`), `20270217000071` and `8cc471294`, none of which is in the 36. Absent from prod: `rpa_auth_token_redemptions` (`…100012`) and `engagement_request_idempotency` (`…100015`, which *is* in the 36), so the applied set is **not exactly** the 36. On 2026-11-10 D1 found none of the band applied, so the band was applied after that.

**Behind:** main's `20270112000001/3/4` and `20270115000000` (person erasure: 4 tables, `leads` changes) are not applied (09 already noted 8 main files `20270111000004…20270115000000` without ledger rows).

This item-by-item effect audit of the stranded band is **outside this task's scope** and was not done beyond §3. It is the MIG-2R / stranded-line landing's input.

## 9. Forward migrations prepared

**None.** Versions `20270301000002`–`…09` remain unused. Reasons:
- The content-table grant correction belongs to Agent D (`…0010+`).
- `api_idempotency_keys` is already covered by `20270301000001`.
- Every other difference is either PRODUCTION-ONLY with a recoverable original (owner rule: land the original, never a replacement), repo-ahead (needs apply authorization, not a migration), or needs an owner decision (`rbac_config` deferred contract promotion = C-7; `omnivyra_pi_inventory_ro`; `signal_excerpt` = baseline regeneration).

## 10. Items needing an owner decision

1. **Out-of-band stranded-line applies in prod with no ledger rows** (§8): about 30 migrations, including `20270111100007` (§3). Decide: verify each effect, land the originals (stranded-line landing, `cherry-pick -x`), then repair ledger rows. Until then, **no bulk `db push`**: re-running `20270111100007` alone resets `20270129000004`'s `search_path` hardening (§3.5).
2. **Ledger rows `20261127000000` + `20270202000000`** (one transaction, writer unknown) were written against the 2026-11-10 instruction "no ledger row before the GD-4 band applies". Accept them as they are, or record a reason. Recommended: accept; both effects are complete.
3. **Landing `20270202000000`**: `cherry-pick -x 144de096e` with the stranded line. Prod effect is exact.
4. **`rbac_config`**: prod already runs the deferred contract (service_role SELECT only). Promote `supabase/deferred/rbac_config_contract_legacy_insert.sql` to a versioned migration (the C-7 step), or record why not. Until then the repo replay grants INSERT that prod does not.
5. **`omnivyra_pi_inventory_ro`**: a production `LOGIN` role with column SELECT on 6 user-id columns and no repo record. Keep it (and document it) or drop it.
6. **Main migrations not applied in prod**: `20270112000001/3/4`, `20270115000000` (and the rest of 09's list). They need apply authorization; they are not drift to "fix" in the repo.
7. **`opportunity_feed_items.signal_excerpt`**: from main's 8-digit `20260818_opportunity_signal_excerpt.sql`, which CI never replays. Only a baseline regeneration fixes it (the owner-run step the gap manifest already names).
8. Content-table `authenticated=arwdxtm` grant (Agent D) and the `content_block` trigger divergence (baseline regeneration): already tracked; listed here for completeness.

## 11. Readiness

This document and the `EV/` artifacts are ready for integration. Nothing in it changes the integration patch: the six tables' alignment, the `20270301000000/1` preconditions and the trigger compatibility all **confirm** 12. The `708f0ac4` follow-up patch is ready for its own commit after the cherry-pick. Items 1–7 in §10 do not block the integration patch. They do block any ledger repair and any bulk migration apply to production.
