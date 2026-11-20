import { supabase } from '../db/supabaseClient';
import { safeFetch } from '../../lib/security/safeFetch';

/**
 * CUSTOMER WEBHOOK CONTRACT (community AI). Customers subscribe per event_type; the POST body is the payload below.
 *
 * 'executed' carries a REQUIRED boolean `metadata.confirmed` (b3 ruling 2026-11-20, PL-122):
 *   confirmed: true   the platform confirmed the action (API success, or an extension ack with confirmation);
 *   confirmed: false  SENT, NOT CONFIRMED BY THE PLATFORM - the action was handed over (a permissive / legacy connector
 *                     ack, a manual simulation) but nothing observed it land. Integrations that need certainty must
 *                     check this field; 'executed' alone does not mean confirmed.
 * The field is never absent: the type requires it, and a payload that arrives here without a boolean is sent as
 * confirmed: false (an unknown confirmation is not a confirmation) and logged at error level.
 * Why not a separate 'sent_unverified' event: integrations handling 'executed' would silently stop firing for
 * unconfirmed sends. A distinct event is register item "webhook v2" (post-launch).
 */
type WebhookEventType = 'failed' | 'high_risk_pending' | 'anomaly' | 'executed';

type WebhookBase = {
  tenant_id: string;
  organization_id: string;
  action_id?: string | null;
  message: string;
};
type WebhookPayload =
  | (WebhookBase & { event_type: 'executed'; metadata: { confirmed: boolean } & Record<string, unknown> })
  | (WebhookBase & { event_type: Exclude<WebhookEventType, 'executed'>; metadata?: Record<string, unknown> | null });

/** The payload as delivered: an 'executed' event always carries a boolean confirmed (absent/non-boolean -> false). */
export function deliveredWebhookPayload(payload: WebhookPayload): WebhookPayload {
  if (payload.event_type !== 'executed') return payload;
  const confirmed = (payload.metadata as { confirmed?: unknown } | null | undefined)?.confirmed;
  if (typeof confirmed === 'boolean') return payload;
  console.error('COMMUNITY_AI_WEBHOOK_CONFIRMED_MISSING', JSON.stringify({ action_id: payload.action_id ?? null }));
  return { ...payload, metadata: { ...(payload.metadata ?? {}), confirmed: false } };
}

const postWebhook = async (url: string, payload: WebhookPayload) => {
  // HARDEN-005: webhook_url is customer-controlled (DB) — deliver through the
  // SSRF-safe fetcher so a hook can never target an internal/private address.
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, { maxBytes: 1 * 1024 * 1024 });
  if (!response.ok) {
    throw new Error(`Webhook failed with status ${response.status}`);
  }
};

export const sendCommunityAiWebhooks = async (input: WebhookPayload) => {
  const payload = deliveredWebhookPayload(input);
  const { data: hooks, error } = await supabase
    .from('community_ai_webhooks')
    .select('webhook_url')
    .eq('tenant_id', payload.tenant_id)
    .eq('organization_id', payload.organization_id)
    .eq('event_type', payload.event_type)
    .eq('is_active', true);

  if (error || !hooks || hooks.length === 0) {
    return;
  }

  for (const hook of hooks) {
    try {
      await postWebhook(hook.webhook_url, payload);
    } catch (err) {
      try {
        await postWebhook(hook.webhook_url, payload);
      } catch (finalError: any) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('COMMUNITY_AI_WEBHOOK_FAILED', finalError?.message || String(finalError));
        }
      }
    }
  }
};

export type { WebhookEventType, WebhookPayload };
