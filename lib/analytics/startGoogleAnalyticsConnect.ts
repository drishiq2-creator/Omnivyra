/**
 * Start the Google Analytics OAuth connection: POST /api/analytics/connect/google (POST-only) → the Google
 * authorization URL to send the browser to. Used by /website-setup, whose former plain GET link answered 405
 * (04, 2026-11-20). /integrations (focus=data) still has its own handler with GA/GSC notices; folding it in is a
 * registered follow-up.
 */
import { fetchWithAuth } from '../../components/community-ai/fetchWithAuth';

export const GA_CONNECT_FAILED_MESSAGE = "Couldn't start the Google Analytics connection.";

export type GoogleAnalyticsConnectStart =
  | { ok: true; authorizationUrl: string }
  | { ok: false; message: string };

export async function startGoogleAnalyticsConnect(companyId: string, returnTo: string): Promise<GoogleAnalyticsConnectStart> {
  try {
    const res = await fetchWithAuth('/api/analytics/connect/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, returnTo }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && typeof body?.authorizationUrl === 'string' && body.authorizationUrl) {
      return { ok: true, authorizationUrl: body.authorizationUrl };
    }
    return { ok: false, message: typeof body?.message === 'string' && body.message ? body.message : GA_CONNECT_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: GA_CONNECT_FAILED_MESSAGE };
  }
}
