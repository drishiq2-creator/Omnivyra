/**
 * TEST HELPER: an in-memory model of public.extension_claim_codes for extensionClaimCodeService, with the exact
 * PostgREST filter chain the service uses (insert; update().eq().is().gt()[.or(product)].select(); delete().lt()).
 * The conditional UPDATE is applied row by row like PostgreSQL's single statement: a row matches all filters or is
 * left untouched, and only the updated rows come back.
 */
type Row = { code_hash: string; organization_id: string; user_id: string; product: string | null; created_at: string; expires_at: string; redeemed_at: string | null };

export function claimCodeTableFake(opts: { failInsert?: boolean; failUpdate?: boolean; throwUpdate?: boolean } = {}) {
  const rows: Row[] = [];
  const calls: string[] = [];
  const table = (name: string) => {
    if (name !== 'extension_claim_codes') throw new Error(`unexpected table ${name}`);
    return {
      async insert(r: Row) {
        calls.push('insert');
        if (opts.failInsert) return { data: null, error: { message: 'down' } };
        if (rows.some((x) => x.code_hash === r.code_hash)) return { data: null, error: { code: '23505' } };
        rows.push({ ...r, redeemed_at: null });
        return { data: null, error: null };
      },
      update(patch: Partial<Row>) {
        const f: Array<(r: Row) => boolean> = [];
        const q = {
          eq(c: keyof Row, v: unknown) { f.push((r) => r[c] === v); return q; },
          is(c: keyof Row, v: null) { f.push((r) => r[c] === v); return q; },
          gt(c: keyof Row, v: string) { f.push((r) => String(r[c]) > v); return q; },
          or(expr: string) {
            const m = /^product\.is\.null,product\.eq\.([a-z_]+)$/.exec(expr);
            if (!m) throw new Error(`unexpected or(): ${expr}`);
            f.push((r) => r.product === null || r.product === m[1]);
            return q;
          },
          async select() {
            calls.push('update');
            if (opts.throwUpdate) throw new Error('network');
            if (opts.failUpdate) return { data: null, error: { message: 'down' } };
            const hit = rows.filter((r) => f.every((p) => p(r)));
            for (const r of hit) Object.assign(r, patch);
            return { data: hit.map((r) => ({ user_id: r.user_id, organization_id: r.organization_id, product: r.product })), error: null };
          },
        };
        return q;
      },
      delete() {
        return { async lt() { calls.push('delete'); return { data: null, error: null }; } };
      },
    };
  };
  return { table, rows, calls };
}
