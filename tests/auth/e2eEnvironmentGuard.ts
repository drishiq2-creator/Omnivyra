/**
 * Fail-closed environment guard for the Auth-Integrity E2E suite.
 *
 * The suite creates, confirms and DELETES real Supabase users via the admin API.
 * It must therefore only ever run against the dedicated, non-production E2E
 * project. Historically the harness loaded `.env.local`, which points at the
 * production project (see PHASE 146 audit) — this module makes that impossible.
 *
 * The guard is deliberately dependency-free and side-effect-free so it can be
 * unit-tested without any network access or E2E credentials.
 *
 * Secrets are never included in error messages. Project refs and hostnames are
 * public identifiers (they already appear in `.mcp.json`) and are safe to log.
 */

/** Supabase project refs that must NEVER be targeted by the E2E suite. */
export const PRODUCTION_PROJECT_REFS: readonly string[] = ['klkiseupptzbecbxwrky'];

/** Hostnames that must NEVER be targeted by the E2E suite. */
export const PRODUCTION_HOSTNAMES: readonly string[] = [
  'klkiseupptzbecbxwrky.supabase.co',
  'klkiseupptzbecbxwrky.supabase.in',
];

/**
 * Production Redis hosts (the hard-coded production markers in scripts/lib/certAwareEnv.cjs and
 * scripts/reset-auth-e2e-rate-limits.js). Refused in every mode, in every connection variable
 * (v3 of C2; review finding F4).
 */
export const PRODUCTION_REDIS_HOSTNAMES: readonly string[] = ['noble-dane-77325.upstash.io'];

/** The dedicated E2E project this suite is allowed to target. */
export const DEFAULT_EXPECTED_E2E_PROJECT_REF = 'lomndxmrpyudaegddpef';

/** Hosts that indicate placeholder / dry-run CI configuration. */
const PLACEHOLDER_HOSTNAMES: readonly string[] = [
  'placeholder.supabase.co',
  'example.supabase.co',
  'dry-run',
  'example.com',
];

const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

const PLACEHOLDER_KEY_MARKERS: readonly string[] = [
  'placeholder',
  'dry-run',
  'changeme',
  'your-service-role-key',
];

const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

/**
 * Loads the E2E-specific env file (default `.env.e2e`, gitignored) if present.
 * NEVER loads `.env.local`: that file points at production. When the file is
 * absent — as in CI — the caller relies on real environment variables, and the
 * guard below still rejects anything that is not the dedicated E2E project.
 *
 * The file is authoritative when present, so a stray exported SUPABASE_URL in a
 * developer's shell cannot silently redirect the suite.
 */
export function loadE2EEnvFile(dotenvConfig: (opts: { path: string; override: boolean }) => unknown): string | null {
  const file = process.env.AUTH_E2E_ENV_FILE || '.env.e2e';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  if (!existsSync(file)) return null;
  dotenvConfig({ path: file, override: true });
  return file;
}

export class E2EEnvironmentError extends Error {
  constructor(message: string) {
    super(`[auth-e2e guard] ${message}`);
    this.name = 'E2EEnvironmentError';
  }
}

export type E2EGuardInput = {
  supabaseUrl?: string | null;
  serviceRoleKey?: string | null;
  /** Pass `null` to disable the allowlist check (denylist still applies). */
  expectedProjectRef?: string | null;
};

export type E2EGuardResult = {
  projectRef: string;
  hostname: string;
  /** Safe, secret-free description for logging. */
  description: string;
};

/** Extracts the Supabase project ref from a project URL, or null if not derivable. */
export function extractProjectRef(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const [firstLabel] = parsed.hostname.split('.');
  if (!firstLabel || !PROJECT_REF_PATTERN.test(firstLabel)) return null;
  return firstLabel;
}

function isProductionTarget(projectRef: string | null, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (PRODUCTION_HOSTNAMES.some((h) => h.toLowerCase() === host)) return true;
  if (projectRef && PRODUCTION_PROJECT_REFS.includes(projectRef)) return true;
  // Defence in depth: a production ref appearing anywhere in the host.
  return PRODUCTION_PROJECT_REFS.some((ref) => host.includes(ref));
}

/**
 * Validates that the supplied Supabase configuration targets the dedicated,
 * non-production E2E project. Throws `E2EEnvironmentError` on any doubt.
 *
 * Fail-closed: every unrecognised, empty, malformed, local, placeholder or
 * production-looking configuration is rejected. There is no permissive path.
 */
export function assertNonProductionE2EEnvironment(input: E2EGuardInput): E2EGuardResult {
  const rawUrl = typeof input.supabaseUrl === 'string' ? input.supabaseUrl.trim() : '';
  const rawKey = typeof input.serviceRoleKey === 'string' ? input.serviceRoleKey.trim() : '';

  if (!rawUrl) {
    throw new E2EEnvironmentError(
      'no Supabase URL configured. Set E2E_SUPABASE_URL (or SUPABASE_URL) from .env.e2e — the suite refuses to guess.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new E2EEnvironmentError('Supabase URL is malformed and cannot be parsed as a URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new E2EEnvironmentError(`unsupported Supabase URL protocol "${parsed.protocol}".`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new E2EEnvironmentError('Supabase URL has no hostname.');
  }

  const projectRef = extractProjectRef(rawUrl);

  // ---- Production rejection (denylist). Must run before any admin API use. ----
  if (isProductionTarget(projectRef, hostname)) {
    throw new E2EEnvironmentError(
      `refusing to run against the PRODUCTION Supabase project (host "${hostname}"). ` +
        'The Auth-Integrity suite creates and deletes real users. Point it at the dedicated E2E project.',
    );
  }

  if (PLACEHOLDER_HOSTNAMES.includes(hostname)) {
    throw new E2EEnvironmentError(
      `Supabase URL "${hostname}" is a placeholder. A real dedicated E2E project is required.`,
    );
  }

  if (LOCAL_HOSTNAMES.includes(hostname) || hostname.endsWith('.local')) {
    throw new E2EEnvironmentError(
      `Supabase URL "${hostname}" is a local instance. The Auth-Integrity suite requires the dedicated hosted E2E project.`,
    );
  }

  if (!hostname.endsWith('.supabase.co') && !hostname.endsWith('.supabase.in')) {
    throw new E2EEnvironmentError(
      `Supabase URL host "${hostname}" is not a recognised Supabase project host.`,
    );
  }

  if (!projectRef) {
    throw new E2EEnvironmentError(
      `could not derive a Supabase project ref from host "${hostname}".`,
    );
  }

  // ---- Expected-project rejection (allowlist). ----
  const expected =
    input.expectedProjectRef === undefined
      ? DEFAULT_EXPECTED_E2E_PROJECT_REF
      : input.expectedProjectRef;
  if (expected && projectRef !== expected) {
    throw new E2EEnvironmentError(
      `Supabase project ref "${projectRef}" is not the expected E2E project "${expected}".`,
    );
  }

  // ---- Credential presence (value never logged). ----
  if (!rawKey) {
    throw new E2EEnvironmentError(
      'no Supabase service-role key configured for the E2E project.',
    );
  }
  const loweredKey = rawKey.toLowerCase();
  if (PLACEHOLDER_KEY_MARKERS.some((marker) => loweredKey.includes(marker))) {
    throw new E2EEnvironmentError('Supabase service-role key looks like a placeholder value.');
  }

  return {
    projectRef,
    hostname,
    description: `E2E project ${projectRef} (${hostname})`,
  };
}

// =============================================================================
// C2 — explicit target modes and ONE authoritative target resolver.
//
// AUTH_E2E_TARGET selects where the suite runs:
//   (unset)  -> "hosted": the dedicated hosted E2E project, validated exactly as
//               before by assertNonProductionE2EEnvironment (default unchanged).
//   "hosted" -> the same, stated explicitly.
//   "local"  -> a disposable Supabase stack on THIS machine (a CI runner), e.g.
//               the one started by tests/supabase-local/bootstrap.sh. Every
//               target-bearing input must be an explicitly allowlisted loopback
//               endpoint on the stack's configured port.
//   anything else (including an empty string) -> rejected.
//
// In EVERY mode, every target-bearing input (all Supabase URL variables, the
// app base URL, database URLs and Redis URLs) is checked against the production
// project; a match is rejected before any network request is possible. Local
// mode additionally rejects the legacy hosted E2E project. A rejected target
// never falls back to another target. Values are never echoed: errors name the
// variable, never its content.
// =============================================================================

/** Legacy hosted E2E project refs; refused in local mode. */
export const LEGACY_E2E_PROJECT_REFS: readonly string[] = [DEFAULT_EXPECTED_E2E_PROJECT_REF];

/**
 * Exact WHATWG-URL hostname forms accepted in local mode. Nothing else: no other
 * 127.0.0.0/8 address, no alternative spellings (0x7f000001, 127.1, LOCALHOST,
 * "localhost."), no DNS names that might resolve to loopback.
 */
export const LOCAL_MODE_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Ports of the disposable stack. MUST equal tests/supabase-local/supabase/config.toml
 * ([api].port and [db].port); a unit test cross-checks them.
 */
export const LOCAL_STACK_PORTS = { api: 54321, db: 54322 } as const;
/** Port of the Next.js app under test (AUTH_E2E_BASE_URL). */
export const LOCAL_APP_PORT = 3000;
/** Port of the CI Redis service container. */
export const LOCAL_REDIS_PORT = 6379;

export type AuthE2ETargetMode = 'hosted' | 'local';

/** Supabase API URL inputs, in the harness's historical precedence order. */
export const SUPABASE_URL_VARIABLES = [
  'E2E_SUPABASE_URL',
  'E2E_NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
] as const;
/** Secret / service-role key inputs, in the harness's historical precedence order. */
export const SERVICE_KEY_VARIABLES = [
  'E2E_SUPABASE_SECRET_KEY',
  'SUPABASE_SECRET_KEY',
  'E2E_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;
/** Database URL inputs that may be present in the test process environment. */
export const DATABASE_URL_VARIABLES = ['E2E_DATABASE_URL', 'SUPABASE_DB_URL', 'DATABASE_URL'] as const;
/** Redis URL inputs that may be present in the test process environment. */
export const REDIS_URL_VARIABLES = ['E2E_REDIS_URL', 'REDIS_URL'] as const;
/**
 * Inputs the app under test reads to choose its own Supabase target (backend/db/supabaseClient.ts:
 * SUPABASE_POOLER_URL replaces SUPABASE_URL; ENV_FILE selects an env file to load). Denial-checked in
 * every mode; REFUSED outright in local mode (v2 of C2; review finding F3).
 */
export const APP_OVERRIDE_VARIABLES = [
  // Supabase target overrides and env-file selection (v2).
  'SUPABASE_POOLER_URL', 'ENV_FILE',
  // v3 (review findings F4, F15), from an inventory of what `npm run dev` (scripts/start-all.js,
  // next dev, backend/db/supabaseClient.ts) and its libraries actually read:
  // a Postgres pool the app opens itself (pages/api/company-grounding/[companyId].ts):
  'GROUNDING_STORE_DSN',
  // database URLs read by scripts and the cert guard (never needed by the local job):
  'W6_DB_URL', 'SUPABASE_POOLER_DB_URL', 'DIRECT_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'CERT_DB_URL', 'ACTOR_FK_DB_URL', 'BETA_SUPABASE_URL',
  // Redis endpoints other than REDIS_URL (creatorRenderDurableQueue.ts, cache-management.ts,
  // intelligencePollingQueue.ts, canonicalClient.ts, namespace.ts):
  'CREATOR_RENDER_REDIS_URL', 'REDIS_PRIVATE_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'UPSTASH_REDIS_URL', 'UPSTASH_REDIS_REST_URL',
  // dotenv loads .env.vault instead of the plain files when DOTENV_KEY is set:
  'DOTENV_KEY',
  // switches off the app's own prod-Supabase/local-Redis hard block (lib/env/namespace.ts):
  'ALLOW_PROD_DB_WITH_LOCAL_REDIS',
  // outbound proxies would carry loopback traffic elsewhere:
  'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
] as const;

/**
 * Connection-like variable names. In local mode any such name that is neither validated
 * (DATABASE_URL_VARIABLES, REDIS_URL_VARIABLES) nor refused by name (APP_OVERRIDE_VARIABLES) nor a
 * known non-connection setting is refused as UNKNOWN; in every mode its value is denial-checked.
 * libpq / node-postgres PG* variables are refused in local mode (pg fills missing connection fields
 * from them). (v3 of C2; review findings F4, F15.)
 */
export const CONNECTION_NAME_PATTERN = /(DATABASE|POSTGRES|REDIS|UPSTASH|POOLER|DSN$|_DB_URL$|^DB_URL$|^KV_)/i;
export const LIBPQ_NAME_PATTERN = /^PG[A-Z0-9_]*$/i;
export const NON_CONNECTION_SETTINGS: readonly string[] = [
  'UPSTASH_DAILY_REQUEST_LIMIT', 'ENABLE_REDIS_USAGE_MONITORING', 'REDIS_WAIT_MS', 'DEV_AUTO_START_REDIS',
  // read by the app as limits / feature switches, never as an endpoint (review R9):
  'REDIS_MAX_BYTES', 'REDIS_OVERFLOW_CAP_PER_QUEUE', 'REDIS_USAGE_MAX_PLAUSIBLE_CMDS_PER_SEC', 'ENTERPRISE_GOVERNANCE_REDIS_ENABLED', 'VARIANT_DIAGNOSTICS_REDIS_ENABLED',
];
/**
 * Env files that Next.js dev or backend/db/supabaseClient.ts would load to fill any variable the
 * job does not set (.env.local points at PRODUCTION). Local mode refuses to run while any exists.
 */
export const APP_ENV_FILES = ['.env', '.env.local', '.env.cert', '.env.development', '.env.development.local', '.env.e2e', '.env.vault'] as const;
export const BASE_URL_VARIABLE = 'AUTH_E2E_BASE_URL';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

type EnvLike = Readonly<Record<string, string | undefined>>;

const RESOLVED_TARGET_BRAND: unique symbol = Symbol('resolved-auth-e2e-target');

export type ResolvedAuthE2ETarget = Readonly<{
  mode: AuthE2ETargetMode;
  /** The Supabase API URL the harness will use (first present URL variable). */
  supabaseUrl: string;
  /** Name of the variable it came from (never the value of a secret). */
  supabaseUrlVariable: string;
  serviceRoleKey: string;
  baseUrl: string;
  guard: E2EGuardResult;
  [RESOLVED_TARGET_BRAND]: true;
}>;

function fail(mode: AuthE2ETargetMode | 'unresolved', variable: string, reason: string): never {
  throw new E2EEnvironmentError(`target mode "${mode}": ${variable} ${reason}`);
}

function present(env: EnvLike, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** Reads AUTH_E2E_TARGET. Unset -> "hosted" (unchanged default). Anything unknown -> rejected. */
export function readAuthE2ETargetMode(env: EnvLike): AuthE2ETargetMode {
  const raw = env.AUTH_E2E_TARGET;
  if (raw === undefined) return 'hosted';
  if (raw === 'hosted' || raw === 'local') return raw;
  if (raw.trim() === '') fail('unresolved', 'AUTH_E2E_TARGET', 'is set but empty; set "local" or "hosted", or unset it.');
  return fail('unresolved', 'AUTH_E2E_TARGET', 'has an unknown value; only "local" or "hosted" are accepted.');
}

function refsDeniedIn(mode: AuthE2ETargetMode): readonly string[] {
  return mode === 'local' ? [...PRODUCTION_PROJECT_REFS, ...LEGACY_E2E_PROJECT_REFS] : PRODUCTION_PROJECT_REFS;
}

/** Invisible / format code points that a parser or a resolver may drop (soft hyphen, zero-width, BOM, ...). */
const INVISIBLE_CODE_POINTS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

function safeDecode(text: string): string {
  let current = text;
  for (let i = 0; i < 4; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Every form of a value that a consumer could end up using: the raw text, its percent-decoded
 * form, and (when it parses as a URL) the WHATWG-normalised hostname and the decoded user name,
 * password, path, query and fragment. Each is NFKC-normalised, stripped of invisible code points
 * and lower-cased. (v2 of C2: v1 matched the raw text only, so percent-encoded, full-width or
 * soft-hyphenated production refs in secondary variables were accepted — review finding F1.)
 */
export function denialCandidates(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined): void => {
    if (!s) return;
    out.add(s.normalize('NFKC').replace(INVISIBLE_CODE_POINTS, '').toLowerCase());
  };
  add(value);
  add(safeDecode(value));
  for (const candidate of [value, safeDecode(value)]) {
    try {
      const u = new URL(candidate.normalize('NFKC').replace(INVISIBLE_CODE_POINTS, ''));
      add(u.hostname);
      add(safeDecode(u.username));
      add(safeDecode(u.password));
      add(safeDecode(u.pathname));
      add(safeDecode(u.search));
      add(safeDecode(u.hash));
    } catch {
      // not a URL in this form; the text forms above still apply
    }
  }
  return [...out];
}

/**
 * Denial pass. Runs on every form of every target-bearing input (denialCandidates), in every
 * mode, before any other decision, so a production (or, in local mode, legacy E2E) project
 * cannot be reached through a secondary variable, a database URL's user name (pooler form
 * "postgres.<ref>"), a path, a query string, or an encoded spelling of any of those.
 */
function assertNotDeniedProject(mode: AuthE2ETargetMode, variable: string, value: string): void {
  const forms = denialCandidates(value);
  for (const ref of refsDeniedIn(mode)) {
    if (forms.some((f) => f.includes(ref))) {
      const what = PRODUCTION_PROJECT_REFS.includes(ref) ? 'the PRODUCTION Supabase project' : 'the legacy hosted E2E project';
      fail(mode, variable, `refers to ${what}; refused.`);
    }
  }
  for (const host of PRODUCTION_HOSTNAMES) {
    if (forms.some((f) => f.includes(host.toLowerCase()))) fail(mode, variable, 'refers to the PRODUCTION Supabase host; refused.');
  }
  for (const host of PRODUCTION_REDIS_HOSTNAMES) {
    if (forms.some((f) => f.includes(host.toLowerCase()))) fail(mode, variable, 'refers to the PRODUCTION Redis host; refused.');
  }
}

/**
 * pathPattern: the ONLY acceptable raw text after the authority. A query string and a fragment are
 * never acceptable for any rule: libpq and node-postgres honour ?host=, ?hostaddr=, ?port= and
 * friends, which override the authority (v2 of C2; review finding F2).
 */
type LoopbackRule = { ports: readonly number[]; protocols: readonly string[]; allowUserInfo: boolean; pathPattern: RegExp };

/**
 * Strict loopback classification for local mode. Both a structural WHATWG URL
 * parse AND a literal check of the raw authority must agree, so normalisation
 * tricks (0x7f000001, 127.1, upper case, trailing dots, "@" smuggling) are refused.
 */
export function assertLocalLoopbackEndpoint(variable: string, value: string, rule: LoopbackRule): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('local', variable, 'is not a parseable URL.');
  }
  if (!rule.protocols.includes(parsed.protocol)) fail('local', variable, `uses an unexpected scheme "${parsed.protocol}".`);
  if ((parsed.username || parsed.password) && !rule.allowUserInfo) fail('local', variable, 'contains embedded credentials (user-info); refused.');
  const host = parsed.hostname.toLowerCase();
  if (!host) fail('local', variable, 'has no hostname.');
  if (!LOCAL_MODE_LOOPBACK_HOSTS.includes(host)) fail('local', variable, 'is not an allowlisted loopback host.');
  if (!parsed.port) fail('local', variable, 'must state an explicit port.');
  const port = Number(parsed.port);
  if (!rule.ports.includes(port)) fail('local', variable, `uses port ${port}, which is not the configured local port.`);
  // Literal authority check on the RAW string (case-sensitive, lower-case hosts only).
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/.exec(value);
  const authority = m ? m[1] : '';
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (authority.includes('@') && !rule.allowUserInfo) fail('local', variable, 'contains "@" in its authority; refused.');
  if (hostPort !== `${host}:${port}`) fail('local', variable, 'has an ambiguous or non-canonical host form; refused.');
  // Checked on the RAW text after the authority as well as on the parsed URL, because the
  // parser normalises dot-segments away ("http://127.0.0.1:54321/../.." parses to path "/").
  const rawRest = m ? value.slice(m[0].length) : value;
  if (rawRest.includes('?') || rawRest.includes('#') || parsed.search || parsed.hash) {
    fail('local', variable, 'must not carry a query string or fragment (they can override the host).');
  }
  if (!rule.pathPattern.test(rawRest)) fail('local', variable, 'carries an unexpected path.');
  return parsed;
}

export const SUPABASE_LOCAL_RULE: LoopbackRule = { ports: [LOCAL_STACK_PORTS.api], protocols: ['http:'], allowUserInfo: false, pathPattern: /^\/?$/ };
export const APP_LOCAL_RULE: LoopbackRule = { ports: [LOCAL_APP_PORT], protocols: ['http:'], allowUserInfo: false, pathPattern: /^\/?$/ };
// A Postgres URL inherently carries user-info (local stack default credentials); it is validated, never logged.
// Path: exactly one database name.
export const DB_LOCAL_RULE: LoopbackRule = { ports: [LOCAL_STACK_PORTS.db], protocols: ['postgres:', 'postgresql:'], allowUserInfo: true, pathPattern: /^\/[A-Za-z0-9_]+$/ };
// Path: none, or a database index.
export const REDIS_LOCAL_RULE: LoopbackRule = { ports: [LOCAL_REDIS_PORT], protocols: ['redis:'], allowUserInfo: false, pathPattern: /^(\/\d{0,2})?$/ };

function assertUsableKey(mode: AuthE2ETargetMode, key: string | null): string {
  if (!key) return fail(mode, SERVICE_KEY_VARIABLES.join('/'), 'is missing; a service key is required.');
  const lowered = key.toLowerCase();
  if (PLACEHOLDER_KEY_MARKERS.some((marker) => lowered.includes(marker))) fail(mode, 'the service key', 'looks like a placeholder value.');
  return key;
}

/**
 * JWT-shaped Supabase keys (legacy service_role / anon keys) carry their project in the payload:
 * hosted keys have {"iss":"supabase","ref":"<project ref>"}, the local CLI stack's keys have
 * {"iss":"supabase-demo"} and no ref. Opaque keys (sb_secret_..., sb_publishable_...) carry no
 * readable project claim; they are confined by the endpoint checks and the guarded admin fetch.
 * The payload is decoded WITHOUT verification (no secret is needed to read a claim) and is never
 * logged. (v3 of C2; review finding F5.)
 */
// Any three dot-separated segments: url-safe or standard base64, padded or not (review R8).
const JWT_SHAPE = /^[^.\s]+\.[^.\s]+\.[^.\s]*$/;

export function decodeJwtClaims(key: string): Record<string, unknown> | null {
  if (!JWT_SHAPE.test(key)) return null;
  const payload = key.split('.')[1];
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) return {};
    parsed = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** Every Supabase key variable the harness or the app under test may read (values never logged). */
export const KEY_VARIABLES_CHECKED_FOR_CLAIMS = [
  ...SERVICE_KEY_VARIABLES,
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
] as const;

function assertKeyClaims(mode: AuthE2ETargetMode, variable: string, key: string, hostedProjectRef: string | null): void {
  for (const form of denialCandidates(key)) {
    for (const ref of refsDeniedIn(mode)) if (form.includes(ref)) fail(mode, variable, 'names a refused Supabase project; refused.');
  }
  const claims = decodeJwtClaims(key);
  if (claims === null) return; // opaque key: no readable project claim
  if (Object.keys(claims).length === 0) fail(mode, variable, 'is JWT-shaped but its payload is not a readable claims object; refused.');
  const text = JSON.stringify(claims).toLowerCase();
  for (const ref of refsDeniedIn(mode)) if (text.includes(ref)) fail(mode, variable, 'is a key issued for a refused Supabase project; refused.');
  if (claims.ref !== undefined && typeof claims.ref !== 'string') fail(mode, variable, 'has a "ref" claim that is not a string; refused.');
  const ref = typeof claims.ref === 'string' ? claims.ref : null;
  if (mode === 'local') {
    if (claims.ref !== undefined) fail(mode, variable, 'is a key bound to a hosted project (it has a "ref" claim); local mode accepts only local-stack keys.');
    if (claims.iss !== 'supabase-demo') fail(mode, variable, 'is not a local-stack key (its "iss" claim is not "supabase-demo"); refused.');
  } else if (ref !== null && hostedProjectRef !== null && ref !== hostedProjectRef) {
    fail(mode, variable, `is a key for a different project than the validated E2E project "${hostedProjectRef}"; refused.`);
  }
}

/**
 * Local mode: the raw value of every target-bearing variable must be plain printable ASCII with no
 * whitespace, backslash or control character, and at most one "@". WHATWG URL, libpq, node-postgres
 * and curl disagree on exactly those inputs (tab/newline stripping, "\" as "/", first vs last "@"),
 * so refusing them makes the validated string and the consumed string the same URL for every
 * consumer. (v3 of C2; review finding F8.)
 */
const STRICT_LOCAL_URL_CHARS = /^[A-Za-z0-9._~:/@%+\-[\]]+$/;

export function assertStrictLocalText(variable: string, raw: string): void {
  if (!STRICT_LOCAL_URL_CHARS.test(raw)) fail('local', variable, 'contains whitespace, a control character, a backslash or another character that URL parsers interpret differently; refused.');
  if (raw.split('@').length > 2) fail('local', variable, 'contains more than one "@"; parsers disagree on where its host starts; refused.');
}

export type ResolveOptions = {
  /** Directory the app under test runs in (default: process.cwd()). */
  cwd?: string;
  /** Existence check for app env files (default: node:fs existsSync). Injectable for tests. */
  fileExists?: (absolutePath: string) => boolean;
};

/**
 * THE authoritative target resolver for the auth E2E harness and its preflight.
 * Reads the supplied environment and, in local mode only, checks whether app env files exist in
 * the app's working directory. No network request. Throws E2EEnvironmentError on any doubt; there
 * is no fallback path.
 */
export function resolveAuthE2ETarget(env: EnvLike, options: ResolveOptions = {}): ResolvedAuthE2ETarget {
  const mode = readAuthE2ETargetMode(env);

  // A target-bearing variable that is SET but blank is an error, never a reason to fall back to the
  // next variable (v2 of C2; review finding F11).
  for (const name of [...SUPABASE_URL_VARIABLES, ...KEY_VARIABLES_CHECKED_FOR_CLAIMS, ...DATABASE_URL_VARIABLES, ...REDIS_URL_VARIABLES, BASE_URL_VARIABLE, ...APP_OVERRIDE_VARIABLES]) {
    const raw = env[name];
    if (typeof raw === 'string' && raw.trim() === '' && raw !== '') fail(mode, name, 'is set but blank (whitespace only); refused rather than falling back.');
  }

  const urlInputs = SUPABASE_URL_VARIABLES.map((name) => ({ name, value: present(env, name) })).filter(
    (x): x is { name: (typeof SUPABASE_URL_VARIABLES)[number]; value: string } => x.value !== null,
  );
  const dbInputs = DATABASE_URL_VARIABLES.map((name) => ({ name, value: present(env, name) })).filter((x) => x.value !== null) as { name: string; value: string }[];
  const redisInputs = REDIS_URL_VARIABLES.map((name) => ({ name, value: present(env, name) })).filter((x) => x.value !== null) as { name: string; value: string }[];
  const overrideInputs = APP_OVERRIDE_VARIABLES.map((name) => ({ name, value: present(env, name) })).filter((x) => x.value !== null) as { name: string; value: string }[];
  const baseUrlRaw = present(env, BASE_URL_VARIABLE);
  const baseUrl = baseUrlRaw ?? DEFAULT_BASE_URL;
  const key = SERVICE_KEY_VARIABLES.map((name) => present(env, name)).find((v) => v !== null) ?? null;
  const known = new Set<string>([...DATABASE_URL_VARIABLES, ...REDIS_URL_VARIABLES, ...APP_OVERRIDE_VARIABLES, ...NON_CONNECTION_SETTINGS]);
  const connectionLike = Object.keys(env)
    .filter((name) => typeof env[name] === 'string' && (CONNECTION_NAME_PATTERN.test(name) || LIBPQ_NAME_PATTERN.test(name)))
    .sort();

  // ---- 1. Denial pass over every form of every target-bearing input (all modes). ----
  for (const input of [...urlInputs, ...dbInputs, ...redisInputs, ...overrideInputs]) assertNotDeniedProject(mode, input.name, input.value);
  assertNotDeniedProject(mode, BASE_URL_VARIABLE, baseUrl);
  // ...and over every other connection-like variable, whatever its name (v3; review finding F4).
  for (const name of connectionLike) if (!known.has(name)) assertNotDeniedProject(mode, name, env[name] as string);

  if (urlInputs.length === 0) {
    fail(mode, SUPABASE_URL_VARIABLES.join('/'), 'is missing; the suite refuses to guess a Supabase target.');
  }
  const primary = urlInputs[0];

  if (mode === 'hosted') {
    // An EMPTY expected ref would switch the allowlist off in the original guard (review R7).
    if (typeof env.AUTH_E2E_EXPECTED_PROJECT_REF === 'string' && env.AUTH_E2E_EXPECTED_PROJECT_REF.trim() === '') {
      fail(mode, 'AUTH_E2E_EXPECTED_PROJECT_REF', 'is set but empty, which would disable the expected-project check; unset it or name the project.');
    }
    // Unchanged contract: the primary URL goes through the original guard.
    const guard = assertNonProductionE2EEnvironment({
      supabaseUrl: primary.value,
      serviceRoleKey: key,
      expectedProjectRef: env.AUTH_E2E_EXPECTED_PROJECT_REF ?? undefined,
    });
    // Every secondary Supabase URL (the app server reads SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL)
    // must name the same, already-validated E2E origin (v2 of C2; review finding F1).
    const primaryOrigin = new URL(primary.value).origin;
    for (const input of urlInputs.slice(1)) {
      let origin = '';
      try {
        origin = new URL(input.value).origin;
      } catch {
        fail(mode, input.name, 'is not a parseable URL.');
      }
      if (origin !== primaryOrigin) fail(mode, input.name, `names a different Supabase origin than ${primary.name}; all Supabase URL variables must name the validated E2E project.`);
    }
    // Every key the harness or the app may use must not be bound to another project (v3; F5).
    for (const name of KEY_VARIABLES_CHECKED_FOR_CLAIMS) {
      const value = present(env, name);
      if (value !== null) assertKeyClaims(mode, name, value, guard.projectRef);
    }
    return Object.freeze({
      mode, supabaseUrl: primary.value, supabaseUrlVariable: primary.name, serviceRoleKey: key as string, baseUrl, guard,
      [RESOLVED_TARGET_BRAND]: true as const,
    });
  }

  // ---- 2. Local mode: every input is a strict loopback endpoint; inputs agree. ----
  if (env.AUTH_E2E_EXPECTED_PROJECT_REF !== undefined) {
    fail(mode, 'AUTH_E2E_EXPECTED_PROJECT_REF', 'is a hosted-mode setting and must not be set in local mode (conflicting configuration).');
  }
  // The app under test picks its own Supabase target from these; in local mode they must not exist
  // (v2 of C2; review finding F3).
  for (const input of overrideInputs) fail(mode, input.name, 'can redirect a connection of the app under test (or disable one of its safety blocks) and must not be set in local mode.');
  // Unknown connection-like variables and libpq PG* variables (v3; review findings F4, F15).
  for (const name of connectionLike) {
    if (LIBPQ_NAME_PATTERN.test(name)) fail(mode, name, 'is a libpq / node-postgres connection variable (it can fill in or redirect a database connection) and must not be set in local mode.');
    if (!known.has(name)) fail(mode, name, 'is an unrecognised connection variable; local mode refuses every connection input it does not validate.');
  }
  // F8 (v3): one character set for every local endpoint, checked on the RAW value the app will read.
  for (const name of [...SUPABASE_URL_VARIABLES, ...DATABASE_URL_VARIABLES, ...REDIS_URL_VARIABLES, BASE_URL_VARIABLE]) {
    const raw = env[name];
    if (typeof raw === 'string' && raw !== '') assertStrictLocalText(name, raw);
  }
  const exists = options.fileExists ?? ((p: string) => (require('node:fs') as typeof import('node:fs')).existsSync(p));
  const cwd = options.cwd ?? process.cwd();
  const { join } = require('node:path') as typeof import('node:path');
  for (const file of APP_ENV_FILES) {
    if (exists(join(cwd, file))) fail(mode, file, 'exists in the app directory; the app would load it to fill unset variables (it may point at a hosted project). Refused in local mode.');
  }
  let canonicalOrigin: string | null = null;
  let primaryHost = '';
  for (const input of urlInputs) {
    const parsed = assertLocalLoopbackEndpoint(input.name, input.value, SUPABASE_LOCAL_RULE);
    if (canonicalOrigin === null) {
      canonicalOrigin = parsed.origin;
      primaryHost = `${parsed.hostname}:${parsed.port}`;
    } else if (parsed.origin !== canonicalOrigin) {
      fail(mode, input.name, `conflicts with ${primary.name}; all Supabase URL variables must name the same local endpoint.`);
    }
  }
  // The app server reads SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL directly; leaving either unset
  // would let an env file fill it (v2 of C2; review finding F3).
  for (const required of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'] as const) {
    if (!urlInputs.some((i) => i.name === required)) fail(mode, required, 'must be set to the local stack in local mode (the app under test reads it).');
  }
  assertLocalLoopbackEndpoint(BASE_URL_VARIABLE, baseUrl, APP_LOCAL_RULE);
  for (const input of dbInputs) assertLocalLoopbackEndpoint(input.name, input.value, DB_LOCAL_RULE);
  // The app defaults an unset REDIS_URL to localhost; local mode states it explicitly (v3; F4).
  if (!redisInputs.some((i) => i.name === 'REDIS_URL')) fail(mode, 'REDIS_URL', 'must be set to the loopback Redis in local mode (the app under test reads it).');
  for (const input of redisInputs) assertLocalLoopbackEndpoint(input.name, input.value, REDIS_LOCAL_RULE);
  const serviceRoleKey = assertUsableKey(mode, key);
  // No key the harness or the app may use can be bound to a hosted project (v3; review finding F5).
  for (const name of KEY_VARIABLES_CHECKED_FOR_CLAIMS) {
    const value = present(env, name);
    if (value !== null) assertKeyClaims(mode, name, value, null);
  }
  // The app server's service-role client uses SUPABASE_SECRET_KEY; it must be the validated key.
  if (present(env, 'SUPABASE_SECRET_KEY') !== serviceRoleKey) {
    fail(mode, 'SUPABASE_SECRET_KEY', 'must be set and equal to the selected local service key in local mode (the app under test uses it).');
  }

  return Object.freeze({
    mode,
    // Exactly the validated endpoint, serialised by the same parser the clients use (v3; F8).
    supabaseUrl: canonicalOrigin as string,
    supabaseUrlVariable: primary.name,
    serviceRoleKey,
    baseUrl,
    guard: { projectRef: 'local', hostname: primaryHost, description: `disposable local Supabase stack (${primaryHost})` },
    [RESOLVED_TARGET_BRAND]: true as const,
  });
}

/** True only for objects produced by resolveAuthE2ETarget. */
export function isResolvedAuthE2ETarget(value: unknown): value is ResolvedAuthE2ETarget {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RESOLVED_TARGET_BRAND] === true;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; redirect?: 'manual' }) => Promise<{ ok: boolean; status: number }>;

/**
 * Local mode only: proves the disposable stack answers BEFORE any admin call.
 * Accepts only a resolver-produced local target, so an unvalidated URL can never
 * be contacted through this path. Never follows redirects; never falls back.
 */
export async function assertLocalStackReachable(target: ResolvedAuthE2ETarget, fetchImpl: FetchLike): Promise<void> {
  if (!isResolvedAuthE2ETarget(target)) throw new E2EEnvironmentError('reachability probe refused: target was not produced by resolveAuthE2ETarget.');
  if (target.mode !== 'local') throw new E2EEnvironmentError('reachability probe is for local mode only.');
  const probeUrl = `${new URL(target.supabaseUrl).origin}/auth/v1/health`;
  let status = 0;
  try {
    const res = await fetchImpl(probeUrl, { method: 'GET', headers: { apikey: target.serviceRoleKey }, redirect: 'manual' });
    status = res.status;
    if (res.ok) return;
  } catch {
    status = 0;
  }
  throw new E2EEnvironmentError(
    `target mode "local": the disposable Supabase stack at ${target.guard.hostname} is not reachable (status ${status}). ` +
      'No fallback target is used; start it with tests/supabase-local/bootstrap.sh on a CI runner.',
  );
}

/**
 * The ONLY fetch the harness's admin Supabase client may use (v3 of C2; review findings F8, F9,
 * F10). For every request it:
 *   1. refuses any destination whose origin is not the validated Supabase origin, so the URL the
 *      guard validated is exactly where the key is sent (no second interpretation);
 *   2. runs `beforeRequest` first (the harness re-resolves the target and, in local mode, runs the
 *      memoised reachability probe), so no admin request can precede local-target validation;
 *   3. sends with redirect "manual" and refuses any 3xx / opaque-redirect answer, so the apikey
 *      and Authorization headers are never forwarded to a redirect destination.
 */
export type AdminFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createGuardedAdminFetch(
  target: ResolvedAuthE2ETarget,
  fetchImpl: AdminFetch,
  beforeRequest: () => void | Promise<void> = () => undefined,
): AdminFetch {
  if (!isResolvedAuthE2ETarget(target)) throw new E2EEnvironmentError('admin fetch refused: target was not produced by resolveAuthE2ETarget.');
  const allowedOrigin = new URL(target.supabaseUrl).origin;
  return async (input, init) => {
    // Only a string, URL or Request is accepted, and the ONE Request object built here is both
    // validated and sent, so no second interpretation (toString vs .url) exists (review R4).
    if (!(typeof input === 'string' || input instanceof URL || input instanceof Request)) {
      throw new E2EEnvironmentError('admin request refused: unsupported request input type.');
    }
    let request: Request;
    try {
      request = new Request(input, { ...init, redirect: 'manual' });
    } catch {
      throw new E2EEnvironmentError('admin request refused: its destination is not a parseable URL.');
    }
    if (new URL(request.url).origin !== allowedOrigin) {
      throw new E2EEnvironmentError(`admin request refused: destination is not the validated Supabase origin (${target.guard.hostname}).`);
    }
    await beforeRequest();
    const response = await fetchImpl(request);
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new E2EEnvironmentError(`admin request refused: the Supabase endpoint answered with a redirect (status ${response.status}); credentials are never forwarded to a redirect.`);
    }
    return response;
  };
}
