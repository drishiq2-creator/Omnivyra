export const OPEN = ['queued', 'running', 'paused_daily_cap', 'auth_expired'];
/**
 * In-memory stand-in for the three 073 tables, enforcing the SAME keys as the migration: owner PK member_id (23505),
 * binding PK (company, user, transport) (23505) + composite FK to the owner (23503), one open run per member (23505).
 * Shared by the store tests and the route tests (one fake, so the two suites cannot disagree about the schema).
 */
export type Row = Record<string, any>;
export function fakeDb(opts: { failTable?: string; failOp?: string } = {}) {
  const t: Record<string, Row[]> = { salesnav_member_owner: [], salesnav_member_bindings: [], salesnav_extraction_runs: [], salesnav_daily_quota: [] };
  let seq = 0;
  const violation = (name: string, row: Row): string | null => {
    if (name === 'salesnav_member_owner' && t[name].some((r) => r.member_id === row.member_id)) return '23505';
    if (name === 'salesnav_member_bindings') {
      if (!t.salesnav_member_owner.some((o) => o.member_id === row.member_id && o.organization_id === row.organization_id)) return '23503';
      if (t[name].some((r) => r !== row && r.organization_id === row.organization_id && r.user_id === row.user_id
        && r.transport === row.transport)) return '23505';
    }
    if (name === 'salesnav_extraction_runs' && OPEN.includes(row.status)
      && t[name].some((r) => r.member_id === row.member_id && OPEN.includes(r.status) && r.id !== row.id)) return '23505';
    return null;
  };
  const table = (name: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
    let payload: Row | null = null; let returning = false; let limitN = Infinity;
    const b: any = {
      select: (_c?: string) => { if (op === 'insert') returning = true; return b; },
      insert: (row: Row) => { op = 'insert'; payload = row; return b; },
      upsert: (row: Row) => { op = 'upsert'; payload = row; return b; },
      update: (patch: Row) => { op = 'update'; payload = patch; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b; },
      lt: (c: string, v: string) => { filters.push((r) => String(r[c]) < v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      order: () => b,
      limit: (n: number) => { limitN = n; return b; },
      then: (res: (v: unknown) => void) => res(run()),
    };
    const run = () => {
      if (opts.failTable === name && (!opts.failOp || opts.failOp === op)) return { data: null, error: { message: 'down' }, status: 500 };
      const rows = t[name];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'select') return { data: match.slice(0, limitN).map((r) => ({ ...r })), error: null, status: 200 };
      if (op === 'insert') {
        const row: Row = { id: `run-${++seq}`, status: 'running', next_page_index: 0, pages_read: 0, leads_read: 0,
          accepted: 0, rejected: 0, created_count: 0, updated_count: 0, held_for_review: 0, skipped_duplicates: 0,
          dropped: 0, quota_refused: 0, seen_lead_keys: [], list_total: null, total_unreliable: false,
          last_has_next_page: null, status_code: null, vendor_cursor: null, closed_at: null, ...payload };
        if (name !== 'salesnav_extraction_runs') delete row.id;
        const v = violation(name, row);
        if (v) return { data: null, error: { code: v }, status: 409 };
        rows.push(row);
        return { data: returning ? [{ id: row.id }] : null, error: null, status: 201 };
      }
      if (op === 'upsert') {
        const v = violation(name, payload!);
        if (v) return { data: null, error: { code: v }, status: 409 };
        const i = rows.findIndex((r) => r.organization_id === payload!.organization_id && r.transport === payload!.transport);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null, status: 201 };
      }
      if (op === 'update') {
        for (const r of match) {
          const next = { ...r, ...payload };
          const v = violation(name, next);
          if (v) return { data: null, error: { code: v }, status: 409, count: null };
          Object.assign(r, payload);
        }
        return { data: null, error: null, status: 204, count: match.length };
      }
      t[name] = rows.filter((r) => !match.includes(r));
      return { data: null, error: null, status: 204 };
    };
    return b;
  };
  return { t, table };
}

