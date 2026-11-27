-- Rollback for 20270314000010_extension_handshake_store.sql
--
-- Pre-image: none of these objects existed before 20270314000010 (new tables + new functions only), so the rollback
-- is a plain drop. ORDER: roll the APPLICATION back first (a deployment whose extension routes call these functions
-- answers 503 on bootstrap / redeem / every signed extension request once they are gone - fail closed, by design).
-- Dropping the tables discards only short-lived claim codes (60 s) and replay nonces (15 min): no user data.

BEGIN;

DROP FUNCTION IF EXISTS public.extension_request_nonce_record(text, integer);
DROP FUNCTION IF EXISTS public.extension_claim_code_redeem(text);
DROP FUNCTION IF EXISTS public.extension_claim_code_peek(text);
DROP FUNCTION IF EXISTS public.extension_claim_code_issue(text, uuid, uuid, integer);
DROP TABLE IF EXISTS public.extension_request_nonces;
DROP TABLE IF EXISTS public.extension_claim_codes;

DO $verify$
BEGIN
  IF to_regclass('public.extension_claim_codes') IS NOT NULL OR to_regclass('public.extension_request_nonces') IS NOT NULL
     OR to_regprocedure('public.extension_claim_code_issue(text, uuid, uuid, integer)') IS NOT NULL
     OR to_regprocedure('public.extension_claim_code_redeem(text)') IS NOT NULL
     OR to_regprocedure('public.extension_claim_code_peek(text)') IS NOT NULL
     OR to_regprocedure('public.extension_request_nonce_record(text, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'EHS rollback postcondition: an extension handshake object still exists';
  END IF;
END
$verify$;

COMMIT;
