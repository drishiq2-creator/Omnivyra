import React from 'react';
import { RETRY_LABEL } from '../lib/extApis/accessLoadCopy';

/** A failed read on /external-apis-access: says so and re-reads on Retry (never an empty list). */
export default function ExtApisLoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <span>{message}</span>
      <button
        type="button"
        onClick={() => onRetry()}
        className="rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
      >
        {RETRY_LABEL}
      </button>
    </div>
  );
}
