/**
 * buildProvenance — runtime view of WHICH SOURCE this deployment was built from,
 * and of the committed schema manifest, each with an explicit status.
 *
 * Both inputs are loaded by a STATIC, literal `require()` so the bundler
 * (webpack, for every API route in the Next build) inlines the JSON into each
 * output file that needs it. No `__dirname`, no `fs`, no output-file tracing:
 * every copy of this module in every function carries the same bytes, so the
 * answer cannot depend on which route an instance served first (round 11: the
 * copy inlined into `health/version.js` resolved `__dirname` to a directory
 * without `generated/` and cached null for the whole instance).
 *
 * The `require()` sits in a try block on purpose: webpack marks such a
 * dependency optional and downgrades "module not found" to a build WARNING
 * (V: next/dist/compiled/webpack/bundle5.js, `optional=Boolean(scope.inTry)`
 * and `every(d=>d.optional) -> warnings.push`). The provenance RESULT is
 * gitignored and written by the build itself, so it is legitimately absent in
 * `next dev`, jest and the worker build; absence is then reported as
 * `missing`, never as an error and never as a value.
 *
 * Statuses
 * ────────
 * build_provenance:
 *   verified    the build re-hashed every file the deploy-time stamp lists and
 *               they matched, and no runtime cross-check disagrees.
 *   unverified  a commit is CLAIMED (stamp or env) but could not be verified,
 *               or a cross-check disagrees. The claim is reported separately as
 *               `claimedCommitSha`; `commitSha` stays null.
 *   missing     nothing claims a commit.
 *
 * `commitSha` is the SOURCE commit. `platformDeploymentId` is the platform's
 * DEPLOYMENT id (VERCEL_DEPLOYMENT_ID / RAILWAY_DEPLOYMENT_ID). They are never
 * substituted for each other.
 */

import { createHash } from 'crypto';

export type BuildProvenanceStatus = 'verified' | 'unverified' | 'missing';
export type SchemaManifestStatus = 'ok' | 'missing' | 'invalid' | 'unavailable';

export interface BuildProvenance {
  /** The source commit, ONLY when verified. Never fabricated. */
  commitSha: string | null;
  /** What was claimed (stamp or env), whether or not it verified. */
  claimedCommitSha: string | null;
  status: BuildProvenanceStatus;
  reason: string;
  source: 'stamp' | 'env' | null;
  /** Platform deployment id. NOT a commit. */
  platformDeploymentId: string | null;
}

export interface SchemaManifestIdentity {
  hash: string | null;
  status: SchemaManifestStatus;
  reason: string;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Env = Record<string, string | undefined>;

function envValue(env: Env, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function firstEnv(env: Env, ...names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = envValue(env, name);
    if (value !== null) return { name, value };
  }
  return null;
}

/** Commit-carrying env names, in precedence order. Deployment ids are NOT here. */
export const COMMIT_ENV_NAMES = ['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'GIT_COMMIT_SHA'] as const;
export const DEPLOYMENT_ENV_NAMES = ['VERCEL_DEPLOYMENT_ID', 'RAILWAY_DEPLOYMENT_ID'] as const;

/**
 * Pure: combine the build-time result (or null) with runtime env.
 */
export function resolveBuildProvenance(result: unknown, env: Env): BuildProvenance {
  const platformDeploymentId = firstEnv(env, ...DEPLOYMENT_ENV_NAMES)?.value ?? null;
  const envCommit = firstEnv(env, ...COMMIT_ENV_NAMES);
  const envSha = envCommit && SHA40.test(envCommit.value) ? envCommit.value : null;

  const out = (
    status: BuildProvenanceStatus,
    reason: string,
    claimedCommitSha: string | null,
    source: 'stamp' | 'env' | null,
  ): BuildProvenance => ({
    commitSha: status === 'verified' ? claimedCommitSha : null,
    claimedCommitSha,
    status,
    reason,
    source,
    platformDeploymentId,
  });

  const r = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
  const hasResult = r !== null;
  const resultStatus = hasResult ? r!.status : undefined;

  // No stamp in the build (or no result at all): fall back to env as a CLAIM.
  if (!hasResult || resultStatus === 'missing') {
    if (envSha) return out('unverified', hasResult ? 'env_only_no_build_stamp' : 'env_only_no_build_result', envSha, 'env');
    if (envCommit) return out('unverified', 'env_commit_malformed', null, 'env');
    return out('missing', hasResult ? 'no_build_stamp_and_no_env' : 'no_build_result_and_no_env', null, null);
  }

  if (r!.schema_version !== 1) return out('unverified', 'build_result_schema_unsupported', null, 'stamp');
  const claimed = typeof r!.commit_sha === 'string' && SHA40.test(r!.commit_sha) ? r!.commit_sha : null;

  if (resultStatus === 'unverified') {
    const why = typeof r!.reason === 'string' && r!.reason ? r!.reason : 'unspecified';
    return out('unverified', `build:${why}`, claimed, 'stamp');
  }
  if (resultStatus !== 'verified') return out('unverified', 'build_result_status_invalid', claimed, 'stamp');
  if (!claimed) return out('unverified', 'build_result_commit_malformed', null, 'stamp');
  if (typeof r!.source_digest !== 'string' || !SHA256.test(r!.source_digest)) {
    return out('unverified', 'build_result_digest_malformed', claimed, 'stamp');
  }

  // Cross-checks: each can only DOWNGRADE, never upgrade.
  if (envCommit && envSha !== claimed) return out('unverified', 'env_commit_disagrees_with_stamp', claimed, 'stamp');
  const builtFor = typeof r!.build_deployment_id === 'string' && r!.build_deployment_id ? r!.build_deployment_id : null;
  const runtimeVercelDeployment = envValue(env, 'VERCEL_DEPLOYMENT_ID');
  if (builtFor && runtimeVercelDeployment && builtFor !== runtimeVercelDeployment) {
    return out('unverified', 'build_result_from_other_deployment', claimed, 'stamp');
  }

  return out('verified', envSha ? 'stamp_verified_env_agrees' : 'stamp_verified', claimed, 'stamp');
}

/** Mirrors `hashManifest` in scripts/generate-schema-manifest.js (rows -> hash). */
function hashManifestRows(columns: ReadonlyArray<Record<string, unknown>>): string {
  const byTable = new Map<string, Map<string, unknown>>();
  for (const c of columns) {
    const table = String(c.table);
    if (!byTable.has(table)) byTable.set(table, new Map());
    byTable.get(table)!.set(String(c.column), c.source_migration);
  }
  const entries: string[] = [];
  for (const [table, cols] of [...byTable.entries()].sort()) {
    for (const [col, src] of [...cols.entries()].sort()) entries.push(`${table}.${col}=${src}`);
  }
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/**
 * Pure: validate the committed manifest and return its hash with a status.
 * The hash is reported only when the manifest is well-formed AND its
 * `manifest_hash` matches its own rows (the same self-consistency rule the
 * `--check` gate applies), so a timestamp or a hand-edited value never passes.
 */
export function evaluateSchemaManifest(raw: unknown): SchemaManifestIdentity {
  if (raw === null || raw === undefined) return { hash: null, status: 'missing', reason: 'manifest_not_loaded' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { hash: null, status: 'invalid', reason: 'manifest_not_an_object' };
  const m = raw as Record<string, unknown>;
  if (m.schema_version !== 1) return { hash: null, status: 'invalid', reason: 'manifest_schema_version_unsupported' };
  if (typeof m.manifest_hash !== 'string' || !SHA256.test(m.manifest_hash)) {
    return { hash: null, status: 'invalid', reason: 'manifest_hash_malformed' };
  }
  if (!Array.isArray(m.columns) || m.columns.length === 0) return { hash: null, status: 'invalid', reason: 'manifest_columns_missing' };
  if (m.columns.some((c) => !c || typeof c !== 'object')) return { hash: null, status: 'invalid', reason: 'manifest_columns_malformed' };
  if (hashManifestRows(m.columns as Array<Record<string, unknown>>) !== m.manifest_hash) {
    return { hash: null, status: 'invalid', reason: 'manifest_hash_does_not_match_rows' };
  }
  return { hash: m.manifest_hash, status: 'ok', reason: 'committed_manifest' };
}

/* eslint-disable @typescript-eslint/no-var-requires */
function loadCommittedManifest(): unknown {
  try {
    return require('../../../generated/schema-column-manifest.json');
  } catch {
    return null;
  }
}

function loadBuildResult(): unknown {
  try {
    return require('../../../generated/build-provenance/result.json');
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-var-requires */

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// Evaluated ONCE per module instance, from bundled bytes only. Nothing a caller
// passes can change these.
const SCHEMA_MANIFEST: Readonly<SchemaManifestIdentity> = deepFreeze(evaluateSchemaManifest(loadCommittedManifest()));
const BUILD_RESULT: unknown = deepFreeze(loadBuildResult());

export function getSchemaManifestIdentity(): Readonly<SchemaManifestIdentity> {
  return SCHEMA_MANIFEST;
}

export function getBuildProvenance(env: Env = process.env): Readonly<BuildProvenance> {
  return Object.freeze(resolveBuildProvenance(BUILD_RESULT, env));
}
