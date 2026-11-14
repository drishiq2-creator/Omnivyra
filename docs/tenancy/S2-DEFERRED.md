# S2 tenant seam: deferred sites

Tier 2 (sensitive reads) is **not** complete for the paths below. Each row says why it stays raw and what unblocks it. Remove a row in the same commit that converts the site.

| Path | Tier | Why raw | Unblocker |
|---|---|---|---|
| `pages/api/campaigns/list.ts` | 2 | SEC91 A8: `campaign_versions` owns divergent campaigns; `campaign_company_scope_fix` pins "never filter campaigns by company_id". The ids already come from the authorized company's versions. | None: stays raw. campaign_company_scope_fix pins no campaigns.company_id filter; ids come from the authorized company's versions. |

**Preferred unblocker (05, 2026-11-14):** a versions-derived owner helper. It keeps A8 and still gives these routes the seam. The alternative, amending A8 with a divergence check, gives up the invariant and only detects a divergence after it has happened. e9 ruled 2026-11-14: no A8 amendment; the canonical resolver resolveCampaignOwnership (3AH-113) is the versions-aware owner.

**Closed 2026-11-14 (598c00356):** `resolveTenantOfRow` now throws a retryable error on a FAILED read; absent / NULL tenant still return null. All 13 callers retry within bounds and log `tenant_row_unreadable`.

Per-site reasons for the other raw tier-2 route sites (campaigns 15, other routes 20) are in the S2 tier-2 work lists. They are pre-authorization bootstrap reads, whose 503/500 split the owner lookups would collapse.
