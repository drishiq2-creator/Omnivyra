/**
 * A ledger-faithful fake of api_idempotency_keys for the blog replay store: insert honours the
 * (scope, caller_id, idempotency_key) unique index (23505), select filters on every .eq(), and failures can be armed.
 */
export type FakeStore = {
  rows: Array<Record<string, unknown>>;
  failInsert: boolean;
  failRead: boolean;
  ownedDbTable: (table: string) => any;
};

export function makeFakeIdempotencyStore(): FakeStore {
  const store: FakeStore = {
    rows: [],
    failInsert: false,
    failRead: false,
    ownedDbTable: (table: string) => {
      if (table !== 'api_idempotency_keys') throw new Error(`fake store: unexpected table ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          if (store.failInsert) return { error: { message: 'connection reset' } };
          const dup = store.rows.some((r) => r.scope === row.scope && r.caller_id === row.caller_id && r.idempotency_key === row.idempotency_key);
          if (dup) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          store.rows.push({ ...row });
          return { error: null };
        },
        select: () => {
          const filters: Array<[string, unknown]> = [];
          const chain: any = {
            eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
            maybeSingle: async () => {
              if (store.failRead) return { data: null, error: { message: 'timeout' } };
              const hit = store.rows.find((r) => filters.every(([c, v]) => r[c] === v));
              return { data: hit ?? null, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
  return store;
}
