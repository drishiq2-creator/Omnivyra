/**
 * In-memory double of rpa_retry_queue's claim functions
 * (20270314000001_rpa_retry_queue_claim.sql), for unit tests that drive the
 * real rpaRetryQueue / rpaWorkerService over a table double.
 *
 * It mirrors the SQL contract, not its concurrency mechanics: JavaScript runs
 * each call to completion, so a claim is atomic here the way FOR UPDATE SKIP
 * LOCKED makes it atomic in PostgreSQL. The real-schema test
 * (backend/tests/realschema/phaseCRpaClaimQueue.realschema.test.ts) proves the
 * SQL itself, including two concurrent sessions.
 */
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

export type RpaQueueRpcCall = { fn: string; args: Record<string, any> };

const iso = (ms: number) => new Date(ms).toISOString();

export function createRpaClaimRpc(rows: () => Row[]) {
  const calls: RpaQueueRpcCall[] = [];
  const nowMs = () => Date.now();

  const rpc = async (fn: string, args: Record<string, any> = {}): Promise<{ data: any; error: any }> => {
    calls.push({ fn, args });
    const table = rows();
    if (fn === 'rpa_retry_queue_accept') {
      // Mirrors production's unique index on (action_id) alone.
      const dup = table.find((r) => r.action_id === args.p_action_id);
      if (dup && dup.organization_id !== args.p_organization_id) {
        return { data: null, error: { code: '42501', message: 'RPA_ACCEPT_ORG_MISMATCH: action_id is queued under another organization' } };
      }
      if (dup) return { data: [{ accepted: false, queue_id: dup.id, claim_token: null }], error: null };
      const claimed = args.p_claimed_by != null;
      const row: Row = {
        id: randomUUID(),
        action_id: args.p_action_id,
        organization_id: args.p_organization_id,
        platform: args.p_platform,
        action_type: args.p_action_type,
        target_url: args.p_target_url,
        text: args.p_text ?? null,
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        last_attempt_at: null,
        next_retry_at: iso(nowMs()),
        claim_token: claimed ? randomUUID() : null,
        claimed_by: claimed ? args.p_claimed_by : null,
        claimed_at: claimed ? iso(nowMs()) : null,
        claim_expires_at: claimed ? iso(nowMs() + Number(args.p_lease_seconds) * 1000) : null,
        completed_at: null,
      };
      table.push(row);
      return { data: [{ accepted: true, queue_id: row.id, claim_token: row.claim_token }], error: null };
    }
    if (fn === 'claim_rpa_retry_queue') {
      const now = nowMs();
      const picked = table
        .filter((r) => (r.claim_token ?? null) === null && (r.completed_at ?? null) === null
          && Number(r.attempts ?? 0) < Number(r.max_attempts ?? 5)
          && Date.parse(r.next_retry_at) <= now
          && (args.p_organization_id == null || r.organization_id === args.p_organization_id))
        .sort((a, b) => Date.parse(a.next_retry_at) - Date.parse(b.next_retry_at) || String(a.id).localeCompare(String(b.id)))
        .slice(0, Number(args.p_limit));
      for (const r of picked) {
        r.claim_token = randomUUID();
        r.claimed_by = args.p_claimed_by;
        r.claimed_at = iso(now);
        r.claim_expires_at = iso(now + Number(args.p_lease_seconds) * 1000);
      }
      return { data: picked.map((r) => ({ ...r })), error: null };
    }
    if (fn === 'finalize_rpa_retry_queue_claim') {
      const r = table.find((x) => x.id === args.p_queue_id && x.claim_token != null && x.claim_token === args.p_claim_token);
      if (!r) return { data: false, error: null };
      const outcome = args.p_outcome;
      const err = String(args.p_error ?? '').slice(0, 480);
      const max = Number(r.max_attempts ?? 5);
      if (outcome === 'succeeded') {
        r.attempts = Math.max(Number(r.attempts), max);
        r.completed_at = iso(nowMs());
        r.last_error = null;
      } else if (outcome === 'unknown') {
        r.attempts = Math.max(Number(r.attempts), max);
        r.last_error = err.startsWith('RPA_OUTCOME_UNKNOWN') ? err : `RPA_OUTCOME_UNKNOWN:${err || 'UNKNOWN'}`;
      } else if (outcome === 'failed') {
        const next = Number(r.attempts) + 1;
        if (args.p_terminal) {
          r.attempts = Math.max(next, max);
        } else {
          r.attempts = next;
          if (next < max) {
            const delay = args.p_retry_delay_seconds ?? Math.min(120, 2 ** next) * 60;
            r.next_retry_at = iso(nowMs() + delay * 1000);
          }
        }
        r.last_error = err || 'unknown';
      } else {
        return { data: null, error: { message: 'bad outcome' } };
      }
      r.last_attempt_at = iso(nowMs());
      r.claim_token = null;
      r.claim_expires_at = null;
      return { data: true, error: null };
    }
    if (fn === 'renew_rpa_retry_queue_claim') {
      const r = table.find((x) => x.id === args.p_queue_id && x.claim_token != null && x.claim_token === args.p_claim_token
        && Date.parse(x.claim_expires_at) > nowMs());
      if (!r) return { data: false, error: null };
      r.claim_expires_at = iso(nowMs() + Number(args.p_lease_seconds) * 1000);
      return { data: true, error: null };
    }
    if (fn === 'release_rpa_retry_queue_claim') {
      const r = table.find((x) => x.id === args.p_queue_id && x.claim_token != null && x.claim_token === args.p_claim_token);
      if (!r) return { data: false, error: null };
      r.claim_token = null;
      r.claim_expires_at = null;
      r.next_retry_at = iso(nowMs() + Number(args.p_retry_delay_seconds ?? 60) * 1000);
      r.last_error = `RPA_CLAIM_RELEASED_NOT_ATTEMPTED:${args.p_reason || 'LEASE_LOST'}`.slice(0, 500);
      return { data: true, error: null };
    }
    if (fn === 'park_expired_rpa_retry_claims') {
      let n = 0;
      for (const r of table) {
        if (r.claim_token != null && Date.parse(r.claim_expires_at) <= nowMs()) {
          r.attempts = Math.max(Number(r.attempts), Number(r.max_attempts ?? 5));
          r.last_error = `RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED claimed_by=${r.claimed_by} claimed_at=${r.claimed_at}`;
          r.claim_token = null;
          r.claim_expires_at = null;
          n += 1;
        }
      }
      return { data: n, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  };
  return { rpc, calls };
}

/** Evaluate a PostgREST `.or()` filter string of `col.op.value` terms (is.null, lte, eq). */
export function orFilter(expr: string): (r: Row) => boolean {
  const terms = expr.split(/,(?=[a-z_]+\.(?:is|lte|lt|gte|gt|eq)\.)/).map((t) => {
    const m = /^([a-z_]+)\.(is|lte|lt|gte|gt|eq)\.(.*)$/.exec(t);
    if (!m) throw new Error(`unsupported or() term: ${t}`);
    return { col: m[1], op: m[2], val: m[3] };
  });
  return (r: Row) => terms.some(({ col, op, val }) => {
    const v = r[col] ?? null;
    if (op === 'is') return val === 'null' ? v === null : String(v) === val;
    if (v === null) return false;
    if (op === 'eq') return String(v) === val;
    if (op === 'lte') return String(v) <= val;
    if (op === 'lt') return String(v) < val;
    if (op === 'gte') return String(v) >= val;
    return String(v) > val;
  });
}
