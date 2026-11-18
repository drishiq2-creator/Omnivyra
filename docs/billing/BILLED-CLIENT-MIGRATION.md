# Billed AI clients → canonical helper + Idempotency-Key (tracker)

**Owner:** UI tab. **Coordinator:** e9. **Server side:** e1 (wirePhase2Route standard shape), 55 (C75 / Market Pulse).

**Why this exists (e9 ruling, 2026-11-13).** The billing enforcement flip is GATED on this list being EMPTY. No billed route may be enforced while a client calling it lacks:
1. **an `Idempotency-Key`**, minted once per user action, reused while it's in flight, and freed when it ends (`createBilledActionKeyGate` in `lib/idempotency.ts`). Without it a double-click double-charges.
2. **the canonical response mapping** (`classifyBilledResponse` / `billedOutcomeText` in `lib/billing/billedResponse.ts`). Without it users see raw codes and an `ALREADY_PROCESSED` success looks like an error.

**Standard server shape**, keyed on status + `code` only:
- 402 `{ error, code: INSUFFICIENT_CREDITS | NO_CREDIT_ACCOUNT | PRICING_UNAVAILABLE, required?, balance? }`
- 409 `{ error, code: ALREADY_PROCESSED }`: success; refresh.
- 500 `{ error, code: RECLAIM_CAP_EXHAUSTED, retryable: false }` (e1): our failure, nothing charged; offer "try again" with a NEW key. It replaces `ALREADY_RELEASED`, which never existed on main and is not handled.
- 200 `{ status: 'executed', ..., settlementPending?: { code: 'CREDIT_SETTLE_AMBIGUOUS', ... } }` (e1's live settle fix; e9 2026-11-13): the WORK IS DONE. Render the result normally. NEVER retry or auto-resubmit. Optionally show a quiet note: "Billing for this item is being finalised. You won't be charged twice." Never show holdId or detail. Routes that used to 500 on a settle error now return 200 with content in this case. The helper already classifies any 2xx as ok whatever the extra fields (`billedResponse.ts:42`); a `settlementNote(body)` for the optional note comes with batch 1. **Audit 2026-11-13 (all 47 tracker client files at main 69dc5027f):** no client parses billed responses with a strict schema, checks `status === 'executed'`, or auto-resubmits. The only retry loop (MarketPulseTabV2Controller `loadRunResult`) re-reads a run result with GET, never the billed POST, and returns on 200. Flip-gate list.
- 503 `{ error, code: DAILY_LIMIT_UNVERIFIABLE | BUDGET_UNVERIFIABLE | ORG_CONTROLS_UNVERIFIABLE | <any>_UNVERIFIABLE }` with a `Retry-After` header. The helper matches the `_UNVERIFIABLE` SUFFIX, so a future code needs no UI change; `KNOWN_UNVERIFIABLE_CODES` lists today's three and is pinned by the helper test (6f, coming; e9 ruling 2026-11-13): "we couldn't confirm your spending limit right now; nothing was charged". Show a plain retry message ("We couldn't check your spending limit just now. Nothing was charged. Please try again in a moment."), honouring Retry-After if shown, and NEVER a top-up prompt. A retry uses a NEW key; the shared gate is unchanged (e9 retracted "same key"). The refusal happens before any hold, and 6f guarantees it records nothing against the key (no hold, no ledger row, no idempotency row), with a test. Part of the flip-gate list.

- 503 `{ code: REPLAY_UNAVAILABLE, retryable: true }` (c6 engagement-v2 b3adbc688): the stored result for this key can't be read right now; nothing new ran or was charged. The helper classifies it as a plain retry (`REPLAY_UNAVAILABLE_MESSAGE`), never "not sure". c6 is making it TERMINAL after a durable count (3 failed re-reads or 24h), which then refunds and ENDS the key.

**Key lifetime with replay (c6 engagement-v2, 2026-11-18; b3 + 7c).** The 21 wirePhase2Route routes below now persist each result BEFORE the charge and REPLAY it (200, the stored body) for the same org + Idempotency-Key; `409 ALREADY_PROCESSED` remains only for charges made before that change. Without a client key the identity is per-request, so a retry is a NEW request and a NEW charge. So for these routes a client must:
- KEEP the key while the outcome is UNKNOWN (connection lost, a 5xx with no billing facts, `REPLAY_UNAVAILABLE`), so trying again replays instead of charging again;
- END it when the outcome is KNOWN (a 2xx, a refusal, a failure stating its billing), so the next click is a new request.
Never "fix" a kept key by ending it on a lost connection: that turns a lost result into a second charge. Routes that do NOT replay (the five in "Done", per c6 2026-11-18) keep ending the key on every outcome until c6 says they replay. One shared keep/end helper in `lib/billing` (generalising `lib/blog/blogGenerateKey.ts`), not a copy per caller (b3).

**Known defect class: the lost response (7c, 2026-11-18; seen on blog, WhatsApp broadcast, Post Now).** The dangerous moment is always the same: a response is lost, the client assumes failure, and the copy invites a retry, so following our instruction sends or charges twice. For any SEND/POST/SPEND surface: a fetch rejection (or a 5xx with no facts) is an UNKNOWN outcome. It must claim no outcome, assert nothing about queued work, and must not advise a plain retry; it says to check first ("We couldn't confirm this. Check … before trying again."), and the key is KEPT so a retry is the same request, **only where the route replays; otherwise end it** (see "Key lifetime with replay": keeping a key against a non-replaying route traps the user in a permanent same-key refusal). Fixed so far by: replay + kept key (blog, the 21 routes), the A16 key (WhatsApp, landing via a9), the publish-now cancel + uncertain copy (89).

**A route is DONE when:** its server returns the standard shape (e1/55 confirm), AND every client file below sends the key with the keep/end rule above and routes errors through the helper, AND shows its price line (`RunCostLine`) in the SAME release that switches its billing on (b3 B5 ruling 2026-11-18: a release gate, not a cleanup), AND a rendered test per caller pins the key (sent; reused after a lost connection; new after a known outcome) and the price line.

**Start condition for the batches below:** c6's engagement-v2 (`b3adbc688`, the replay store) is on main (b3 2026-11-18: right after the BLOCKING-launch items, because the enforcement flip is on the launch path). The authoritative set of 21 wirePhase2Route routes is the structural pin `backend/tests/unit/settlementPendingSurface.test.ts` on that branch; re-read it before each batch. (Superseded: e1's `fix/phase2-route-wiring-token-actual-20261113`, 18 routes + `campaigns/[id]/virality/assess`.)
For those routes, `PRICING_UNAVAILABLE` arrives as **503** `{ code: PRICING_UNAVAILABLE }` (a config gap). The helper keys on the code, so it is classified correctly and never shows "top up".

## Done

| Route | Client files | Commit |
|---|---|---|
| `/api/market-pulse/run` | `components/recommendations/tabs/MarketPulseTabV2Controller.tsx` | e82d21f8c |
| `/api/ai/blog-card-chat` | `components/blog/AIBlogCardModal.tsx` | e82d21f8c |
| `/api/content/regenerate` | `components/campaign-ai/useCampaignAiOps.ts` | e82d21f8c |
| `/api/activity-workspace/content` (`refine_variant`) | `hooks/useActivityWorkspaceRefinementOps.ts` | e82d21f8c |
| `/api/content/suggest` | `components/content/SuggestWithAIPanel.tsx` | e82d21f8c |

## To migrate (wirePhase2Route-billed), in planned batches

Batches group screens that share a feature, so each one can be reviewed and checked as a unit. They're ordered by customer exposure.

### Batch 1: Recommendations & trend campaigns (high traffic)
- [ ] `/api/recommendations/generate`: `components/recommendations/hooks/useTrendCampaigns.ts`, `components/recommendations/tabs/useTrendCampaignsHandlers.tsx`, `hooks/useRecommendationsState.tsx`
- [ ] `/api/recommendations/[id]/preview-strategy`: `hooks/useCampaignPlanningState.tsx`, `hooks/useRecommendationsState.tsx`
- [ ] `/api/recommendations/detected-opportunities`: `hooks/useRecommendationsState.tsx`
- [ ] `/api/recommendations/group-preview`: `hooks/useRecommendationsState.tsx`

### Batch 2: Campaign planning
- [ ] `/api/campaigns/run-preplanning`: `hooks/useCampaignDetailsHandlers.tsx`, `lib/campaign-details/usePrePlanningActions.ts`
- [ ] `/api/campaigns/suggest-duration`: `hooks/useCampaignDetailsCore.tsx`, `lib/campaign-details/usePrePlanningActions.ts`
- [ ] `/api/planner/chat-themes`: `components/planner/StrategyAIChat.tsx`
- [ ] `/api/planner/skeleton-command`: `components/planner/SkeletonBuilderPanel.tsx`
- [ ] `/api/campaign-content/assist`: `components/planner/ContentWorkspace.tsx`
- [ ] `/api/campaigns/[id]/virality/assess`: `hooks/useCampaignDetailsHandlers.tsx` (:740). Billed per e1; joins the standard shape in e1's phase2 wiring.

### Batch 3: BOLT
- [ ] `/api/bolt/campaign-chat`: `components/bolt/BoltCampaignChat.tsx`, `components/BoltCreatorViewMain.tsx`, `components/command-center/BoltCombinedStrategyMain.tsx`

### Batch 4: Content & engagement
- [ ] **Rewire (b3, 2026-11-18): `pages/engagement-inbox.tsx` "Generate a reply"** (:249-259 at main 516d526d3) → `/api/engagement/suggestions`. Today it POSTs `/api/engagement/generate-response` with `original_message` and no `engagement_type`; the route reads `message` + requires `engagement_type` (generate-response.ts:79-88), so it ALWAYS 400s "message required" and has never worked. c6 is closing that route's unbilled AI fallback (409 `AI_REPLY_USE_SUGGESTIONS`). The new call uses the shared keep/end helper (replaying route) and the price line. Owner opt-in: when `ai_suggestions` is OFF (the default) the button does NOT call; it shows "Reply suggestions are off. A company admin can switch them on in Inbox AI settings." with a link to the Inbox AI settings page. Rendered tests: off -> no request + the message/link; on -> key sent, kept on a lost connection, price line shown.
- [ ] `/api/company/blog/brief-suggestions` (shared fetcher first, then pages):
  - `components/content/managed-intelligence/briefSuggestionsFetcher.ts`
  - `components/blog/intelligence/useBlogIntelligence.ts`
  - `components/content/ManagedSuggestionsPage.tsx`
  - `pages/articles/generate.tsx`, `pages/blogs/generate.tsx`, `pages/blogs/suggestions.tsx`
  - `pages/case-studies/generate.tsx`, `pages/guides/generate.tsx`
  - `pages/newsletters/generate.tsx`, `pages/newsletters/suggestions.tsx`
  - `pages/stories/generate.tsx`, `pages/whitepapers/generate.tsx`
- [ ] `/api/content/quick-platform-adapt`: `components/blog/blogsNewMain.tsx`, `components/content/PromotionWorkspace.tsx`, `components/MultiPlatformSchedulerController.tsx`
- [ ] `/api/ai/content-suggestions`: `components/activity-workspace/AISuggestionPanel.tsx`
- [ ] `/api/engagement/refine-suggestion`: `components/engagement/AISuggestionPanel.tsx`
- [ ] `/api/engagement/suggestions` (**GET**, surface `engagement.suggestions`): `components/engagement/AISuggestionPanel.tsx` (:34). Billed on e1's fix/engagement-replies-billed-20261113, dark until the flip. The key goes on a GET.
- [ ] `/api/blogs/[id]/repurpose`: `pages/company-blog/[slug].tsx`
  - **source=public now requires login and is charged to the caller's company** (owner ruling via e9; 55's fix/public-repurpose-rate-limit-20261113). The client must ALWAYS send `company_id` = the selected company, so multi-company users never get 400.
  - New responses on the public source, which the client must handle:
    - 401 `AUTH_REQUIRED` → prompt sign-in
    - 400 `COMPANY_REQUIRED` (several companies, none named)
    - 403 `NO_ACTIVE_COMPANY` / 403 company not theirs
    - 429 `RATE_LIMITED` (per-IP / global limit)
    - plus the shared billing 402s
  - Find and migrate the public-blog caller(s) too (re-run the caller grep on 55's branch).

### Batch 5: Creator
- [ ] `/api/creator-templates/chat-brief`: `components/creator/CreateWithAIChat.tsx`
- [ ] `/api/creator-templates/field-assist`: `components/creator/AssetCreationWorkspace.tsx`, `components/creator/workflow/useCreatorWorkflowActions.tsx`

### Batch 6: Admin blog (super-admin only)
- [ ] `/api/admin/blog/brief-suggestions`: `pages/admin/blog/content-refine.tsx`, `pages/admin/blog/generate.tsx`
- [ ] `/api/admin/blog/generate`: `pages/admin/blog/content-refine.tsx`, `lib/blog/hookAssessment.ts`, `lib/blog/runBlogGeneration.ts`

## Moving to persist-before-settle + replay (c6 via b3, 2026-11-18, BLOCKING-launch, in this order)

> **BILLED TODAY, no client key (7c, 2026-11-18): `activity-workspace/content` `generate_master` and `/api/planner/generate-workspace-content` take credits NOW, not after the flip.** Do NOT work them in batch order. And do NOT add a per-click key before the route replays: without a header the server keys on a body hash, so an identical retry is refused (charged once, result lost); a fresh key that ends on every outcome would make each retry a SECOND charge. The fix order is server replay first (c6; asked to move the planner route up), then the client switches straight to keep-on-unknown with rendered tests.

Each needs a key per user action. **Keep ENDING the key until c6 says that route "replays"**; then switch it to keep-on-unknown (same shape as the 21: same key -> 200 stored body; read error -> 503, terminal after durable re-read failures).
1. [ ] `/api/activity-workspace/content`: `generate_master` first, then `improve` / `generate_variants` (transient-draft case), then `refine_variant`. Callers by `action` (c6, main 516d526d3): `hooks/useActivityWorkspaceContentOps.ts` generate_master (:68, :194), generate_variants (:224); `components/MultiPlatformSchedulerController.tsx` generate_variants (:837); `lib/planning/executeMasterContentPipeline.ts` generate_master (:109), generate_variants (:146), improve_variant (:200); `hooks/useActivityWorkspaceRefinementOps.ts` refine_variant (key already sent, see Done). generate_master is charged TODAY in every mode (executeWithCredits); refine_variant only when its billing flag is on. **Gap found:** only refine_variant was tracked; the other callers were missing from this list.
2. [ ] `/api/campaign-content/assist`: `components/planner/ContentWorkspace.tsx` (also listed in Batch 4).
3. [ ] `/api/creator-templates/field-assist`: `components/creator/AssetCreationWorkspace.tsx`, `components/creator/workflow/useCreatorWorkflowActions.tsx` (also in Batch 5).
4. [ ] `/api/creator-templates/chat-brief`: `components/creator/CreateWithAIChat.tsx` (also in Batch 5).
5. [ ] `/api/planner/generate-workspace-content`: `components/planner/ContentWorkspace.tsx`. **Gap found:** this route was not in the tracker at all. Billed TODAY (c6): runAiExecution billing 'entry-auto' (executeWithCredits in 'off', entry consumption under 'enforce').

## Not billed (no helper, no Idempotency-Key needed)
- `/api/creator-intelligence/campaign-variant-estimate` (`components/variant-experience/CampaignVariantBillingEstimate.tsx`). e1 confirmed at main 9cecd075f: read-only, no charging and no AI call; a pure calculation from the persisted variant_strategy.

## Billed routes with NO client caller (nothing to migrate; listed so the flip review sees them)
- `/api/engagement/thread/bulk-ai-reply` (POST, surface `engagement.bulk-ai-reply`; e1's fix/engagement-replies-billed-20261113). No client caller at main 69dc5027f (`git grep bulk-ai` over components/hooks/lib/pages finds nothing; control: the same grep finds ConversationView's `thread/bulk-resolve`). Any future caller needs the gate + helper. With c6's replay the same key on a retry → 200 replay of the stored result (nothing sent twice); 409 ALREADY_PROCESSED only for runs before that change.
- `/api/admin/blog/rewrite-hook`
- `/api/campaigns/planner/suggest-update`
- `/api/ai/claude-chat`: its only caller, `components/MultiAIChat.tsx`, was dead code and is deleted (UI 55400bd54)

## How this list was produced (re-run before the flip)
- **Server billed routes:** files under `pages/api` referencing `wirePhase2Route` / `BilledAiNotExecutedError` / billed-AI wrappers.
- **Clients:** `grep -rlE "/api/<route>"` across `components hooks pages lib`, excluding `pages/api`.
- **Before the flip:** re-run both, and confirm every server route is listed here and that **Done** covers all of its client files.
