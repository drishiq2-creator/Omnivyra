#!/usr/bin/env python3
"""
Generator for supabase/migrations/20270217000053_credit_settle_guards_reauthor.sql (e1, 2026-11-14).

WHY A GENERATOR: 053 must be authored on the LIVE prod bodies (C100 extraction, committed under
backend/tests/fixtures/live-credit-functions-20261113, md5 = prod md5(prosrc)) so nothing that runs in prod today is
lost. Every guard is applied as an ANCHORED edit to the live text - each anchor must occur exactly once or generation
aborts - so the diff between prod and 053 is exactly the guards, reviewable hunk by hunk. The migration's postcondition
pins md5(prosrc) of the bodies this script emits.

Run from the repo root:  python scripts/migrations/gen-053-credit-settle-guards.py
It rewrites the migration and its rollback; commit both with this script.
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIX = ROOT / 'backend/tests/fixtures/live-credit-functions-20261113'
OUT = ROOT / 'supabase/migrations/20270217000053_credit_settle_guards_reauthor.sql'
RB = ROOT / 'supabase/migrations/rollbacks/credit_settle_guards_reauthor_rollback.sql'

LIVE_RES = (FIX / 'LIVE-apply_credit_reservation.prosrc.sql').read_text(encoding='utf-8')
LIVE_PC = (FIX / 'LIVE-apply_credit_partial_confirm.prosrc.sql').read_text(encoding='utf-8')
LIVE_EXP = (FIX / 'LIVE-expire_org_free_credits.prosrc.sql').read_text(encoding='utf-8')
MD5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
assert MD5(LIVE_RES) == 'ad5383bf6ccf24a2c8ddee70db3b1297', 'fixture is not the prod apply_credit_reservation body'
assert MD5(LIVE_PC) == 'ff208f60617a7a272305a804037bf47d', 'fixture is not the prod apply_credit_partial_confirm body'
assert MD5(LIVE_EXP) == 'ae410c7ab297eebe2890a7f925d95f04', 'fixture is not the prod expire_org_free_credits body'
CRLF = lambda s: s.replace('\n', '\r\n')

# ── KNOWN PRE-053 BODIES (the preflight allowlist; 7c/cb 2026-11-20) ────────────────────────────────────────────────
# Every md5 below is COMPUTED from a committed text, never typed: the prod fixtures, the 20260625 bodies a full-history
# replay installs, and 20270217000001 single_count's patch of each (000001 runs BEFORE 053). The literals in the asserts
# are checkpoints only: 000001 pins the same constants, so a drift between its patch and ours aborts generation here.
_SRC_625 = (ROOT / 'supabase/migrations/20260625_monetization_invariant_hardening.sql').read_text(encoding='utf-8')
_B625 = re.findall(r'AS \$\$(.*?)\$\$;', _SRC_625, re.S)
assert len(_B625) == 3, '20260625 no longer has exactly three $$ bodies'
R625_RES, R625_PC = _B625[1], _B625[2]
assert MD5(R625_RES) == 'c62d8dde5e3ad20a22ad6fd8ccc77154', '20260625 apply_credit_reservation body moved'
assert MD5(R625_PC) == '9591e6b38a79e6cfb02f60f19075f140', '20260625 apply_credit_partial_confirm body moved'


def single_count(body, needles):
    """20270217000001's patch: each availability needle replaced (it asserts the counts; we assert its md5s)."""
    for old, new in needles:
        body = body.replace(old, new)
    return body


SC_LIVE = single_count(LIVE_RES, [(f'GREATEST(0, v_wallet.{c}_balance{pad} - v_wallet.reserved_{c})', f'GREATEST(0, v_wallet.{c}_balance)')
                                  for c, pad in (('free', '     '), ('incentive', ''), ('paid', '     '))])
SC_625 = single_count(R625_RES, [(f'(v_wallet.{c}_balance - v_wallet.reserved_{c})', f'v_wallet.{c}_balance')
                                 for c in ('free', 'incentive', 'paid')])
assert MD5(SC_LIVE) == '03d616e692cdfb9fefc25eb81e8e4595' and MD5(CRLF(SC_LIVE)) == '90bcbfb5e9eb2eedf1a0b7a8266554bf', '000001 (prod) drift'
assert MD5(SC_625) == '7799ec2755c49c952bacd529916acc9c' and MD5(CRLF(SC_625)) == '7ee214ad28938b36d57f63eb68a9b9cd', '000001 (replay) drift'


def both_endings(*bodies):
    """LF and CRLF md5 of each body: line endings are PER FUNCTION (a Windows checkout may have applied any of them)."""
    return [m for b in bodies for m in (MD5(b), MD5(CRLF(b)))]


RES_PRE = both_endings(LIVE_RES, SC_LIVE, R625_RES, SC_625)
PC_PRE = both_endings(LIVE_PC, R625_PC)
sqlset = lambda ms: ', '.join(f"'{m}'" for m in ms)

# The unique constraints/indexes that ARE the idempotency key on credit_transactions (C100). A unique_violation on any
# other constraint is a real error and is re-raised; a key collision with no row behind it is raised too, never {id:null}.
KEY_CONSTRAINTS = "'credit_transactions_idempotency_key_key', 'credit_transactions_idempotency_key_lockdown_unique', 'idx_credit_txn_idempotency'"


def edit(text, anchor, replacement, label):
    n = text.count(anchor)
    if n != 1:
        raise SystemExit(f'anchor for "{label}" occurs {n} times (expected exactly 1)')
    return text.replace(anchor, replacement)


HANDLER_OLD = """EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_tx_row
      FROM credit_transactions
     WHERE idempotency_key = p_idempotency_key
     LIMIT 1;
    RETURN row_to_json(v_tx_row)::jsonb;
END;"""
HANDLER_NEW = f"""EXCEPTION
  WHEN unique_violation THEN
    -- 053: only a collision on the IDEMPOTENCY KEY is a replay; any other unique rule is a real error. A key
    -- collision with no row behind it is raised too - never a success-shaped {{id:null}}.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS NULL OR v_constraint NOT IN ({KEY_CONSTRAINTS}) THEN
      RAISE;
    END IF;
    SELECT * INTO v_tx_row
      FROM credit_transactions
     WHERE idempotency_key = p_idempotency_key
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDIT_IDEMPOTENCY_COLLISION_WITHOUT_ROW: %', p_idempotency_key USING ERRCODE = 'P0001';
    END IF;
    RETURN row_to_json(v_tx_row)::jsonb;
END;"""

# ── apply_credit_reservation ─────────────────────────────────────────────────────────────────────────────────────
res = LIVE_RES
res = edit(res, """  v_paid_delta      int := 0;
BEGIN""", """  v_paid_delta      int := 0;
  v_hold            credit_transactions%ROWTYPE;
  v_settled_id      uuid;
  v_constraint      text;
BEGIN
  -- ── 053 guard: amounts and key (20260625 intent; refusals, never silent clamps) ─────────────────────────────
  IF p_free_amount IS NULL OR p_incentive_amount IS NULL OR p_paid_amount IS NULL THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_NULL: phase=%', p_phase USING ERRCODE = 'P0001';
  END IF;
  IF p_free_amount < 0 OR p_incentive_amount < 0 OR p_paid_amount < 0 THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_NEGATIVE: phase=% free=% incentive=% paid=%',
      p_phase, p_free_amount, p_incentive_amount, p_paid_amount USING ERRCODE = 'P0001';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'CREDIT_IDEMPOTENCY_KEY_REQUIRED: phase=%', p_phase USING ERRCODE = 'P0001';
  END IF;
""", 'reservation: declare + amount/key guards')

res = edit(res, """  -- ── Phase dispatch ──────────────────────────────────────────────────────────""",
"""  -- ── 053 guard: settle integrity (runs AFTER the wallet lock, which serialises every credit write of this org) ──
  IF p_phase IN ('confirm', 'release') THEN
    IF p_parent_id IS NULL THEN
      RAISE EXCEPTION 'SETTLE_REQUIRES_PARENT_HOLD: phase=%', p_phase USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_hold FROM credit_transactions WHERE id = p_parent_id;
    IF NOT FOUND OR v_hold.organization_id IS DISTINCT FROM p_org_id OR v_hold.execution_phase IS DISTINCT FROM 'hold' THEN
      RAISE EXCEPTION 'SETTLE_PARENT_NOT_A_HOLD: parent=% org=%', p_parent_id, p_org_id USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO v_settled_id FROM credit_transactions
     WHERE parent_transaction_id = p_parent_id AND execution_phase IN ('confirm', 'confirm_partial', 'release')
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'HOLD_ALREADY_SETTLED: hold=% by transaction %', p_parent_id, v_settled_id USING ERRCODE = 'P0001';
    END IF;
    IF p_free_amount      > ABS(COALESCE(v_hold.free_delta, 0))
       OR p_incentive_amount > ABS(COALESCE(v_hold.incentive_delta, 0))
       OR p_paid_amount      > ABS(COALESCE(v_hold.paid_delta, 0)) THEN
      RAISE EXCEPTION 'SETTLE_EXCEEDS_HOLD: hold=%', p_parent_id USING ERRCODE = 'P0001';
    END IF;
    IF p_free_amount      > v_wallet.reserved_free
       OR p_incentive_amount > v_wallet.reserved_incentive
       OR p_paid_amount      > v_wallet.reserved_paid THEN
      RAISE EXCEPTION 'SETTLE_EXCEEDS_RESERVED: hold=%', p_parent_id USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_ONLY_FOR_SETTLE: phase=%', p_phase USING ERRCODE = 'P0001';
  END IF;

  -- ── Phase dispatch ──────────────────────────────────────────────────────────""", 'reservation: settle guards')

res = edit(res, """    v_avail_free      := GREATEST(0, v_wallet.free_balance      - v_wallet.reserved_free);
    v_avail_incentive := GREATEST(0, v_wallet.incentive_balance - v_wallet.reserved_incentive);
    v_avail_paid      := GREATEST(0, v_wallet.paid_balance      - v_wallet.reserved_paid);""",
"""    -- 053: a HOLD moves credits OUT of *_balance INTO reserved_* (see the UPDATE below), so *_balance already excludes
    -- every open hold. The live body subtracted reserved_* AGAIN, counting each open hold twice and refusing customers
    -- who had spendable credits. Availability is the balance itself (same definition as creditPriorityService).
    v_avail_free      := GREATEST(0, v_wallet.free_balance);
    v_avail_incentive := GREATEST(0, v_wallet.incentive_balance);
    v_avail_paid      := GREATEST(0, v_wallet.paid_balance);""", 'reservation: availability double-subtract')

res = edit(res, HANDLER_OLD, HANDLER_NEW, 'reservation: unique_violation handler')

# ── apply_credit_partial_confirm ─────────────────────────────────────────────────────────────────────────────────
pc = LIVE_PC
pc = edit(pc, """  v_released_total  int;
BEGIN""", """  v_released_total  int;
  v_settled_id      uuid;
  v_constraint      text;
BEGIN
  -- ── 053 guard: amounts and key ─────────────────────────────────────────────────────────────────────────────
  IF p_actual_free IS NULL OR p_actual_incentive IS NULL OR p_actual_paid IS NULL THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_NULL: partial confirm of hold %', p_hold_txn_id USING ERRCODE = 'P0001';
  END IF;
  IF p_actual_free < 0 OR p_actual_incentive < 0 OR p_actual_paid < 0 THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_NEGATIVE: partial confirm of hold %', p_hold_txn_id USING ERRCODE = 'P0001';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'CREDIT_IDEMPOTENCY_KEY_REQUIRED: partial confirm of hold %', p_hold_txn_id USING ERRCODE = 'P0001';
  END IF;
""", 'partial: declare + amount/key guards')

pc = edit(pc, """  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_credit_account: org %', p_org_id;
  END IF;
""", """  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_credit_account: org %', p_org_id;
  END IF;

  -- ── 053 guard: a hold settles ONCE (after the wallet lock, which serialises every credit write of this org) ──
  SELECT id INTO v_settled_id FROM credit_transactions
   WHERE parent_transaction_id = p_hold_txn_id AND execution_phase IN ('confirm', 'confirm_partial', 'release')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'HOLD_ALREADY_SETTLED: hold=% by transaction %', p_hold_txn_id, v_settled_id USING ERRCODE = 'P0001';
  END IF;
""", 'partial: already-settled guard')

pc = edit(pc, HANDLER_OLD, HANDLER_NEW, 'partial: unique_violation handler')

RES_SIG = """public.apply_credit_reservation(
  p_org_id           uuid,
  p_phase            text,
  p_free_amount      int  DEFAULT 0,
  p_incentive_amount int  DEFAULT 0,
  p_paid_amount      int  DEFAULT 0,
  p_idempotency_key  text DEFAULT NULL,
  p_reference_type   text DEFAULT NULL,
  p_reference_id     text DEFAULT NULL,
  p_note             text DEFAULT NULL,
  p_performed_by     uuid DEFAULT NULL,
  p_parent_id        uuid DEFAULT NULL,
  p_category         text DEFAULT 'paid'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public"""
PC_SIG = """public.apply_credit_partial_confirm(
  p_org_id uuid,
  p_hold_txn_id uuid,
  p_actual_free int DEFAULT 0,
  p_actual_incentive int DEFAULT 0,
  p_actual_paid int DEFAULT 0,
  p_idempotency_key text DEFAULT NULL,
  p_reference_type text DEFAULT NULL,
  p_reference_id text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions"""
EXP_SIG = """public.expire_org_free_credits(
  p_org_id uuid,
  p_amount int,
  p_note   text DEFAULT 'free credit expiry'
) RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public"""
RES_REG = 'public.apply_credit_reservation(uuid,text,integer,integer,integer,text,text,text,text,uuid,uuid,text)'
PC_REG = 'public.apply_credit_partial_confirm(uuid,uuid,integer,integer,integer,text,text,text,text,uuid)'
EXP_REG = 'public.expire_org_free_credits(uuid,integer,text)'

for body in (res, pc):
    assert '$fn$' not in body

HEADER = f"""-- 20270217000053 - credit settle guards, RE-AUTHORED ON THE LIVE BODIES (e1; e9-ruled BLOCKING for the enforcement flip
-- and the pricing release; version reserved by virality-83; review: virality-05). GENERATED by
-- scripts/migrations/gen-053-credit-settle-guards.py from backend/tests/fixtures/live-credit-functions-20261113 (the C100
-- extraction, md5 = prod md5(prosrc)). Do not hand-edit the function bodies: change the generator and re-run it.
--
-- WHAT IS LIVE (C98/C99/C100, 2026-11-13):
--   apply_credit_reservation     = 20260322_expiry_category_guard (md5 ad5383bf6ccf24a2c8ddee70db3b1297)
--   apply_credit_partial_confirm = a hand-applied body matching NO repo file (md5 ff208f60617a7a272305a804037bf47d)
--   expire_org_free_credits      = 20260323_remove_balance_credits (md5 ae410c7ab297eebe2890a7f925d95f04)
--
-- NOT A REPLAY (05). THREE divergent replacements of apply_credit_reservation exist in the repo, NONE live:
--   20260322_wallet_reservation (never ran - a version collision), 20260323_remove_balance_credits (has a ledger row,
--   its body is not live), 20260625_monetization_invariant_hardening (never ran). 053 does not re-run any of them: it
--   reconciles their INTENT - chiefly 20260625's settle guards - against the live bodies, carrying over only guards.
--
-- GUARDS ADDED (each a money defect on the live body; 05/e9 review 2026-11-13):
--   both functions:
--     - NULL or negative amounts refused (a negative HOLD raised the balance);
--     - the idempotency key is REQUIRED (a keyless retry applied twice);
--     - a hold settles ONCE: a confirm / confirm_partial / release child already present -> HOLD_ALREADY_SETTLED
--       (release-after-confirm refunded consumed credits; double release refunded twice). The check runs after the
--       org's wallet row lock, which both functions take first, so it is race-free per org;
--     - unique_violation: only a collision on the idempotency KEY ({KEY_CONSTRAINTS})
--       is a replay; anything else re-raises; a key collision with no row raises (no success-shaped {{id:null}}).
--   apply_credit_reservation only:
--     - confirm/release REQUIRE p_parent_id naming this org's 'hold' row; other phases refuse a parent;
--     - a settle may not exceed the hold's own split nor the wallet's reserved_* (the live GREATEST(0, ...) clamp hid it);
--     - HOLD AVAILABILITY no longer subtracts reserved_* a second time (e9 BLOCKING-launch: every open hold was counted
--       twice, refusing customers with spendable credits). Paired TS change: creditPriorityService.computeAvailable.
-- KEPT AS LIVE (losing nothing): every phase's wallet arithmetic, the expire / expire_incentive clamp semantics, the
-- partial-confirm consume/release/excess/underfunded logic, both search_paths, invoker rights, service_role-only EXECUTE.
-- DROPPED: expire_org_free_credits (20260625 intended it; no caller in code, SQL bodies, triggers or pg_cron - the
-- preflight ABORTS if any reference exists, so the drop never strands a caller).
-- SPLIT OUT (e9 allowed): the expiry leak on RELEASE (held free credits escaping their grant's expiry) needs per-grant
-- lot tracking - a follow-up version, not 053.
--
-- PRE-REQUISITE AT APPLY / ORDER (7c + cb, 2026-11-20; cb's prod read C128: both functions are the pre-000001 LF
-- bodies ad5383bf / ff208f60, and neither 20270217000001 nor 053 has a ledger row):
--   ORDER: 20270217000001 (single_count) BEFORE 053. ROLLBACK: 053 first, then 000001. 000001 refuses 053's body as an
--   unknown md5, so a reversed order fails closed instead of silently mixing.
--   BODY PREFLIGHT = an md5 ALLOWLIST ONLY, three classes per function:
--     1. a known pre-053 body: prod (ad5383bf; partial ff208f60), 000001's patch of it (03d616e6), the 20260625 bodies a
--        full-history replay installs (c62d8dde; partial 9591e6b3) and 000001's patch of that (7799ec27) - each in its
--        LF and CRLF form. Line endings are PER FUNCTION (a Windows checkout may have applied any one body CRLF); the
--        CRLF md5s are computed by the generator from the LF text, not measured;
--     2. 053's own output, LF or CRLF - a re-run. Every statement below is idempotent, so there is no "already applied"
--        branch;
--     3. anything else RAISES: the body moved and 053 must be re-generated.
--   There is no substring test: 'already settled by' accepted ANY body containing that text (an identity it is not).
--   The real-schema CI replay restores supabase/_schema/baseline.sql (a prod snapshot: ad5383bf / ff208f60) and runs
--   only versions above its ledgerMax, so it exercises the PROD class-1 path; 20260625 runs only in a full-history replay.
--   ENVELOPE PREFLIGHT (7c V1): md5(prosrc) carries nothing about privileges, so for both replaced functions the
--   preflight ALSO refuses unless the live envelope already IS what 053 installs: SECURITY INVOKER, exactly the
--   proconfig below, no EXECUTE for PUBLIC / anon / authenticated, and EXECUTE for service_role. 053 therefore changes
--   the BODY only - its REVOKE / GRANT are no-ops on an accepted database - and any envelope difference is an
--   escalation, never a silent rewrite. The postcondition then pins the same values.
--   PRE-IMAGE CAPTURE: before a class-1 body is replaced (and before expire_org_free_credits is dropped), the WHOLE
--   function is stored insert-only in migration_preimage.credit_settle_guards_053: prosrc, prosecdef, proconfig, the ACL (acldefault-expanded when NULL), the
--   owner and pg_get_functiondef (signature, defaults, RETURNS, LANGUAGE, SECURITY and SET clauses). A capture that
--   cannot be stored, or a stored pre-image that differs from the live function, fails the migration. A 053 body that
--   is live with NO stored pre-image fails too: its rollback could not be made correct (escalate to b3/owner).
--   The schema migration_preimage is not exposed through the API; the schema and the table have zero grants (owner only), the
--   table has RLS on and no policy; the postcondition asserts that posture. END OF LIFE: the capture lives until 053 is
--   rolled back; once 053 is permanent a later contract migration drops it (post-launch register row, owner c6).
--   WHY THE ROLLBACK READS THE CAPTURE: 053 outputs ONE fixed body whatever it replaced, so neither the ledger nor the
--   live md5 at rollback time can say which pre-image to restore (prod + 000001, a 20260625 replay, ...). The rollback
--   re-creates each function from its captured definition, restores the captured ACL and owner, verifies body,
--   SECURITY, proconfig, ACL and owner against the capture, and refuses unless the live body is still 053's output.
"""

CAP_SCHEMA = 'migration_preimage'
CAP = f'{CAP_SCHEMA}.credit_settle_guards_053'
RES_OUT = both_endings(res)
PC_OUT = both_endings(pc)
RES_CFG = "ARRAY['search_path=pg_catalog, public']"
PC_CFG = "ARRAY['search_path=public, extensions']"
# The comparable form of an ACL: sorted 'grantee:privilege:grantable' (grantor excluded - a restore is issued by the
# owner, whoever granted originally). grantee 0 = PUBLIC renders as '-'.
ACLSET = lambda acl: (f"ARRAY(SELECT a.grantee::regrole::text || ':' || a.privilege_type || ':' || a.is_grantable "
                      f"FROM aclexplode({acl}) a ORDER BY 1)")
LIVE_ACL = "COALESCE(p.proacl, acldefault('f', p.proowner))"

PREFLIGHT = f"""
DO $preflight$
DECLARE
  v_res text;
  v_pc  text;
  v_refs int;
  f     record;
  p     record;
BEGIN
  SELECT prosrc INTO v_res FROM pg_proc WHERE oid = to_regprocedure('{RES_REG}');
  SELECT prosrc INTO v_pc  FROM pg_proc WHERE oid = to_regprocedure('{PC_REG}');
  IF v_res IS NULL OR v_pc IS NULL THEN
    RAISE EXCEPTION '053 preflight: apply_credit_reservation / apply_credit_partial_confirm (exact signatures) missing';
  END IF;
  -- class 1 (known pre-053 bodies) or class 2 (053's own output); anything else is unknown.
  IF md5(v_res) NOT IN ({sqlset(RES_PRE)},
                        {sqlset(RES_OUT)}) THEN
    RAISE EXCEPTION '053 preflight: apply_credit_reservation body is unknown (md5 %) - it moved; re-generate 053', md5(v_res);
  END IF;
  IF md5(v_pc) NOT IN ({sqlset(PC_PRE)},
                       {sqlset(PC_OUT)}) THEN
    RAISE EXCEPTION '053 preflight: apply_credit_partial_confirm body is unknown (md5 %) - it moved; re-generate 053', md5(v_pc);
  END IF;
  -- ENVELOPE: the live function must already be what 053 installs (053 then changes the body only).
  FOR f IN SELECT * FROM (VALUES ('{RES_REG}', {RES_CFG}),
                                 ('{PC_REG}', {PC_CFG})) AS t(fn, cfg) LOOP
    SELECT p0.prosecdef, p0.proconfig, {LIVE_ACL.replace('p.', 'p0.')} AS acl INTO p FROM pg_proc p0 WHERE p0.oid = to_regprocedure(f.fn);
    IF p.prosecdef THEN
      RAISE EXCEPTION '053 preflight: % is SECURITY DEFINER - 053 would make it INVOKER; escalate, nothing changed', f.fn;
    END IF;
    IF p.proconfig IS DISTINCT FROM f.cfg THEN
      RAISE EXCEPTION '053 preflight: % proconfig is % - 053 would install %; escalate, nothing changed', f.fn, p.proconfig, f.cfg;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(p.acl) a
                WHERE a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))) THEN
      RAISE EXCEPTION '053 preflight: PUBLIC / anon / authenticated hold a privilege on % (%) - 053 would revoke it; escalate, nothing changed',
        f.fn, {ACLSET('p.acl')};
    END IF;
    IF NOT EXISTS (SELECT 1 FROM aclexplode(p.acl) a JOIN pg_roles r ON r.oid = a.grantee
                    WHERE r.rolname = 'service_role' AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '053 preflight: service_role cannot EXECUTE % - 053 would grant it; escalate, nothing changed', f.fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'credit_transactions'
                  AND column_name = 'parent_transaction_id') THEN
    RAISE EXCEPTION '053 preflight: credit_transactions.parent_transaction_id is missing';
  END IF;
  -- expire_org_free_credits may be dropped only if NOTHING references it.
  IF to_regprocedure('{EXP_REG}') IS NOT NULL THEN
    SELECT count(*) INTO v_refs FROM pg_proc
     WHERE prosrc ILIKE '%expire_org_free_credits%' AND oid <> to_regprocedure('{EXP_REG}');
    IF v_refs > 0 THEN
      RAISE EXCEPTION '053 preflight: % function body(ies) reference expire_org_free_credits - it cannot be dropped', v_refs;
    END IF;
    IF to_regclass('cron.job') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM cron.job WHERE command ILIKE ''%expire_org_free_credits%''' INTO v_refs;
      IF v_refs > 0 THEN
        RAISE EXCEPTION '053 preflight: % pg_cron job(s) call expire_org_free_credits - it cannot be dropped', v_refs;
      END IF;
    END IF;
  END IF;
END
$preflight$;

-- Pre-053 functions, captured WHOLE for the rollback (see header). Not API-exposed; owner-only; RLS on, no policy.
CREATE SCHEMA IF NOT EXISTS {CAP_SCHEMA};
REVOKE ALL ON SCHEMA {CAP_SCHEMA} FROM PUBLIC;
CREATE TABLE IF NOT EXISTS {CAP} (
  fn          text        PRIMARY KEY CHECK (fn IN ('{RES_REG}',
                                                    '{PC_REG}',
                                                    '{EXP_REG}')),
  prosrc      text        NOT NULL,
  prosrc_md5  text        NOT NULL,
  prosecdef   boolean     NOT NULL,
  proconfig   text[],
  proacl      aclitem[]   NOT NULL,   -- acldefault-expanded when the catalog ACL is NULL
  proowner    text        NOT NULL,   -- role name
  functiondef text        NOT NULL,   -- pg_get_functiondef: signature, defaults, RETURNS, LANGUAGE, SECURITY, SET
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_settle_guards_053_md5 CHECK (prosrc_md5 = md5(prosrc))
);
ALTER TABLE {CAP} ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE {CAP} FROM PUBLIC;
DO $revoke$
DECLARE r text;
BEGIN
  -- every non-owner grantee on the schema and the table, including any a default-privilege rule added.
  FOR r IN SELECT DISTINCT a.grantee::regrole::text FROM pg_namespace n, aclexplode(n.nspacl) a
            WHERE n.nspname = '{CAP_SCHEMA}' AND a.grantee <> 0 AND a.grantee <> n.nspowner LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA {CAP_SCHEMA} FROM %s', r);
  END LOOP;
  FOR r IN SELECT DISTINCT a.grantee::regrole::text FROM pg_class c, aclexplode(c.relacl) a
            WHERE c.oid = '{CAP}'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE {CAP} FROM %s', r);
  END LOOP;
END
$revoke$;

DO $capture$
DECLARE
  f   record;
  liv record;
  cap record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
      ('{RES_REG}', ARRAY[{sqlset(RES_PRE)}], ARRAY[{sqlset(RES_OUT)}]),
      ('{PC_REG}', ARRAY[{sqlset(PC_PRE)}], ARRAY[{sqlset(PC_OUT)}]),
      ('{EXP_REG}', NULL::text[], NULL::text[])) AS t(fn, pre, out) LOOP
    SELECT p.prosrc, md5(p.prosrc) AS m, p.prosecdef, p.proconfig, {LIVE_ACL} AS acl, p.proowner::regrole::text AS owner,
           pg_get_functiondef(p.oid) AS def
      INTO liv FROM pg_proc p WHERE p.oid = to_regprocedure(f.fn);
    CONTINUE WHEN liv.prosrc IS NULL;                     -- only expire_org_free_credits can be absent (preflight)
    IF f.pre IS NULL OR liv.m = ANY (f.pre) THEN          -- class 1 (expire: whatever is live; 053 drops it)
      INSERT INTO {CAP} (fn, prosrc, prosrc_md5, prosecdef, proconfig, proacl, proowner, functiondef)
      VALUES (f.fn, liv.prosrc, liv.m, liv.prosecdef, liv.proconfig, liv.acl, liv.owner, liv.def)
      ON CONFLICT (fn) DO NOTHING;
      SELECT * INTO cap FROM {CAP} WHERE fn = f.fn;
      IF cap.prosrc_md5 IS DISTINCT FROM liv.m OR cap.prosecdef IS DISTINCT FROM liv.prosecdef
         OR cap.proconfig IS DISTINCT FROM liv.proconfig OR cap.proowner IS DISTINCT FROM liv.owner
         OR {ACLSET('cap.proacl')} IS DISTINCT FROM {ACLSET('liv.acl')} THEN
        RAISE EXCEPTION '053 capture: % already holds a DIFFERENT pre-053 function (stored md5 %, live md5 %) - the rollback could not be made correct; escalate',
          f.fn, cap.prosrc_md5, liv.m;
      END IF;
    ELSIF liv.m = ANY (f.out) THEN                         -- class 2: a re-run; the pre-image must already be stored
      IF NOT EXISTS (SELECT 1 FROM {CAP} WHERE fn = f.fn) THEN
        RAISE EXCEPTION '053 capture: % is already 053''s body but NO pre-053 function is stored - its rollback could not be made correct; escalate', f.fn;
      END IF;
    ELSE
      RAISE EXCEPTION '053 capture: % is neither a known pre-053 body nor 053''s output (md5 %)', f.fn, liv.m;
    END IF;
  END LOOP;
END
$capture$;
"""

POST = f"""
DO $verify$
DECLARE
  r text;
BEGIN
  IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('{RES_REG}')), '') NOT IN ({sqlset(RES_OUT)}) THEN
    RAISE EXCEPTION '053 postcondition: apply_credit_reservation body is not the generated one';
  END IF;
  IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('{PC_REG}')), '') NOT IN ({sqlset(PC_OUT)}) THEN
    RAISE EXCEPTION '053 postcondition: apply_credit_partial_confirm body is not the generated one';
  END IF;
  -- PRIVILEGE: both stay SECURITY INVOKER, as the preflight required them to be before 053.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('{RES_REG}'))
     OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('{PC_REG}')) THEN
    RAISE EXCEPTION '053 postcondition: a credit function became SECURITY DEFINER (pre-053: invoker rights)';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure('{RES_REG}')) IS DISTINCT FROM {RES_CFG}
     OR (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure('{PC_REG}')) IS DISTINCT FROM {PC_CFG} THEN
    RAISE EXCEPTION '053 postcondition: a credit function''s proconfig is not the pre-053 one';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, '{RES_REG}', 'EXECUTE') OR has_function_privilege(r, '{PC_REG}', 'EXECUTE') THEN
      RAISE EXCEPTION '053 postcondition: % can execute a credit settle function', r;
    END IF;
  END LOOP;
  IF to_regprocedure('{EXP_REG}') IS NOT NULL THEN
    RAISE EXCEPTION '053 postcondition: expire_org_free_credits still exists';
  END IF;
  -- The rollback's pre-images exist for both replaced functions; the capture is owner-only.
  IF (SELECT count(*) FROM {CAP} WHERE fn IN ('{RES_REG}', '{PC_REG}')) <> 2 THEN
    RAISE EXCEPTION '053 postcondition: a pre-053 function is not captured';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = '{CAP}'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = '{CAP}'::regclass)
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = '{CAP}'::regclass AND a.grantee <> c.relowner)
     OR EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = '{CAP_SCHEMA}' AND a.grantee <> n.nspowner) THEN
    RAISE EXCEPTION '053 postcondition: {CAP} is not owner-only (schema + table zero grants, RLS on, no policy)';
  END IF;
END
$verify$;
"""

mig = (HEADER + PREFLIGHT
       + f"\nCREATE OR REPLACE FUNCTION {RES_SIG}\nAS $fn${res}$fn$;\n"
       + f"REVOKE ALL ON FUNCTION {RES_REG} FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION {RES_REG} TO service_role;\n"
       + f"\nCREATE OR REPLACE FUNCTION {PC_SIG}\nAS $fn${pc}$fn$;\n"
       + f"REVOKE ALL ON FUNCTION {PC_REG} FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION {PC_REG} TO service_role;\n"
       + f"\nDROP FUNCTION IF EXISTS {EXP_REG};\n"
       + POST
       + "\n-- ROLLBACK: supabase/migrations/rollbacks/credit_settle_guards_reauthor_rollback.sql (re-creates the CAPTURED pre-053 functions)\n")


def restore(reg, label):
    return f"""
  -- {label}
  SELECT * INTO cap FROM {CAP} WHERE fn = '{reg}';
  IF NOT FOUND THEN
    RAISE EXCEPTION '053 rollback: no captured pre-053 function for {label} - nothing restored; escalate';
  END IF;
  EXECUTE cap.functiondef;                                   -- the whole captured definition (SECURITY, SET included)
  IF (SELECT proowner::regrole::text FROM pg_proc WHERE oid = to_regprocedure('{reg}')) IS DISTINCT FROM cap.proowner THEN
    EXECUTE format('ALTER FUNCTION {reg} OWNER TO %s', cap.proowner);
  END IF;
  FOR g IN SELECT DISTINCT x.grantee FROM pg_proc p, aclexplode({LIVE_ACL}) x WHERE p.oid = to_regprocedure('{reg}') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION {reg} FROM %s', CASE g.grantee WHEN 0 THEN 'PUBLIC' ELSE g.grantee::regrole::text END);
  END LOOP;
  FOR g IN SELECT * FROM aclexplode(cap.proacl) LOOP
    EXECUTE format('GRANT %s ON FUNCTION {reg} TO %s%s', g.privilege_type,
      CASE g.grantee WHEN 0 THEN 'PUBLIC' ELSE g.grantee::regrole::text END,
      CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  SELECT p.prosrc, p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner, {LIVE_ACL} AS acl
    INTO liv FROM pg_proc p WHERE p.oid = to_regprocedure('{reg}');
  IF md5(liv.prosrc) IS DISTINCT FROM cap.prosrc_md5 OR liv.prosecdef IS DISTINCT FROM cap.prosecdef
     OR liv.proconfig IS DISTINCT FROM cap.proconfig OR liv.owner IS DISTINCT FROM cap.proowner
     OR {ACLSET('liv.acl')} IS DISTINCT FROM {ACLSET('cap.proacl')} THEN
    RAISE EXCEPTION '053 rollback: restored {label} differs from the capture (body, SECURITY, proconfig, owner or ACL)';
  END IF;
"""


rb = (f"""-- Rollback of 20270217000053_credit_settle_guards_reauthor.sql (e1, c6). GENERATED by
-- scripts/migrations/gen-053-credit-settle-guards.py. Re-creates EXACTLY the pre-053 functions 053 captured in
-- {CAP} (per function: prod, prod + 20270217000001, or a 20260625 replay - the live md5 cannot tell
-- which, see the 053 header): each from its captured pg_get_functiondef (signature, defaults, RETURNS, LANGUAGE,
-- SECURITY and SET clauses), then the captured owner and ACL; it VERIFIES body md5, prosecdef, proconfig, owner and
-- ACL against the capture, then drops the capture (and its schema when empty).
-- ORDER: roll back 053 BEFORE 20270217000001. One DO block: all or nothing.
-- It REFUSES unless both live bodies are still 053's output, so it never undoes a later change.
DO $rollback$
DECLARE
  cap record;
  liv record;
  g   record;
BEGIN
  IF to_regclass('{CAP}') IS NULL THEN
    RAISE EXCEPTION '053 rollback: {CAP} is missing - no pre-053 function to restore; escalate';
  END IF;
  IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('{RES_REG}')), '') <> ALL (ARRAY[{sqlset(RES_OUT)}])
     OR COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('{PC_REG}')), '') <> ALL (ARRAY[{sqlset(PC_OUT)}]) THEN
    RAISE EXCEPTION '053 rollback: a live credit body is not 053''s output - something changed it after 053; nothing restored';
  END IF;
{restore(RES_REG, 'apply_credit_reservation')}{restore(PC_REG, 'apply_credit_partial_confirm')}
  -- expire_org_free_credits: restored only if it existed when 053 ran (053 dropped it).
  IF EXISTS (SELECT 1 FROM {CAP} WHERE fn = '{EXP_REG}') THEN
    IF to_regprocedure('{EXP_REG}') IS NOT NULL THEN
      RAISE EXCEPTION '053 rollback: expire_org_free_credits exists again - something recreated it after 053; nothing restored';
    END IF;
{restore(EXP_REG, 'expire_org_free_credits')}  END IF;

  DROP TABLE {CAP};
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = '{CAP_SCHEMA}'::regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = '{CAP_SCHEMA}'::regnamespace) THEN
    DROP SCHEMA {CAP_SCHEMA};
  END IF;
END
$rollback$;
""")

OUT.write_text(mig, encoding='utf-8', newline='\n')
RB.write_text(rb, encoding='utf-8', newline='\n')
print('apply_credit_reservation md5 ', MD5(res))
print('apply_credit_partial_confirm md5', MD5(pc))
print('wrote', OUT.relative_to(ROOT), 'and', RB.relative_to(ROOT))
