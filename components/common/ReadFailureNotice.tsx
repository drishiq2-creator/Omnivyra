import React from 'react';

/**
 * A read that failed, said as a failure with a Retry that re-reads (b3 rule 1, 2026-11-20). Never render an empty
 * list or a zero in its place. `onRetry` must perform the read again, not just re-render.
 */
export default function ReadFailureNotice({ message, onRetry }: { message: string; onRetry: () => unknown }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <span>{message}</span>
      <button
        type="button"
        onClick={() => { void onRetry(); }}
        className="rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
      >
        Retry
      </button>
    </div>
  );
}
