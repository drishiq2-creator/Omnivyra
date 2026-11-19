/**
 * NON-ENUMERATIVE guard for the Market Pulse console gate (owner ruling 2026-11-13: "the scan console is company-admin
 * only"; 89/7c 2026-11-19). It walks EVERY route file under pages/api/market-pulse/** and requires each one to either
 * call the console gate (backend/services/marketPulse/consoleAccess) or appear in MARKET_PULSE_CONSOLE_EXEMPT with a
 * reason. A new Market Pulse route that does neither fails CI here instead of shipping member-reachable.
 *
 * Rule for an exemption: only a read a member needs (the Executive room) or per-USER state. A write that changes
 * COMPANY-WIDE state (what scans run or watch, company config, shared findings) is gated.
 *
 * Behaviour (403 for a member, pass for an admin) is asserted per route in marketPulseConsoleAdminGate.test.ts; this
 * suite asserts the SURFACE is covered.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../pages/api/market-pulse');

/** Route files (relative to pages/api/market-pulse, '/' separators) that are member-level ON EVERY METHOD, and why. */
const MARKET_PULSE_CONSOLE_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  'context.ts': 'GET-only read of the company Market Pulse context - the Executive room every member reads',
  'people.ts': 'GET-only read of assignable people shown in the Executive room every member reads',
});

const GATE_CALL = /\b(requireMarketPulseConsoleAccess|refuseUnlessMarketPulseConsoleRole)\s*\(/;
const GATE_IMPORT = /from\s+['"][^'"]*marketPulse\/consoleAccess['"]/;

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function callsConsoleGate(source: string): boolean {
  return GATE_IMPORT.test(source) && GATE_CALL.test(source);
}

/** Pure decision, so the mutant control below can feed it a synthetic route. */
function classifySurface(
  files: Record<string, string>,
  exempt: Readonly<Record<string, string>>,
): { ungated: string[]; staleExemptions: string[]; gatedButExempt: string[]; reasonless: string[] } {
  const names = Object.keys(files);
  return {
    ungated: names.filter((f) => !callsConsoleGate(files[f]) && !(f in exempt)),
    staleExemptions: Object.keys(exempt).filter((f) => !(f in files)),
    gatedButExempt: names.filter((f) => callsConsoleGate(files[f]) && f in exempt),
    reasonless: Object.entries(exempt).filter(([, why]) => typeof why !== 'string' || why.trim().length < 10).map(([f]) => f),
  };
}

const routeFiles = walk(ROOT);
const sources: Record<string, string> = Object.fromEntries(routeFiles.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

describe('Market Pulse console surface: every route is gated or exempt-with-reason', () => {
  it('non-vacuity: the walk finds the whole Market Pulse API surface (>= 17 route files)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(17);
    // positive anchors: a known-gated and a known-exempt file are among them
    expect(routeFiles).toEqual(expect.arrayContaining(['run.ts', 'findings/[id]/shown.ts', 'context.ts']));
  });

  it('no route is ungated and unlisted', () => {
    expect(classifySurface(sources, MARKET_PULSE_CONSOLE_EXEMPT).ungated).toEqual([]);
  });

  it('every exemption names a file that exists, does not also call the gate, and carries a reason', () => {
    const r = classifySurface(sources, MARKET_PULSE_CONSOLE_EXEMPT);
    expect(r.staleExemptions).toEqual([]);
    expect(r.gatedButExempt).toEqual([]);
    expect(r.reasonless).toEqual([]);
  });

  it('every exempt route says why at the route itself', () => {
    for (const f of Object.keys(MARKET_PULSE_CONSOLE_EXEMPT)) expect(sources[f]).toMatch(/Console-gate EXEMPT/);
  });

  it('every non-exempt route is gated (count check: gated + exempt = all)', () => {
    const gated = routeFiles.filter((f) => callsConsoleGate(sources[f]));
    expect(gated.length + Object.keys(MARKET_PULSE_CONSOLE_EXEMPT).length).toBe(routeFiles.length);
  });

  describe('mutant controls (the guard must fail on an ungated route)', () => {
    it('a NEW route that never calls the gate and is not listed is reported', () => {
      const mutant = {
        ...sources,
        'brand-new.ts': "import { resolveCompanyAccess } from '../../../backend/services/contentArchitectService';\nexport default async function h() {}\n",
      };
      expect(classifySurface(mutant, MARKET_PULSE_CONSOLE_EXEMPT).ungated).toEqual(['brand-new.ts']);
    });
    it('a route that imports the gate but never CALLS it is reported', () => {
      const mutant = { ...sources, 'import-only.ts': "import { refuseUnlessMarketPulseConsoleRole } from '../../../backend/services/marketPulse/consoleAccess';\n" };
      expect(classifySurface(mutant, MARKET_PULSE_CONSOLE_EXEMPT).ungated).toEqual(['import-only.ts']);
    });
    it('dropping the gate call from a real gated route (shown) is reported', () => {
      const mutant = { ...sources, 'findings/[id]/shown.ts': sources['findings/[id]/shown.ts'].replace(/refuseUnlessMarketPulseConsoleRole\(/g, 'noop(') };
      expect(classifySurface(mutant, MARKET_PULSE_CONSOLE_EXEMPT).ungated).toEqual(['findings/[id]/shown.ts']);
    });
  });
});
