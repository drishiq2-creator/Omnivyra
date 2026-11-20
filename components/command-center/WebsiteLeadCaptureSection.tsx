/**
 * "Website & lead capture": the bottom section of the Command Center (owner request 2026-11-20, via b3).
 * It replaces the header's former "Web & Capture" menu. Company ADMINS only; non-admins don't see admin-only
 * setup. Every link goes to the same route the menu used (lib/nav/websiteLeadCapture.ts), so old deep links still
 * resolve.
 */
import React from 'react';
import Link from 'next/link';
import { WEBSITE_LEAD_CAPTURE_LINKS, isCompanyAdminRole } from '../../lib/nav/websiteLeadCapture';

export default function WebsiteLeadCaptureSection({ userRole }: { userRole: string | null | undefined }) {
  if (!isCompanyAdminRole(userRole)) return null;
  return (
    <section aria-labelledby="website-lead-capture-heading" data-testid="website-lead-capture-section">
      <div className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Integrations</p>
        <h2 id="website-lead-capture-heading" className="mt-1 text-xl font-semibold text-slate-950">Website &amp; lead capture</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {WEBSITE_LEAD_CAPTURE_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-sky-300 hover:bg-sky-50/40"
          >
            <div className="text-sm font-semibold text-slate-900">{link.label}</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">{link.description}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}
