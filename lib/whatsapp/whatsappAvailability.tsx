/**
 * WhatsApp launch gate (b3, 2026-11-18): WhatsApp has never been used in production, so its connect
 * and broadcast entry points stay hidden until the stranded WhatsApp line's stage 3 is live.
 *
 * Contract (a9, fix/whatsapp-connect-gate-20261118): GET /api/whatsapp/status -> 200
 * { enabled: boolean } (global, any signed-in user, no-store). The SERVER also refuses every
 * WhatsApp write while the flag is off (409 WHATSAPP_NOT_AVAILABLE), so this UI gate is cosmetic;
 * it must FAIL CLOSED: loading, an error, a 401/404 or anything but `enabled === true` -> hidden.
 */
import React, { useEffect, useState } from 'react';
import { apiFetch } from '../apiFetch';

export const WHATSAPP_COMING_SOON = 'WhatsApp is coming soon.';

export type WhatsAppAvailability = 'loading' | 'enabled' | 'hidden';

/** One request per page mount; anything short of a 200 with enabled === true is hidden. */
export function useWhatsAppAvailability(): WhatsAppAvailability {
  const [state, setState] = useState<WhatsAppAvailability>('loading');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/whatsapp/status');
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (!cancelled) setState(res.status === 200 && body && body.enabled === true ? 'enabled' : 'hidden');
      } catch {
        if (!cancelled) setState('hidden');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * Renders `children` only when WhatsApp is enabled. While loading it renders nothing (never the
 * real page, so no WhatsApp request is made); when hidden it renders the plain coming-soon line.
 */
export function WhatsAppGate({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const state = useWhatsAppAvailability();
  if (state === 'enabled') return <>{children}</>;
  if (state === 'loading') return null;
  return (
    <>
      {fallback ?? (
        <div className="mx-auto max-w-xl px-6 py-16 text-center text-sm text-gray-600" data-testid="whatsapp-coming-soon">
          {WHATSAPP_COMING_SOON}
        </div>
      )}
    </>
  );
}
