/**
 * Omnivyra Sales Navigator PAGE READER - the ONE reader for every browser transport (owner ruling 2026-11-21).
 *
 * Used unchanged by:
 *   - the Chrome extension (content script; manifest order: profileUrlClass.js, salesNavPageReader.js, li15.js);
 *   - the server's Playwright/RPA route (89): page.addScriptTag({ content: profileUrlClass + this file }), then
 *     page.evaluate(() => omnivyraSalesNavReader.readSalesNavPage(document, location.href, params)).
 * CANONICAL COPY: server repo lib/salesnav/salesNavPageReader.js. The extension carries a BYTE-IDENTICAL copy, pinned by
 * a sha256 test on both sides; a change is made in the server copy, READER_VERSION is bumped, and the copy re-vendored.
 *
 * PURE: no chrome.*, no network, no storage, no clicks, no navigation. Every function that reads the page takes the
 * Document explicitly. Depends only on globalThis.omnivyraProfileUrl (profileUrlClass.js, PI's profile-URL rule).
 *
 * Contract: CONTRACT-1.5.1-SALESNAV-EXTRACT.md section 4 (verification order) and section 6 (result shape); PI's shared
 * rule parseSalesNavUrl / isCommandedPage (server backend/services/salesNav/contract.ts) is PORTED VERBATIM below.
 * The data-x-- selectors are synthetic fixtures and UNVERIFIED against a live Sales Navigator page (owner live check).
 */
(function attach() {
  if (globalThis.omnivyraSalesNavReader) return;

  /** Bump on ANY behaviour change. Both transports report it; the server refuses unaccepted versions. */
  const READER_VERSION = 'snr-1';

  const MAX_LEADS = 25;
  const SELECTORS = Object.freeze({
    meBootstrap: 'code',
    salesRow: '[data-x--people-list--row]',
    salesPanel: '[data-x--lead-panel]',
    salesName: '[data-anonymize="person-name"]',
    salesHeadline: '[data-anonymize="headline"]',
    salesTitle: '[data-anonymize="title"]',
    salesCompany: '[data-anonymize="company-name"]',
    salesLocation: '[data-anonymize="location"]',
    salesDegree: '[data-x--lead-degree]',
    salesSavedAt: 'time[datetime]',
    salesListName: '[data-x--list-name]',
    salesPageCurrent: '[data-x--pagination] [aria-current="true"]',
    salesPagination: '[data-x--pagination]',
    salesNext: '[data-x--pagination] [data-x--pagination-next]',
    salesEmptyState: '[data-x--empty-state]',
    salesTotal: '[data-x--results-count]',
    rateNotice: '[data-x--rate-limit-notice]',
    loginForm: 'form[data-x--login-form]',
  });

  const MEMBER_URN = /^urn:li:fsd_profile:[A-Za-z0-9_-]{1,128}$/;
  const SALES_TUPLE = /urn:li:fs_salesProfile:\(([^,()\s]+),[^()]*\)/;
  const SALES_ID = /^AC[ow]AA[A-Za-z0-9_-]{20,60}$/;
  const ALLOWED_HOSTS = new Set(['www.linkedin.com', 'linkedin.com']);
  const LOGIN_PATHS = /^\/(login|checkpoint|authwall|uas\/login|uas\/request-password-reset)(\/|$)/i;

  const clean = (s, max = 5000) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
  };
  const textOf = (el, sel, max = 300) => {
    const n = el && el.querySelector(sel);
    return n ? clean(n.textContent, max) : null;
  };

  // ------------------------------------------------------------ element helpers

  function urlCandidates(el) {
    if (!el) return [];
    const out = [];
    for (const a of Array.from(el.querySelectorAll('a[href]'))) {
      out.push(a.getAttribute('href'));           // the attribute verbatim; never a.href (resolved)
      const txt = clean(a.textContent, 400);
      if (txt && /^https?:\/\//i.test(txt)) out.push(txt);
    }
    return out.filter((v) => typeof v === 'string' && v.trim());
  }

  function salesTupleIn(el) {
    if (!el) return null;
    for (const n of [el, ...el.querySelectorAll('*')]) {
      for (const a of Array.from(n.attributes || [])) {
        const m = String(a.value || '').match(SALES_TUPLE);
        if (m) return { raw: m[0], first: m[1] };
      }
    }
    return null;
  }

  /** Member-scoped lead id: the FIRST element of the fs_salesProfile tuple, never the tuple. */
  function leadKeyOf(el) {
    const t = salesTupleIn(el);
    if (t && SALES_ID.test(t.first)) return { lead_key: t.first, raw_urn: t.raw };
    for (const v of urlCandidates(el)) {
      const m = String(v).match(/^(?:https:\/\/www\.linkedin\.com)?\/sales\/lead\/([^,/?#]+),/);
      if (m && SALES_ID.test(m[1])) return { lead_key: m[1], raw_urn: null };
    }
    return null;
  }

  /** A displayed /in/ URL, verbatim; never a /sales/ URL; never constructed. */
  function displayedProfileUrl(els) {
    const P = globalThis.omnivyraProfileUrl;
    for (const el of els) {
      for (const v of urlCandidates(el)) {
        const t = v.trim();
        if (P.isSalesNavigatorUrl(t) || /\/sales\//i.test(t)) continue;
        if (P.classifyLinkedinProfile(t).form !== 'refused') return t;
      }
    }
    return null;
  }
  function displayedCompanyUrl(el) {
    const P = globalThis.omnivyraProfileUrl;
    for (const v of urlCandidates(el)) {
      const t = v.trim();
      if (/\/sales\//i.test(t)) continue;
      if (P.normalizeLinkedinUrl(t, '/company/')) return t;
    }
    return null;
  }
  function accountIdOf(el) {
    for (const v of urlCandidates(el)) {
      const m = String(v).match(/\/sales\/company\/(\d{1,20})(?:[/?#]|$)/);
      if (m) return m[1];
    }
    return null;
  }

  // ------------------------------------------------------------ page helpers (Document passed in)

  /**
   * The logged-in member's urn:li:fsd_profile:<id>, read from LinkedIn's own bootstrap data on this page. Returns
   * null unless exactly ONE distinct member URN is found on a "Me" record.
   */
  function readMemberUrn(doc) {
    const found = new Set();
    for (const code of Array.from(doc.querySelectorAll(SELECTORS.meBootstrap))) {
      const raw = String(code.textContent || '');
      if (!raw.includes('fsd_profile') || raw.length > 2_000_000) continue;
      let data;
      try { data = JSON.parse(raw); } catch (_) { continue; }
      const records = [data, data && data.data, ...((data && Array.isArray(data.included)) ? data.included : [])];
      for (const r of records) {
        if (!r || typeof r !== 'object') continue;
        const type = String(r.$type || '');
        if (!/(^|\.)Me$/.test(type)) continue;
        for (const k of ['dashEntityUrn', '*dashEntityUrn', 'entityUrn', '*profile', 'profileUrn']) {
          const v = r[k];
          if (typeof v === 'string' && MEMBER_URN.test(v)) found.add(v);
        }
      }
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /** The visible lead rows (contract 5.3 lead shape), at most `max`. Read-only: no click, no open. */
  function readSalesRows(doc, max) {
    const panel = doc.querySelector(SELECTORS.salesPanel);
    const panelKey = panel ? leadKeyOf(panel) : null;
    const leads = [];
    let skipped = 0;
    for (const row of Array.from(doc.querySelectorAll(SELECTORS.salesRow))) {
      if (leads.length >= max) break;
      const key = leadKeyOf(row);
      const full_name = textOf(row, SELECTORS.salesName, 200);
      if (!key || !full_name) { skipped += 1; continue; }
      const lead = { lead_key: key.lead_key };
      if (key.raw_urn) lead.raw_urn = key.raw_urn;
      const profileSources = [row];
      if (panel && panelKey && panelKey.lead_key === key.lead_key) profileSources.push(panel);
      const url = displayedProfileUrl(profileSources);
      if (url) lead.public_profile_url = url;
      lead.full_name = full_name;
      const opt = {
        headline: textOf(row, SELECTORS.salesHeadline),
        title: textOf(row, SELECTORS.salesTitle),
        company_name: textOf(row, SELECTORS.salesCompany),
        account_external_id: accountIdOf(row),
        company_linkedin_url: displayedCompanyUrl(row),
        location: textOf(row, SELECTORS.salesLocation),
      };
      const deg = textOf(row, SELECTORS.salesDegree, 10);
      const d = deg ? parseInt(deg, 10) : NaN;
      if (Number.isInteger(d) && d >= 1 && d <= 3) opt.connection_degree = d;
      const saved = row.querySelector(SELECTORS.salesSavedAt);
      const iso = saved && saved.getAttribute('datetime');
      if (iso && !Number.isNaN(Date.parse(iso))) opt.saved_at = new Date(Date.parse(iso)).toISOString();
      for (const [k, v] of Object.entries(opt)) if (v !== null && v !== undefined) lead[k] = v;
      leads.push(lead);
    }
    return { leads, skipped };
  }

  /** list_total: a number ONLY for a plain exact integer ("1,234" or "1234"); "1,000+", "1K", "about 300" -> null. */
  function exactTotal(text) {
    const t = clean(text, 200);
    if (!t) return null;
    const m = /^(?:[^\d]*?)(\d{1,3}(?:,\d{3})+|\d+)(?:\s+(?:results?|leads?|people))?$/i.exec(t);
    if (!m) return null;
    // The pattern only matches a number at the END (optionally followed by results/leads/people), so a '+', a K/M
    // suffix or a decimal never matches. Anything before the number ('about', 'over') makes it inexact.
    const prefix = t.slice(0, t.indexOf(m[1]));
    if (/\S/.test(prefix)) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  /** has_next_page: true/false only from LinkedIn's own next control; null when it cannot be read. */
  function readHasNext(doc) {
    const pag = doc.querySelector(SELECTORS.salesPagination);
    if (!pag) return null;
    const next = doc.querySelector(SELECTORS.salesNext);
    if (!next) return false;
    const disabled = next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true';
    return !disabled;
  }

  // ------------------------------------------------------------ PI's shared rule, VERBATIM PORT
  // (server backend/services/salesNav/contract.ts @ 494a759c2: parseSalesNavUrl, isCommandedPage). Change only with it.
  const SN_LIST_ID = /^\/sales\/lists\/people\/([A-Za-z0-9_-]{1,100})\/?$/;
  const SN_ORIGIN = 'https://www.linkedin.com';
  function parseSalesNavUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return { ok: false, refused: 'not_a_url' };
    let u;
    try { u = new URL(raw.trim()); } catch (_) { return { ok: false, refused: 'not_a_url' }; }
    if (u.protocol !== 'https:') return { ok: false, refused: 'not_https' };
    const host = u.hostname.toLowerCase();
    if ((host !== 'www.linkedin.com' && host !== 'linkedin.com') || u.port || u.username || u.password) {
      return { ok: false, refused: 'not_linkedin' };
    }
    const path = u.pathname;
    if (!path.startsWith('/sales/')) return { ok: false, refused: 'not_sales_navigator' };
    u.searchParams.delete('page');
    const query = u.searchParams.toString();
    const q = query ? '?' + query : '';
    if (path === '/sales/search/people' || path === '/sales/search/people/') {
      const kind = u.searchParams.has('savedSearchId') ? 'saved_search' : 'people_search';
      return { ok: true, kind, canonicalUrl: SN_ORIGIN + '/sales/search/people' + q };
    }
    const list = SN_LIST_ID.exec(path);
    if (list) return { ok: true, kind: 'lead_list', canonicalUrl: SN_ORIGIN + '/sales/lists/people/' + list[1] + q };
    return { ok: false, refused: 'unsupported_kind' };
  }
  function isCommandedPage(finalUrl, commandedPageUrl, position) {
    if (!position || position.param !== 'page' || !/^\d{1,4}$/.test(String(position.value))) return false;
    const loaded = parseSalesNavUrl(finalUrl);
    const asked = parseSalesNavUrl(commandedPageUrl);
    if (!loaded.ok || !asked.ok || loaded.canonicalUrl !== asked.canonicalUrl) return false;
    let shown;
    try { shown = new URL(String(finalUrl)).searchParams.get('page'); } catch (_) { return false; }
    if (shown === null) shown = '1';
    return shown === String(position.value);
  }

  // ------------------------------------------------------------ the page read (contract section 4)

  const stop = (outcome, code) => ({ ok: true, outcome, outcome_code: code, leads: [], has_next_page: null, list_total: null, reader_version: READER_VERSION });
  const fail = (code, message) => ({ ok: false, code, message: message || code, reader_version: READER_VERSION });

  /**
   * Verify the loaded page in contract order, then read it. Nothing is read unless every check passes.
   * @param {Document} doc  the loaded page
   * @param {string} href   its FINAL URL (after any redirect)
   * @param {{ page_url, page_index, url_kind, max_leads, position, acting_member_urn }} p
   */
  function readSalesNavPage(doc, href, p) {
    p = p || {};
    const max = Number.isInteger(p.max_leads) ? Math.min(p.max_leads, MAX_LEADS) : 0;
    if (max < 1) return fail('PARAMS_OUT_OF_BOUNDS', 'max_leads must be 1..25');
    if (!Number.isInteger(p.page_index) || p.page_index < 0) return fail('PARAMS_OUT_OF_BOUNDS', 'page_index');
    const pos = p.position;
    if (!pos || pos.param !== 'page' || typeof pos.value !== 'string' || !/^\d{1,4}$/.test(pos.value) || !parseSalesNavUrl(String(p.page_url)).ok) {
      // The position rule comes from the server (pageUrlFor). Without it the page cannot be verified: fail closed.
      return fail('POSITION_RULE_MISSING', 'the command carries no valid page-position rule');
    }
    let here;
    try { here = new URL(String(href)); } catch (_) { return stop('unknown', 'PAGE_NOT_RECOGNISED'); }
    // 4.1 an allowed host
    if (here.protocol !== 'https:' || !ALLOWED_HOSTS.has(here.hostname.toLowerCase())) return stop('refused', 'OFF_ALLOWLIST_REDIRECT');
    // 4.2 login wall / checkpoint: never interacted with
    if (LOGIN_PATHS.test(here.pathname) || doc.querySelector(SELECTORS.loginForm)) return stop('auth_expired', 'LOGIN_OR_CHECKPOINT');
    // 4.1 still an allowed Sales Navigator URL after any redirect
    if (!parseSalesNavUrl(String(href)).ok) return stop('refused', 'OFF_ALLOWLIST_REDIRECT');
    // 4.3 LinkedIn rate notice
    if (doc.querySelector(SELECTORS.rateNotice)) return stop('rate_limited', 'LINKEDIN_RATE_NOTICE');
    // 4.4 the logged-in member
    if (readMemberUrn(doc) !== p.acting_member_urn) return stop('refused', 'MEMBER_MISMATCH');
    // 4.6 the loaded page IS the commanded page (same list/search AND same page)
    if (!isCommandedPage(String(href), String(p.page_url), pos)) return stop('unknown', 'PAGE_POSITION_MISMATCH');
    const current = doc.querySelector(SELECTORS.salesPageCurrent);
    if (current) {
      const shown = parseInt(clean(current.textContent) || '', 10);
      if (!Number.isInteger(shown) || shown - 1 !== p.page_index) return stop('unknown', 'PAGE_POSITION_MISMATCH');
    }
    // 4.5 the structure is recognised: rows, or LinkedIn's empty-state marker
    const hasRows = doc.querySelectorAll(SELECTORS.salesRow).length > 0;
    const empty = !hasRows && Boolean(doc.querySelector(SELECTORS.salesEmptyState));
    if (!hasRows && !empty) return stop('unknown', 'PAGE_NOT_RECOGNISED');
    const listName = textOf(doc, SELECTORS.salesListName, 200);
    const totalEl = doc.querySelector(SELECTORS.salesTotal);
    const { leads, skipped } = empty ? { leads: [], skipped: 0 } : readSalesRows(doc, max);
    return {
      ok: true,
      outcome: 'read',
      leads,
      skipped,
      source: { url_kind: p.url_kind, ...(listName ? { list_name: listName } : {}), page_index: p.page_index },
      has_next_page: empty ? false : readHasNext(doc),
      list_total: totalEl ? exactTotal(totalEl.textContent) : null,
      reader_version: READER_VERSION,
    };
  }

  globalThis.omnivyraSalesNavReader = Object.freeze({
    READER_VERSION, MAX_LEADS, SELECTORS, MEMBER_URN, SALES_ID,
    clean, textOf, urlCandidates, salesTupleIn, leadKeyOf, displayedProfileUrl, displayedCompanyUrl, accountIdOf,
    readMemberUrn, readSalesRows, exactTotal, readHasNext, parseSalesNavUrl, isCommandedPage, readSalesNavPage,
  });
})();
