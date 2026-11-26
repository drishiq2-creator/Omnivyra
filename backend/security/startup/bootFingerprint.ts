/**
 * bootFingerprint — produce + emit a deterministic, structured "what's
 * deployed" log line so a single grep across server logs answers the
 * question "which version of the auth contract is this process running?"
 *
 * Why this exists
 * ───────────────
 * When the Phase 2.B login loop hit production, multiple environments
 * were running different combinations of: (a) deployed application code,
 * (b) applied migrations, (c) PostgREST schema cache state. Each layer
 * made the symptom look slightly different. Without a single artifact
 * naming all three, debugging required reading and correlating three log
 * surfaces.
 *
 * The fingerprint captures all three:
 *   - auth_contract_version: bumped manually when AUTH_ERROR_CODE / the
 *     resolver protocol changes shape.
 *   - schema_manifest_hash: the committed `generated/schema-column-manifest.json`
 *     (see `scripts/generate-schema-manifest.js`), bundled by a static require
 *     and validated (`buildProvenance.ts`); null + a status when absent/invalid.
 *   - build provenance: the verified source commit (deploy-time stamp
 *     re-verified at build time), a claimed commit, a status and a reason, and
 *     the platform deployment id kept separate from the commit.
 *   - runtime: node version, NODE_ENV, Vercel / Railway env names.
 *
 * `fingerprint` is a stable digest of the above so two processes with
 * the same fingerprint are interchangeable from an auth-contract POV.
 */

import { createHash } from 'crypto';
import { firstNonEmptyEnv } from '../../../config/provenanceEnv';
import { logger } from '../../services/logger';
import {
  getBuildProvenance,
  getSchemaManifestIdentity,
  type BuildProvenanceStatus,
  type SchemaManifestStatus,
} from './buildProvenance';

/**
 * Bump this when the AUTH_ERROR_CODE enum, the resolver protocol, or the
 * client decision matrix changes shape. Major version is a breaking
 * change to the response envelope; minor is additive.
 */
export const AUTH_CONTRACT_VERSION = '2.B.2' as const;

export interface BootFingerprint {
  /** Stable digest of contract version + schema hash + Node version. */
  fingerprint:           string;
  authContractVersion:   string;
  /** The committed manifest's `manifest_hash`, or null (see schemaManifestStatus). Never a timestamp. */
  schemaManifestHash:    string | null;
  schemaManifestStatus:  SchemaManifestStatus;
  nodeVersion:           string;
  nodeEnv:               string;
  /**
   * LEGACY, kept for compatibility: the first non-empty of VERCEL_GIT_COMMIT_SHA,
   * RAILWAY_DEPLOYMENT_ID, GIT_COMMIT_SHA — a commit on Vercel but a DEPLOYMENT
   * id on Railway, and never verified. New readers use `commitSha` (verified
   * source commit) and `platformDeploymentId` (deployment id) instead.
   */
  deploymentId:          string | null;
  /** Source commit, ONLY when build provenance is verified; otherwise null. */
  commitSha:             string | null;
  /** The commit a stamp or env CLAIMS, verified or not. Never fabricated. */
  claimedCommitSha:      string | null;
  buildProvenance:       BuildProvenanceStatus;
  buildProvenanceReason: string;
  buildProvenanceSource: 'stamp' | 'env' | null;
  /** VERCEL_DEPLOYMENT_ID / RAILWAY_DEPLOYMENT_ID. A deployment, NOT a commit. */
  platformDeploymentId:  string | null;
  vercelEnv:             string | null;
  railwayEnv:            string | null;
  emittedAt:             string;
}

function digestFingerprint(parts: ReadonlyArray<string | null>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex');
}

let cached: BootFingerprint | null = null;

/**
 * Compute (cached) + emit the fingerprint exactly once. Returns the
 * snapshot. Subsequent calls are no-ops returning the same object.
 *
 * ROUND 12: takes NO hint. It used to accept `{ schemaManifestHash }` and the
 * boot orchestrator passed `schema.checkedAt` — an ISO timestamp — which won
 * the `length > 16` test, so the first caller decided whether an instance
 * reported the manifest hash, a timestamp, or (via a `__dirname` read that
 * missed `generated/` in one bundle copy) null. The manifest hash and the build
 * provenance now come only from bundled bytes (`buildProvenance.ts`), so every
 * caller, in any order, gets the same values.
 */
export function emitBootFingerprint(): BootFingerprint {
  if (cached) return cached;

  const manifest = getSchemaManifestIdentity();
  const schemaManifestHash = manifest.hash;
  const provenance = getBuildProvenance(process.env);

  const nodeVersion = process.version;
  const nodeEnv = process.env.NODE_ENV ?? 'unknown';
  const vercelEnv = process.env.VERCEL_ENV ?? null;
  const railwayEnv = process.env.RAILWAY_ENVIRONMENT ?? null;
  // An empty VERCEL_GIT_COMMIT_SHA must not win the chain (see provenanceEnv).
  const deploymentId = firstNonEmptyEnv(
    'VERCEL_GIT_COMMIT_SHA',
    'RAILWAY_DEPLOYMENT_ID',
    'GIT_COMMIT_SHA',
  );

  const fingerprint = digestFingerprint([
    AUTH_CONTRACT_VERSION,
    schemaManifestHash,
    nodeVersion,
    nodeEnv,
    vercelEnv,
    railwayEnv,
  ]).slice(0, 32);

  const snapshot: BootFingerprint = {
    fingerprint,
    authContractVersion: AUTH_CONTRACT_VERSION,
    schemaManifestHash,
    nodeVersion,
    nodeEnv,
    deploymentId,
    commitSha:             provenance.commitSha,
    claimedCommitSha:      provenance.claimedCommitSha,
    buildProvenance:       provenance.status,
    buildProvenanceReason: provenance.reason,
    buildProvenanceSource: provenance.source,
    platformDeploymentId:  provenance.platformDeploymentId,
    schemaManifestStatus:  manifest.status,
    vercelEnv,
    railwayEnv,
    emittedAt: new Date().toISOString(),
  };

  logger.info('auth_boot_fingerprint', {
    fingerprint:           snapshot.fingerprint,
    auth_contract_version: snapshot.authContractVersion,
    schema_manifest_hash:  snapshot.schemaManifestHash,
    schema_manifest_status: snapshot.schemaManifestStatus,
    commit_sha:            snapshot.commitSha,
    claimed_commit_sha:    snapshot.claimedCommitSha,
    build_provenance:      snapshot.buildProvenance,
    build_provenance_reason: snapshot.buildProvenanceReason,
    platform_deployment_id: snapshot.platformDeploymentId,
    node_version:          snapshot.nodeVersion,
    node_env:              snapshot.nodeEnv,
    deployment_id:         snapshot.deploymentId,
    vercel_env:            snapshot.vercelEnv,
    railway_env:           snapshot.railwayEnv,
  });

  cached = snapshot;
  return snapshot;
}

/** Reset for tests only. */
export function resetBootFingerprint(): void {
  cached = null;
}
