-- 20270222000000 extension_claim_codes (b3, owner 2026-11-22: two independently usable LinkedIn extensions)
--
-- The one-time claim codes that pair a Chrome extension with a signed-in Omnivyra user. They were held in ONE server
-- process's memory (backend/services/extensionClaimCodeService.ts: "fine for a single-instance backend"), so on the
-- multi-instance production deployment a code created by one instance was "INVALID_OR_EXPIRED" on another (seen in the
-- owner's hands-on test 2026-11-22). This table is the shared store.
--
-- Rules the service relies on:
--   - the RAW code is never stored, only sha256(code) (code_hash, the primary key);
--   - a code is redeemable ONCE and only before expires_at: one UPDATE .. WHERE redeemed_at IS NULL AND expires_at >
--     now() RETURNING - no read-then-write;
--   - product is the extension the page asked for (NULL = a page built before the split); the server refuses a
--     redemption by the other product.
-- Rows are tiny; redeemed/expired rows older than a day are deleted by the service (hence DELETE).
--
-- This version: never applied anywhere. RLS on, zero client grants, service_role only (REVOKE ALL first - the public
-- schema's default ACL grants service_role ALL on every new table, C163).

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'ECC preflight: public.companies is missing - there is no tenant to scope a claim code to';
  END IF;
  IF to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'ECC preflight: auth.role() is missing - the house service_role policy cannot be expressed';
  END IF;
  IF to_regclass('public.extension_claim_codes') IS NOT NULL THEN
    RAISE EXCEPTION 'ECC preflight: public.extension_claim_codes already exists - this migration creates it and must not adopt an unknown shape';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.extension_claim_codes (
  code_hash        text        NOT NULL
    CONSTRAINT extension_claim_codes_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  organization_id  uuid        NOT NULL
    CONSTRAINT extension_claim_codes_org_fk REFERENCES public.companies (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL,
  product          text        NULL
    CONSTRAINT extension_claim_codes_product CHECK (product IS NULL OR product IN ('linkedin_engagement', 'salesnav')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  redeemed_at      timestamptz NULL,
  CONSTRAINT extension_claim_codes_pkey PRIMARY KEY (code_hash),
  CONSTRAINT extension_claim_codes_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS extension_claim_codes_created_at_idx ON public.extension_claim_codes (created_at);

COMMENT ON TABLE public.extension_claim_codes IS
  'One-time Chrome-extension pairing codes (sha256 only), shared by every server instance. Redeemed once, before '
  'expires_at, by one atomic UPDATE. product = the extension the page addressed (NULL = pre-split page).';

ALTER TABLE public.extension_claim_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY extension_claim_codes_service_role ON public.extension_claim_codes
  FOR ALL TO service_role
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- REVOKE ALL (not a list: PG17 adds MAINTAIN), naming every client role.
REVOKE ALL ON TABLE public.extension_claim_codes FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.extension_claim_codes TO service_role;

DO $postcondition$
DECLARE
  v_priv text[];
  r text;
  p text;
BEGIN
  IF to_regclass('public.extension_claim_codes') IS NULL THEN
    RAISE EXCEPTION 'ECC postcondition: the table is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.extension_claim_codes'::regclass) THEN
    RAISE EXCEPTION 'ECC postcondition: row level security must be ENABLED';
  END IF;
  SELECT array_agg(privilege_type::text ORDER BY privilege_type) INTO v_priv
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'extension_claim_codes' AND grantee = 'service_role';
  IF v_priv IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE'] THEN
    RAISE EXCEPTION 'ECC postcondition: service_role must hold exactly {DELETE,INSERT,SELECT,UPDATE}, found %', coalesce(v_priv::text, '{}');
  END IF;
  IF has_table_privilege('service_role', 'public.extension_claim_codes', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ECC postcondition: service_role must not hold TRUNCATE';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.extension_claim_codes', p) THEN
        RAISE EXCEPTION 'ECC postcondition: % holds % on extension_claim_codes', r, p;
      END IF;
    END LOOP;
  END LOOP;
END
$postcondition$;

COMMIT;
