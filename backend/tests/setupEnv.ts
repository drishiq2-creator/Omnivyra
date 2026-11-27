import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// STEP 3F / R1 — the test environment is NEVER production.
//
// This file used to load `.env.local` first. `.env.local` IS production
// (Supabase project klkiseupptzbecbxwrky + a live service-role key), so
// `npm test` ran against production while holding write permission. It also
// bypassed scripts/lib/certAwareEnv.cjs and both cert isolation guards.
//
// Resolution order below is non-production only, and `.env.local` is not a
// candidate at any position. Gaps fall through to the local/cert stack:
//
//   .env.test  (gitignored, placeholder credentials, loopback addresses)
//   .env.cert  (local/cert stack — localhost:54321 + local Redis)
//   .env       (bare local defaults)
//
// dotenv never overwrites an already-set variable, so the first file to define
// a variable wins and anything pre-set by the caller (e.g. a hermetic wrapper)
// still takes precedence over all of them.
const TEST_ENV_CANDIDATES = ['.env.test', '.env.cert', '.env'] as const;

const loadedEnvFiles: string[] = [];
for (const candidate of TEST_ENV_CANDIDATES) {
  const candidatePath = path.resolve(process.cwd(), candidate);
  if (!fs.existsSync(candidatePath)) continue;
  dotenv.config({ path: candidatePath });
  loadedEnvFiles.push(candidate);
}

// CI jobs (GitHub Actions sets CI=true) supply a hermetic environment inline and
// ship no env file, so a missing file is only fatal on a developer machine. The
// production check below still runs unconditionally, CI included.
if (loadedEnvFiles.length === 0 && process.env.CI !== 'true') {
  throw new Error(
    '[test-env] REFUSING TO RUN: no non-production env file found. Expected one of ' +
      `${TEST_ENV_CANDIDATES.join(', ')} in ${process.cwd()}. ` +
      'Copy .env.cert or create .env.test with placeholder values. ' +
      '.env.local is production and is deliberately never loaded by tests.'
  );
}

// Fail-closed production check, reusing the single source of truth for "what is
// production" (scripts/lib/certAwareEnv.cjs — same markers as
// scripts/cert/assert-cert-isolation.mjs). This runs unconditionally rather
// than only under CERT_ENV=1: a test run must never reach production, even if
// .env.test is edited or deleted, or a production value is exported by the
// shell before jest starts.
//
// E2E consolidation (docs/supabase-e2e-retirement/15-*): the same scan also
// refuses the hosted E2E project. Automated tests use a disposable/loopback
// stack only; the hosted E2E project is shared, persistent and being retired.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanHostedTargets } = require('../../scripts/lib/certAwareEnv.cjs');

// Reports the variable and marker only — never the value.
const hostedTargetViolations: string[] = scanHostedTargets(process.env);

if (hostedTargetViolations.length > 0) {
  throw new Error(
    '[test-env] REFUSING TO RUN TESTS AGAINST PRODUCTION OR THE HOSTED E2E PROJECT.\n  ' +
      hostedTargetViolations.join('\n  ') +
      `\n\nLoaded env files: ${loadedEnvFiles.join(', ')}. ` +
      'Tests must use .env.test / .env.cert (local). Never .env.local or .env.e2e.'
  );
}

// Allow execution engine writes during tests (guard in executionPlannerPersistence)
process.env.ALLOW_EXECUTION_ENGINE_WRITE = '1';

// Execution engine: allow persistence writes when tests call service methods
process.env.ALLOW_EXECUTION_ENGINE_WRITE = '1';
