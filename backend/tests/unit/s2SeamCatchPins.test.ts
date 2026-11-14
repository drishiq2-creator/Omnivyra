/**
 * S2 (2026-11-14): routes whose OWN generic catch answers 500 must hand a tenant-seam error to seamDenial first, so a
 * RETRYABLE one (a row that could not be READ - resolveTenantOfRow / owner lookups) is 503 + Retry-After and no seam
 * message is echoed in a 500. These two routes have no harness that can inject a seam failure, so the contract is
 * pinned structurally: inside the final catch, the seamDenial branch comes BEFORE the 500.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../../..');
const CASES: Array<[string, string]> = [
  ['pages/api/campaigns/commit-daily-plan.ts', 'error'],
  ['pages/api/campaigns/planner-finalize.ts', 'err'],
];

describe('S2: generic 500 catches route tenant-seam errors through seamDenial first', () => {
  it.each(CASES)('%s', (file, v) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).toMatch(/import \{ TenantSeamError \} from '\.\.\/\.\.\/\.\.\/backend\/db\/tenantTable';/);
    expect(src).toMatch(/import \{ seamDenial \} from '\.\.\/\.\.\/\.\.\/backend\/db\/seamDenial';/);
    // The LAST catch in the handler (the generic one).
    const at = src.lastIndexOf(`} catch (${v}) {`);
    expect(at).toBeGreaterThan(-1);
    const tail = src.slice(at);
    const branch = tail.indexOf(`if (${v} instanceof TenantSeamError) return seamDenial(res, ${v}, 500,`);
    const five = tail.indexOf('status(500)');
    expect(branch).toBeGreaterThan(-1); // positive control: the branch exists in THIS catch
    expect(five).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(five);
  });
});
