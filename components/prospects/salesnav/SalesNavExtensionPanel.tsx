/**
 * The Omnivyra Sales Navigator EXTENSION's sign-in state on the Sales Navigator page (owner 2026-11-22). This is the
 * browser extension's own connection - separate from the LinkedIn account link (shown below it) and from the
 * Engagement Center's LinkedIn API connection. Signs the extension in automatically once per page load when it is
 * installed and signed out; the button retries.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectSalesNavExtension, readSalesNavExtensionState, type SalesNavExtensionState,
} from '@/lib/prospects/salesnav/salesNavExtensionLink';

export default function SalesNavExtensionPanel({ companyId }: { companyId: string }) {
  const [state, setState] = useState<SalesNavExtensionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  const refresh = useCallback(async () => {
    const s = await readSalesNavExtensionState(companyId);
    setState(s);
    return s;
  }, [companyId]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await connectSalesNavExtension(companyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The extension could not sign in.');
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [companyId, refresh]);

  useEffect(() => {
    void (async () => {
      const s = await refresh();
      if (!autoTried.current && (s.kind === 'signed_out' || s.kind === 'other_company')) {
        autoTried.current = true;
        await connect();
      }
    })();
  }, [refresh, connect]);

  const line = state === null ? 'Checking the Omnivyra Sales Navigator extension…'
    : state.kind === 'not_detected' ? 'The Omnivyra Sales Navigator extension was not detected in this browser. Install it (or reload this page if you just loaded it).'
      : state.kind === 'signed_out' ? 'The Omnivyra Sales Navigator extension is installed but not signed in.'
        : state.kind === 'other_company' ? 'The Omnivyra Sales Navigator extension is signed in to a different company.'
          : 'The Omnivyra Sales Navigator extension is signed in.';

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="salesnav-extension">
      <p data-testid="salesnav-extension-state" data-state={state?.kind ?? 'checking'}>{line}</p>
      {state !== null && state.kind !== 'signed_in' && state.kind !== 'not_detected' && (
        <button type="button" disabled={busy} onClick={() => { void connect(); }}
          className="mt-2 rounded-lg border border-purple-600 px-3 py-1.5 text-sm text-purple-700">
          {busy ? 'Signing in…' : 'Sign in the extension'}
        </button>
      )}
      {error && <p className="mt-2 text-red-700" role="alert">{error}</p>}
    </section>
  );
}
