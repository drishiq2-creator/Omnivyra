/**
 * Static contract for 20270301000000_prospect_lists_client_privileges_revoked.sql
 * (no database; the real-PostgreSQL cover is
 * backend/tests/realschema/pl_client_privileges_revoked.test.ts).
 *
 * Owner rules #23/#26: no new anon/authenticated grant; every tenant table
 * closed to client roles. Convention: 20270111000002 (REVOKE ALL from client
 * roles, service_role and policies untouched, postcondition RAISEs).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MIG = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const FILE = '20270301000000_prospect_lists_client_privileges_revoked.sql';
const raw = fs.readFileSync(path.join(MIG, FILE), 'utf8');
const code = raw.replace(/--[^\n]*/g, ''); // statements only

describe(FILE, () => {
  it('runs in its own transaction', () => {
    expect(code).toMatch(/^\s*BEGIN;/m);
    expect(code).toMatch(/^\s*COMMIT;\s*$/m);
  });

  it('revokes ALL (not a hand list that misses MAINTAIN) from PUBLIC, anon, authenticated, authenticator on both tables', () => {
    for (const t of ['prospect_lists', 'prospect_list_members']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM PUBLIC, anon, authenticated, authenticator;`));
    }
  });

  it('grants nothing to anyone and never touches service_role', () => {
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/REVOKE[^;]*\bservice_role\b/i);
  });

  it('changes no policy, RLS flag, table or function', () => {
    expect(code).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
    expect(code).not.toMatch(/\b(DISABLE|NO FORCE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i);
    expect(code).not.toMatch(/\b(CREATE|DROP|ALTER)\s+(TABLE|FUNCTION|VIEW|INDEX|TRIGGER)\b/i);
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it('fails closed when a table or role is missing (preflight RAISEs before any REVOKE)', () => {
    const pre = code.indexOf('DO $preflight$');
    const firstRevoke = code.indexOf('REVOKE ALL');
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(firstRevoke);
    expect(code).toMatch(/PL-ACL preflight: public\.% does not exist/);
    expect(code).toMatch(/PL-ACL preflight: role % does not exist/);
  });

  it('asserts its postcondition both ways after the REVOKEs', () => {
    const post = code.indexOf('DO $post$');
    expect(post).toBeGreaterThan(code.lastIndexOf('REVOKE ALL'));
    const body = code.slice(post);
    expect(body).toMatch(/has_table_privilege\(r, 'public\.' \|\| t, p\)/);
    expect(body).toMatch(/has_any_column_privilege\(r, 'public\.' \|\| t, p\)/);
    expect(body).toMatch(/ARRAY\['anon', 'authenticated', 'authenticator'\]/);
    expect(body).toMatch(/array_append\(v_privs, 'MAINTAIN'\)/);
    expect(body).toMatch(/server_version_num'\)::int >= 170000/);
    expect(body).toMatch(/a\.grantee = 0/); // PUBLIC
    expect(body).toMatch(/service_role lacks %/); // presence of the application's need
    expect(body).toMatch(/non-client ACL entries changed/); // service_role/owner/policies/RLS unchanged
  });

  it('is numbered above the attested applied boundary (never into applied history)', () => {
    const boundary = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'migrations', 'applied-boundary.json'), 'utf8'));
    expect(FILE.slice(0, 14) > String(boundary.ledger_max)).toBe(true);
  });

  it('leaves the applied original 20261127000000 byte-identical (sha256 over its bytes)', () => {
    const orig = fs.readFileSync(path.join(MIG, '20261127000000_pi_prospect_lists.sql'));
    expect(crypto.createHash('sha256').update(orig).digest('hex'))
      .toBe('01315600d26291f7cc366982faef21e9bf0ba34505e2fb8ee0576fdf1462c734');
  });
});
