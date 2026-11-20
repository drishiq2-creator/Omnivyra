/**
 * The repo-wide Meta Graph API version scan, shared by metaGraphApiVersionConsistency.test.ts (every caller
 * sends the SAME version) and metaGraphApiVersionFreshness.test.ts (that version is still inside Meta's
 * support window). Moved verbatim from the consistency test (PL-60, a9 2026-11-20); see that file for why the
 * scan reads both host+version literals and declared *GRAPH*VERSION constants.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Source trees that make real Graph calls. */
const SCAN_DIRS = ['backend', 'pages', 'lib', 'components', 'hooks'];

/**
 * Excluded on purpose:
 *  - backend/tests — fixtures and scanners quote URLs as literal test DATA.
 *  - node_modules / .next — not ours.
 * Markdown is not scanned at all: historical audit reports quote the versions
 * that were live when they were written, and rewriting history is not a fix.
 */
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.next', '.git', 'tests', '__tests__']);

const HOST_VERSION = /\b(?:graph|www)\.facebook\.com\/v(\d+)\.(\d+)/g;
/**
 * A caller that declares its version ONCE and builds the URL from it (instagramAdapter:
 * `const GRAPH_VERSION = 'v22.0'` + `https://graph.facebook.com/${GRAPH_VERSION}`) has no literal
 * host+version for HOST_VERSION to find - the declaration IS its version, so it is read as one
 * occurrence. Without this the guard went red on main once the adapter was refactored (e2d7e09f8):
 * not a drift, a blind spot - a real drift in such a constant would have gone unseen.
 */
const DECLARED_VERSION = /\b[A-Z_]*GRAPH[A-Z_]*VERSION\s*(?::\s*string\s*)?=\s*['"`]v(\d+)\.(\d+)['"`]/g;

function walk(dir: string, out: string[] = []): string[] {
  let entries: import('fs').Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export interface Occurrence {
  file: string;
  version: string;
}

export function collectOccurrences(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(REPO_ROOT, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const pattern of [HOST_VERSION, DECLARED_VERSION]) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(src)) !== null) {
          found.push({
            file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
            version: `v${m[1]}.${m[2]}`,
          });
        }
      }
    }
  }
  return found;
}
