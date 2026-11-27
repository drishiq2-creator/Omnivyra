/**
 * Round 30 / P0-1: the Sales Navigator page while extraction is legally stopped (gate reason `legal_not_cleared`).
 *
 * Honest about three things, and promises nothing else:
 *   1. Omnivyra does not read, extract or sync leads from Sales Navigator right now (the legal stop, round 9).
 *   2. The supported route is the customer's OWN data, imported as a file through the existing import wizard
 *      (`/prospects/import`), which runs the canonical Prospect Intelligence pipeline.
 *   3. There is no direct CRM connection yet, so a CRM is mentioned only as the place a file export comes from.
 *
 * No acknowledgement, no list input and no Extract are rendered in this state - not hidden behind a flag, absent.
 * The import link is shown only when the import page exists in this build (`isProspectImportUiEnabled`); otherwise
 * the page says the import is not switched on yet rather than linking to a page that would answer 404.
 */
import React from 'react';
import Link from 'next/link';
import { isProspectImportUiEnabled } from '@/lib/prospects/import/prospectImportUi';

export default function SalesNavStoppedState({ importEnabled = isProspectImportUiEnabled() }: { importEnabled?: boolean }) {
  return (
    <div className="space-y-6" data-testid="salesnav-stopped">
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
        <h2 className="text-base font-semibold text-amber-900">Direct Sales Navigator extraction is not available</h2>
        <p className="mt-2 text-sm text-amber-900">
          Omnivyra does not currently read, extract or sync leads from LinkedIn Sales Navigator, including saved
          leads, lead lists and searches. This is switched off while LinkedIn&apos;s terms are under legal review,
          and there is no date for it to return.
        </p>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" data-testid="salesnav-import-path">
        <h2 className="text-base font-semibold text-gray-900">Bring your own prospect data</h2>
        <p className="mt-2 text-sm text-gray-700">
          If your organisation already holds prospect data, for example contacts exported from your CRM or a
          spreadsheet your team maintains, you can import it as a CSV file. You choose what each column means and
          see a preview before anything is created. Re-importing a row with the same reference (or, without one, the
          same email and phone) updates that prospect instead of adding it again, and possible duplicate people are
          flagged for your review rather than merged.
        </p>
        <p className="mt-2 text-sm text-gray-700">
          Only import data your organisation is entitled to use.
        </p>
        {importEnabled ? (
          <Link
            href="/prospects/import"
            className="mt-4 inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-700"
          >
            Import prospects from a file
          </Link>
        ) : (
          <p className="mt-4 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600" data-testid="salesnav-import-off">
            File import is not switched on for this workspace yet. Ask your Omnivyra administrator to enable it.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-700">
        <h2 className="text-base font-semibold text-gray-900">Using a CRM?</h2>
        <p className="mt-2">
          Omnivyra does not connect to your CRM directly yet. Export the contacts you want from your CRM as a CSV
          file and import that file.
        </p>
      </section>
    </div>
  );
}
