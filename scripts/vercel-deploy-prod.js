#!/usr/bin/env node
/**
 * Production Vercel deploy with explicit commit provenance.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA to an EMPTY STRING on CLI deploys (there is
 * no git integration to populate it), so the deployed app cannot discover its
 * own commit. `config/provenanceEnv.ts` now refuses to treat that empty value as
 * a real SHA, which makes the absence explicit rather than silent — but the
 * value still has to come from somewhere. It comes from here.
 *
 * Supplying it in the deploy command (rather than relying on an operator to
 * remember `-e`) is what makes `/api/health/version` report the real commit by
 * default. Extra CLI args are passed through.
 *
 * ROUND 12 (build provenance). `-e` is deployment-scoped RUNTIME env and
 * `vercel redeploy` does not replay it, so a redeploy lost the commit. This
 * script now ALSO writes an uploaded stamp (`generated/build-provenance/
 * stamp.json`, gitignored, never committed): the commit, its tree, and a
 * sha256 of every file the upload carries. A redeploy reuses the uploaded
 * files, the build (`scripts/safe-build.js`) re-hashes them, and the runtime
 * reports the commit as `verified` only if they still match. `-e` stays as a
 * runtime CROSS-CHECK: a stamp that disagrees with it is reported unverified.
 *
 * The stamp is deleted when the vercel command returns (success OR failure),
 * so a later bare `vercel` upload from this tree cannot carry a stale stamp.
 *
 * The pure steps are exported for unit tests; `main()` runs only when this file
 * is executed directly.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('../backend/security/startup/buildProvenanceStamp');

const SCOPE = 'rawats-projects-5fb9f1f3';

function defaultGit(cmd) {
  return execSync(`git ${cmd}`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
}

/** Returns an error message, or null when the value is a full commit SHA. */
function checkSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) {
    return `REFUSING TO DEPLOY: 'git rev-parse HEAD' did not yield a 40-char SHA (got: ${sha || '<empty>'}).\n`;
  }
  return null;
}

/** Returns an error message, or null when `git status --porcelain` is empty. */
function checkClean(porcelain) {
  if (porcelain) {
    return (
      'REFUSING TO DEPLOY: working tree is not clean.\n' +
      'The injected VERCEL_GIT_COMMIT_SHA would claim a commit that does not\n' +
      'describe what is being uploaded.\n\n' + porcelain + '\n'
    );
  }
  return null;
}

function buildVercelArgs(sha, extra) {
  return [
    '--prod',
    '--skip-domain',
    '--scope', SCOPE,
    '-e', `VERCEL_GIT_COMMIT_SHA=${sha}`,
    ...extra,
  ];
}

/** `git ls-files` arguments listing the tracked files the upload will NOT carry. */
function ignoredListArgs() {
  return ['ls-files', '-z', '--cached', '--ignored', '--exclude-from=.vercelignore',
    ...core.VERCEL_DEFAULT_IGNORES.map((p) => `--exclude=${p}`)];
}

function quoteArgs(args) {
  return args.map((a) => (/[\s*?"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

/**
 * Run the deploy. Every side effect goes through `deps` so tests can drive the
 * refusal / stamp / cleanup paths with a fake `vercel` (the real one is never
 * invoked by a test). Returns the process exit code.
 */
function main(deps = {}) {
  const root = deps.root || process.cwd();
  const git = deps.git || defaultGit;
  const runVercel = deps.runVercel || ((args) => execFileSync('vercel', args, { stdio: 'inherit', shell: true }));
  const fsImpl = deps.fs || fs;
  const out = deps.stdout || ((s) => process.stdout.write(s));
  const err = deps.stderr || ((s) => process.stderr.write(s));
  const now = deps.now || (() => new Date().toISOString());
  const extra = deps.argv || process.argv.slice(2);

  const sha = git('rev-parse HEAD');
  const shaErr = checkSha(sha);
  if (shaErr) { err(shaErr); return 1; }

  const dirtyErr = checkClean(git('status --porcelain'));
  if (dirtyErr) { err(dirtyErr); return 1; }

  const stampAbs = path.join(root, core.STAMP_REL);
  const resultAbs = path.join(root, core.RESULT_REL);
  const cleanup = () => {
    let ok = true;
    for (const p of [stampAbs, resultAbs]) {
      try { core.removeIfPresent(p, fsImpl); } catch (e) {
        ok = false;
        err(`WARNING: could not delete ${path.relative(root, p)} (${e && e.message ? e.message : e}). ` +
          'Delete it by hand before any other upload from this tree.\n');
      }
    }
    return ok;
  };

  // A result left by a local build must never ride the upload; the stamp is
  // rewritten below. Failing to remove either is a refusal, not a warning.
  if (!cleanup()) { err('REFUSING TO DEPLOY: a stale provenance file could not be removed.\n'); return 1; }

  let stamp;
  try {
    const treeSha = git('rev-parse "HEAD^{tree}"');
    const files = core.uploadableFiles(
      git('ls-files -z'),
      git(quoteArgs(ignoredListArgs())),
    );
    stamp = core.buildStamp({
      commitSha: sha,
      treeSha,
      clean: true,
      files: core.hashFiles(root, files, fsImpl),
      stampedAt: now(),
    });
    fsImpl.mkdirSync(path.join(root, core.PROVENANCE_DIR), { recursive: true });
    fsImpl.writeFileSync(stampAbs, JSON.stringify(stamp) + '\n');
  } catch (e) {
    cleanup();
    err(`REFUSING TO DEPLOY: could not write the provenance stamp (${e && e.message ? e.message : e}).\n`);
    return 1;
  }

  // The stamp must be ignored by git (or it would itself dirty the tree and be
  // committed), and nothing may have changed while it was being hashed.
  const afterStamp = git('status --porcelain');
  if (afterStamp) {
    cleanup();
    err('REFUSING TO DEPLOY: the tree changed (or the stamp is not gitignored) while stamping.\n\n' + afterStamp + '\n');
    return 1;
  }
  if (git('rev-parse HEAD') !== sha) {
    cleanup();
    err('REFUSING TO DEPLOY: HEAD moved while stamping.\n');
    return 1;
  }

  out(`Deploying ${sha} (provenance stamp: ${stamp.file_count} files, digest ${stamp.source_digest.slice(0, 16)}…; -e cross-check)\n`);
  let code = 0;
  try {
    runVercel(buildVercelArgs(sha, extra));
  } catch (e) {
    code = typeof e?.status === 'number' && e.status !== 0 ? e.status : 1;
  } finally {
    if (!cleanup()) code = code || 1;
  }
  return code;
}

module.exports = { checkSha, checkClean, buildVercelArgs, ignoredListArgs, quoteArgs, main, SCOPE };

if (require.main === module) {
  process.exit(main());
}
