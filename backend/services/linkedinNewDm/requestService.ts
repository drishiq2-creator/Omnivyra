/**
 * "Message on LinkedIn" from a lead in Prospects (owner-approved 2026-11-22). Creates ONE pending action in the
 * EXISTING approved-actions workflow (community_ai_actions; approved via /api/community-ai/actions/approve, executed
 * via /execute). Nothing is sent here, and nothing is sent until a person approves.
 *
 * Everything that decides WHO receives and WHO sends is resolved on the server, never taken from the browser:
 *   recipient  the lead's LinkedIn profile as Sales Navigator displayed it (source_records of provider
 *              'linkedin_sales_navigator' for the lead's person, raw_payload.public_profile_url), normalised to
 *              https://www.linkedin.com/in/<slug>/. None -> NO_LINKEDIN_PROFILE; two different -> ambiguous, refused.
 *   sender     the requesting user (acting_user_id) and THEIR linked LinkedIn account for the Sales Navigator
 *              extension (salesnav_member_bindings, transport 'extension'). Not linked -> refused.
 * A read that fails is reported as 'unavailable' (503), never as "no profile" / "not linked".
 * One open request per (lead, sender): a second click while one is pending/approved is refused, not duplicated.
 */
import { ownedDbTable } from '../../db/writeOwner';
import { boundMember } from '../salesNav/store';
import { SALESNAV_SOURCE } from '../salesNav/contract';

export const LINKEDIN_DM_MAX_TEXT = 8000;
const PROFILE_URL = /^https?:\/\/(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{1,100})\/?(?:[?#].*)?$/i;

export type NewDmRequestResult =
  | { ok: true; actionId: string; recipientProfileUrl: string; senderMemberId: string }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

export interface NewDmDeps {
  readonly table?: (name: string) => any;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly memberFor?: (org: string, userId: string) => Promise<string | null | 'unreadable'>;
}

/** The canonical recipient URL, or null when the value is not an absolute linkedin.com/in/ profile link. */
export function canonicalProfileUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = PROFILE_URL.exec(value.trim());
  return m ? `https://www.linkedin.com/in/${m[1]}/` : null;
}

type Rows = { data?: unknown; error?: unknown };
const rowsOf = (r: Rows): Array<Record<string, unknown>> | null => (r && !r.error && Array.isArray(r.data) ? r.data as Array<Record<string, unknown>> : null);

/** The lead's single LinkedIn profile URL from its Sales Navigator evidence. */
export async function resolveLeadProfileUrl(
  org: string, prospectId: string, deps: NewDmDeps = {},
): Promise<{ url: string; personId: string } | { error: 'PROSPECT_NOT_FOUND' | 'NO_LINKEDIN_PROFILE' | 'LINKEDIN_PROFILE_AMBIGUOUS' | 'unavailable' }> {
  const table = deps.table ?? ownedDbTable;
  const lead = rowsOf(await table('canonical_leads').select('id, unified_person_id').eq('id', prospectId).eq('company_id', org).limit(1));
  if (!lead) return { error: 'unavailable' };
  if (!lead[0]) return { error: 'PROSPECT_NOT_FOUND' };
  const personId = typeof lead[0].unified_person_id === 'string' ? lead[0].unified_person_id : null;
  if (!personId) return { error: 'NO_LINKEDIN_PROFILE' };
  const recs = rowsOf(await table('source_records').select('raw_payload')
    .eq('organization_id', org).eq('person_id', personId).eq('provider', SALESNAV_SOURCE).limit(50));
  if (!recs) return { error: 'unavailable' };
  const urls = new Set<string>();
  for (const r of recs) {
    const raw = r.raw_payload as Record<string, unknown> | null;
    const url = canonicalProfileUrl(raw && raw.public_profile_url);
    if (url) urls.add(url);
  }
  if (urls.size === 0) return { error: 'NO_LINKEDIN_PROFILE' };
  const distinct = new Set([...urls].map((u) => u.toLowerCase()));
  if (distinct.size > 1) return { error: 'LINKEDIN_PROFILE_AMBIGUOUS' };
  return { url: [...urls][0], personId };
}

export async function requestLinkedInNewDm(
  input: { organizationId: string; userId: string; prospectId: string; text: unknown },
  deps: NewDmDeps = {},
): Promise<NewDmRequestResult> {
  const table = deps.table ?? ownedDbTable;
  const text = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n') : '';
  if (!text.trim()) return { ok: false, status: 400, error: 'MESSAGE_REQUIRED' };
  if (text.length > LINKEDIN_DM_MAX_TEXT) return { ok: false, status: 400, error: 'MESSAGE_TOO_LONG' };

  const recipient = await resolveLeadProfileUrl(input.organizationId, input.prospectId, deps);
  if ('error' in recipient) {
    if (recipient.error === 'unavailable') return { ok: false, status: 503, error: 'LEAD_UNREADABLE' };
    return { ok: false, status: recipient.error === 'PROSPECT_NOT_FOUND' ? 404 : 409, error: recipient.error };
  }

  const member = await (deps.memberFor ?? ((o, u) => boundMember(o, u, 'extension', deps.table ? { table: deps.table } : {})))(input.organizationId, input.userId);
  if (member === 'unreadable') return { ok: false, status: 503, error: 'SENDER_ACCOUNT_UNREADABLE' };
  if (!member) return { ok: false, status: 409, error: 'SALESNAV_ACCOUNT_NOT_LINKED' };

  // One open request per (lead, sender): a double click must not queue two messages.
  const open = rowsOf(await table('community_ai_actions').select('id')
    .eq('organization_id', input.organizationId).eq('dm_lead_id', input.prospectId).eq('acting_user_id', input.userId)
    .in('status', ['pending', 'approved']).limit(1));
  if (!open) return { ok: false, status: 503, error: 'ACTIONS_UNREADABLE' };
  if (open[0]) return { ok: false, status: 409, error: 'MESSAGE_ALREADY_PENDING' };

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const id = (deps.newId ?? (() => require('crypto').randomUUID() as string))();
  const ins = await table('community_ai_actions').insert({
    id,
    tenant_id: input.organizationId,
    organization_id: input.organizationId,
    platform: 'linkedin',
    action_type: 'dm',
    target_id: recipient.url,
    suggested_text: text,
    risk_level: 'medium',
    requires_human_approval: true,
    requires_approval: true,
    // NO execution mode until a person approves and the executor runs it: a pending 'browser' row is what the
    // extension hand-out and the abandoned-dispatch recovery look at, and this one is not dispatchable yet.
    execution_mode: null,
    status: 'pending',
    acting_user_id: input.userId,
    dm_lead_id: input.prospectId,
    dm_sender_member_id: member,
    created_at: now,
    updated_at: now,
  });
  if (!ins || ins.error) return { ok: false, status: 503, error: 'ACTION_NOT_RECORDED' };
  return { ok: true, actionId: id, recipientProfileUrl: recipient.url, senderMemberId: member };
}
