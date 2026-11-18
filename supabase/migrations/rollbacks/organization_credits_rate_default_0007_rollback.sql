-- Rollback of 20270217000059_organization_credits_rate_default_0007.sql (c6). Restores the column default to 0.01.
-- No row is changed (wallets created while 059 was in force keep 0.007 - their rate is the owner's rate).
ALTER TABLE public.organization_credits ALTER COLUMN credit_rate_usd SET DEFAULT 0.01;
