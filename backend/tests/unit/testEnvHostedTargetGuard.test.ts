/**
 * E2E consolidation (docs/supabase-e2e-retirement/15-application-and-ci-connection-transition.md),
 * Stage 1 — the jest test environment refuses PRODUCTION and the HOSTED E2E project.
 *
 * Two layers:
 *   1. the pure scan (scripts/lib/certAwareEnv.cjs scanHostedTargets / scanCertEnv);
 *   2. the REAL jest setup file (backend/tests/setupEnv.ts), executed in a child process with a
 *      controlled environment and an empty working directory (so no developer env file is read).
 *      Every refusal is paired with a loopback control that must load cleanly, so a setup file that
 *      refuses everything (or nothing) fails here.
 *
 * Hermetic: no network. The child process only parses its environment.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const certEnv = require('../../../scripts/lib/certAwareEnv.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SETUP_ENV = path.join(ROOT, 'backend', 'tests', 'setupEnv.ts');

const PROD_REF = 'klkiseupptzbecbxwrky';
const E2E_REF = 'lomndxmrpyudaegddpef';
const LOOPBACK_SUPABASE = 'http://127.0.0.1:54321';
// Fake credentials (never real). Named constants keep the source free of literal credential URLs
// (gitleaks rule postgres-url-with-password allows a ${NAME} placeholder in the password position).
const FAKE_PW_ONE = 'VerySecretPw1';
const FAKE_PW_TWO = 'VerySecretPw2';

jest.setTimeout(120_000);

describe('scanHostedTargets (pure)', () => {
  it('exports the hosted E2E marker separately from the production markers', () => {
    expect(certEnv.HOSTED_E2E_MARKERS).toEqual([E2E_REF]);
    expect(certEnv.PROD_MARKERS).toContain(PROD_REF);
    expect(certEnv.PROD_MARKERS).not.toContain(E2E_REF);
  });

  it('a loopback environment has no violation (control)', () => {
    expect(certEnv.scanHostedTargets({ SUPABASE_URL: LOOPBACK_SUPABASE, NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE, REDIS_URL: 'redis://127.0.0.1:6379' })).toEqual([]);
  });

  it('refuses the hosted E2E ref in every target variable, in any case', () => {
    for (const key of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_DB_URL', 'DATABASE_URL', 'E2E_SUPABASE_URL', 'E2E_NEXT_PUBLIC_SUPABASE_URL', 'E2E_DATABASE_URL']) {
      const v = certEnv.scanHostedTargets({ [key]: `https://${E2E_REF.toUpperCase()}.supabase.co` });
      expect(v).toEqual([`${key} contains "${E2E_REF}" (hosted E2E project)`]);
    }
  });

  it('still refuses production (and labels it production)', () => {
    expect(certEnv.scanHostedTargets({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` })).toEqual([`SUPABASE_URL contains "${PROD_REF}" (production)`]);
  });

  it('never includes the value in a violation', () => {
    const v = certEnv.scanHostedTargets({ DATABASE_URL: `postgresql://postgres:${FAKE_PW_ONE}@db.${E2E_REF}.supabase.co:5432/postgres` });
    expect(v.join('\n')).not.toContain(FAKE_PW_ONE);
    expect(v).toHaveLength(1);
  });

  it('covers every CONNECTION_VAR plus SUPABASE_DB_URL and the E2E_ names', () => {
    for (const key of certEnv.CONNECTION_VARS) expect(certEnv.TEST_TARGET_VARS).toContain(key);
    for (const key of ['SUPABASE_DB_URL', 'E2E_SUPABASE_URL', 'E2E_NEXT_PUBLIC_SUPABASE_URL', 'E2E_DATABASE_URL', 'E2E_REDIS_URL']) {
      expect(certEnv.TEST_TARGET_VARS).toContain(key);
    }
  });
});

describe('scanCertEnv (CERT_ENV=1) also names the hosted E2E project', () => {
  it('flags the hosted E2E ref in a connection var', () => {
    const v: string[] = certEnv.scanCertEnv({ SUPABASE_SERVICE_ROLE_KEY: `x-${E2E_REF}-y` });
    expect(v).toContain(`SUPABASE_SERVICE_ROLE_KEY → "${E2E_REF}" (hosted E2E project)`);
  });

  it('a loopback cert environment stays clean (control)', () => {
    expect(certEnv.scanCertEnv({ SUPABASE_URL: LOOPBACK_SUPABASE, REDIS_URL: 'redis://127.0.0.1:6379' })).toEqual([]);
  });
});

describe('backend/tests/setupEnv.ts (executed for real in a child process)', () => {
  let emptyCwd: string;
  beforeAll(() => {
    expect(fs.existsSync(TSX_CLI)).toBe(true);
    expect(fs.existsSync(SETUP_ENV)).toBe(true);
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'setupenv-guard-'));
  });
  afterAll(() => {
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  });

  function runSetup(extra: Record<string, string>): { status: number | null; output: string } {
    const env: Record<string, string> = { CI: 'true' };
    for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const v = process.env[k];
      if (typeof v === 'string') env[k] = v;
    }
    Object.assign(env, extra);
    const r = spawnSync(process.execPath, [TSX_CLI, SETUP_ENV], { cwd: emptyCwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 90_000 });
    return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
  }

  it('CONTROL: a loopback environment loads cleanly', () => {
    const r = runSetup({ SUPABASE_URL: LOOPBACK_SUPABASE, NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE, REDIS_URL: 'redis://127.0.0.1:6379' });
    expect(r.output).not.toContain('REFUSING');
    expect(r.status).toBe(0);
  });

  it('refuses the hosted E2E project in SUPABASE_URL', () => {
    const r = runSetup({ SUPABASE_URL: `https://${E2E_REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: LOOPBACK_SUPABASE });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('REFUSING TO RUN TESTS AGAINST PRODUCTION OR THE HOSTED E2E PROJECT');
    expect(r.output).toContain(`SUPABASE_URL contains "${E2E_REF}" (hosted E2E project)`);
  });

  it('refuses the hosted E2E project in E2E_SUPABASE_URL and never prints a credential', () => {
    const r = runSetup({
      SUPABASE_URL: LOOPBACK_SUPABASE,
      E2E_SUPABASE_URL: `https://${E2E_REF}.supabase.co`,
      SUPABASE_DB_URL: `postgresql://postgres:${FAKE_PW_TWO}@db.${E2E_REF}.supabase.co:5432/postgres`,
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(`E2E_SUPABASE_URL contains "${E2E_REF}"`);
    expect(r.output).toContain(`SUPABASE_DB_URL contains "${E2E_REF}"`);
    expect(r.output).not.toContain(FAKE_PW_TWO);
  });

  it('still refuses production', () => {
    const r = runSetup({ NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co` });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(`NEXT_PUBLIC_SUPABASE_URL contains "${PROD_REF}" (production)`);
  });
});
