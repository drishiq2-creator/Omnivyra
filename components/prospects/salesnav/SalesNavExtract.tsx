/**
 * Sales Navigator - Extract (the web half of the owner's flow: "paste a Sales Navigator list/search URL in Omnivyra,
 * Extract, the extension navigates"). One screen, four states, each read from the server, never assumed:
 *   1. the route's GATE (shown honestly when closed, with what is missing);
 *   2. the LinkedIn-restriction ACKNOWLEDGEMENT - the user reads the exact text and accepts it HERE (only ever from
 *      this browser session);
 *   3. the CONNECTION - the Omnivyra extension binds the user's logged-in LinkedIn account; this page only reports it;
 *   4. the RUN - paste a URL, Extract, then a live status (polled) with Cancel / Resume.
 * Anything the page could not read is shown as "couldn't check", never as "not accepted" / "not connected".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptSalesNavRestriction, cancelSalesNavRun, getSalesNavRun, getSalesNavSetup, resumeSalesNavRun,
  SalesNavApiError, startSalesNavRun, type SalesNavRunView, type SalesNavSetup,
} from './salesNavClient';

const POLL_MS = 5000;

/** Plain words for the gate's closed reasons (reason strings from backend/services/salesNav/gate.ts). */
export function gateMessage(reason: string): string {
  if (reason === 'legal_not_cleared') return 'Sales Navigator extraction is not yet enabled for this route. Omnivyra enables it after its legal review.';
  if (reason.startsWith('tenant_flag_off')) return 'Sales Navigator extraction is not switched on for your company yet.';
  if (reason.startsWith('flag_unreadable') || reason === 'ack_unreadable') return "We couldn't check whether extraction is enabled right now. Please try again.";
  if (reason === 'ack_missing') return 'Please read and accept the LinkedIn notice below to continue.';
  if (reason === 'ack_text_changed') return 'The LinkedIn notice has changed. Please read and accept it again.';
  return 'Sales Navigator extraction is not available right now.';
}

/** What a run's status means to the user (statuses / codes: the shared contract's closed sets). */
export function runMessage(run: Pick<SalesNavRunView, 'status' | 'code'>): string {
  switch (run.status) {
    case 'running': return 'Reading your list. Keep Chrome open with the Omnivyra extension signed in.';
    case 'queued': return 'Starting…';
    case 'paused_daily_cap': return "Paused for today's limit. It continues after midnight (UTC) - press Resume then.";
    case 'auth_expired': return 'LinkedIn signed you out (or asked for a check). Sign in to LinkedIn in Chrome, then press Resume.';
    case 'completed': return run.code === 'empty_first_page' ? 'Done - the list was empty.' : 'Done - the whole list was read.';
    case 'cancelled': return 'Cancelled.';
    case 'rate_limited': return 'Stopped: LinkedIn asked us to slow down. Nothing more was read; try again later.';
    case 'refused':
      if (run.code === 'reader_version_unsupported') return 'Stopped: please update the Omnivyra extension, then start again.';
      if (run.code === 'member_mismatch') return 'Stopped: a different LinkedIn account is signed in than the one connected.';
      if (run.code === 'url_not_allowed') return 'Stopped: LinkedIn redirected away from the list.';
      return 'Stopped: extraction is not enabled for your company right now.';
    case 'unknown': return run.code === 'run_stale'
      ? 'Stalled: no page arrived for three minutes. Is Chrome open with the extension signed in?'
      : 'Stopped: we could not confirm a page was read correctly, so nothing further was imported.';
    default: return 'Stopped: something went wrong while reading.';
  }
}

const OPEN = new Set(['running', 'queued', 'paused_daily_cap', 'auth_expired']);
const RESUMABLE = new Set(['paused_daily_cap', 'auth_expired']);

export default function SalesNavExtract({ companyId }: { companyId: string }) {
  const [setup, setSetup] = useState<SalesNavSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [url, setUrl] = useState('');
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<SalesNavRunView | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSetup = useCallback(async () => {
    setSetupError(null);
    try { setSetup(await getSalesNavSetup(companyId)); }
    catch { setSetup(null); setSetupError("We couldn't load Sales Navigator settings. Please try again."); }
  }, [companyId]);

  useEffect(() => { void loadSetup(); }, [loadSetup]);

  const pollRun = useCallback(async (id: string) => {
    try { setRun(await getSalesNavRun(companyId, id)); setRunError(null); }
    catch { setRunError("We couldn't refresh the run status. Retrying…"); }
  }, [companyId]);

  useEffect(() => {
    if (!runId) return undefined;
    void pollRun(runId);
    timer.current = setInterval(() => { void pollRun(runId); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [runId, pollRun]);

  useEffect(() => {                                   // stop polling once the run has ended
    if (run && !OPEN.has(run.status) && timer.current) { clearInterval(timer.current); timer.current = null; }
  }, [run]);

  async function accept() {
    if (!setup) return;
    setAccepting(true);
    try {
      await acceptSalesNavRestriction(companyId, { version: setup.ack.version, textSha256: setup.ack.textSha256 });
      await loadSetup();
    } catch (e) {
      setSetupError(e instanceof SalesNavApiError && e.code === 'ACK_TEXT_STALE'
        ? 'The notice changed while you were reading it. Please read the new text.'
        : "We couldn't record your acceptance. Please try again.");
      await loadSetup();
    } finally { setAccepting(false); setAgreed(false); }
  }

  async function start() {
    setStartError(null); setStarting(true);
    try {
      const r = await startSalesNavRun(companyId, url.trim());
      setRun(null); setRunId(r.runId);
    } catch (e) {
      const code = e instanceof SalesNavApiError ? e.code : null;
      setStartError(
        code === 'URL_REFUSED' ? 'That is not a Sales Navigator people search, saved search or lead list link.'
          : code === 'MEMBER_UNRESOLVED' ? 'Connect your LinkedIn account first: open LinkedIn in Chrome with the Omnivyra extension signed in.'
            : code === 'RUN_ALREADY_OPEN' ? 'A Sales Navigator run is already open for your LinkedIn account. Finish or cancel it first.'
              : code === 'GATE_CLOSED' ? gateMessage(String((e as SalesNavApiError).detail.reason ?? ''))
                : "We couldn't start the run. Please try again.");
      if (code === 'GATE_CLOSED') await loadSetup();
    } finally { setStarting(false); }
  }

  async function act(kind: 'cancel' | 'resume') {
    if (!runId) return;
    try {
      if (kind === 'cancel') await cancelSalesNavRun(companyId, runId); else await resumeSalesNavRun(companyId, runId);
      if (kind === 'resume' && !timer.current) timer.current = setInterval(() => { void pollRun(runId); }, POLL_MS);
      await pollRun(runId);
    } catch { setRunError(kind === 'cancel' ? "We couldn't cancel the run. Please try again." : "We couldn't resume the run yet."); }
  }

  if (setupError && !setup) {
    return <section className="rounded-2xl border border-red-200 bg-white p-6 text-sm text-red-700" role="alert">{setupError}</section>;
  }
  if (!setup) return <section className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-500">Loading…</section>;

  const needsAck = setup.acked !== true;
  return (
    <div className="space-y-6">
      {setupError && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="alert">{setupError}</div>}

      {!setup.gate.allowed && !needsAck && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-700" data-testid="gate-closed">
          {gateMessage(setup.gate.reason)}
        </section>
      )}

      {needsAck && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" data-testid="ack-panel">
          <h2 className="text-base font-semibold text-gray-900">Before you extract from Sales Navigator</h2>
          {setup.acked === null
            ? <p className="mt-2 text-sm text-amber-700" role="alert">We couldn't check whether you've already accepted this notice. Please try again.</p>
            : (
              <>
                <p className="mt-3 whitespace-pre-line text-sm text-gray-700" data-testid="ack-text">{setup.ack.text}</p>
                <label className="mt-4 flex items-center gap-2 text-sm text-gray-800">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  I have read this and accept it for my company.
                </label>
                <button type="button" disabled={!agreed || accepting} onClick={() => { void accept(); }}
                  className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {accepting ? 'Saving…' : 'Accept'}
                </button>
              </>
            )}
        </section>
      )}

      {!needsAck && setup.gate.allowed && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <p className="text-sm text-gray-700" data-testid="connection">
            {setup.bound === true ? 'Your LinkedIn account is connected through the Omnivyra extension.'
              : setup.bound === null ? "We couldn't check your LinkedIn connection right now."
                : 'Connect your LinkedIn account: open LinkedIn in Chrome with the Omnivyra extension signed in.'}
          </p>
          <label className="block text-sm font-medium text-gray-800" htmlFor="salesnav-url">Sales Navigator list or search link</label>
          <input id="salesnav-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.linkedin.com/sales/lists/people/…" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button type="button" disabled={!url.trim() || starting} onClick={() => { void start(); }}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {starting ? 'Starting…' : 'Extract'}
          </button>
          {startError && <p className="text-sm text-red-700" role="alert">{startError}</p>}
        </section>
      )}

      {runId && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" data-testid="run-panel">
          {run ? (
            <>
              <p className="text-sm font-medium text-gray-900" data-testid="run-message">{runMessage(run)}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-700 sm:grid-cols-3">
                <div><dt className="text-gray-500">Pages read</dt><dd>{run.pagesRead}</dd></div>
                <div><dt className="text-gray-500">Added</dt><dd>{run.added}</dd></div>
                <div><dt className="text-gray-500">Updated</dt><dd>{run.updated}</dd></div>
                <div><dt className="text-gray-500">Skipped (already have)</dt><dd>{run.skippedAlreadyHave}</dd></div>
                <div><dt className="text-gray-500">Held for review</dt><dd>{run.heldForReview}</dd></div>
                <div><dt className="text-gray-500">Not checked / not imported</dt><dd>{run.dropped}</dd></div>
              </dl>
              <div className="mt-4 flex gap-2">
                {RESUMABLE.has(run.status) && (
                  <button type="button" onClick={() => { void act('resume'); }} className="rounded-lg border border-purple-600 px-3 py-1.5 text-sm text-purple-700">Resume</button>
                )}
                {OPEN.has(run.status) && (
                  <button type="button" onClick={() => { void act('cancel'); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700">Cancel</button>
                )}
              </div>
            </>
          ) : <p className="text-sm text-gray-500">Loading run…</p>}
          {runError && <p className="mt-2 text-sm text-amber-700" role="alert">{runError}</p>}
        </section>
      )}
    </div>
  );
}
