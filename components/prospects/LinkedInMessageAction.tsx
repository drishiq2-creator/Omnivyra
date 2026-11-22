/**
 * "Message on LinkedIn" on a lead in Prospects (owner-approved 2026-11-22).
 *
 * The user writes a message; it becomes ONE pending action in the existing approved-actions workflow
 * (/community-ai/actions). Nothing is sent from here. After a person approves it, it is sent only by the requesting
 * user's own Omnivyra Sales Navigator extension, only if the lead is a first-degree connection (never InMail).
 * Every refusal is shown in plain words; a failed read is never shown as "no profile" or "not linked".
 */
import React, { useState } from 'react';

const MAX = 8000;

const MESSAGES: Record<string, string> = {
  NO_LINKEDIN_PROFILE: 'This lead has no LinkedIn profile link from Sales Navigator, so a message cannot be addressed.',
  LINKEDIN_PROFILE_AMBIGUOUS: 'This lead has more than one LinkedIn profile link, so the recipient is not certain. Nothing was queued.',
  SALESNAV_ACCOUNT_NOT_LINKED: 'Link your LinkedIn account in the Omnivyra Sales Navigator extension first. Messages are sent only from your own account.',
  MESSAGE_ALREADY_PENDING: 'You already have a message to this lead waiting for approval or sending.',
  MESSAGE_REQUIRED: 'Write a message first.',
  MESSAGE_TOO_LONG: `Messages can be at most ${MAX} characters.`,
  SENDER_NOT_A_MEMBER: 'Only a member of this company can send from their own LinkedIn account.',
  PROSPECT_NOT_FOUND: 'This lead could not be found in this company.',
};

export default function LinkedInMessageAction({ companyId, prospectId }: { companyId: string; prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/prospects/${encodeURIComponent(prospectId)}/linkedin-message?companyId=${encodeURIComponent(companyId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 201) {
        setResult({ ok: true, message: 'Queued for approval. It will be sent only after it is approved in Community AI actions, from your own Sales Navigator extension, and only if this lead is a first-degree connection.' });
        setText('');
      } else if (res.status === 503) {
        setResult({ ok: false, message: "We couldn't check everything needed to queue this message right now. Nothing was queued; please try again." });
      } else {
        setResult({ ok: false, message: (json.error && MESSAGES[json.error]) || `The message was not queued (${json.error || res.status}).` });
      }
    } catch {
      setResult({ ok: false, message: "We couldn't reach Omnivyra. If you are unsure whether it was queued, check Community AI actions before trying again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" data-testid="linkedin-message">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} disabled={!companyId || !prospectId}
          className="rounded-lg border border-purple-600 px-3 py-1.5 text-sm text-purple-700">
          Message on LinkedIn
        </button>
      ) : (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Message on LinkedIn</h2>
          <p className="text-xs text-gray-600">
            A new LinkedIn message to this lead, from your own LinkedIn account. It waits for approval, then your
            Sales Navigator extension sends it once - only if this lead is a first-degree connection. No InMail.
          </p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX} rows={5}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" aria-label="LinkedIn message" />
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !text.trim()} onClick={() => { void submit(); }}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {busy ? 'Queuing…' : 'Queue for approval'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setResult(null); }} className="text-sm text-gray-600">Close</button>
            <span className="ml-auto text-xs text-gray-500">{text.length}/{MAX}</span>
          </div>
          {result && <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'text-sm text-green-700' : 'text-sm text-red-700'}>{result.message}</p>}
        </div>
      )}
    </section>
  );
}
