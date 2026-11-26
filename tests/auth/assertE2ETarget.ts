/**
 * Standalone preflight: asserts the configured auth E2E target is acceptable for
 * the selected mode (AUTH_E2E_TARGET unset/"hosted" = the dedicated non-production
 * hosted E2E project; "local" = a disposable loopback stack). Exits non-zero with
 * a secret-free message otherwise. Run with tsx (npm run check:auth-e2e-target).
 */
import dotenv from 'dotenv';

import { loadE2EEnvFile, resolveAuthE2ETarget } from './e2eEnvironmentGuard';

// Same source of truth as the harness. Never .env.local.
loadE2EEnvFile(dotenv.config);

try {
  // Same single resolver as authTestHarness.ts (variable precedence is defined once).
  const result = resolveAuthE2ETarget(process.env);
  console.log(`Auth E2E target validated (${result.mode}): ${result.guard.description}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
