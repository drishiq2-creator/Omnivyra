/**
 * Admin-only pages (owner ruling 2026-11-20, via b3): the website & lead-capture pages are for company admins.
 *
 * The SERVER decides: useCompanyAdminAccess asks GET /api/company-admin/access, which runs the same gate
 * (backend/services/companyAdminGate.requireCompanyAdmin) as every API behind these pages. The client never infers
 * admin-ness from its own role state, which cannot tell "not loaded yet" from "no role".
 *
 * Four outcomes, each rendered honestly (Rule 1: a failed check is never shown as "not allowed", nor as the page):
 *   admin       → the page
 *   not_admin   → "Only company admins can manage this"
 *   unavailable → "We couldn't check your access" + Retry
 *   checking    → a neutral loading line
 * With no company selected there is nothing to check; the page renders its own "select a company" state, and its
 * APIs stay gated regardless.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useCompanyContext } from '../CompanyContext';
import { COMPANY_ADMIN_REQUIRED_MESSAGE, isCompanyAdminRequired } from '../../shared/auth/companyAdminRequired';

export const COMPANY_ADMIN_ACCESS_STATES = ['checking', 'admin', 'not_admin', 'unavailable', 'no_company'] as const;
export type CompanyAdminAccess = (typeof COMPANY_ADMIN_ACCESS_STATES)[number];

export const ACCESS_UNAVAILABLE_MESSAGE = "We couldn't check your access to this page.";

export function useCompanyAdminAccess(companyId: string): { access: CompanyAdminAccess; retry: () => void } {
  const [access, setAccess] = useState<CompanyAdminAccess>(companyId ? 'checking' : 'no_company');
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!companyId) { setAccess('no_company'); return; }
    const requestId = ++latest.current;
    setAccess('checking');
    (async () => {
      let next: CompanyAdminAccess = 'unavailable';
      try {
        const res = await fetch(`/api/company-admin/access?company_id=${encodeURIComponent(companyId)}`, { credentials: 'include' });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.admin === true) next = 'admin';
        else if (isCompanyAdminRequired(res.status, body)) next = 'not_admin';
        else next = 'unavailable'; // 401, a non-member 403, a 5xx, a malformed 200: not an answer about admin-ness
      } catch {
        next = 'unavailable';
      }
      if (requestId === latest.current) setAccess(next); // a company switch mid-flight never shows the old answer
    })();
  }, [companyId, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { access, retry };
}

export function CompanyAdminAccessNotice({
  access,
  onRetry,
  fallback = { label: 'Back to Command Center', href: '/command-center' },
}: {
  access: Exclude<CompanyAdminAccess, 'admin' | 'no_company'>;
  onRetry: () => void;
  fallback?: { label: string; href: string };
}) {
  if (access === 'checking') {
    return <div className="py-12 text-center text-sm text-gray-500" data-testid="company-admin-checking">Checking access…</div>;
  }
  if (access === 'unavailable') {
    return (
      <div role="alert" data-testid="company-admin-unavailable" className="mx-auto my-10 max-w-lg rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p className="font-semibold">{ACCESS_UNAVAILABLE_MESSAGE}</p>
        <button type="button" onClick={onRetry} className="mt-3 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100">
          Retry
        </button>
      </div>
    );
  }
  return (
    <div data-testid="company-admin-required" className="mx-auto my-10 max-w-lg rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700 shadow-sm">
      <p className="text-base font-semibold text-slate-900">{COMPANY_ADMIN_REQUIRED_MESSAGE}</p>
      <p className="mt-1 text-slate-500">Ask a company admin if something here needs to change.</p>
      <Link href={fallback.href} className="mt-4 inline-block font-semibold text-indigo-600 hover:text-indigo-700">
        {fallback.label}
      </Link>
    </div>
  );
}

export default function CompanyAdminOnly({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: { label: string; href: string };
}) {
  const { selectedCompanyId } = useCompanyContext();
  const { access, retry } = useCompanyAdminAccess(selectedCompanyId || '');
  if (access === 'admin' || access === 'no_company') return <>{children}</>;
  return <CompanyAdminAccessNotice access={access} onRetry={retry} fallback={fallback} />;
}
