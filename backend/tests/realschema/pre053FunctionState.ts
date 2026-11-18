/**
 * expire_org_free_credits(uuid,integer,text) in its PRODUCTION pre-053 state (c6, was e1).
 *
 * 20270217000053 DROPS it (20260625 intended to; no caller). Earlier migrations that a suite RE-APPLIES on the fully
 * replayed database (SEC-B 20270111000003 REVOKEs / ALTERs it, and its preflight requires it) ran in production while
 * the function existed, so a replay that carries 053 needs it back - restored byte-for-byte from the committed C100
 * live-body fixture. Call it INSIDE the test transaction (inRollback); nothing persists. No-op when it already exists
 * (a replay without 053).
 */
import * as fs from 'fs';
import * as path from 'path';
import { db } from './setup';

const EXPIRE_LIVE_BODY = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'live-credit-functions-20261113', 'LIVE-expire_org_free_credits.prosrc.sql'), 'utf8');

export async function expireOrgFreeCreditsProductionState(): Promise<void> {
  const { rows } = await db.query(`SELECT to_regprocedure('public.expire_org_free_credits(uuid,integer,text)') IS NULL AS missing`);
  if (!rows[0].missing) return;
  await db.query('CREATE FUNCTION public.expire_org_free_credits(p_org_id uuid, p_amount int, p_note text DEFAULT \'free credit expiry\') '
    + 'RETURNS int LANGUAGE plpgsql AS $fn$' + EXPIRE_LIVE_BODY + '$fn$');
}
