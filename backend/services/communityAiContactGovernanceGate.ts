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
 * KIND (`target_id`, `dm_thread_url`, `dm_thread_id`).
 */
import { isSuppressed, type SuppressionResult } from './execution/suppressionService';
import { normalizePlatform } from '../constants/platforms';

export const CONTACTING_ACTION_TYPES: ReadonlySet<string> = new Set(['dm', 'reply', 'follow']);

const METADATA_RECIPIENT_KEYS = ['dm_thread_url', 'dm_thread_id'] as const;

export type CommunityContactGateInput = {
  organization_id?: string | null;
  platform?: string | null;
  action_type?: string | null;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

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
    };

export const isContactingAction = (actionType: unknown): boolean =>
  CONTACTING_ACTION_TYPES.has(String(actionType ?? '').trim().toLowerCase());

/** A fail-closed exit of `isSuppressed` — governance could not be ASKED. */
const isFailClosedResult = (r: SuppressionResult): boolean =>
  typeof r.reason === 'string' && /_failclosed$/.test(r.reason);

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
