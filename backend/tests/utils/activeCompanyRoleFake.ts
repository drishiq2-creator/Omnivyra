/**
 * Test double for `user_company_roles` reads through the owned DB seam (ownedDbTable).
 *
 * The campaign WRITE-role guard (backend/services/campaignWriteRole.ts, 2026-11-13) reads the caller's ACTIVE
 * membership role on every POST/PUT/PATCH/DELETE. Suites that test other campaign rules serve a real membership row
 * here so the guard RUNS and ALLOWS on its own logic - it is never mocked out, and isPlatformSuperAdmin is never
 * forced true. Rows are filtered by the query's eq()/in() filters, so a row only answers for its own user + company
 * + status (a different user or company, or a non-active row, reads as "no role" and the guard denies).
 *
 * Usage (inside a jest.mock factory, which may not close over module scope):
 *   jest.mock('../../db/writeOwner', () =>
 *     require('../utils/activeCompanyRoleFake').writeOwnerServingRoles([
 *       { user_id: 'user-1', company_id: 'company-123', role: 'COMPANY_ADMIN', status: 'active' },
 *     ]));
 * Every other table falls through to the real ownedDbTable (and so to the suite's mocked supabase.from).
 */
export type FakeCompanyRoleRow = { user_id: string; company_id: string; role: string; status: string };

export function fakeUserCompanyRolesQuery(rows: FakeCompanyRoleRow[]) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let limitN: number | null = null;
  const result = () => {
    let out = rows.filter((r) => filters.every((f) => f(r as unknown as Record<string, unknown>)));
    if (limitN !== null) out = out.slice(0, limitN);
    return out.map((r) => ({ ...r }));
  };
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return q;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => Array.isArray(vals) && vals.includes(r[col]));
      return q;
    },
    order: () => q,
    limit: (n: number) => {
      limitN = n;
      return q;
    },
    maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
    single: async () => {
      const r = result();
      return r.length === 1
        ? { data: r[0], error: null }
        : { data: null, error: { message: `fake single(): ${r.length} rows` } };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: result(), error: null }).then(resolve, reject),
  };
  return q;
}

export function writeOwnerServingRoles(rows: FakeCompanyRoleRow[]) {
  const actual = jest.requireActual('../../db/writeOwner');
  return {
    ...actual,
    ownedDbTable: (table: string) =>
      table === 'user_company_roles' ? fakeUserCompanyRolesQuery(rows) : actual.ownedDbTable(table),
  };
}
