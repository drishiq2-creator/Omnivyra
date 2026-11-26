/**
 * WhatsApp Business Platform Adapter
 *
 * Implements IPlatformAdapter for WhatsApp Business API.
 * Uses Facebook Graph API: https://graph.facebook.com/v22.0
 */

import type {
  IPlatformAdapter,
  PublishContentPayload,
  FetchCommentsParams,
  PlatformCredentials,
  PublishResult,
  ConnectionTestResult,
} from './baseAdapter';
import { withRateLimit, enforcePublishPolicy, fetchJsonWithBearer } from './baseAdapter';
import { isWhatsAppEnabled, WHATSAPP_NOT_AVAILABLE } from '../whatsappAvailability';

const WHATSAPP_API = 'https://graph.facebook.com/v22.0';

/**
 * R26 T-5 — a tenant's WhatsApp traffic uses the TENANT's sender, or nothing.
 *
 * Before round 26 every method addressed `process.env.WHATSAPP_PHONE_NUMBER_ID` (Omnivyra's own number) with the
 * tenant's token, and publishContent defaulted the recipient to `process.env.WHATSAPP_RECIPIENT_PHONE`, all without
 * the WHATSAPP_CONNECT_ENABLED gate. Now:
 *   - every egress method checks isWhatsAppEnabled() FIRST and fails closed (WHATSAPP_NOT_AVAILABLE, no fetch);
 *   - the sender is the tenant's `phone_number_id` (social_accounts.phone_number_id, passed in with the credentials);
 *     absent -> refused, never the platform env;
 *   - the recipient must be given explicitly; there is no default recipient.
 * The platform env variables are no longer read here at all.
 */
type WhatsAppCredentials = PlatformCredentials & { phone_number_id?: string | null };

function tenantPhoneNumberId(credentials: PlatformCredentials | { phone_number_id?: string | null } | null | undefined): string | null {
  const raw = (credentials as WhatsAppCredentials | null | undefined)?.phone_number_id;
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || null;
}

const NOT_AVAILABLE = { success: false, error: WHATSAPP_NOT_AVAILABLE } as const;
const NO_TENANT_SENDER = { success: false, error: 'WHATSAPP_TENANT_PHONE_NUMBER_ID_MISSING' } as const;

export const whatsappAdapter: IPlatformAdapter = {
  platformKey: 'whatsapp',

  async publishContent(
    payload: PublishContentPayload,
    credentials: PlatformCredentials
  ): Promise<PublishResult> {
    if (!isWhatsAppEnabled()) return { ...NOT_AVAILABLE };
    return withRateLimit('whatsapp', async () => {
      enforcePublishPolicy('whatsapp', payload);
      if (process.env.USE_MOCK_PLATFORMS === 'true') {
        return {
          success: true,
          platform_post_id: `mock_wa_${Date.now()}`,
          post_url: undefined,
        };
      }
      const phoneNumberId = tenantPhoneNumberId(credentials);
      if (!phoneNumberId) return { ...NO_TENANT_SENDER };
      const recipient = typeof payload.platform_post_id === 'string' ? payload.platform_post_id.trim() : '';
      if (!recipient) return { success: false, error: 'WHATSAPP_RECIPIENT_REQUIRED' };
      try {
        const body: any = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          text: { body: payload.content.slice(0, 4096) },
        };
        if (payload.template_name) {
          body.type = 'template';
          body.template = { name: payload.template_name, language: { code: 'en' } };
          delete body.text;
        }
        const res = await fetchJsonWithBearer(
          `${WHATSAPP_API}/${phoneNumberId}/messages`,
          credentials.access_token,
          { init: { method: 'POST', body: JSON.stringify(body) } }
        );
        const id = res?.messages?.[0]?.id;
        return { success: true, platform_post_id: id, post_url: undefined };
      } catch (e: any) {
        return { success: false, error: e?.message || 'WhatsApp send failed' };
      }
    });
  },

  async replyToComment(
    threadId: string,
    message: string,
    credentials: PlatformCredentials
  ): Promise<{ success: boolean; error?: string }> {
    if (!isWhatsAppEnabled()) return { ...NOT_AVAILABLE };
    return withRateLimit('whatsapp', async () => {
      const phoneNumberId = tenantPhoneNumberId(credentials);
      if (!phoneNumberId) return { ...NO_TENANT_SENDER };
      try {
        await fetchJsonWithBearer(
          `${WHATSAPP_API}/${phoneNumberId}/messages`,
          credentials.access_token,
          { init: { method: 'POST', body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: threadId.replace(/\D/g, '').slice(-15),
            type: 'text',
            text: { body: message.slice(0, 4096) },
          }) } }
        );
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e?.message || 'WhatsApp reply failed' };
      }
    });
  },

  async likeComment(
    _messageId: string,
    _credentials: PlatformCredentials
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'WhatsApp does not support like/reaction via this API' };
  },

  async fetchComments(params: FetchCommentsParams): Promise<unknown> {
    // Read path: no platform sender either. Without the gate, or without the tenant's own phone number id, there is
    // nothing this tenant may read.
    if (!isWhatsAppEnabled()) return { data: [], messaging_product: 'whatsapp' };
    return withRateLimit('whatsapp', async () => {
      const phoneNumberId = tenantPhoneNumberId(params as FetchCommentsParams & { phone_number_id?: string | null });
      if (!phoneNumberId) {
        return { data: [], messaging_product: 'whatsapp' };
      }
      try {
        const url = `${WHATSAPP_API}/${phoneNumberId}/messages?limit=100`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            Accept: 'application/json',
          },
        });
        if (!response.ok) return { data: [], messaging_product: 'whatsapp' };
        return response.json();
      } catch {
        return { data: [], messaging_product: 'whatsapp' };
      }
    });
  },

  async testConnection(credentials: PlatformCredentials): Promise<ConnectionTestResult> {
    return withRateLimit('whatsapp', async () => {
      try {
        const me = await fetchJsonWithBearer(`${WHATSAPP_API}/me`, credentials.access_token);
        if (me?.id) {
          return { success: true, message: 'Connection test passed (token valid)' };
        }
        return { success: false, error: 'Token validation failed' };
      } catch (e: any) {
        return { success: false, error: e?.message || 'Connection test failed' };
      }
    });
  },
};
