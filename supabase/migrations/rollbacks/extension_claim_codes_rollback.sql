-- ROLLBACK for 20270222000000_extension_claim_codes.sql
--
-- Drops the shared claim-code store. Codes in flight (60 s lifetime) stop working; an extension pairs again from the
-- Omnivyra page. Deploy the previous server build FIRST (it keeps codes in memory and never reads this table).

BEGIN;

DROP TABLE IF EXISTS public.extension_claim_codes;

DO $verify$
BEGIN
  IF to_regclass('public.extension_claim_codes') IS NOT NULL THEN
    RAISE EXCEPTION 'ECC rollback postcondition: extension_claim_codes still exists';
  END IF;
END
$verify$;

COMMIT;
