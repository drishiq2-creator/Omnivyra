/**
 * `/prospects/salesnav` - Sales Navigator Extract (the owner's flow: paste a Sales Navigator list/search URL in
 * Omnivyra, Extract, the extension navigates). A route shell around `SalesNavExtract`, following
 * pages/prospects/import.tsx: the page owns the title, the chrome and the tenant, and fetches nothing itself.
 * `companyId` comes from CompanyContext; every route re-validates it against live membership (requireTenantAccess).
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { useCompanyContext } from '@/components/CompanyContext';
import SalesNavExtract from '@/components/prospects/salesnav/SalesNavExtract';
import { isSalesNavUiEnabled } from '@/lib/prospects/salesnav/salesNavUi';

/** Default OFF: the page does not exist until NEXT_PUBLIC_SALESNAV_UI_ENABLED=true. */
export const getServerSideProps: GetServerSideProps = async () =>
  (isSalesNavUiEnabled() ? { props: {} } : { notFound: true });

export default function SalesNavExtractPage() {
  const { selectedCompanyId } = useCompanyContext();
  return (
    <>
      <Head><title>Sales Navigator | Omnivyra</title></Head>
      <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <header className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-600">Prospects</p>
            {/* Round 30 / P0-1: a neutral header. What is (and is not) available is said by the component below, from
                the server's gate - this header never claims Omnivyra reads Sales Navigator. */}
            <h1 className="mt-2 text-2xl font-bold text-gray-900">Sales Navigator</h1>
            <Link href="/prospects" className="mt-3 inline-block text-xs font-medium text-purple-600 hover:underline">← Prospects</Link>
          </header>
          {!selectedCompanyId ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
              Select a company first.
            </div>
          ) : (
            <SalesNavExtract key={selectedCompanyId} companyId={selectedCompanyId} />
          )}
        </div>
      </main>
    </>
  );
}
