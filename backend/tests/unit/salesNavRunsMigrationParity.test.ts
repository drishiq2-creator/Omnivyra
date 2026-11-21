/**
 * PARITY: migration 20270217000073's (status, code) CHECK must be EXACTLY the contract's closed sets
 * (SALESNAV_STATUS_CODES + SALESNAV_PAUSE_CODES, plus the two open statuses with no code). A status or code added on
 * one side only fails here, before a route can write a pair the database refuses (or the database admits one the
 * contract forbids). Also pins the transport and url_kind lists.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SALESNAV_STATUS_CODES, SALESNAV_PAUSE_CODES, SALESNAV_RUN_STATUSES, SALESNAV_TRANSPORTS, SALESNAV_URL_KINDS,
} from '../../services/salesNav/contract';

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/20270217000073_salesnav_extraction_runs.sql'), 'utf8');

/** Parse the status_code CHECK into { status: codes[] } (open statuses map to []). Pure. */
export function parseStatusCodeCheck(sql: string): Record<string, string[]> {
  const start = sql.indexOf('CONSTRAINT salesnav_extraction_runs_status_code CHECK (');
  if (start < 0) throw new Error('status_code CHECK not found');
  const end = sql.indexOf('\n  ),', start);
  const body = sql.slice(start, end);
  const out: Record<string, string[]> = {};
  const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const clause of body.split(/\n\s*(?:OR\s+)?\(/).slice(1)) {
    const open = /^status IN \(([^)]*)\) AND status_code IS NULL\)/.exec(clause.trim());
    if (open) { for (const st of quoted(open[1])) out[st] = []; continue; }
    const m = /^status\s*=\s*'([a-z_]+)'\s+AND status_code (?:=|IN)\s*([\s\S]*)$/.exec(clause.trim());
    if (!m) throw new Error(`unparsed clause: ${clause.trim().slice(0, 60)}`);
    out[m[1]] = quoted(m[2]).sort();
  }
  return out;
}

const contractPairs = (): Record<string, string[]> => {
  const out: Record<string, string[]> = { queued: [], running: [] };
  for (const [st, codes] of Object.entries({ ...SALESNAV_STATUS_CODES, ...SALESNAV_PAUSE_CODES })) {
    out[st] = [...(codes as readonly string[])].sort();
  }
  return out;
};

describe('073 (status, code) CHECK == contract.ts closed sets', () => {
  it('every status, and every code per status, is identical', () => {
    expect(parseStatusCodeCheck(SQL)).toEqual(contractPairs());
  });

  it('the CHECK covers exactly SALESNAV_RUN_STATUSES', () => {
    expect(Object.keys(parseStatusCodeCheck(SQL)).sort()).toEqual([...SALESNAV_RUN_STATUSES].sort());
  });

  it('CONTROL: a code added only to the SQL is caught', () => {
    const drifted = SQL.replace("status_code = 'user_cancelled'", "status_code IN ('user_cancelled', 'admin_cancelled')");
    expect(drifted).not.toBe(SQL);
    expect(parseStatusCodeCheck(drifted)).not.toEqual(contractPairs());
  });

  it('CONTROL: a status dropped from the SQL is caught', () => {
    const drifted = SQL.replace(/\n\s*OR \(status = 'cancelled'[^\n]*/, '');
    expect(drifted).not.toBe(SQL);
    expect(parseStatusCodeCheck(drifted)).not.toEqual(contractPairs());
  });
});

describe('073 transport and url_kind lists == contract.ts', () => {
  const listIn = (name: string): string[] => {
    const m = new RegExp(`CONSTRAINT ${name} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(SQL);
    if (!m) throw new Error(`${name} not found`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };
  it('transports (all three tables)', () => {
    for (const c of ['salesnav_member_bindings_transport', 'salesnav_extraction_runs_transport']) {
      expect(listIn(c)).toEqual([...SALESNAV_TRANSPORTS].sort());
    }
  });
  it('url kinds', () => {
    expect(listIn('salesnav_extraction_runs_url_kind')).toEqual([...SALESNAV_URL_KINDS].sort());
  });
});
