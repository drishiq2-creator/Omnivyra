/**
 * Pairing the Omnivyra Sales Navigator EXTENSION from the Sales Navigator page (owner 2026-11-22: two independently
 * usable LinkedIn extensions; before this, only the Engagement page could sign an extension in).
 *
 * Same handshake as the Engagement page (hooks/useExtensionBridge.ts), addressed to product 'salesnav': every window
 * message carries product, so only the Sales Navigator extension answers (the engagement extension ignores it), and
 * the one-time claim code is issued for, and redeemable only by, that product. The page never sees a token.
 *
 * States are distinct and never collapsed: an extension that did not answer is 'not_detected' (not installed, or the
 * tab was opened before the extension was loaded), never "not signed in".
 */
export const SALESNAV_EXTENSION_PRODUCT = 'salesnav';

export type SalesNavExtensionState =
  | { kind: 'not_detected' }
  | { kind: 'signed_out' }
  | { kind: 'signed_in'; orgId: string | null }
  | { kind: 'other_company'; orgId: string };

type Win = Pick<Window, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout' | 'location'>;

function waitFor<T>(win: Win, type: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== (win as unknown as Window)) return;
      if (!event.data || event.data.type !== type) return;
      win.clearTimeout(timer);
      win.removeEventListener('message', onMessage as EventListener);
      resolve((event.data.data ?? event.data) as T);
    };
    const timer = win.setTimeout(() => {
      win.removeEventListener('message', onMessage as EventListener);
      resolve(null);
    }, timeoutMs);
    win.addEventListener('message', onMessage as EventListener);
  });
}

/** Ask the Sales Navigator extension (only) whether it is installed and signed in, and for which company. */
export async function readSalesNavExtensionState(companyId: string, win: Win = window, timeoutMs = 3000): Promise<SalesNavExtensionState> {
  const reply = waitFor<{ isAuthenticated?: boolean; orgId?: string | null }>(win, 'OMNIVYRA_EXTENSION_AUTH_STATE', timeoutMs);
  win.postMessage({ type: 'OMNIVYRA_REQUEST_AUTH_STATE', product: SALESNAV_EXTENSION_PRODUCT }, win.location.origin);
  const auth = await reply;
  if (!auth) return { kind: 'not_detected' };
  if (auth.isAuthenticated !== true) return { kind: 'signed_out' };
  const orgId = typeof auth.orgId === 'string' ? auth.orgId : null;
  if (orgId && orgId !== companyId) return { kind: 'other_company', orgId };
  return { kind: 'signed_in', orgId };
}

/**
 * Sign the Sales Navigator extension in for this company: a claim code issued for product 'salesnav', handed to that
 * extension only. Resolves with the extension's own answer; throws with a plain message on any failure.
 */
export async function connectSalesNavExtension(
  companyId: string, win: Win = window, fetcher: typeof fetch = fetch, timeoutMs = 15000,
): Promise<void> {
  const res = await fetcher('/api/extension/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ organization_id: companyId, product: SALESNAV_EXTENSION_PRODUCT }),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { claim_code?: string }; error?: string };
  if (!res.ok || !json.success || !json.data?.claim_code) {
    throw new Error(json.error === 'CLAIM_STORE_UNAVAILABLE'
      ? 'Signing in is temporarily unavailable. Please try again in a minute.'
      : `We couldn't start signing in the extension (${res.status}).`);
  }
  const reply = waitFor<{ success?: boolean; message?: string }>(win, 'OMNIVYRA_CLAIM_CODE_RESULT', timeoutMs);
  win.postMessage({ type: 'OMNIVYRA_CLAIM_CODE', product: SALESNAV_EXTENSION_PRODUCT, data: { claim_code: json.data.claim_code } }, win.location.origin);
  const result = await reply;
  if (!result) throw new Error('The Sales Navigator extension did not answer. Make sure it is installed, then reload this page.');
  if (result.success !== true) throw new Error(`The extension could not sign in (${result.message || 'unknown reason'}). Reload this page and try again.`);
}
