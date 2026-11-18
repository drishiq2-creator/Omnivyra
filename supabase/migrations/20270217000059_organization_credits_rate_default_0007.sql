-- 20270217000059 - organization_credits.credit_rate_usd column default 0.01 -> 0.007 (c6, was e1; OWNER ruling
-- 2026-11-18 via b3; version from virality-cb; review: virality-7c).
--
-- THE RULING. Every NEW wallet starts at the owner's rate 0.007 (one credit = USD 0.007), ahead of the pricing release.
-- Wallets are created by more than one path: the signup upsert (initialFreeCreditService - now the shared
-- NEW_WALLET_CREDIT_RATE_USD constant, 0.007, insert-only) AND the live SQL credit functions / the projection reconciler,
-- which INSERT organization_credits(organization_id) and take the COLUMN DEFAULT (0.01 until now). This makes the column
-- default the same 0.007, so every creation path agrees.
--
-- NEW ROWS ONLY: an ALTER ... SET DEFAULT rewrites no existing row. Existing wallets (29/31 at 0.001) move only in the D8
-- rate equalisation (pricing release). Embrosales (73e5fa6f) is untouched.
-- Rollback: rollbacks/organization_credits_rate_default_0007_rollback.sql (default back to 0.01; rows untouched).

DO $m059_pre$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organization_credits' AND column_name = 'credit_rate_usd';
  IF v_default IS NULL THEN
    RAISE EXCEPTION '059 preflight: organization_credits.credit_rate_usd not found (or has no default)';
  END IF;
  RAISE NOTICE '059 preflight: credit_rate_usd default was %', v_default;
END
$m059_pre$;

ALTER TABLE public.organization_credits ALTER COLUMN credit_rate_usd SET DEFAULT 0.007;

DO $m059_post$
BEGIN
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organization_credits' AND column_name = 'credit_rate_usd')
     NOT IN ('0.007', '0.007::numeric') THEN
    RAISE EXCEPTION '059 postcondition: credit_rate_usd default is not 0.007';
  END IF;
END
$m059_post$;
