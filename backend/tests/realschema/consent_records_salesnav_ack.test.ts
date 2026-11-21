/**
 * 20270217000075 consent_records_salesnav_ack - on the real schema (b3 ruling 1; cb review points):
 *   - the ledger admits the new capability, and the check is EXACTLY the 9 values, validated;
 *   - an acknowledgement row is append-only like every consent row (UPDATE of content and DELETE refused);
 *   - a capability outside the 9 is still refused.
 */
import { db, seedTenants, ORG_A, inRollback, attempt, effect } from './setup';

const ack = (capability: string, platform = 'salesnav:unipile') => effect(
  `INSERT INTO public.consent_records (organization_id, platform, capability, consent_version, granted_at, metadata)
   VALUES ($1, $2, $3, 'placeholder-v0', now(), '{"wording_status":"placeholder"}'::jsonb)`,
  [ORG_A, platform, capability]);

describe('075: the consent ledger admits the Sales Navigator restriction acknowledgement', () => {
  it('the capability check is EXACTLY the 9 values and validated', async () => {
    const { rows } = await db.query(
      `SELECT array_agg(m[1] ORDER BY m[1]) AS v, bool_and(c.convalidated) AS valid
         FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
        WHERE c.conrelid = 'public.consent_records'::regclass AND c.conname = 'consent_records_capability_check'`);
    expect(rows[0].v).toEqual(['ingest_comments', 'ingest_communities', 'ingest_dms', 'ingest_mentions', 'listen',
      'monitor_competitors', 'publish', 'salesnav_linkedin_restriction_ack', 'tenant_data_controller_ack']);
    expect(rows[0].valid).toBe(true);
  });

  it('an acknowledgement row is accepted', () => inRollback(async () => {
    await seedTenants();
    expect(await ack('salesnav_linkedin_restriction_ack')).toBe('ok');
  }));

  it('control: a capability outside the 9 is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await ack('salesnav_made_up_ack')).toBe('23514');
  }));

  it('the acknowledgement is append-only: its content cannot be updated and it cannot be deleted', () => inRollback(async () => {
    await seedTenants();
    expect(await ack('salesnav_linkedin_restriction_ack')).toBe('ok');
    const changed = await attempt(
      `UPDATE public.consent_records SET consent_version = 'forged' WHERE capability = 'salesnav_linkedin_restriction_ack'`);
    expect(changed).not.toBe('ok');
    const deleted = await attempt(`DELETE FROM public.consent_records WHERE capability = 'salesnav_linkedin_restriction_ack'`);
    expect(deleted).not.toBe('ok');
  }));

  it('control: revoking (revoked_at) an acknowledgement is allowed - the one permitted change', () => inRollback(async () => {
    await seedTenants();
    expect(await ack('salesnav_linkedin_restriction_ack')).toBe('ok');
    expect(await attempt(
      `UPDATE public.consent_records SET revoked_at = now() WHERE capability = 'salesnav_linkedin_restriction_ack'`)).toBe('ok');
  }));
});
