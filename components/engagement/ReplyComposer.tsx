/**
 * ReplyComposer — compose and send replies.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import ChatVoiceButton from '../ChatVoiceButton';
import { recordEngagementEvent } from '@/lib/engagementTelemetry';
import { resolveEngagementCapability } from '@/lib/engagementCapabilities';
import { isDmMessageType } from '@/lib/engagement/messageRoles';
import {
  ReplyKeyHolder,
  classifyReplySendResponse,
  isUnknownOutcomeError,
  REPLY_STATUS_UNKNOWN_MESSAGE,
} from '@/lib/engagement/replySendOutcome';

export interface ReplyComposerProps {
  threadId: string;
  messageId: string;
  platform: string;
  organizationId: string;
  /** The target message's type — drives capability lookup ('dm' vs 'reply'). */
  messageType?: string | null;
  value?: string;
  onChange?: (value: string) => void;
  onReplySent?: () => void;
  onExecuteReply?: (input: {
    threadId: string;
    messageId: string;
    platform: string;
    replyText: string;
    messageType?: string | null;
    /**
     * E3: the stable key of this logical reply (same target + same draft →
     * same key on every retry). Executors that POST /api/engagement/reply
     * should forward it as `client_reply_key`.
     */
    clientReplyKey?: string;
  }) => Promise<{ mode?: string; platform?: string; message?: string } | void>;
  onRequestSuggestions?: () => void;
  disabled?: boolean;
  className?: string;
}

export const ReplyComposer = React.memo(function ReplyComposer({
  threadId,
  messageId,
  platform,
  organizationId,
  messageType,
  value: controlledValue,
  onChange,
  onReplySent,
  onExecuteReply,
  onRequestSuggestions,
  disabled = false,
  className = '',
}: ReplyComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [internalValue, setInternalValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  /** E3: true when the last attempt may have reached the platform — the UI must not invite a blind resend. */
  const [statusUnknown, setStatusUnknown] = useState(false);
  // E3: one client key per composed reply; kept across retries (network error,
  // timeout, unknown outcome) and replaced only on success or a changed draft/target.
  const replyKeyRef = useRef<ReplyKeyHolder | null>(null);
  if (!replyKeyRef.current) replyKeyRef.current = new ReplyKeyHolder();

  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener('engagement:focus-reply', handler);
    return () => window.removeEventListener('engagement:focus-reply', handler);
  }, []);

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const isControlled = controlledValue !== undefined;
  const text = isControlled ? controlledValue : internalValue;
  const setText = isControlled ? (onChange ?? (() => {})) : setInternalValue;

  // For DMs the capability key is 'dm', not 'reply' — they have separate
  // matrix entries and different dispatch modes (browser vs api).
  const isDmMessage = isDmMessageType(messageType);
  const capabilityAction = isDmMessage ? 'dm' : 'reply';
  const capability = useMemo(
    () => resolveEngagementCapability(platform, capabilityAction),
    [platform, capabilityAction],
  );
  const unsupportedReason =
    capability.status === 'api_verified'
      ? null
      : capability.reason ?? `${capabilityAction === 'dm' ? 'DM' : 'Reply'} is not supported on this platform.`;

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    if (unsupportedReason) {
      setError(unsupportedReason);
      return;
    }

    setSending(true);
    setError(null);
    setStatusUnknown(false);
    setSuccessMessage(null);

    const clientReplyKey = replyKeyRef.current!.keyFor({ threadId, messageId, platform, text: trimmed });

    try {
      let executionMessage: string | null = null;

      if (onExecuteReply) {
        const executionResult = await onExecuteReply({
          threadId,
          messageId,
          platform,
          replyText: trimmed,
          messageType,
          clientReplyKey,
        });
        if (
          executionResult
          && typeof executionResult === 'object'
          && ['browser_failed', 'browser_unverified', 'browser_queued', 'browser_pending'].includes(String(executionResult.mode || ''))
        ) {
          throw new Error(executionResult.message || 'Browser delivery was not confirmed.');
        }
        if (executionResult && typeof executionResult === 'object' && executionResult.message) {
          executionMessage = executionResult.message;
        }
      } else {
        let res: Response;
        try {
          res = await fetch('/api/engagement/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              organization_id: organizationId,
              thread_id: threadId,
              message_id: messageId,
              reply_text: trimmed,
              platform,
              client_reply_key: clientReplyKey,
            }),
          });
        } catch {
          // No response: the server may have sent it. Keep the key; never say "try again".
          setStatusUnknown(true);
          setError(REPLY_STATUS_UNKNOWN_MESSAGE);
          return;
        }

        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const outcome = classifyReplySendResponse({ httpStatus: res.status, json, platform });
        if (outcome.kind === 'unknown') {
          setStatusUnknown(true);
          setError(outcome.message);
          return;
        }
        if (outcome.kind === 'not_sent') {
          throw new Error(outcome.message);
        }
        // Three visible states: confirmed (platform id), sent (no id to verify
        // against), already sent (a retry of a reply the platform already has).
        // We never say "confirmed" without a platform_id.
        executionMessage = outcome.message;
      }

      replyKeyRef.current!.reset();
      setText('');
      if (!isControlled) setInternalValue('');
      void recordEngagementEvent('reply_sent', {
        organization_id: organizationId,
        thread_id: threadId,
        metadata: { platform },
      });
      setSuccessMessage(executionMessage || 'Reply confirmed by the platform.');
      onReplySent?.();
    } catch (err) {
      if (isUnknownOutcomeError(err)) {
        setStatusUnknown(true);
        const message = err instanceof Error ? err.message : '';
        const isNetworkLevel = !message || (err instanceof Error && (err.name === 'TypeError' || err.name === 'AbortError' || err.name === 'TimeoutError'));
        // A server message that already says "Sending status unknown" is shown as is; any other
        // unknown-class message is prefixed so the first words never invite a blind resend.
        setError(
          isNetworkLevel
            ? REPLY_STATUS_UNKNOWN_MESSAGE
            : /^Sending status unknown/i.test(message) ? message : `${REPLY_STATUS_UNKNOWN_MESSAGE} ${message}`,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Failed to send reply');
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, disabled, unsupportedReason, onExecuteReply, threadId, messageId, platform, organizationId, messageType, isControlled, setText, onReplySent]);

  const composerDisabled = disabled || Boolean(unsupportedReason);

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={unsupportedReason ? 'Replies are not available for this platform.' : 'Write a reply...'}
          rows={3}
          disabled={composerDisabled}
          className="flex-1 rounded border border-slate-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
        />
        <ChatVoiceButton
          onTranscription={(t) => setText(text.trim() ? `${text.trim()} ${t}` : t)}
          disabled={composerDisabled}
          title="Speak your reply"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div>
          <button
            type="button"
            onClick={onRequestSuggestions}
            disabled={composerDisabled}
            className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            AI suggestions
          </button>
        </div>
        <button
          type="button"
          onClick={handleSend}
          disabled={composerDisabled || !text.trim() || sending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {unsupportedReason && (
        <p className="text-xs text-slate-500" role="note">
          {unsupportedReason}
        </p>
      )}
      {error && (
        <p className={`text-sm ${statusUnknown ? 'text-amber-700' : 'text-red-600'}`} role="alert" data-status-unknown={statusUnknown ? 'true' : undefined}>
          {error}
        </p>
      )}
      {successMessage && !error && (
        <p className="text-sm text-emerald-700" role="status">
          {successMessage}
        </p>
      )}
    </div>
  );
});
