/**
 * Super-admin Outreach operator (a9, 2026-11-20; owner: build the outreach engines).
 *
 * Drives the two EXISTING operator routes, in their documented order (Audit §2 "Outbound approval" / "Email send";
 * Execution Register OUT-02):
 *   1. Preview   POST /api/super-admin/outreach/activate { previewOnly: true }  - nothing written, nothing sent.
 *   2. Activate  POST /api/super-admin/outreach/activate                        - materialises the lead's plan into
 *                tasks and dispatches ONLY tasks already approved (none, the first time).
 *   3. Approve   POST /api/super-admin/outreach/approve { taskId, reason }      - one task, a reason is required; the
 *                approver is the authenticated principal (the route never reads it from the body).
 *   4. Activate again - dispatches what was approved.
 * Both routes require OUTREACH_PLATFORM_MANAGE with passkey step-up; this screen runs the existing step-up helper
 * (runStepUpFlowIfNeeded) and retries the identical request once.
 *
 * EMAIL IS GATED, not this screen: the email channel is offered only when the activate response says
 * emailEnabled === true (LEAD_OUTREACH_EMAIL_ENABLED, default OFF; the transport itself refuses every send while
 * it is off - backend/services/leadOutreachExecution/emailTransport.ts). Until a response has been read the switch is
 * shown as UNKNOWN and email is not offered. Internal (contacts nobody) is the default channel.
 */
import React, { useState } from 'react';
import { fetchWithAuth } from '../../community-ai/fetchWithAuth';
import { runStepUpFlowIfNeeded, describeStepUpOutcome, type StepUpOutcome } from '@/lib/security/superAdminStepUp';
import { describeAuthFailure } from '@/lib/security/superAdminAuthFailure';

type TaskRow = {
  taskId: string;
  channel: string | null;
  status: string;
  action: 'dispatched' | 'not_approved' | 'channel_not_permitted' | 'no_transport' | 'terminal';
  outcome?: string;
  reason?: string;
  governance?: string;
};
type Report = {
  planPresent: boolean;
  planGeneratedAt: string | null;
  permittedChannels: string[];
  registeredChannels: string[];
  materialization: unknown;
  tasks: TaskRow[];
  dispatched: number;
  blocked?: string;
};
/** The email switch as last reported by the server. 'unknown' until a response has been read. */
export type EmailSwitch = 'on' | 'off' | 'unknown';

export function emailSwitchFrom(body: unknown): EmailSwitch {
  const v = (body as { emailEnabled?: unknown } | null)?.emailEnabled;
  return v === true ? 'on' : v === false ? 'off' : 'unknown';
}

const ACTION_LABEL: Record<TaskRow['action'], string> = {
  dispatched: 'Sent / handed to its channel',
  not_approved: 'Waiting for approval',
  channel_not_permitted: 'Channel not permitted in this run',
  no_transport: 'No transport registered for this channel',
  terminal: 'Already finished',
};

export default function OutreachOperatorTab() {
  const [companyId, setCompanyId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [useEmail, setUseEmail] = useState(false);
  const [emailSwitch, setEmailSwitch] = useState<EmailSwitch>('unknown');
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const describeStepUpFailure = (outcome: StepUpOutcome): string =>
    outcome.kind === 'session_lost' || outcome.kind === 'auth_banner'
      ? describeAuthFailure(outcome.failure)
      : describeStepUpOutcome(outcome);

  /** POST with step-up; returns the parsed body or null (error already shown). */
  const post = async (url: string, body: Record<string, unknown>, label: string): Promise<any | null> => {
    setError(null);
    const fire = () => fetchWithAuth(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const initial = await fire();
    const outcome = await runStepUpFlowIfNeeded(initial, fire, { onChallengeStart: () => setMessage(`Confirm with your passkey to ${label}…`) });
    setMessage(null);
    if (outcome.kind !== 'success') { setError(describeStepUpFailure(outcome)); return null; }
    const json = await outcome.response.json().catch(() => null);
    if (!outcome.response.ok) {
      setError((json && (json.error || json.code)) ? `${json.code ? json.code + ': ' : ''}${json.error ?? ''}` : `Request failed (${outcome.response.status})`);
      return null;
    }
    return json;
  };

  const channels = (): string[] => (useEmail && emailSwitch === 'on' ? ['internal', 'email'] : ['internal']);

  const activate = async (previewOnly: boolean) => {
    if (!companyId.trim() || !leadId.trim()) { setError('Company id and lead id are required.'); return; }
    setBusy(previewOnly ? 'preview' : 'activate');
    try {
      const json = await post('/api/super-admin/outreach/activate', { companyId: companyId.trim(), leadId: leadId.trim(), channels: channels(), previewOnly }, previewOnly ? 'preview outreach' : 'activate outreach');
      if (!json) return;
      setEmailSwitch(emailSwitchFrom(json));
      if (emailSwitchFrom(json) !== 'on') setUseEmail(false);
      setReport(json.report as Report);
    } finally { setBusy(null); }
  };

  const approve = async (taskId: string) => {
    const reason = (reasons[taskId] ?? '').trim();
    if (!reason) { setError('A reason is required to approve a task.'); return; }
    setBusy(`approve:${taskId}`);
    try {
      const json = await post('/api/super-admin/outreach/approve', { companyId: companyId.trim(), taskId, reason }, 'approve this task');
      if (!json) return;
      setMessage('Approved. Run "Activate" again to send approved tasks.');
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6" data-testid="outreach-operator">
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <h2 className="text-lg font-semibold text-slate-900">Outreach operator</h2>
        <p className="text-sm text-slate-600 mt-1">
          Preview a lead&apos;s outreach plan, create its tasks, approve them one by one, then send what was approved.
          Nothing is sent without an approval.
        </p>
        <p className="text-sm mt-2" data-testid="email-switch">
          Email sending:{' '}
          {emailSwitch === 'on' && <span className="font-medium text-green-700">ON</span>}
          {emailSwitch === 'off' && <span className="font-medium text-slate-700">OFF (internal tasks only)</span>}
          {emailSwitch === 'unknown' && <span className="font-medium text-slate-500">not known yet - run Preview</span>}
        </p>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm">Company id
          <input aria-label="Company id" className="mt-1 w-full border rounded px-2 py-1" value={companyId} onChange={(e) => setCompanyId(e.target.value)} />
        </label>
        <label className="text-sm">Lead id
          <input aria-label="Lead id" className="mt-1 w-full border rounded px-2 py-1" value={leadId} onChange={(e) => setLeadId(e.target.value)} />
        </label>
        <label className="text-sm flex items-center gap-2 md:col-span-2">
          <input
            type="checkbox"
            aria-label="Include email"
            checked={useEmail && emailSwitch === 'on'}
            disabled={emailSwitch !== 'on'}
            onChange={(e) => setUseEmail(e.target.checked)}
          />
          Include email {emailSwitch !== 'on' && <span className="text-slate-500">(available only when email sending is ON)</span>}
        </label>
        <div className="flex gap-2 md:col-span-2">
          <button type="button" className="px-3 py-1.5 rounded border" disabled={busy !== null} onClick={() => activate(true)}>Preview</button>
          <button type="button" className="px-3 py-1.5 rounded bg-indigo-600 text-white" disabled={busy !== null} onClick={() => activate(false)}>Activate</button>
        </div>
      </div>

      {message && <div role="status" className="text-sm text-indigo-700">{message}</div>}
      {error && <div role="alert" className="text-sm text-red-700">{error}</div>}

      {report && (
        <div className="bg-white rounded-lg border border-slate-200 p-4" data-testid="outreach-report">
          {!report.planPresent && <p className="text-sm text-slate-700">No outreach plan exists for this lead yet.</p>}
          {report.blocked && <p className="text-sm text-amber-700">Not run: {report.blocked}</p>}
          <p className="text-sm text-slate-600">Channels this run: {report.permittedChannels.join(', ') || 'none'} - sent: {report.dispatched}</p>
          {report.tasks.length > 0 && (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="text-left text-slate-500"><th>Task</th><th>Channel</th><th>State</th><th>Detail</th><th /></tr></thead>
              <tbody>
                {report.tasks.map((t) => (
                  <tr key={t.taskId} className="border-t" data-testid={`task-${t.taskId}`}>
                    <td className="py-1 font-mono text-xs">{t.taskId}</td>
                    <td>{t.channel ?? 'unknown'}</td>
                    <td>{ACTION_LABEL[t.action] ?? `Unknown state (${String(t.action)})`}</td>
                    <td className="text-slate-600">{t.reason ?? t.outcome ?? t.governance ?? ''}</td>
                    <td>
                      {t.action === 'not_approved' && (
                        <span className="flex gap-1">
                          <input aria-label={`Reason for ${t.taskId}`} className="border rounded px-1" placeholder="Reason" value={reasons[t.taskId] ?? ''} onChange={(e) => setReasons({ ...reasons, [t.taskId]: e.target.value })} />
                          <button type="button" className="px-2 rounded border" disabled={busy !== null} onClick={() => approve(t.taskId)}>Approve</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
