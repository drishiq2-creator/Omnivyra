/**
 * Rule 9 (cb 2026-11-21) — a new public table must not inherit service_role's default ALL by omission.
 *
 * C163 (owner-approved read-only, 2026-11-21) found 22 of the 31 tables created by that week's production applies with
 * service_role holding DELETE and TRUNCATE: the public schema's DEFAULT ACL grants it arwdDxtm, and the migrations
 * revoked the client roles and GRANTed service_role a narrower set without ever revoking the default. The append-only
 * opt-out review store (20270127000001) is the shape reproduced below.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serviceRoleAclViolations, SERVICE_ROLE_ACL_FROM } = require('../../../scripts/check-migration-quality.js');

const rules = (sql: string): string[] => serviceRoleAclViolations(sql).map((v: { rule: string }) => v.rule);

// The real defect shape: client roles revoked, service_role granted a narrower set, its default ALL never revoked.
const C163_SHAPE = `CREATE TABLE IF NOT EXISTS public.contact_opt_out_reviews (id uuid primary key);
ALTER TABLE public.contact_opt_out_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_opt_out_reviews FROM PUBLIC;
REVOKE ALL ON public.contact_opt_out_reviews FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.contact_opt_out_reviews TO service_role;`;

describe('migration quality — rule 9: service_role default ACL on new tables', () => {
  it('applies from 20270217000073 (the first unapplied versions after C163)', () => {
    expect(SERVICE_ROLE_ACL_FROM).toBe('20270217000073');
  });

  it('FLAGS the C163 shape: client roles revoked, service_role narrowed by GRANT only (DELETE/TRUNCATE survive)', () => {
    expect(rules(C163_SHAPE)).toEqual([expect.stringContaining('table public.contact_opt_out_reviews: REVOKE ALL ON public.contact_opt_out_reviews FROM service_role')]);
  });

  it('accepts the fixed shape: REVOKE ALL FROM service_role BEFORE the narrower GRANT', () => {
    const fixed = C163_SHAPE.replace('REVOKE ALL ON public.contact_opt_out_reviews FROM anon, authenticated;',
      'REVOKE ALL ON public.contact_opt_out_reviews FROM anon, authenticated, service_role;');
    expect(fixed).not.toBe(C163_SHAPE); // control: the replacement really happened
    expect(rules(fixed)).toEqual([]);
  });

  it('FLAGS a REVOKE that comes AFTER the GRANT (it would undo the grant)', () => {
    const late = `${C163_SHAPE}\nREVOKE ALL ON TABLE public.contact_opt_out_reviews FROM service_role;`;
    expect(rules(late)).toEqual([expect.stringContaining('comes AFTER its GRANT')]);
  });

  it('accepts a narrow revoke (DELETE, TRUNCATE) from service_role, or one in a multi-role list', () => {
    expect(rules(`CREATE TABLE public.a (id int);\nREVOKE DELETE, TRUNCATE ON public.a FROM service_role;`)).toEqual([]);
    expect(rules(`CREATE TABLE public.b (id int);\nREVOKE ALL ON TABLE "public"."b" FROM anon, "service_role";`)).toEqual([]);
  });

  it('a REVOKE from service_role on a DIFFERENT table does not count (control against a loose match)', () => {
    expect(rules(`CREATE TABLE public.a (id int);\nREVOKE ALL ON public.ab FROM service_role;`)).toHaveLength(1);
  });

  it('accepts the reviewed escape hatch, and only with a reason', () => {
    expect(rules(`-- service-role-acl-ok: server-owned scratch table, DELETE intended\nCREATE TABLE public.a (id int);`)).toEqual([]);
    expect(rules(`-- service-role-acl-ok:\nCREATE TABLE public.a (id int);`)).toHaveLength(1);
  });

  it('the shared annotation helper requires a reason ON THE SAME LINE (existing rules too: grant-ok)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { securityViolations } = require('../../../scripts/check-migration-quality.js');
    const grant = (ann: string) => securityViolations(`${ann}\nGRANT SELECT ON public.x TO authenticated;`).length;
    expect(grant('-- grant-ok: read model for signed-in members')).toBe(0);
    expect(grant('-- grant-ok:')).toBe(1); // before the fix, `\s*` crossed the newline and this passed
  });

  it('exempts temporary tables and other schemas; ignores commented-out DDL', () => {
    expect(rules('CREATE TEMP TABLE t (id int);')).toEqual([]);
    expect(rules('CREATE TABLE audit.x (id int);')).toEqual([]);
    expect(rules('-- CREATE TABLE public.ghost (id int);')).toEqual([]);
  });

  it('dynamically named tables need REVOKE … FROM service_role inside the same block', () => {
    const dyn = (body: string) => `DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I (id int)', 'x'); ${body} END $$;`;
    expect(rules(dyn(''))).toEqual([expect.stringContaining('dynamically-named public table must REVOKE')]);
    expect(rules(dyn(`EXECUTE format('REVOKE ALL ON public.%I FROM service_role', 'x');`))).toEqual([]);
  });
});
