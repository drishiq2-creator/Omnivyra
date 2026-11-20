import { createHash, createHmac } from 'crypto';
import { supabase } from '../db/supabaseClient';
import { getRequestContext } from './requestContext';
import { ownedDbTable } from '../db/writeOwner';
import { enqueueEmailJob } from './emailJobsService';
import { logger } from './logger';
import { config } from '@/config';
import { getCanonicalAppUrl } from '../config/getCanonicalAppUrl';
import { SigningSecretUnavailableError } from '../auth/signingSecrets';

const INVITE_EXPIRY_DAYS = 7;

function getAppUrl(): string {
  return getCanonicalAppUrl();
}

/**
 * The HMAC secret for invitation tokens — shared by createInvitation and the super-admin
 * resend route (which rebuilds the same token), so there is exactly one resolver.
 *
 * SEC91-B1: INVITATION_TOKEN_SECRET only (trimmed, as before). The chain used to fall back
 * to the Supabase service-role API key and then to a literal committed to this repository.
 * Production sets INVITATION_TOKEN_SECRET, so every issued token keeps resolving; an
 * unconfigured deployment now fails closed instead of signing with a known value.
 */
export function getInvitationSigningSecret(): string {
  const secret = config.INVITATION_TOKEN_SECRET?.trim();
  if (!secret) throw new SigningSecretUnavailableError('invitation tokens', ['INVITATION_TOKEN_SECRET']);
  return secret;
}

function getInvitationSecret(): string {
  return getInvitationSigningSecret();
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildInvitationToken(email: string, companyId: string, idempotencyKey?: string): string {
  const basis = [email.toLowerCase(), companyId, idempotencyKey ?? createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex')].join(':');
  return createHmac('sha256', getInvitationSecret()).update(basis).digest('hex');
}

async function normalizeInvitationState(email: string, companyId: string): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await ownedDbTable('invitations')
    .update({ revoked_at: now })
    .eq('company_id', companyId)
    .eq('email', email.toLowerCase())
    .is('accepted_at', null)
    .is('revoked_at', null)
    .lt('expires_at', now);

  if (error) {
    throw new Error(`INVITATION_NORMALIZE_FAILED:${error.message}`);
  }
}

type ReplayRow = {
  id: string;
  expires_at: string;
  revoked_at?: string | null;
  accepted_at?: string | null;
  token_consumed_at?: string | null;
};

/**
 * A replay may only ever re-send a LIVE invitation (b3/04 2026-11-20, correct-sending). An idempotency key whose
 * invitation was since revoked (a newer invitation superseded it), accepted, consumed or has expired must NOT be
 * re-sent: its link is dead. The caller gets a definitive refusal it can show; nothing is enqueued.
 */
export const INVITATION_NOT_REPLAYABLE = 'INVITATION_NOT_REPLAYABLE';
export class InvitationNotReplayableError extends Error {
  readonly code = INVITATION_NOT_REPLAYABLE;
  readonly statusCode = 409;
  readonly retryable = false;
  constructor(readonly reason: 'revoked' | 'accepted' | 'expired') {
    super('This invitation is no longer active. Send a new invitation.');
    this.name = 'InvitationNotReplayableError';
  }
}

function assertReplayable(row: ReplayRow, nowMs: number = Date.now()): void {
  if (row.revoked_at) throw new InvitationNotReplayableError('revoked');
  if (row.accepted_at || row.token_consumed_at) throw new InvitationNotReplayableError('accepted');
  const exp = Date.parse(row.expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) throw new InvitationNotReplayableError('expired');
}

async function findExistingByIdempotencyKey(idempotencyKey: string): Promise<ReplayRow | null> {
  const { data, error } = await ownedDbTable('invitations')
    .select('id, expires_at, revoked_at, accepted_at, token_consumed_at')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error(`INVITATION_LOOKUP_FAILED:${error.message}`);
  }

  return (data as ReplayRow | null) ?? null;
}

export async function createInvitation(input: {
  email: string;
  companyId: string;
  role: string;
  invitedBy: string | null;
  idempotencyKey?: string;
}): Promise<{ id: string; rawToken: string; inviteLink: string; expiresAt: string; replayed: boolean }> {
  const normalizedEmail = input.email.toLowerCase();
  const ctx = getRequestContext();
  const effectiveIdempotencyKey = input.idempotencyKey ?? ctx.idempotencyKey ?? null;

  if (effectiveIdempotencyKey) {
    const existing = await findExistingByIdempotencyKey(effectiveIdempotencyKey);
    if (existing) {
      assertReplayable(existing);
      const rawToken = buildInvitationToken(normalizedEmail, input.companyId, effectiveIdempotencyKey);
      return {
        id: existing.id,
        rawToken,
        inviteLink: `${getAppUrl()}/auth/accept-invite?token=${rawToken}`,
        expiresAt: existing.expires_at,
        replayed: true,
      };
    }
  }

  await normalizeInvitationState(normalizedEmail, input.companyId);

  const rawToken = buildInvitationToken(normalizedEmail, input.companyId, effectiveIdempotencyKey ?? undefined);
  const tokenHash = hashInvitationToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 86_400_000).toISOString();

  const { data, error } = await ownedDbTable('invitations')
    .insert({
      email: normalizedEmail,
      company_id: input.companyId,
      role: input.role,
      token_hash: tokenHash,
      invited_by: input.invitedBy,
      expires_at: expiresAt,
      accepted_at: null,
      revoked_at: null,
      token_consumed_at: null,
      idempotency_key: effectiveIdempotencyKey,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    if (error?.code === '23505' && effectiveIdempotencyKey) {
      const existing = await findExistingByIdempotencyKey(effectiveIdempotencyKey);
      if (existing) {
        assertReplayable(existing);
        return {
          id: existing.id,
          rawToken,
          inviteLink: `${getAppUrl()}/auth/accept-invite?token=${rawToken}`,
          expiresAt: existing.expires_at,
          replayed: true,
        };
      }
    }
    throw new Error(error?.message || 'INVITATION_CREATE_FAILED');
  }

  const inviteLink = `${getAppUrl()}/auth/accept-invite?token=${rawToken}`;
  return { id: data.id as string, rawToken, inviteLink, expiresAt, replayed: false };
}

/**
 * Phase 2.A.1 — async delivery.
 *
 * Previously called `sendInvite` synchronously and threw on failure (which
 * the caller would translate to a 500 + invitation revoke). The async
 * pipeline replaces that with an email_jobs enqueue: the row is created
 * atomically alongside the invitation, the cron worker drains it with
 * exponential backoff + dead-lettering, and delivery state is observable
 * via /api/super-admin/invitations.
 *
 * Behavior preserved:
 *   - return shape is unchanged (callers see `{ id, inviteLink, expiresAt,
 *     replayed }` — only the "did the email leave the building" semantic
 *     changed from "yes, synchronously" to "yes, queued").
 *
 * Behavior changed:
 *   - we no longer auto-revoke the invitation on send failure, because
 *     there IS no synchronous send. If the enqueue itself fails (rare —
 *     DB error), the invitation is LEFT LIVE and the error is rethrown
 *     (2026-11-20): revoking it made the same-key retry replay a REVOKED
 *     row and email a DEAD link. Do NOT restore the revoke - see the
 *     catch block below and invitationReplayLiveOnly.test.ts.
 *   - a replay only ever re-sends a LIVE invitation; a revoked / accepted /
 *     expired one throws InvitationNotReplayableError (409, not retryable).
 */
export async function createAndSendInvitation(input: {
  email: string;
  companyId: string;
  role: string;
  invitedBy: string | null;
  idempotencyKey?: string;
}): Promise<{ id: string; inviteLink: string; expiresAt: string; replayed: boolean }> {
  const invitation = await createInvitation(input);
  const requestIdempotencyKey = input.idempotencyKey ?? getRequestContext().idempotencyKey ?? null;
  const correlationId = requestIdempotencyKey ?? `invitation:${invitation.id}`;

  // Best-effort lookups for the email body — null is acceptable for both.
  let companyName: string | null = null;
  let recipientName: string | null = null;
  try {
    const { data: companyRow } = await supabase
      .from('companies')
      .select('name')
      .eq('id', input.companyId)
      .maybeSingle();
    companyName = (companyRow as any)?.name ?? null;

    const { data: userRow } = await supabase
      .from('users')
      .select('name')
      .eq('email', input.email.toLowerCase())
      .maybeSingle();
    recipientName = (userRow as any)?.name ?? null;
  } catch (err: any) {
    logger.warn('invitation_metadata_lookup_failed', {
      invitationId: invitation.id,
      message: err?.message ?? String(err),
    });
  }

  try {
    await enqueueEmailJob({
      templateKey: 'team_invite_magic_link',
      recipientEmail: input.email.toLowerCase(),
      invitationId: invitation.id,
      correlationId,
      idempotencyKey: requestIdempotencyKey
        ? `${requestIdempotencyKey}:email:magic_link`
        : undefined,
      payload: {
        recipientEmail: input.email.toLowerCase(),
        recipientName,
        companyName,
        role: input.role,
        inviteUrl: invitation.inviteLink,
        invitationId: invitation.id,
        correlationId,
      },
    });
  } catch (error: any) {
    // Enqueue failure (DB-level). The invitation is LEFT LIVE (b3/04 2026-11-20): revoking it here made the next
    // same-key retry replay a REVOKED row and email a dead link (withIdempotency resumes a 5xx key). Left live, that
    // retry replays it and enqueues the email under the same `<key>:email:magic_link` key (one email: the email_jobs
    // key is UNIQUE). If nobody retries, a live unsent invitation remains until a new invitation for the address
    // supersedes it (normalizeInvitationState) or it expires.
    throw error;
  }

  return {
    id: invitation.id,
    inviteLink: invitation.inviteLink,
    expiresAt: invitation.expiresAt,
    replayed: invitation.replayed,
  };
}
