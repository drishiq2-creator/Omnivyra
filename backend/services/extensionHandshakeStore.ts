/**
 * EXTENSION HANDSHAKE STORE - the cross-instance state behind the extension handshake.
 *
 * Claim codes (bootstrap -> redeem) and request-signature nonces used to live in a per-process Map. On Vercel the
 * bootstrap and the redeem of one code can run on different instances (valid code -> INVALID_OR_EXPIRED_CLAIM_CODE),
 * and a nonce remembered by one instance was unknown to every other (a captured signed request could be replayed
 * once per instance inside the timestamp window).
 *
 * Store choice: Postgres (migration 20270314000010_extension_handshake_store), reached through the service-role
 * Supabase client every extension route already uses. Redis (ioredis, REDIS_URL) is also reachable from some API routes
 * (e.g. pages/api/auth/mfa-verify.ts), but it is not chosen: a replay guard must not lose a key to memory-pressure
 * eviction, the check-and-set here needs the database clock and a real-schema replay proof (CI already has one),
 * and an outage of the one store the extension routes already depend on adds no new failure mode.
 *
 * Every operation is ONE call to a SECURITY INVOKER function that does the check-and-set in ONE statement on the
 * DATABASE clock (single-use redeem; first-use nonce). Only SHA-256 digests are stored.
 *
 * FAIL CLOSED: any error (transport, missing function, unexpected shape) throws
 * ExtensionHandshakeStoreUnavailableError. Callers answer 503; an unreadable store is never read as "valid",
 * "not redeemed" or "nonce unseen".
 */

import { createHash } from 'crypto';
import { supabase } from '../db/supabaseClient';

export class ExtensionHandshakeStoreUnavailableError extends Error {
  readonly operation: string;
  constructor(operation: string, detail: string) {
    super(`extension handshake store unavailable (${operation}): ${detail}`);
    this.name = 'ExtensionHandshakeStoreUnavailableError';
    this.operation = operation;
  }
}

export function isExtensionHandshakeStoreUnavailable(err: unknown): err is ExtensionHandshakeStoreUnavailableError {
  return err instanceof ExtensionHandshakeStoreUnavailableError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ExtensionHandshakeStoreUnavailableError');
}

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

async function rpc(operation: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let out: RpcResult;
  try {
    out = (await supabase.rpc(fn, args)) as RpcResult;
  } catch (err) {
    throw new ExtensionHandshakeStoreUnavailableError(operation, (err as Error)?.message || 'rpc threw');
  }
  if (!out || out.error) {
    throw new ExtensionHandshakeStoreUnavailableError(operation, out?.error?.code || out?.error?.message || 'no response');
  }
  return out.data;
}

const toEpochMs = (value: unknown): number => {
  const ms = typeof value === 'string' || value instanceof Date ? new Date(value as string).getTime() : NaN;
  return ms;
};

/** Store a claim-code digest bound to (user, org). Returns the database-clock issue and expiry instants. */
export async function storeIssueClaimCode(input: {
  codeHash: string; userId: string; orgId: string; ttlSeconds: number;
}): Promise<{ createdAt: number; expiresAt: number }> {
  const data = await rpc('issue', 'extension_claim_code_issue', {
    p_code_hash: input.codeHash,
    p_user_id: input.userId,
    p_organization_id: input.orgId,
    p_ttl_seconds: input.ttlSeconds,
  });
  const row = Array.isArray(data) ? data[0] : data;
  const createdAt = toEpochMs((row as { issued_at?: unknown } | null)?.issued_at);
  const expiresAt = toEpochMs((row as { valid_until?: unknown } | null)?.valid_until);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new ExtensionHandshakeStoreUnavailableError('issue', 'unexpected response shape');
  }
  return { createdAt, expiresAt };
}

/**
 * Look up a claim-code digest WITHOUT redeeming it (review S-4). null = unknown, expired or already redeemed.
 * Read only: the redeem route uses it to refuse a principal before the single-use code is consumed.
 */
export async function storePeekClaimCode(codeHash: string): Promise<{ userId: string; orgId: string } | null> {
  const data = await rpc('peek', 'extension_claim_code_peek', { p_code_hash: codeHash });
  if (!Array.isArray(data)) throw new ExtensionHandshakeStoreUnavailableError('peek', 'unexpected response shape');
  if (data.length === 0) return null;
  if (data.length > 1) throw new ExtensionHandshakeStoreUnavailableError('peek', 'more than one row');
  const row = data[0] as { peek_user_id?: unknown; peek_organization_id?: unknown };
  if (typeof row?.peek_user_id !== 'string' || typeof row?.peek_organization_id !== 'string') {
    throw new ExtensionHandshakeStoreUnavailableError('peek', 'unexpected row shape');
  }
  return { userId: row.peek_user_id, orgId: row.peek_organization_id };
}

/** Atomically redeem a claim-code digest. null = unknown, expired or already redeemed (a definite answer). */
export async function storeRedeemClaimCode(codeHash: string): Promise<{ userId: string; orgId: string } | null> {
  const data = await rpc('redeem', 'extension_claim_code_redeem', { p_code_hash: codeHash });
  if (!Array.isArray(data)) throw new ExtensionHandshakeStoreUnavailableError('redeem', 'unexpected response shape');
  if (data.length === 0) return null;
  if (data.length > 1) throw new ExtensionHandshakeStoreUnavailableError('redeem', 'more than one row');
  const row = data[0] as { redeemed_user_id?: unknown; redeemed_organization_id?: unknown };
  if (typeof row?.redeemed_user_id !== 'string' || typeof row?.redeemed_organization_id !== 'string') {
    throw new ExtensionHandshakeStoreUnavailableError('redeem', 'unexpected row shape');
  }
  return { userId: row.redeemed_user_id, orgId: row.redeemed_organization_id };
}

/** Record a nonce key. 'recorded' = first use; 'replayed' = seen and unexpired. */
export async function storeRecordRequestNonce(nonceKey: string, ttlSeconds: number): Promise<'recorded' | 'replayed'> {
  const data = await rpc('nonce', 'extension_request_nonce_record', { p_nonce_key: nonceKey, p_ttl_seconds: ttlSeconds });
  if (data === true) return 'recorded';
  if (data === false) return 'replayed';
  throw new ExtensionHandshakeStoreUnavailableError('nonce', 'unexpected response shape');
}
