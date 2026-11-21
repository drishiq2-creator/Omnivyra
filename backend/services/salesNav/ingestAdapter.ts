/**
 * The Sales Navigator lead source adapter — PURE translation, like every other.
 *
 * LANDED FROM THE ORIGINAL (owner rule: land reviewed originals, name the rewrites). Source:
 * backend/services/salesNavCapture/adapter.ts @ 37759f971 (removed from the Apollo landing by a19ef5944, remainder
 * PL-170), with checkLeadKey / salesNavCompanyId / text from salesNavCapture/providers.ts and
 * registerSalesNavLeadSource from salesNavCapture/service.ts at the same commit. translateSalesNavLead, the three
 * helpers, the adapter object and registerSalesNavLeadSource are VERBATIM.
 * REWRITTEN HUNKS (named):
 *   R1 toRawEvidence / toBatchRecord take the shared contract v2.2 `SalesNavLead` (snake_case wire shape) plus the
 *      transport, instead of the capture contract's `CapturedSavedLead`. Field correspondence: leadKey -> lead_key,
 *      profileUrl -> public_profile_url, fullName -> full_name, company.name -> company_name,
 *      company.salesNavUrn -> account_external_id, company.linkedinUrl -> company_linkedin_url,
 *      capturedAt -> captured_at. The RAW EVIDENCE KEYS are unchanged, so evidence hashes match the original.
 *   R2 imports: SALESNAV_SOURCE from ./contract (the shared contract), not the capture contract.
 *   R3 fromWire (providers.ts) returns a SalesNavLead; its validation body (lead_key, raw-URN containment, captured /
 *      capturedUrl per field, bounds) is the original's. captured and capturedUrl are VERBATIM (review F1 / NEW 1:
 *      evidence stored exactly as sent or not at all; a /sales/ app URL, which can carry an auth token, is never stored).
 * PL-170 REMAINDER (registered): the capture service, providers (snap / extension saved-leads) and captureSwitch are
 * NOT landed - the shared contract's store + routes replace them.
 *
 * Input is a `SalesNavLead` serialised as the raw record; output is the vendor-neutral `NormalizedIngestionRecord`.
 * No I/O, no identity decision, no write: the orchestrator does all of that, exactly as for CSV or Apollo.
 *
 * ─── IDENTITY ──────────────────────────────────────────────────────────────
 * `externalId` is `salesnav:<leadKey>` — the MEMBER, never the list, so a
 * person in two lists is one person (the simulator's rule, kept). The same key
 * goes into `externalKeys` under `linkedin_sales_navigator`, NOT under
 * `linkedin`: the Sales Navigator id is a different encoding from the core
 * LinkedIn member id, and putting it in the same namespace would let two
 * different numbering schemes collide.
 *
 * ─── WHAT IS DELIBERATELY NOT MAPPED ──────────────────────────────────────
 *  - email / phone: not on the page (owner decision P-3).
 *  - `company.linkedinUrl` is NEVER a website or domain. W4 normalises a website
 *    into a domain; `linkedin.com` would become the "domain" of every employer
 *    and merge them all into one account.
 *  - headline, location, profile URL: kept in the raw evidence only. Parsing a
 *    free-text location into a country code, or a headline into a title, would
 *    be invention; profile-URL identity claims are deferred (LI-5C Q-3).
 *
 * ─── RAW EVIDENCE IS LEAD-DESCRIBING ONLY ─────────────────────────────────
 * LI-2 hashes the whole raw payload for change detection. Per-capture fields
 * (capture time, page, list, the viewer's connection degree, saved-at) are
 * therefore NOT part of `raw`: if they were, every re-capture — or the same
 * lead seen in a second list — would register as "changed" evidence.
 * `capturedAt` travels as `observedAt` instead.
 */

import type { AdapterResult, LeadSourceAdapter, NormalizedIngestionRecord } from '../leadIngestion/contracts';
import { hasLeadSourceAdapter, registerLeadSourceAdapter } from '../leadIngestion/registry';
import { connectionDegreeOf, SALESNAV_SOURCE, type SalesNavLead, type SalesNavTransport } from './contract';

// -- verbatim from salesNavCapture/providers.ts @ 37759f971 ------------------------------------------------------
const LEAD_KEY_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export function text(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

export function checkLeadKey(v: unknown): { key: string } | { reason: string } {
  if (typeof v !== 'string' || !v.trim()) return { reason: 'missing_lead_key' };
  const k = v.trim();
  if (/urn:|[(),:]/i.test(k)) return { reason: 'lead_key_is_full_urn' };
  if (!LEAD_KEY_PATTERN.test(k)) return { reason: 'invalid_lead_key' };
  return { key: k };
}

export function salesNavCompanyId(v: unknown): string | null {
  const t = text(v, 200);
  if (!t) return null;
  const m = /^(?:urn:li:fs_salesCompany:)?(\d{1,20})$/.exec(t);
  return m ? m[1] : null;
}

/**
 * A captured evidence string, kept EXACTLY as sent: no trimming, no case
 * change, no URL rewriting (see `CapturedSavedLead`, review F1). Only absence,
 * blankness and oversize are refused, which are rejections, not transformations.
 */
export function captured(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null;
}

/**
 * A captured URL that is safe to STORE as evidence, kept verbatim, or null.
 *
 * Refusing is not rewriting (F1 holds): a URL is either stored exactly as sent
 * or not stored at all. Refused, because storing them would persist a secret or
 * a non-profile locator (review NEW 1):
 *  - credentials in the authority (`user:pass@`);
 *  - any Sales Navigator app URL (`/sales/...`): `/sales/lead/<id>,<authToken>`
 *    carries an auth token, and the boundary's redactor matches KEY names only,
 *    never values, so a token in a URL value would be stored durably;
 *  - anything that does not parse as an absolute http(s) URL.
 */
export function capturedUrl(v: unknown, max = 400): string | null {
  const c = captured(v, max);
  if (!c) return null;
  let u: URL;
  try { u = new URL(c.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (/^\/sales(\/|$)/i.test(u.pathname)) return null;
  return c;
}

// -- R3 (rewritten OUTPUT only): fromWire, from salesNavCapture/providers.ts @ 37759f971 --------------------------
// The validation body is the original's line for line (lead_key check, raw-URN containment, captured / capturedUrl
// per field, the same length bounds). Rewritten: it returns the shared contract's SalesNavLead (snake_case) instead
// of CapturedSavedLead, and connection_degree / saved_at (per-capture fields, never evidence) are carried through
// connectionDegreeOf / captured so the page counts can use them. EVERY lead from every route passes through here.
export function fromWire(
  w: unknown,
  capturedAt: string,
): { lead: SalesNavLead } | { reason: string } {
  if (!w || typeof w !== 'object') return { reason: 'lead_not_object' };
  const o = w as Record<string, unknown>;
  const checked = checkLeadKey(o.lead_key);
  if ('reason' in checked) return checked;
  const rawUrn = text(o.raw_urn, 400);
  // The raw URN is evidence the key was extracted from. If it is sent and does
  // not contain the key, the extraction is wrong — refuse rather than mint an
  // identity from a key nobody can trace.
  if (rawUrn && !rawUrn.includes(checked.key)) return { reason: 'lead_key_urn_mismatch' };

  const fullName = captured(o.full_name, 300);
  return {
    lead: {
      lead_key: checked.key,
      raw_urn: rawUrn,
      public_profile_url: capturedUrl(o.public_profile_url),
      full_name: fullName ?? '',
      headline: captured(o.headline, 500),
      title: captured(o.title, 300),
      company_name: captured(o.company_name, 300),
      account_external_id: captured(o.account_external_id ?? o.company_salesnav_urn, 200),
      company_linkedin_url: capturedUrl(o.company_linkedin_url),
      location: captured(o.location, 300),
      connection_degree: connectionDegreeOf(o.connection_degree),
      saved_at: captured(o.saved_at, 40),
      captured_at: capturedAt,
    },
  };
}

// -- R1 (rewritten): the shared contract's SalesNavLead -> the ORIGINAL raw evidence keys ------------------------

/** The raw evidence for one lead. Stable for an unchanged lead. */
export function toRawEvidence(lead: SalesNavLead, transport: SalesNavTransport): Record<string, unknown> {
  return {
    lead_key: lead.lead_key,
    capture_transport: transport,
    public_profile_url: lead.public_profile_url ?? null,
    // the contract types full_name as a string; a nameless lead ('') is stored as the original stored it: null
    full_name: captured(lead.full_name, 300),
    headline: lead.headline ?? null,
    title: lead.title ?? null,
    company_name: lead.company_name ?? null,
    company_salesnav_urn: lead.account_external_id ?? null,
    company_linkedin_url: lead.company_linkedin_url ?? null,
    location: lead.location ?? null,
  };
}

/**
 * The record handed to `ingestLeadBatch`: the raw evidence plus the capture
 * instant under a reserved key. The adapter reads `__observed_at` and returns
 * a `raw` WITHOUT it, so the instant never enters the hashed evidence.
 */
export function toBatchRecord(lead: SalesNavLead, transport: SalesNavTransport): Record<string, unknown> {
  return { ...toRawEvidence(lead, transport), __observed_at: lead.captured_at ?? null };
}

// -- verbatim from salesNavCapture/adapter.ts @ 37759f971 --------------------------------------------------------
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function translateSalesNavLead(raw: Record<string, unknown>, organizationId: string): AdapterResult {
  const checked = checkLeadKey(raw.lead_key);
  if ('reason' in checked) throw new Error(`sales navigator lead rejected: ${checked.reason}`);
  const leadKey = checked.key;

  const { __observed_at: observedAtRaw, ...evidence } = raw;
  const observedAt = str(observedAtRaw);

  // Derived at READ time from the evidence as captured (review F1).
  const companyName = str(evidence.company_name);
  const companyId = salesNavCompanyId(evidence.company_salesnav_urn);

  const normalized: NormalizedIngestionRecord = {
    organizationId,
    source: SALESNAV_SOURCE,
    entityType: 'person',
    externalId: `salesnav:${leadKey}`,
    person: {
      fullName: str(evidence.full_name),
      jobTitle: str(evidence.title),
      externalKeys: { [SALESNAV_SOURCE]: { external_id: leadKey } },
    },
    // Only a Sales Navigator company id anchors an employer. A name alone is
    // not identity, and the company's LinkedIn URL is never a domain (header).
    account: companyId
      ? { externalId: companyId, name: companyName }
      : null,
    observedAt,
    // Sales Navigator states no per-record confidence.
    confidence: null,
  };
  return { raw: evidence, normalized };
}

export const salesNavLeadSourceAdapter: LeadSourceAdapter = {
  source: SALESNAV_SOURCE,
  label: 'LinkedIn Sales Navigator (saved leads)',
  capabilities: ['person_discovery', 'bulk_fetch'],
  translate: translateSalesNavLead,
};

// -- verbatim from salesNavCapture/service.ts @ 37759f971 --------------------------------------------------------
export function registerSalesNavLeadSource(): void {
  if (!hasLeadSourceAdapter(salesNavLeadSourceAdapter.source)) {
    registerLeadSourceAdapter(salesNavLeadSourceAdapter);
  }
}
