/**
 * Real-schema cover for 20270217000053 credit_settle_guards_reauthor (e1; e9-ruled BLOCKING for the enforcement flip and
 * the pricing release). The guards ARE Postgres behaviour, so they are proven here on real rows:
 *   BEFORE: the LIVE prod bodies (committed C100 fixtures, md5 = prod) are installed inside a rolled-back transaction and
 *           shown to HAVE each defect - so the defect list is real, not assumed;
 *   AFTER:  the 053 bodies (installed by the replay) refuse each one, keep the live arithmetic, and two connections
 *           settling one hold concurrently produce exactly one settle.
 * Synthetic org ids only (disposable replay DB; the suite refuses a non-loopback W6_DB_URL).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { db, inRollback } from './setup';
import { expireOrgFreeCreditsProductionState } from './pre053FunctionState';

const URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(URL)) throw new Error('credit_settle_guards_053 refuses a non-loopback W6_DB_URL');

const ORG = '0eda0053-0000-4000-8000-000000000053';
const FIX = path.join(__dirname, '..', 'fixtures', 'live-credit-functions-20261113');
const LIVE_RES = fs.readFileSync(path.join(FIX, 'LIVE-apply_credit_reservation.prosrc.sql'), 'utf8');
const LIVE_PC = fs.readFileSync(path.join(FIX, 'LIVE-apply_credit_partial_confirm.prosrc.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/rollbacks/credit_settle_guards_reauthor_rollback.sql'), 'utf8');

// No params -> the simple-query protocol, which allows a multi-statement script (the rollback file).
const q = (sql: string, params: unknown[] = []) => (params.length ? db.query(sql, params) : db.query(sql));

/** Run on the shared connection inside a savepoint; 'ok' or the error message. */
async function attempt(sql: string, params: unknown[] = []): Promise<string> {
  await q('SAVEPOINT g053');
  try { await q(sql, params); await q('RELEASE SAVEPOINT g053'); return 'ok'; }
  catch (e: any) { await q('ROLLBACK TO SAVEPOINT g053'); return String(e.message); }
}

type Phase = 'hold' | 'confirm' | 'release' | 'grant' | 'expire';
function res(phase: Phase, free: number | null, key: string | null, parent: string | null = null): [string, unknown[]] {
  return [
    `SELECT public.apply_credit_reservation(p_org_id => $1, p_phase => $2, p_free_amount => $3, p_idempotency_key => $4,
       p_parent_id => $5, p_reference_type => 'g053', p_category => 'free')`,
    [ORG, phase, free, key, parent],
  ];
}
const run = (phase: Phase, free: number | null, key: string | null, parent: string | null = null) => attempt(...res(phase, free, key, parent));
const pc = (hold: string, actual: number, key: string) => attempt(
  `SELECT public.apply_credit_partial_confirm(p_org_id => $1, p_hold_txn_id => $2, p_actual_free => $3, p_idempotency_key => $4)`,
  [ORG, hold, actual, key]);
const idOf = async (key: string) => (await q('SELECT id FROM public.credit_transactions WHERE idempotency_key = $1', [key])).rows[0]?.id as string;
const wallet = async () => (await q('SELECT free_balance, reserved_free FROM public.organization_credits WHERE organization_id = $1', [ORG])).rows[0];

/** 300 free credits granted, then a 50 hold. */
async function seed(prefix: string): Promise<string> {
  await q('INSERT INTO public.organization_credits (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [ORG]);
  expect(await run('grant', 300, `${prefix}:grant`)).toBe('ok');
  expect(await run('hold', 50, `${prefix}:hold`)).toBe('ok');
  return idOf(`${prefix}:hold`);
}

async function installLiveBodies(resBody: string = LIVE_RES, pcBody: string = LIVE_PC): Promise<void> {
  await q(`CREATE OR REPLACE FUNCTION public.apply_credit_reservation(p_org_id uuid, p_phase text, p_free_amount int DEFAULT 0,
    p_incentive_amount int DEFAULT 0, p_paid_amount int DEFAULT 0, p_idempotency_key text DEFAULT NULL,
    p_reference_type text DEFAULT NULL, p_reference_id text DEFAULT NULL, p_note text DEFAULT NULL,
    p_performed_by uuid DEFAULT NULL, p_parent_id uuid DEFAULT NULL, p_category text DEFAULT 'paid')
    RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$` + resBody + '$fn$');
  await q(`CREATE OR REPLACE FUNCTION public.apply_credit_partial_confirm(p_org_id uuid, p_hold_txn_id uuid,
    p_actual_free int DEFAULT 0, p_actual_incentive int DEFAULT 0, p_actual_paid int DEFAULT 0,
    p_idempotency_key text DEFAULT NULL, p_reference_type text DEFAULT NULL, p_reference_id text DEFAULT NULL,
    p_note text DEFAULT NULL, p_performed_by uuid DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql SET search_path = public, extensions AS $fn$` + pcBody + '$fn$');
}

// ── pre-image capture + rollback (7c/cb 2026-11-20) ─────────────────────────────────────────────────────────────────
const MIG = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20270217000053_credit_settle_guards_reauthor.sql'), 'utf8');
const CAP = 'migration_preimage.credit_settle_guards_053';
const RES_REG = 'public.apply_credit_reservation(uuid,text,integer,integer,integer,text,text,text,text,uuid,uuid,text)';
const PC_REG = 'public.apply_credit_partial_confirm(uuid,uuid,integer,integer,integer,text,text,text,text,uuid)';
const EXP_REG = 'public.expire_org_free_credits(uuid,integer,text)';
const OUT_RES = '5242c45fa92183090997c4bb4f6b8189';
const OUT_PC = '71b0c840b1eb3116b4e53ec840aa4d19';
/** 20270217000001 single_count's patch of the prod body; pinned below to 000001's own output md5 (03d616e6). */
const SC_LIVE = LIVE_RES
  .replace('GREATEST(0, v_wallet.free_balance      - v_wallet.reserved_free)', 'GREATEST(0, v_wallet.free_balance)')
  .replace('GREATEST(0, v_wallet.incentive_balance - v_wallet.reserved_incentive)', 'GREATEST(0, v_wallet.incentive_balance)')
  .replace('GREATEST(0, v_wallet.paid_balance      - v_wallet.reserved_paid)', 'GREATEST(0, v_wallet.paid_balance)');
const liveMd5 = async (reg: string) =>
  (await q('SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = to_regprocedure($1)', [reg])).rows[0]?.m ?? null;
const captured = async (): Promise<Record<string, string>> =>
  Object.fromEntries((await q(`SELECT fn, prosrc_md5 FROM ${CAP}`)).rows.map((r: any) => [r.fn, r.prosrc_md5]));
const capTableExists = async () => (await q(`SELECT to_regclass('${CAP}') IS NOT NULL AS e`)).rows[0].e as boolean;
/** The whole envelope of a function: body md5, SECURITY, proconfig, owner and the ACL as a sorted grantee:priv:grantable set. */
const envelope = async (reg: string) => (await q(`SELECT md5(p.prosrc) AS md5, p.prosecdef AS secdef, p.proconfig AS cfg,
    p.proowner::regrole::text AS owner,
    ARRAY(SELECT a.grantee::regrole::text || ':' || a.privilege_type || ':' || a.is_grantable
            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a ORDER BY 1) AS acl
  FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [reg])).rows[0] ?? null;
/** A database in PRODUCTION's pre-053 shape: no capture rows yet, expire_org_free_credits present, given bodies live. */
async function prodShape(resBody: string, pcBody: string = LIVE_PC): Promise<void> {
  await q(`DELETE FROM ${CAP}`);
  await expireOrgFreeCreditsProductionState();
  await installLiveBodies(resBody, pcBody);
}

describe('BEFORE - the LIVE prod bodies have each defect (installed in a rolled-back transaction)', () => {
  it('release after confirm succeeds and refunds consumed credits; availability double-subtracts; negative hold raises balance', async () => {
    await inRollback(async () => {
      await installLiveBodies();
      const hold = await seed('b1');
      expect(await wallet()).toEqual({ free_balance: 250, reserved_free: 50 });
      expect(await run('hold', 250, 'b1:hold2')).toMatch(/insufficient free balance/);      // 250 spendable, refused
      expect(await run('confirm', 50, 'b1:confirm', hold)).toBe('ok');
      expect(await run('release', 50, 'b1:release', hold)).toBe('ok');                     // DOUBLE SETTLE accepted
      expect((await wallet()).free_balance).toBe(300);                                       // consumed credits refunded
      expect(await run('hold', -10, 'b1:neg')).toBe('ok');                                   // negative hold accepted
    });
  });
});

describe('AFTER - 053 refuses each defect and keeps the live arithmetic', () => {
  it('availability: 300 granted, 50 held -> a 250 hold succeeds (no double subtraction)', async () => {
    await inRollback(async () => {
      await seed('a1');
      expect(await run('hold', 250, 'a1:hold2')).toBe('ok');
      expect(await wallet()).toEqual({ free_balance: 0, reserved_free: 300 });
      expect(await run('hold', 1, 'a1:hold3')).toMatch(/insufficient free balance/);
    });
  });

  it('a hold settles ONCE: release after confirm, double release, confirm after release are refused', async () => {
    await inRollback(async () => {
      const hold = await seed('a2');
      expect(await run('confirm', 50, 'a2:confirm', hold)).toBe('ok');
      expect(await run('release', 50, 'a2:release', hold)).toMatch(/HOLD_ALREADY_SETTLED/);
      expect(await wallet()).toEqual({ free_balance: 250, reserved_free: 0 });
      const h2 = (await run('hold', 10, 'a2:h2'), await idOf('a2:h2'));
      expect(await run('release', 10, 'a2:r1', h2)).toBe('ok');
      expect(await run('release', 10, 'a2:r2', h2)).toMatch(/HOLD_ALREADY_SETTLED/);
      expect(await run('confirm', 10, 'a2:c2', h2)).toMatch(/HOLD_ALREADY_SETTLED/);
    });
  });

  it('settle needs a real parent hold of this org, may not exceed it, and other phases refuse a parent', async () => {
    await inRollback(async () => {
      const hold = await seed('a3');
      expect(await run('confirm', 10, 'a3:c-noparent')).toMatch(/SETTLE_REQUIRES_PARENT_HOLD/);
      const grantId = await idOf('a3:grant');
      expect(await run('confirm', 10, 'a3:c-notahold', grantId)).toMatch(/SETTLE_PARENT_NOT_A_HOLD/);
      expect(await run('confirm', 51, 'a3:c-over', hold)).toMatch(/SETTLE_EXCEEDS_HOLD/);
      expect(await run('grant', 5, 'a3:g-parent', hold)).toMatch(/PARENT_ONLY_FOR_SETTLE/);
    });
  });

  it('negative / NULL amounts and a missing key are refused', async () => {
    await inRollback(async () => {
      await seed('a4');
      expect(await run('hold', -10, 'a4:neg')).toMatch(/CREDIT_AMOUNT_NEGATIVE/);
      expect(await run('hold', null, 'a4:null')).toMatch(/CREDIT_AMOUNT_NULL/);
      expect(await run('hold', 10, null)).toMatch(/CREDIT_IDEMPOTENCY_KEY_REQUIRED/);
      expect(await run('hold', 10, '   ')).toMatch(/CREDIT_IDEMPOTENCY_KEY_REQUIRED/);
    });
  });

  it('a replay with the same key still returns the existing row (idempotency kept)', async () => {
    await inRollback(async () => {
      await seed('a5');
      const before = await wallet();
      expect(await run('hold', 50, 'a5:hold')).toBe('ok');
      expect(await wallet()).toEqual(before);
    });
  });

  it('partial confirm settles once: a second partial confirm or a later release of the same hold is refused', async () => {
    await inRollback(async () => {
      const hold = await seed('a6');
      expect(await pc(hold, 20, 'a6:pc1')).toBe('ok');
      expect(await wallet()).toEqual({ free_balance: 280, reserved_free: 0 });   // 30 returned with the partial settle
      expect(await pc(hold, 20, 'a6:pc2')).toMatch(/HOLD_ALREADY_SETTLED/);
      expect(await run('release', 50, 'a6:release', hold)).toMatch(/HOLD_ALREADY_SETTLED/);
      expect(await pc(hold, -1, 'a6:neg')).toMatch(/CREDIT_AMOUNT_NEGATIVE/);
    });
  });

  it('expire keeps the live clamp: expiring more than the free balance drains it to 0, never negative', async () => {
    await inRollback(async () => {
      await seed('a7');
      expect(await run('expire', 1000, 'a7:expire')).toBe('ok');
      expect(await wallet()).toEqual({ free_balance: 0, reserved_free: 50 });  // the hold's 50 is untouched
    });
  });

  it('expire_org_free_credits is dropped; the credit functions keep invoker rights and their live search_path', async () => {
    const { rows } = await q(`SELECT to_regprocedure('public.expire_org_free_credits(uuid,integer,text)') AS f,
      (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.apply_credit_reservation(uuid,text,integer,integer,integer,text,text,text,text,uuid,uuid,text)')) AS r_def,
      (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure('public.apply_credit_partial_confirm(uuid,uuid,integer,integer,integer,text,text,text,text,uuid)')) AS pc_cfg`);
    expect(rows[0].f).toBeNull();
    expect(rows[0].r_def).toBe(false);
    expect(rows[0].pc_cfg).toEqual(['search_path=public, extensions']);
  });

  it('replay: 053 captured the bodies it replaced (the baseline = prod body, or 000001 over it), and the capture table is owner-only', async () => {
    // The CI replay restores supabase/_schema/baseline.sql (a prod snapshot) and replays only versions above its ledgerMax,
    // so 20260625 never runs here: the replaced bodies are prod's (000001's patch once 000001 is in the tree).
    const cap = await captured();
    expect(['ad5383bf6ccf24a2c8ddee70db3b1297', '03d616e692cdfb9fefc25eb81e8e4595']).toContain(cap[RES_REG]);
    expect(cap[PC_REG]).toBe('ff208f60617a7a272305a804037bf47d');
    const { rows } = await q(`SELECT c.relrowsecurity AS rls,
        (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
        (SELECT count(*)::int FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) AS grants
      FROM pg_class c WHERE c.oid = '${CAP}'::regclass`);
    expect(rows[0]).toEqual({ rls: true, policies: 0, grants: 0 });
    for (const r of ['anon', 'authenticated', 'service_role']) {
      const { rows: p } = await q(`SELECT has_table_privilege($1, '${CAP}', 'SELECT') AS s, has_table_privilege($1, '${CAP}', 'INSERT') AS i,
        has_schema_privilege($1, 'migration_preimage', 'USAGE') AS u`, [r]);
      expect(p[0]).toEqual({ s: false, i: false, u: false });
    }
  });

  it('replay: the rollback restores EXACTLY the captured functions (body AND envelope) and drops the capture + schema', async () => {
    await inRollback(async () => {
      const { rows } = await q(`SELECT fn, prosrc_md5 AS md5, prosecdef AS secdef, proconfig AS cfg, proowner AS owner,
        ARRAY(SELECT a.grantee::regrole::text || ':' || a.privilege_type || ':' || a.is_grantable FROM aclexplode(proacl) a ORDER BY 1) AS acl
        FROM ${CAP}`);
      expect(rows.map((r: any) => r.fn).sort()).toEqual([EXP_REG, PC_REG, RES_REG].sort());
      expect(await attempt(ROLLBACK)).toBe('ok');
      for (const r of rows) {
        const { fn, ...want } = r;
        expect(await envelope(fn)).toEqual(want);
      }
      expect(await capTableExists()).toBe(false);
      expect((await q(`SELECT to_regnamespace('migration_preimage') IS NULL AS gone`)).rows[0].gone).toBe(true);
    });
  });
});

describe('PROD PATH - prod body -> 20270217000001 -> 053 -> rollback (cb C128: prod = ad5383bf / ff208f60, both unapplied)', () => {
  it('the 000001 stand-in is byte-exact: its md5 is 000001\'s own pinned output', () => {
    expect(crypto.createHash('md5').update(SC_LIVE).digest('hex')).toBe('03d616e692cdfb9fefc25eb81e8e4595');
  });

  it('053 over 000001: captures 03d616e6, re-runs idempotently, and the rollback KEEPS 000001\'s fix (not the prod body)', async () => {
    await inRollback(async () => {
      await prodShape(SC_LIVE);
      expect(await liveMd5(RES_REG)).toBe('03d616e692cdfb9fefc25eb81e8e4595');
      expect(await attempt(MIG)).toBe('ok');
      expect([await liveMd5(RES_REG), await liveMd5(PC_REG), await liveMd5(EXP_REG)]).toEqual([OUT_RES, OUT_PC, null]);
      const cap = await captured();
      expect(cap).toEqual({
        [RES_REG]: '03d616e692cdfb9fefc25eb81e8e4595',
        [PC_REG]: 'ff208f60617a7a272305a804037bf47d',
        [EXP_REG]: 'ae410c7ab297eebe2890a7f925d95f04',
      });
      expect(await attempt(MIG)).toBe('ok');                   // class 2: a re-run, no "already applied" branch
      expect(await captured()).toEqual(cap);                   // nothing re-captured
      expect(await attempt(ROLLBACK)).toBe('ok');
      expect([await liveMd5(RES_REG), await liveMd5(PC_REG), await liveMd5(EXP_REG)])
        .toEqual(['03d616e692cdfb9fefc25eb81e8e4595', 'ff208f60617a7a272305a804037bf47d', 'ae410c7ab297eebe2890a7f925d95f04']);
      expect(await capTableExists()).toBe(false);
    });
  });

  it('053 straight over the prod body (no 000001): the rollback restores ad5383bf', async () => {
    await inRollback(async () => {
      await prodShape(LIVE_RES);
      expect(await attempt(MIG)).toBe('ok');
      expect(await attempt(ROLLBACK)).toBe('ok');
      expect(await liveMd5(RES_REG)).toBe('ad5383bf6ccf24a2c8ddee70db3b1297');
    });
  });

  it('a full-history replay (the 20260625 bodies c62d8dde / 9591e6b3): accepted, and the rollback restores them', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260625_monetization_invariant_hardening.sql'), 'utf8');
    const b = [...src.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1]);
    await inRollback(async () => {
      await prodShape(b[1], b[2]);
      expect([await liveMd5(RES_REG), await liveMd5(PC_REG)]).toEqual(['c62d8dde5e3ad20a22ad6fd8ccc77154', '9591e6b38a79e6cfb02f60f19075f140']);
      expect(await attempt(MIG)).toBe('ok');
      expect(await attempt(ROLLBACK)).toBe('ok');
      expect([await liveMd5(RES_REG), await liveMd5(PC_REG)]).toEqual(['c62d8dde5e3ad20a22ad6fd8ccc77154', '9591e6b38a79e6cfb02f60f19075f140']);
    });
  });

  it('a CRLF-applied prod body (1db00c4d) is accepted and restored byte-for-byte, CR included', async () => {
    await inRollback(async () => {
      await prodShape(LIVE_RES.replace(/\n/g, '\r\n'));
      expect(await liveMd5(RES_REG)).toBe('1db00c4d06a4a16c84ed419c4cc47bf6');
      expect(await attempt(MIG)).toBe('ok');
      expect(await attempt(ROLLBACK)).toBe('ok');
      expect(await liveMd5(RES_REG)).toBe('1db00c4d06a4a16c84ed419c4cc47bf6');
    });
  });

  it('an UNKNOWN body is refused and nothing is captured or replaced', async () => {
    await inRollback(async () => {
      await prodShape(LIVE_RES + '\n-- drift\n');
      expect(await attempt(MIG)).toMatch(/053 preflight: apply_credit_reservation body is unknown/);
      expect(await captured()).toEqual({});
      expect(await liveMd5(RES_REG)).not.toBe(OUT_RES);
    });
  });

  it('053 live with NO stored pre-image -> refused (its rollback could not be made correct)', async () => {
    await inRollback(async () => {
      await q(`DELETE FROM ${CAP}`);
      expect(await attempt(MIG)).toMatch(/is already 053's body but NO pre-053 function is stored/);
    });
  });

  it('a stored pre-image that differs from the live class-1 body -> refused (insert-only, never overwritten)', async () => {
    await inRollback(async () => {
      await prodShape(LIVE_RES);
      await q(`INSERT INTO ${CAP} (fn, prosrc, prosrc_md5, prosecdef, proconfig, proacl, proowner, functiondef)
        SELECT $1, $2, md5($2), false, proconfig, COALESCE(proacl, acldefault('f', proowner)), proowner::regrole::text, 'x'
          FROM pg_proc WHERE oid = to_regprocedure($1)`, [RES_REG, SC_LIVE]);
      expect(await attempt(MIG)).toMatch(/already holds a DIFFERENT pre-053 function/);
    });
  });

  it('the rollback refuses when a live body is no longer 053\'s output (never undoes a later change)', async () => {
    await inRollback(async () => {
      await installLiveBodies(SC_LIVE);
      expect(await attempt(ROLLBACK)).toMatch(/a live credit body is not 053's output/);
      expect(await capTableExists()).toBe(true);
    });
  });

  // ── ENVELOPE (7c V1): 053 changes the body ONLY; any envelope difference is refused before anything changes ──
  it.each([
    ['SECURITY DEFINER', `ALTER FUNCTION ${RES_REG} SECURITY DEFINER`, /is SECURITY DEFINER - 053 would make it INVOKER/],
    ['a different search_path', `ALTER FUNCTION ${PC_REG} SET search_path = public`, /proconfig is .* - 053 would install/],
    ['EXECUTE for authenticated', `GRANT EXECUTE ON FUNCTION ${RES_REG} TO authenticated`, /PUBLIC \/ anon \/ authenticated hold a privilege/],
    ['EXECUTE for PUBLIC', `GRANT EXECUTE ON FUNCTION ${PC_REG} TO PUBLIC`, /PUBLIC \/ anon \/ authenticated hold a privilege/],
    ['no EXECUTE for service_role', `REVOKE EXECUTE ON FUNCTION ${RES_REG} FROM service_role`, /service_role cannot EXECUTE/],
  ])('preflight refuses a live envelope with %s, and nothing is captured or replaced', async (_l, alter, msg) => {
    await inRollback(async () => {
      await prodShape(LIVE_RES);
      const before = [await envelope(RES_REG), await envelope(PC_REG)];
      await q(alter);
      const altered = [await envelope(RES_REG), await envelope(PC_REG)];
      expect(altered).not.toEqual(before);                       // the alteration took effect (control on the setup)
      expect(await attempt(MIG)).toMatch(msg);
      expect(await captured()).toEqual({});
      expect([await envelope(RES_REG), await envelope(PC_REG)]).toEqual(altered);
    });
  });

  it('an extra grantee and a non-default expire envelope survive 053 -> rollback EXACTLY (captured, not guessed)', async () => {
    await inRollback(async () => {
      await prodShape(LIVE_RES);
      await q(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'c6_053_probe') THEN CREATE ROLE c6_053_probe NOLOGIN; END IF; END $r$`);
      await q(`GRANT EXECUTE ON FUNCTION ${RES_REG} TO c6_053_probe`);
      await q(`ALTER FUNCTION ${EXP_REG} SECURITY DEFINER`);
      await q(`ALTER FUNCTION ${EXP_REG} SET search_path = public`);
      await q(`REVOKE ALL ON FUNCTION ${EXP_REG} FROM PUBLIC`);
      await q(`GRANT EXECUTE ON FUNCTION ${EXP_REG} TO c6_053_probe WITH GRANT OPTION`);
      const before = { res: await envelope(RES_REG), pc: await envelope(PC_REG), exp: await envelope(EXP_REG) };
      expect(before.exp.secdef).toBe(true);
      expect(before.res.acl).toContain('c6_053_probe:EXECUTE:false');
      expect(await attempt(MIG)).toBe('ok');
      expect((await envelope(RES_REG)).acl).toContain('c6_053_probe:EXECUTE:false');  // 053 left the other grantee alone
      expect(await envelope(EXP_REG)).toBeNull();
      expect(await attempt(ROLLBACK)).toBe('ok');
      const after = { res: await envelope(RES_REG), pc: await envelope(PC_REG), exp: await envelope(EXP_REG) };
      expect(after).toEqual(before);
    });
  });

  it('control: a capture whose envelope disagrees with what the definition restores -> the rollback refuses', async () => {
    await inRollback(async () => {
      await q(`UPDATE ${CAP} SET prosecdef = NOT prosecdef WHERE fn = $1`, [PC_REG]);
      expect(await attempt(ROLLBACK)).toMatch(/restored apply_credit_partial_confirm differs from the capture/);
    });
  });

  it('control: the rollback refuses when the capture row is missing', async () => {
    await inRollback(async () => {
      await q(`DELETE FROM ${CAP} WHERE fn = $1`, [PC_REG]);
      expect(await attempt(ROLLBACK)).toMatch(/no captured pre-053 function for apply_credit_partial_confirm/);
    });
  });
});

describe('AFTER - concurrency (separate connections, committed rows)', () => {
  const extra: Client[] = [];
  const CORG = '0eda0053-0000-4000-8000-0000000c0053';
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) { const c = new Client({ connectionString: URL }); await c.connect(); extra.push(c); }
  });
  afterAll(async () => { await Promise.all(extra.map((c) => c.end())); });

  it('two partial confirms of ONE hold with DIFFERENT keys, concurrently -> exactly one settles', async () => {
    const tag = `cc${Date.now()}`;
    await db.query('INSERT INTO public.organization_credits (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [CORG]);
    await db.query(`SELECT public.apply_credit_reservation(p_org_id => $1, p_phase => 'grant', p_free_amount => 100,
      p_idempotency_key => $2, p_reference_type => 'g053', p_category => 'free')`, [CORG, `${tag}:grant`]);
    await db.query(`SELECT public.apply_credit_reservation(p_org_id => $1, p_phase => 'hold', p_free_amount => 40,
      p_idempotency_key => $2, p_reference_type => 'g053', p_category => 'free')`, [CORG, `${tag}:hold`]);
    const hold = (await db.query('SELECT id FROM public.credit_transactions WHERE idempotency_key = $1', [`${tag}:hold`])).rows[0].id;
    const settle = (c: Client, key: string) => c.query(
      'SELECT public.apply_credit_partial_confirm(p_org_id => $1, p_hold_txn_id => $2, p_actual_free => 25, p_idempotency_key => $3)',
      [CORG, hold, key]).then(() => 'ok', (e) => String(e.message));
    const out = await Promise.all([settle(extra[0], `${tag}:pcA`), settle(extra[1], `${tag}:pcB`)]);
    expect(out.filter((o) => o === 'ok')).toHaveLength(1);
    expect(out.filter((o) => /HOLD_ALREADY_SETTLED/.test(o))).toHaveLength(1);
    const { rows } = await db.query(`SELECT count(*)::int n FROM public.credit_transactions WHERE parent_transaction_id = $1`, [hold]);
    expect(rows[0].n).toBe(1);
  });
});
