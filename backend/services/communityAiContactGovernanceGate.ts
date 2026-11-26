/**
 * Round 24D / G-7 (round 18 S9) — contact-governance gate for the
 * `community_ai_actions` path.
 *
 * WHAT THIS IS NOT. It is not a second suppression model. Every rule lives in
 * `prospectIdentity/contactGovernance.mayContact`, reached through the ONE
 * suppression engine `execution/suppressionService.isSuppressed` (canonical
 * `contact_governance_records` first, then legacy `suppression_entries`,
 * fail-closed). This module only decides WHICH community actions address a
 * person, WHICH identifiers on the row name that person, and how a
 * `SuppressionResult` maps onto the community-action vocabulary.
 *
 * WHICH ACTIONS. Only actions that deliver something TO a person are gated:
 *   dm     — a direct message (API, extension command chain, RPA)
 *   reply  — a message posted into a person's thread/comment
 *   follow — a direct, notified touch on a person's profile (network expansion)
 * `like`, `share` and `schedule` deliver no message to a recipient and are not
 * gated here (documented in the round-24 report).
 *
 * WHICH IDENTIFIERS. `target_id` (profile URL / handle / thread id / comment
 * id) plus the DM thread identifiers the executor itself dispatches on
 * (`metadata.dm_thread_url`, `metadata.dm_thread_id`). Each is checked on the
 * action's platform channel; `isSuppressed` also honours `*` records. Any one
 * identifier that is suppressed blocks the action.
 *
 * TENANT. The question is always asked for `organization_id` of the action
 * itself — never a caller-supplied tenant — and `isSuppressed` filters every
 * read by that tenant. A tenant-less action fails closed inside
 * `isSuppressed` (`suppression_no_tenant_failclosed`).
 *
 * FAIL-CLOSED. A governance read failure, a thrown lookup, a missing platform
 * or a contacting action with no identifier is NOT an allow: it is reported as
 * `CONTACT_GOVERNANCE_UNAVAILABLE` so callers can refuse without recording a
 * (false) suppression.
 *
 * NEVER A WRITE. This gate reads governance only. It never records, revokes or
 * releases a suppression, so it cannot reactivate a suppressed contact.
 *
 * PII. Identifier VALUES are never returned or logged; only the identifier
 * KIND (`target_id`, `dm_thread_url`, `dm_thread_id`, `recipient_profile_url`, …).
 *
 * ─── ROUND 26 (S-1 / S-2): THE PERSON, NOT THE THREAD OR THE COMMENT ────────
 * Suppression records are keyed on a PERSON (profile URL / handle / email),
 * but a DM row's `target_id` is usually its thread URL and a reply row's is a
 * comment/post URN — so before round 26 a suppressed person was blocked only if
 * a record happened to name the thread or comment. Now every `dm` and `reply`
 * must ALSO resolve the person it reaches, and that identity is checked:
 *   dm     → the RECIPIENT  (`metadata.recipient_profile_url` / `recipient_handle`)
 *   reply  → the AUTHOR of the comment/post replied to
 *            (`metadata.author_profile_url` / `author_handle`)
 *   follow → `target_id` is the profile itself.
 * Resolution order (first that yields an identity wins), all tenant-scoped:
 *   1. the metadata handed in (stamped at creation by engagement/reply.ts,
 *      bulkEngagementService, responseOrchestrator);
 *   2. a `target_id` that is itself a profile URL (linkedin.com/in/…, x.com/<handle>);
 *   3. the engagement store: the message whose platform id is the reply target /
 *      the latest authored message of the DM thread (a LinkedIn thread URL is
 *      reduced to its thread id) → `engagement_authors`.
 * NOTE: `community_ai_actions` has no `metadata` column (repo schema), so a
 * stamped identity lives only in memory for the creating call; later
 * boundaries (approve, execute, hand-out, RPA retry) resolve via step 3.
 * No identity → `CONTACT_IDENTITY_UNRESOLVED`: a terminal refusal for automated
 * sends and a reason-coded refusal for manual ones. A read error while resolving
 * → `CONTACT_GOVERNANCE_UNAVAILABLE` (transient, fail-closed). Never an allow.
 */
import { isSuppressed, type SuppressionResult } from './execution/suppressionService';
import { normalizePlatform } from '../constants/platforms';
import { ownedDbTable } from '../db/writeOwner';
import { isAuthorSelf } from '../../lib/engagement/messageRoles';

export const CONTACTING_ACTION_TYPES: ReadonlySet<string> = new Set(['dm', 'reply', 'follow']);

const METADATA_RECIPIENT_KEYS = ['dm_thread_url', 'dm_thread_id'] as const;

/** The metadata keys that name the PERSON a contacting action reaches (round 26). */
export const PERSON_IDENTITY_KEYS: Readonly<Record<string, readonly string[]>> = {
  dm: ['recipient_profile_url', 'recipient_handle'],
  reply: ['author_profile_url', 'author_handle'],
};

export type CommunityContactGateInput = {
  /** Row id (audit context only; the row has no metadata column to read). */
  id?: string | null;
  organization_id?: string | null;
  platform?: string | null;
  action_type?: string | null;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
  /** A reply to a specific comment: the comment URN (its author is the person reached). */
  parent_comment_urn?: string | null;
  /** Extra platform message-id candidates for the replied-to comment (e.g. every stored LinkedIn comment form). */
  platform_message_ids?: string[] | null;
};

export type PersonIdentity = { profile_url: string | null; handle: string | null };

export type CommunityContactGateResult =
  | { allowed: true; reason: 'not_contacting' | 'not_suppressed'; checked: number }
  | {
      allowed: false;
      code: 'CONTACT_SUPPRESSED';
      reason: string;
      store: string | null;
      identifierKind: string;
      checked: number;
    }
  | {
      allowed: false;
      code: 'CONTACT_GOVERNANCE_UNAVAILABLE';
      reason: string;
      identifierKind: string | null;
      checked: number;
    }
  | {
      allowed: false;
      code: 'CONTACT_IDENTITY_UNRESOLVED';
      reason: string;
      identifierKind: null;
      checked: number;
    };

export const isContactingAction = (actionType: unknown): boolean =>
  CONTACTING_ACTION_TYPES.has(String(actionType ?? '').trim().toLowerCase());

/** A fail-closed exit of `isSuppressed` — governance could not be ASKED. */
const isFailClosedResult = (r: SuppressionResult): boolean =>
  typeof r.reason === 'string' && /_failclosed$/.test(r.reason);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isHttpUrl = (v: string | null): v is string => !!v && /^https?:\/\//i.test(v);

/** A target that is itself a person's profile (not a thread, post, comment or status URL). */
export function isPersonProfileUrl(value: unknown): boolean {
  const v = str(value);
  if (!isHttpUrl(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (host.endsWith('linkedin.com')) return /^\/in\/[^/]+$/i.test(path);
  if (host === 'x.com' || host === 'twitter.com') return /^\/[A-Za-z0-9_]{1,15}$/.test(path);
  return false;
}

/** Identity of one engagement author row (+ the message's raw payload fallbacks). Pure. */
export function personFromAuthor(
  author: { profile_url?: unknown; platform_user_id?: unknown } | null | undefined,
  rawPayload?: Record<string, unknown> | null,
): PersonIdentity | null {
  const profileUrl = str(author?.profile_url);
  const platformUserId = str(author?.platform_user_id);
  const rpUrl = str(rawPayload?.sender_profile_url);
  const rpHandle = str(rawPayload?.sender_handle) ?? str(rawPayload?.sender_username);
  const profile = (isHttpUrl(profileUrl) && profileUrl) || (isHttpUrl(platformUserId) && platformUserId) || (isHttpUrl(rpUrl) && rpUrl) || null;
  const handle = (platformUserId && !isHttpUrl(platformUserId) ? platformUserId : null) ?? rpHandle;
  return profile || handle ? { profile_url: profile || null, handle: handle ?? null } : null;
}

type Lookup<T> = { ok: true; value: T } | { ok: false };

type EngagementMessageRow = {
  id?: string;
  thread_id?: string | null;
  author_id?: string | null;
  raw_payload?: unknown;
  direction?: string | null;
  content?: string | null;
};

/**
 * Every stored form a LinkedIn comment id can take (integration review M-5):
 *   - the API ingester strips the prefix (engagementIngestionService.normalizeLinkedInComments):
 *     `123` or `(urn:li:activity:1,123)`;
 *   - the extension stores the full compound URN: `urn:li:comment:(urn:li:activity:1,123)`;
 *   - callers pass any of these, or the bare numeric id plus the post URN.
 * Pure and deterministic; never throws.
 */
export function linkedInCommentIdCandidates(commentId: unknown, postUrn?: unknown): string[] {
  const out = new Set<string>();
  const raw = str(commentId);
  if (!raw) return [];
  out.add(raw);
  const stripped = raw.replace(/^urn:li:comment:/i, '');
  out.add(stripped);
  out.add(`urn:li:comment:${stripped}`);
  const compound = /^\((urn:li:(?:activity|share|ugcPost):[^,]+),([^)]+)\)$/i.exec(stripped);
  if (compound) {
    out.add(compound[2]);
  } else {
    const post = str(postUrn);
    if (post && /^urn:li:(?:activity|share|ugcPost):/i.test(post)) {
      out.add(`(${post},${stripped})`);
      out.add(`urn:li:comment:(${post},${stripped})`);
    }
  }
  return [...out];
}

/** Platform message-id candidates for a target / parent that may be a LinkedIn comment URN in any stored form. */
function messageIdCandidates(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const s = str(v);
    if (!s) continue;
    if (/^(urn:li:comment:|\(urn:li:)/i.test(s)) linkedInCommentIdCandidates(s).forEach((c) => out.add(c));
    else out.add(s);
  }
  return [...out];
}

/**
 * Is this engagement message OURS (the tenant's own post, comment or DM turn)? The canonical signals
 * (`lib/engagement/messageRoles.isAuthorSelf`: direction, author_self / sender_self, the "You:" preview) plus the
 * connected-account identity (an author whose platform:platform_user_id is one of the tenant's active
 * social_accounts). A self message is never "the person reached" — resolving to ourselves would let a reply pass
 * unchecked (integration review H-2b).
 */
function isSelfMessage(m: EngagementMessageRow, selfAuthorIds: Set<string>): boolean {
  const raw = m.raw_payload && typeof m.raw_payload === 'object' ? (m.raw_payload as Record<string, unknown>) : {};
  if (m.author_id && selfAuthorIds.has(m.author_id)) return true;
  return isAuthorSelf({
    direction: m.direction ?? null,
    author_self: raw.author_self === true,
    sender_self: raw.sender_self === true,
    content: m.content ?? null,
  });
}

/** The tenant's own author ids: engagement_authors matching an active connected social account. A read error is `ok:false`. */
async function loadSelfAuthorIds(org: string, authorIds: string[]): Promise<Lookup<Set<string>>> {
  if (authorIds.length === 0) return { ok: true, value: new Set() };
  const { data: accounts, error: aErr } = await ownedDbTable('social_accounts')
    .select('platform, platform_user_id').eq('company_id', org).eq('is_active', true);
  if (aErr) return { ok: false };
  const own = new Set(
    ((accounts as Array<{ platform?: string; platform_user_id?: string }>) ?? [])
      .map((a) => (a.platform && a.platform_user_id ? `${String(a.platform).toLowerCase()}:${String(a.platform_user_id).trim()}` : null))
      .filter((k): k is string => !!k),
  );
  if (own.size === 0) return { ok: true, value: new Set() };
  const { data: authors, error: auErr } = await ownedDbTable('engagement_authors')
    .select('id, platform, platform_user_id').in('id', authorIds);
  if (auErr) return { ok: false };
  const ids = new Set<string>();
  for (const a of (authors as Array<{ id?: string; platform?: string; platform_user_id?: string }>) ?? []) {
    const key = a.platform && a.platform_user_id ? `${String(a.platform).toLowerCase()}:${String(a.platform_user_id).trim()}` : null;
    if (a.id && key && own.has(key)) ids.add(a.id);
  }
  return { ok: true, value: ids };
}

/**
 * Every PERSON (non-self author) an engagement reference reaches, tenant-scoped and deterministic. Order:
 *   1. `messageId` — that message (exact: the comment/DM being answered);
 *   2. `platformMessageIds` — messages with those platform ids (every stored LinkedIn comment form);
 *   3. `platformThreadIds` — every non-self author of that thread (a reply aimed at a POST URN, or a DM thread,
 *      reaches its participants; checking all of them is the deterministic superset when the exact comment is
 *      no longer known — the row has no metadata column to remember it).
 * A self message at any step is skipped, never returned. A read error is `ok:false` (fail closed).
 */
export async function resolveEngagementPersons(
  organizationId: string,
  ref: { messageId?: string | null; platformMessageIds?: Array<string | null | undefined>; platformThreadIds?: Array<string | null | undefined> },
): Promise<Lookup<PersonIdentity[]>> {
  const org = str(organizationId);
  if (!org) return { ok: true, value: [] };
  const COLS = 'id, thread_id, author_id, raw_payload, direction, content';
  try {
    const messageId = str(ref.messageId);
    const pmids = messageIdCandidates(ref.platformMessageIds ?? []);
    const ptids = [...new Set((ref.platformThreadIds ?? []).map(str).filter((v): v is string => !!v))];
    let candidates: EngagementMessageRow[] = [];
    if (messageId) {
      const { data, error } = await ownedDbTable('engagement_messages').select(COLS).eq('organization_id', org).eq('id', messageId).maybeSingle();
      if (error) return { ok: false };
      if (data) candidates = [data as EngagementMessageRow];
    }
    if (candidates.length === 0 && pmids.length) {
      const { data, error } = await ownedDbTable('engagement_messages').select(COLS).eq('organization_id', org).in('platform_message_id', pmids).limit(20);
      if (error) return { ok: false };
      candidates = (data as EngagementMessageRow[]) ?? [];
    }
    const resolveFrom = async (rows: EngagementMessageRow[]): Promise<Lookup<PersonIdentity[]>> => {
      const authorIds = [...new Set(rows.map((r) => r.author_id).filter((v): v is string => !!v))];
      const self = await loadSelfAuthorIds(org, authorIds);
      if (self.ok === false) return { ok: false };
      const others = rows.filter((r) => !isSelfMessage(r, self.value));
      const otherAuthorIds = [...new Set(others.map((r) => r.author_id).filter((v): v is string => !!v))];
      const byId = new Map<string, { profile_url?: unknown; platform_user_id?: unknown }>();
      if (otherAuthorIds.length) {
        const { data, error } = await ownedDbTable('engagement_authors').select('id, profile_url, platform_user_id').in('id', otherAuthorIds);
        if (error) return { ok: false };
        for (const a of (data as Array<{ id?: string; profile_url?: unknown; platform_user_id?: unknown }>) ?? []) if (a.id) byId.set(a.id, a);
      }
      const persons: PersonIdentity[] = [];
      const seen = new Set<string>();
      for (const r of others) {
        const raw = r.raw_payload && typeof r.raw_payload === 'object' ? (r.raw_payload as Record<string, unknown>) : null;
        const p = personFromAuthor(r.author_id ? byId.get(r.author_id) ?? null : null, raw);
        if (!p) continue;
        const key = `${p.profile_url ?? ''}|${p.handle ?? ''}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        persons.push(p);
      }
      return { ok: true, value: persons };
    };
    if (candidates.length) {
      const direct = await resolveFrom(candidates);
      if (direct.ok === false || direct.value.length) return direct;
    }
    if (ptids.length) {
      const { data: threads, error: tErr } = await ownedDbTable('engagement_threads')
        .select('id').eq('organization_id', org).in('platform_thread_id', ptids).limit(5);
      if (tErr) return { ok: false };
      const threadIds = ((threads as Array<{ id?: string }>) ?? []).map((t) => t.id).filter((v): v is string => !!v);
      if (threadIds.length) {
        const { data: msgs, error: mErr } = await ownedDbTable('engagement_messages')
          .select(COLS).eq('organization_id', org).in('thread_id', threadIds).order('created_at', { ascending: false }).limit(100);
        if (mErr) return { ok: false };
        return resolveFrom((msgs as EngagementMessageRow[]) ?? []);
      }
    }
    return { ok: true, value: [] };
  } catch {
    return { ok: false };
  }
}

/**
 * The single author of one engagement message (exact; used to STAMP identity at action creation).
 * A self-authored message resolves to null (never ourselves). A read error is `{ ok:false }`.
 */
export async function resolveEngagementAuthorIdentity(
  organizationId: string,
  ref: { messageId?: string | null; platformMessageIds?: Array<string | null | undefined>; platformThreadIds?: Array<string | null | undefined> },
): Promise<Lookup<PersonIdentity | null>> {
  const r = await resolveEngagementPersons(organizationId, ref);
  if (r.ok === false) return { ok: false };
  return { ok: true, value: r.value[0] ?? null };
}

/** Metadata to STAMP on a new dm/reply so every later boundary checks the person. */
export function personIdentityMetadata(actionType: 'dm' | 'reply', person: PersonIdentity | null): Record<string, string> {
  if (!person) return {};
  const [urlKey, handleKey] = PERSON_IDENTITY_KEYS[actionType];
  const out: Record<string, string> = {};
  if (person.profile_url) out[urlKey] = person.profile_url;
  if (person.handle) out[handleKey] = person.handle;
  return out;
}

function personIdentifiers(actionType: string, md: Record<string, unknown> | null, targetId: unknown): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  if (actionType === 'follow') {
    const t = str(targetId);
    if (t) out.push({ kind: 'target_id', value: t });
    return out;
  }
  for (const key of PERSON_IDENTITY_KEYS[actionType] ?? []) {
    const v = str(md?.[key]);
    if (v) out.push({ kind: key, value: v });
  }
  if (out.length === 0 && isPersonProfileUrl(targetId)) out.push({ kind: 'target_id', value: String(targetId).trim() });
  return out;
}

/** A LinkedIn messaging thread URL → its thread id (engagement_threads.platform_thread_id). */
export function linkedInThreadIdFromUrl(value: unknown): string | null {
  const v = str(value);
  if (!v) return null;
  const m = /linkedin\.com\/messaging\/thread\/([^/?#]+)/i.exec(v);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** Step 3 of the resolution order: the engagement store (re-resolved at EVERY gate; nothing is persisted). */
async function resolvePersonIdentifiers(
  input: CommunityContactGateInput,
  actionType: string,
): Promise<Lookup<Array<{ kind: string; value: string }>>> {
  const org = str(input.organization_id);
  if (!org) return { ok: true, value: [] };
  const md = input.metadata && typeof input.metadata === 'object' ? (input.metadata as Record<string, unknown>) : null;
  const threadKeys = [input.target_id, str(md?.dm_thread_id), str(md?.dm_thread_url)];
  const looked = await resolveEngagementPersons(org, actionType === 'reply'
    // A reply: the exact comment when known (parent / extra ids / a comment-URN target); otherwise the thread whose
    // platform id is the target (LinkedIn replies target the POST URN: engagement/reply.ts) → its non-self authors.
    ? { platformMessageIds: [input.parent_comment_urn, ...(input.platform_message_ids ?? []), input.target_id], platformThreadIds: [input.target_id] }
    : { platformThreadIds: [...threadKeys, ...threadKeys.map(linkedInThreadIdFromUrl)] });
  if (looked.ok === false) return { ok: false };
  const kinds = PERSON_IDENTITY_KEYS[actionType] ?? [];
  const out: Array<{ kind: string; value: string }> = [];
  for (const person of looked.value) {
    if (person.profile_url) out.push({ kind: kinds[0] ?? 'person_profile_url', value: person.profile_url });
    if (person.handle) out.push({ kind: kinds[1] ?? 'person_handle', value: person.handle });
  }
  return { ok: true, value: out };
}

function recipientIdentifiers(input: CommunityContactGateInput): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  const seen = new Set<string>();
  const push = (kind: string, raw: unknown) => {
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };
  push('target_id', input.target_id);
  const md = input.metadata && typeof input.metadata === 'object' ? input.metadata : null;
  if (md) for (const k of METADATA_RECIPIENT_KEYS) push(k, (md as Record<string, unknown>)[k]);
  return out;
}

/**
 * May this community action contact its recipient? Read-only; never throws.
 */
export async function checkCommunityActionContactGovernance(
  input: CommunityContactGateInput,
): Promise<CommunityContactGateResult> {
  if (!isContactingAction(input?.action_type)) {
    return { allowed: true, reason: 'not_contacting', checked: 0 };
  }

  const channel = normalizePlatform(input?.platform ?? null);
  if (!channel) {
    return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'no_channel_failclosed', identifierKind: null, checked: 0 };
  }

  const identifiers = recipientIdentifiers(input);
  if (identifiers.length === 0) {
    return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'no_recipient_identifier_failclosed', identifierKind: null, checked: 0 };
  }

  // Round 26 (S-1/S-2): the PERSON reached must be known and is checked FIRST.
  const actionType = String(input.action_type).trim().toLowerCase();
  const md = input.metadata && typeof input.metadata === 'object' ? (input.metadata as Record<string, unknown>) : null;
  let person = personIdentifiers(actionType, md, input.target_id);
  if (person.length === 0) {
    const resolved = await resolvePersonIdentifiers(input, actionType);
    if (resolved.ok === false) {
      return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'person_identity_lookup_failed_failclosed', identifierKind: null, checked: 0 };
    }
    person = resolved.value;
  }
  if (person.length === 0) {
    return {
      allowed: false,
      code: 'CONTACT_IDENTITY_UNRESOLVED',
      reason: actionType === 'reply' ? 'reply_author_unresolved' : actionType === 'dm' ? 'dm_recipient_unresolved' : 'contact_unresolved',
      identifierKind: null,
      checked: 0,
    };
  }
  const seenValues = new Set(person.map((p) => p.value.toLowerCase()));
  identifiers.unshift(...person);
  // de-duplicate (a profile-URL target is both the person and the target)
  for (let i = identifiers.length - 1; i >= person.length; i -= 1) {
    if (seenValues.has(identifiers[i].value.toLowerCase())) identifiers.splice(i, 1);
  }

  const companyId = String(input?.organization_id ?? '');
  let checked = 0;
  for (const id of identifiers) {
    let result: SuppressionResult;
    try {
      result = await isSuppressed(companyId, channel, id.value);
    } catch {
      return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'governance_check_threw_failclosed', identifierKind: id.kind, checked };
    }
    checked += 1;
    if (!result || typeof result.suppressed !== 'boolean') {
      return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'governance_result_malformed_failclosed', identifierKind: id.kind, checked };
    }
    if (result.suppressed) {
      if (isFailClosedResult(result)) {
        return { allowed: false, code: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: String(result.reason), identifierKind: id.kind, checked };
      }
      return {
        allowed: false,
        code: 'CONTACT_SUPPRESSED',
        reason: result.reason ?? 'suppressed',
        store: result.store ?? null,
        identifierKind: id.kind,
        checked,
      };
    }
  }
  return { allowed: true, reason: 'not_suppressed', checked };
}

/** Audit payload for a refusal: codes and identifier KIND only, never the value. */
export function contactGateAuditPayload(
  gate: Exclude<CommunityContactGateResult, { allowed: true }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gate: 'contact_governance',
    code: gate.code,
    reason: gate.reason,
    store: gate.code === 'CONTACT_SUPPRESSED' ? gate.store : null,
    identifier_kind: gate.identifierKind,
    identifiers_checked: gate.checked,
    ...extra,
  };
}
