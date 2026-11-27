/**
 * Static contract for 20270301000010_content_learning_client_privileges_revoked.sql
 * (no database; the real-PostgreSQL cover is
 * backend/tests/realschema/cl_client_privileges_revoked.test.ts).
 *
 * Owner rules #23/#26: no anon/authenticated grant on a tenant table. Conventions:
 * 20270301000000 (REVOKE ALL from client roles, two-way postcondition) and
 * 20270111000003 class T (trigger function: REVOKE ALL from client roles, pinned
 * search_path, owner/service_role keep EXECUTE).
 *
 * CL_ACL_STATIC_FILE substitutes a mutated migration (failing controls).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20270301000010_content_learning_client_privileges_revoked.sql';
const raw = fs.readFileSync(process.env.CL_ACL_STATIC_FILE || path.join(MIG, FILE), 'utf8');
const code = raw.replace(/--[^\n]*/g, ''); // statements only
const TABLES = ['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'];
const block = (tag: string) => {
  const s = code.indexOf(`DO $${tag}$`);
  const e = code.indexOf(`$${tag}$;`, s + 4);
  if (s < 0 || e < 0) throw new Error(`block ${tag} not found`);
  return code.slice(s, e);
};

describe(FILE, () => {
  it('runs in its own transaction', () => {
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code).toMatch(/^\s*COMMIT;\s*$/m);
    expect(code).not.toMatch(/CONCURRENTLY/i);
  });

  it('revokes ALL (not a hand list that misses MAINTAIN) from PUBLIC, anon, authenticated, authenticator on exactly the four tables', () => {
    const rev = block('revoke');
    expect(rev).toMatch(/EXECUTE format\('REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated, authenticator', t\)/);
    expect(rev).toContain(`ARRAY[${TABLES.map((t) => `'${t}'`).join(', ')}]`);
    // ... and only in the mode where all four exist.
    expect(rev).toMatch(/IF current_setting\('cl_acl\.mode', true\) = 'present' THEN/);
  });

  it('closes set_content_updated_at() like SEC-B class T: client EXECUTE revoked, search_path pinned to pg_catalog, public', () => {
    const fn = block('fn');
    expect(fn).toMatch(/REVOKE ALL ON FUNCTION public\.set_content_updated_at\(\) FROM PUBLIC, anon, authenticated, authenticator/);
    expect(fn).toMatch(/ALTER FUNCTION public\.set_content_updated_at\(\) SET search_path = pg_catalog, public/);
  });

  it('grants nothing to anyone and never touches service_role', () => {
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/REVOKE[^;']*\bservice_role\b/i);
  });

  it('changes no policy, RLS flag, table, trigger, view or default privilege', () => {
    expect(code).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
    expect(code).not.toMatch(/\b(DISABLE|NO FORCE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i);
    expect(code).not.toMatch(/\b(CREATE|DROP)\s+(TABLE|FUNCTION|VIEW|INDEX|TRIGGER)\b/i);
    expect(code).not.toMatch(/\bALTER\s+(TABLE|VIEW|INDEX|TRIGGER)\b/i);
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it('preflight decides the mode BEFORE any change: all absent -> WARNING skip, partial -> RAISE, all present -> revoke', () => {
    const pre = code.indexOf('DO $preflight$');
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(code.indexOf('DO $revoke$'));
    expect(pre).toBeLessThan(code.indexOf('DO $fn$'));
    const p = block('preflight');
    expect(p).toMatch(/IF n_pub = 0 THEN/);
    expect(p).toMatch(/RAISE WARNING 'CL-ACL: content_performance, content_prediction, learning_intelligence, learning_memory are ALL absent/);
    expect(p).toMatch(/ELSIF n_pub < 4 THEN\s+RAISE EXCEPTION 'CL-ACL preflight: only % of the 4 tables exist/);
    // "absent" means absent in EVERY schema, not just public.
    expect(p).toMatch(/SELECT count\(\*\) INTO n_any FROM pg_class WHERE relname = ANY \(tabs\);/);
    expect(p).toMatch(/IF n_any <> 0 THEN\s+RAISE EXCEPTION/);
    expect(p).toMatch(/CL-ACL preflight: role % does not exist/);
    expect(p).toMatch(/is in a publication/);
    expect(p).toMatch(/owner-rights views readable by clients/);
    // the search_path pin is verified against the reviewed body
    expect(p).toContain(`IS DISTINCT FROM 'BEGIN NEW.updated_at = now(); RETURN NEW; END;'`);
    // an unexpected mode can never fall through to "no change"
    expect(block('revoke')).toMatch(/ELSIF current_setting\('cl_acl\.mode', true\) IS DISTINCT FROM 'absent' THEN\s+RAISE EXCEPTION/);
  });

  it('asserts its postcondition both ways after every change', () => {
    const post = code.indexOf('DO $post$');
    expect(post).toBeGreaterThan(code.indexOf('DO $fn$'));
    const body = block('post');
    expect(body).toMatch(/has_table_privilege\(r, 'public\.' \|\| t, p\)/);
    expect(body).toMatch(/has_any_column_privilege\(r, 'public\.' \|\| t, p\)/);
    expect(body).toMatch(/ARRAY\['anon', 'authenticated', 'authenticator'\]/);
    expect(body).toMatch(/array_append\(v_privs, 'MAINTAIN'\)/);
    expect(body).toMatch(/a\.grantee = 0/); // PUBLIC
    expect(body).toMatch(/service_role lacks %/);
    expect(body).toMatch(/non-client ACL entries changed/);
    expect(body).toMatch(/has_function_privilege\(r, fn, 'EXECUTE'\)/);
    expect(body).toMatch(/search_path not pinned/);
    expect(body).toMatch(/learning_memory_set_updated_at is missing, disabled/);
    expect(body).toMatch(/owner, definer flag, body or non-client ACL changed/);
    expect(body).toMatch(/ELSE\s+RAISE EXCEPTION 'CL-ACL postcondition: preflight mode not set/);
  });

  it('is numbered above the attested applied boundary, inside the reserved 20270301000010-19 band', () => {
    const boundary = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'migrations', 'applied-boundary.json'), 'utf8'));
    const v = FILE.slice(0, 14);
    expect(v > String(boundary.ledger_max)).toBe(true);
    expect(v >= '20270301000010' && v <= '20270301000019').toBe(true);
    expect(fs.readdirSync(MIG).filter((f) => f.startsWith(v))).toEqual([FILE]);
  });

  it('the absent-mode skip is covered: the replay still creates the four tables after this file (gap manifest) or the baseline already has them', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'supabase', '_schema', 'baseline-gap-migrations.txt'), 'utf8')
      .split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    const baseline = fs.readFileSync(path.join(ROOT, 'supabase', '_schema', 'baseline.sql'), 'utf8');
    const inBaseline = TABLES.every((t) => new RegExp(`CREATE TABLE public\\.${t} \\(`).test(baseline));
    expect(manifest.includes('20260718000003_content_learning_performance.sql') || inBaseline).toBe(true);
  });

  it('has a rollback companion that restores exactly production\'s pre-image (authenticated arwdxtm, no TRUNCATE; function EXECUTE; unpinned)', () => {
    const rb = fs.readFileSync(path.join(MIG, 'rollbacks', 'content_learning_client_privileges_revoked_rollback.sql'), 'utf8')
      .replace(/--[^\n]*/g, '');
    expect(rb).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE\s+public\.content_performance, public\.content_prediction, public\.learning_intelligence, public\.learning_memory\s+TO authenticated;/);
    expect(rb).not.toMatch(/TRUNCATE/i);
    expect(rb).not.toMatch(/TO\s+(anon|PUBLIC|authenticator)\b/i);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_content_updated_at\(\) TO authenticated;/);
    expect(rb).toMatch(/ALTER FUNCTION public\.set_content_updated_at\(\) RESET search_path;/);
  });

  it('leaves the original 20260718000003 byte-identical (sha256 over its bytes)', () => {
    const orig = fs.readFileSync(path.join(MIG, '20260718000003_content_learning_performance.sql'));
    expect(crypto.createHash('sha256').update(orig).digest('hex'))
      .toBe('525b9d0d3051762f95003d46b28e2bf8b3f608141b5a0425f3c74383c1fbb4f9');
  });
});
