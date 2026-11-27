/**
 * buildProvenanceStamp — deploy-time STAMP and build-time VERIFY for the
 * source revision a deployment was built from.
 *
 * Plain CommonJS on purpose: it is loaded by `scripts/vercel-deploy-prod.js`
 * (deploy time, on the operator's machine, with `.git`) and by
 * `scripts/safe-build.js` (build time, on Vercel, WITHOUT `.git`), neither of
 * which can load TypeScript. The runtime never loads this file; it reads only
 * the small RESULT this file writes (see `buildProvenance.ts`).
 *
 * Why a stamp and not only `-e VERCEL_GIT_COMMIT_SHA`
 * ──────────────────────────────────────────────────
 * `-e` is a deployment-scoped RUNTIME env value. `vercel redeploy` re-reads the
 * project env and does not replay it, so a redeploy served `build: null`
 * (round 11). A redeploy DOES reuse the uploaded files and rebuilds them, so a
 * file in the upload survives it. That file is the stamp:
 *
 *   generated/build-provenance/stamp.json   written by the deploy script after
 *     the clean-tree check, uploaded with the source, deleted locally when the
 *     deploy command returns (so a later bare `vercel` upload cannot carry it).
 *   generated/build-provenance/result.json  written by the BUILD (safe-build)
 *     after re-hashing every file the stamp lists. Small; the runtime bundles it.
 *
 * Both are gitignored (`generated/build-provenance/`); neither is committed, so
 * no SHA value is ever committed to the repository.
 *
 * Soundness of the digest
 * ───────────────────────
 * The stamp lists every tracked file the Vercel CLI will upload, with the
 * sha256 of its bytes AS UPLOADED (working-tree bytes, not git blobs, so a
 * line-ending conversion cannot make a matching file look different or vice
 * versa). `source_digest` is a sha256 over the sorted (path, hash) list. The
 * build recomputes the digest from the list (stamp integrity) and re-hashes
 * every listed file on disk (content identity). Any changed or missing file
 * makes the result `unverified`. A file ADDED to the upload that the stamp does
 * not list is not detected here (see the remediation report, residual risks);
 * the clean-tree refusal (untracked files count as dirty) is what prevents it.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STAMP_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
const PROVENANCE_DIR = path.join('generated', 'build-provenance');
const STAMP_REL = path.join(PROVENANCE_DIR, 'stamp.json');
const RESULT_REL = path.join(PROVENANCE_DIR, 'result.json');

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Vercel CLI default upload ignores (A: Vercel documentation; consistent with
 * round 11, where tracked `.gitignore`, `.dockerignore` and `__pycache__` files
 * were absent from the upload). Passed to `git ls-files --exclude=` IN ADDITION
 * to `.vercelignore`. Over-listing here only narrows coverage; under-listing
 * makes the build see a listed file as missing, i.e. `unverified` (a false
 * red, never a false green).
 */
const VERCEL_DEFAULT_IGNORES = Object.freeze([
  '.hg', '.git', '.gitmodules', '.svn', '.cache', '.next', '.now', '.vercel',
  '.npmignore', '.dockerignore', '.gitignore', '.*.swp', '.DS_Store',
  '.wafpickle-*', '.lock-wscript', '.env.local', '.env.*.local', '.venv',
  'npm-debug.log', 'config.gypi', 'node_modules', '__pycache__', 'venv', 'CVS',
]);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Repo-relative POSIX path; the stamp never carries a platform separator. */
function toPosix(p) {
  return String(p).split(path.sep).join('/').split('\\').join('/');
}

/** Deterministic digest over a { path: sha256 } map (key order irrelevant). */
function digestFileMap(files) {
  const keys = Object.keys(files).sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) h.update(`${k}\0${files[k]}\n`);
  return h.digest('hex');
}

/**
 * The files the upload will carry: tracked files minus those `.vercelignore`
 * or the Vercel defaults exclude. Both inputs are NUL-separated `git ls-files`
 * outputs, so this is pure and testable without git.
 */
function uploadableFiles(trackedZ, ignoredZ) {
  const split = (s) => String(s || '').split('\0').filter(Boolean).map(toPosix);
  const ignored = new Set(split(ignoredZ));
  return split(trackedZ).filter((p) => !ignored.has(p)).sort();
}

/** sha256 of each listed file's bytes under `root`. Throws on an unreadable file. */
function hashFiles(root, relPaths, fsImpl = fs) {
  const files = {};
  for (const rel of relPaths) {
    files[rel] = sha256(fsImpl.readFileSync(path.join(root, rel)));
  }
  return files;
}

/**
 * Build the stamp object. REFUSES (throws) rather than stamp anything it cannot
 * stand behind: a malformed commit, a dirty tree, or an empty file list.
 */
function buildStamp({ commitSha, treeSha, clean, files, stampedAt }) {
  if (!SHA40.test(String(commitSha || ''))) throw new Error(`refusing to stamp: commit sha is not 40 hex (${commitSha || '<empty>'})`);
  if (!SHA40.test(String(treeSha || ''))) throw new Error(`refusing to stamp: tree sha is not 40 hex (${treeSha || '<empty>'})`);
  if (clean !== true) throw new Error('refusing to stamp: working tree is not clean');
  const count = files && typeof files === 'object' ? Object.keys(files).length : 0;
  if (count === 0) throw new Error('refusing to stamp: no files to cover');
  return {
    schema_version: STAMP_SCHEMA_VERSION,
    commit_sha: commitSha,
    tree_sha: treeSha,
    clean: true,
    file_count: count,
    source_digest: digestFileMap(files),
    stamped_at: stampedAt,
    files,
  };
}

const MAX_SAMPLE = 5;

/**
 * Verify a parsed stamp against the files actually present under `root`.
 * Returns { status: 'verified' | 'unverified', reason, ... }. Never throws for
 * a bad stamp; a bad stamp is an `unverified` verdict with a reason.
 */
function verifyStamp(stamp, root, fsImpl = fs) {
  const claimed = stamp && SHA40.test(String(stamp.commit_sha || '')) ? stamp.commit_sha : null;
  const base = {
    commit_sha: claimed,
    tree_sha: stamp && SHA40.test(String(stamp.tree_sha || '')) ? stamp.tree_sha : null,
    source_digest: stamp && SHA256.test(String(stamp.source_digest || '')) ? stamp.source_digest : null,
    file_count: stamp && Number.isInteger(stamp.file_count) ? stamp.file_count : null,
    checked_file_count: 0,
  };
  const bad = (reason, extra) => ({ status: 'unverified', reason, ...base, ...(extra || {}) });

  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return bad('stamp_not_an_object');
  if (stamp.schema_version !== STAMP_SCHEMA_VERSION) return bad('stamp_schema_version_unsupported');
  if (!claimed) return bad('stamp_commit_sha_malformed');
  if (!base.tree_sha) return bad('stamp_tree_sha_malformed');
  if (stamp.clean !== true) return bad('stamp_not_clean');
  if (!stamp.files || typeof stamp.files !== 'object' || Array.isArray(stamp.files)) return bad('stamp_files_missing');
  const keys = Object.keys(stamp.files);
  if (keys.length === 0) return bad('stamp_files_empty');
  if (stamp.file_count !== keys.length) return bad('stamp_file_count_mismatch');
  for (const k of keys) {
    if (!SHA256.test(String(stamp.files[k]))) return bad('stamp_file_hash_malformed', { sample: [k] });
    // A listed path must stay inside the project root.
    if (k.startsWith('/') || k.split('/').includes('..') || /^[A-Za-z]:/.test(k)) return bad('stamp_path_outside_root', { sample: [k] });
  }
  if (!base.source_digest || digestFileMap(stamp.files) !== stamp.source_digest) return bad('stamp_digest_mismatch');

  const missing = [];
  const changed = [];
  let checked = 0;
  for (const k of keys.sort()) {
    let buf;
    try {
      buf = fsImpl.readFileSync(path.join(root, k));
    } catch {
      missing.push(k);
      continue;
    }
    checked++;
    if (sha256(buf) !== stamp.files[k]) changed.push(k);
  }
  const counts = {
    checked_file_count: checked,
    missing_count: missing.length,
    changed_count: changed.length,
  };
  if (missing.length || changed.length) {
    return bad(changed.length ? 'source_content_mismatch' : 'source_file_missing', {
      ...counts,
      sample: [...changed, ...missing].slice(0, MAX_SAMPLE),
    });
  }
  return { status: 'verified', reason: 'stamp_matches_built_source', ...base, ...counts };
}

/** The small, runtime-facing result. Carries no file list. */
function buildResult(verdict, { buildDeploymentId, builtAt }) {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    status: verdict.status,
    reason: verdict.reason,
    commit_sha: verdict.commit_sha ?? null,
    tree_sha: verdict.tree_sha ?? null,
    source_digest: verdict.source_digest ?? null,
    file_count: verdict.file_count ?? null,
    checked_file_count: verdict.checked_file_count ?? 0,
    missing_count: verdict.missing_count ?? 0,
    changed_count: verdict.changed_count ?? 0,
    sample: verdict.sample ?? [],
    build_deployment_id: buildDeploymentId || null,
    built_at: builtAt,
  };
}

function removeIfPresent(absPath, fsImpl = fs) {
  try {
    fsImpl.unlinkSync(absPath);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Build-time step (safe-build). ALWAYS replaces the result: first deletes any
 * existing result (a stale one must never survive into the bundle; a failure
 * to delete throws and fails the build), then writes a fresh verdict:
 *   - no stamp            -> status 'missing'
 *   - unparseable stamp   -> 'unverified' (stamp_unparseable)
 *   - otherwise           -> verifyStamp()
 */
function runBuildVerify({ root, env = process.env, fsImpl = fs, now = () => new Date().toISOString() }) {
  const resultAbs = path.join(root, RESULT_REL);
  const stampAbs = path.join(root, STAMP_REL);
  removeIfPresent(resultAbs, fsImpl);

  let verdict;
  let raw = null;
  try {
    raw = fsImpl.readFileSync(stampAbs, 'utf8');
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      verdict = { status: 'unverified', reason: 'stamp_unreadable' };
    }
  }
  if (!verdict) {
    if (raw === null) {
      verdict = { status: 'missing', reason: 'no_stamp_in_build_source' };
    } else {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      verdict = parsed === undefined
        ? { status: 'unverified', reason: 'stamp_unparseable' }
        : verifyStamp(parsed, root, fsImpl);
    }
  }
  const result = buildResult(verdict, {
    buildDeploymentId: (env.VERCEL_DEPLOYMENT_ID || '').trim() || null,
    builtAt: now(),
  });
  fsImpl.mkdirSync(path.join(root, PROVENANCE_DIR), { recursive: true });
  fsImpl.writeFileSync(resultAbs, JSON.stringify(result, null, 2) + '\n');
  return result;
}

module.exports = {
  STAMP_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  PROVENANCE_DIR,
  STAMP_REL,
  RESULT_REL,
  VERCEL_DEFAULT_IGNORES,
  sha256,
  toPosix,
  digestFileMap,
  uploadableFiles,
  hashFiles,
  buildStamp,
  verifyStamp,
  buildResult,
  removeIfPresent,
  runBuildVerify,
};

if (require.main === module && process.argv.includes('--verify-build')) {
  try {
    const r = runBuildVerify({ root: process.cwd() });
    process.stdout.write(
      `build-provenance: ${r.status} (${r.reason})` +
      (r.commit_sha ? ` commit=${r.commit_sha}` : '') +
      ` checked=${r.checked_file_count}/${r.file_count ?? 0}\n`,
    );
  } catch (e) {
    // Only reachable when the stale result could not be deleted or the new one
    // could not be written; a build must not ship a possibly-stale verdict.
    process.stderr.write(`build-provenance: FAILED ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}
