-- =============================================================================
-- PI-LDB-5 — catalog row for the `lead_attribute_mapping` credit action
--
-- WHY THIS MIGRATION EXISTS AT ALL
-- --------------------------------
-- AI semantic attribute mapping is a new billable capability, so it needs its
-- own action key. Reusing an existing one (content_rewrite was the tempting
-- shortcut, since creator field-assist already borrows it) would have made the
-- usage ledger attribute import-mapping spend to content generation, and the
-- ledger is what the per-activity credit question is answered from. A wrong
-- attribution is worse than a new row.
--
-- `assertCanonicalCreditAction()` throws when the monetization registry cannot
-- resolve the action (featureRegistry.ts), and the fixed-price charge reads
-- this row through getCreditCost(). Until it is applied the proposer fails,
-- `proposeFieldMappings` records one `degraded` entry, and the import maps
-- deterministically: dark, not broken.
--
-- PRICING (owner ruling 2026-11-20, reworked by c6 before landing)
-- -------
-- FIXED: 2 credits per AI mapping proposal, whatever the tokens. Reusing a
-- saved mapping profile or mapping by hand makes no AI call and costs nothing.
-- The original version of this file was token-priced (an action_pricing_config
-- 'llm' row); that violated the pricing hold (no new rate-priced billing), so
-- the llm pricing row is gone and the charge is this credit_cost_config row.
--
-- SAFETY
-- ------
--   * Purely additive. No schema change, no existing row modified.
--   * Idempotent: ON CONFLICT (action_type) DO NOTHING; a pre-existing row
--     keeps its credits (pinned by the snapshot postcondition).
--   * NOT APPLIED anywhere real by this change (C150: absent in prod). Apply
--     only through the controlled migration process.
-- =============================================================================

-- ONE TRANSACTION (2026-11-11): the snapshot below is ON COMMIT DROP, and the
-- seed plus its postconditions must land together or not at all.
BEGIN;

-- ── 0. Snapshot any PRE-EXISTING billing row (GOV-SECURITY, 2026-11-11) ─────
-- A re-applied seed must NEVER overwrite a live billing row. The insert below is
-- DO NOTHING on conflict, and the postcondition proves an existing row's
-- credits are unchanged against this snapshot.
CREATE TEMP TABLE pi_ldb_m04_prior ON COMMIT DROP AS
  SELECT credits FROM credit_cost_config WHERE action_type = 'lead_attribute_mapping';

-- ── 1. The fixed price ──────────────────────────────────────────────────────
INSERT INTO credit_cost_config (action_type, credits, category, description, smart_dedup_seconds)
VALUES (
  'lead_attribute_mapping',
  2,
  'low',
  'AI column-mapping proposal for an imported prospect file (fixed 2 credits; saved or manual mapping is free)',
  -- No smart dedup. Re-proposing is already deduplicated where it belongs, by
  -- the billing idempotency key, which keys on the actor, the action, the
  -- source + schema fingerprint and a digest of the prompt. A time window here
  -- would additionally suppress a genuinely different question asked about the
  -- same file within the window.
  0
)
ON CONFLICT (action_type) DO NOTHING;

-- ── Postconditions ─────────────────────────────────────────────────────────
-- These assert the two things the code actually requires at runtime. They are
-- written as counts rather than as "the insert succeeded", because on a replay
-- neither statement inserts anything and a success check would be vacuous.
DO $$
DECLARE
  v_credit  integer;
  v_credits integer;
BEGIN
  SELECT count(*) INTO v_credit
    FROM credit_cost_config WHERE action_type = 'lead_attribute_mapping';
  IF v_credit <> 1 THEN
    RAISE EXCEPTION 'PI-LDB-5 postcondition: expected exactly 1 credit_cost_config row for lead_attribute_mapping, found %. getCreditCost() would have no price.', v_credit;
  END IF;

  SELECT credits INTO v_credits
    FROM credit_cost_config WHERE action_type = 'lead_attribute_mapping';

  IF EXISTS (SELECT 1 FROM pi_ldb_m04_prior) THEN
    -- A row that existed before this file ran keeps its credits EXACTLY (the
    -- seed is DO NOTHING; this pins it).
    IF EXISTS (SELECT 1 FROM pi_ldb_m04_prior p WHERE p.credits IS DISTINCT FROM v_credits) THEN
      RAISE EXCEPTION 'PI-LDB-5 postcondition: the PRE-EXISTING credit_cost_config row for lead_attribute_mapping had its credits changed by this seed (a replay must never overwrite a live billing row)';
    END IF;
  ELSIF v_credits IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'PI-LDB-5 postcondition: a freshly seeded lead_attribute_mapping must cost the owner-approved 2 credits, found %.', v_credits;
  END IF;

  -- Fixed price only: an active token-pricing row would contradict the pricing hold.
  IF EXISTS (SELECT 1 FROM action_pricing_config
              WHERE action_key = 'lead_attribute_mapping' AND is_active = true) THEN
    RAISE EXCEPTION 'PI-LDB-5 postcondition: an ACTIVE action_pricing_config row exists for lead_attribute_mapping; this action is fixed-price (owner 2026-11-20), not token-priced.';
  END IF;

  RAISE NOTICE 'PI-LDB-5: lead_attribute_mapping fixed at % credits.', v_credits;
END
$$;

COMMIT;
