/**
 * LinkedIn profile-URL classification (port of PI's shared
 * lib/linkedin/profileUrl.ts: normalizeLinkedinUrl + classifyLinkedinProfile).
 *
 * The rule is PI's, ported verbatim so both sides classify identically; the
 * extension test suite runs every CLASSIFY (and NORMALIZE) fixture row of
 * lib/linkedin/profileUrlFixtures.ts against this port.
 *
 *   opaque = the raw /in/ slug matches ^ac[ow]aa[a-z0-9_-]{20,60}$ (i) AND
 *            starts with the case-sensitive AC[ow]AA prefix (length 25-65);
 *   vanity = any other normalisable /in/ URL (the conservative default);
 *   refused = not a normalisable linkedin.com /in/ URL (/sales/, /pub/,
 *            other hosts, credentials, dot-segments, control characters...).
 *
 * Pure: no DOM, no storage, no messaging. Used by the Sales Navigator capture
 * (to accept a displayed /in/ URL) and by the redacted inventory helper.
 */
(function attach() {
  function text(v, max) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t && t.length <= max ? t : null;
  }

  const LINKEDIN_PATH_SPACES = Object.freeze({ '/in/': 'in', '/company/': 'company' });

  function normalizeLinkedinUrl(v, pathPrefix) {
    const space = LINKEDIN_PATH_SPACES[pathPrefix];
    if (!space) return null;
    const t = text(v, 400);
    if (!t) return null;
    const rawPath = t.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
    if (/\.\.|%2e/i.test(rawPath)) return null;
    let u;
    try { u = new URL(t); } catch (_) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0].toLowerCase() !== space) return null;
    const slug = segments[1].toLowerCase();
    if (!/^[a-z0-9_\-%]{1,100}$/.test(slug)) return null;
    let decoded;
    try { decoded = decodeURIComponent(slug); } catch (_) { return null; }
    if (/[\s\p{C}/\\]/u.test(decoded)) return null;
    if (/\.\.|%2e/i.test(decoded)) return null;
    return `https://www.linkedin.com/${space}/${slug}`;
  }

  const OPAQUE_SLUG = /^ac[ow]aa[a-z0-9_-]{20,60}$/i;

  /** @returns {{key: string|null, form: 'vanity'|'opaque'|'refused'}} */
  function classifyLinkedinProfile(v) {
    const key = normalizeLinkedinUrl(v, '/in/');
    if (!key) return { key: null, form: 'refused' };
    const rawSlug = (() => {
      try {
        return new URL(String(v).trim()).pathname.split('/').filter(Boolean)[1] ?? '';
      } catch (_) { return ''; }
    })();
    const opaque = OPAQUE_SLUG.test(rawSlug) && /^AC[ow]AA/.test(rawSlug);
    return opaque
      ? { key: `https://www.linkedin.com/in/${rawSlug}`, form: 'opaque' }
      : { key, form: 'vanity' };
  }

  /**
   * True for a Sales Navigator app URL: a linkedin.com URL (absolute, or a
   * root-relative path) whose path starts /sales/.
   */
  function isSalesNavigatorUrl(v) {
    const t = text(v, 2000);
    if (!t) return false;
    if (/^\/sales\//i.test(t)) return true;
    let u;
    try { u = new URL(t); } catch (_) { return false; }
    const host = u.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return false;
    return /^\/sales\//i.test(u.pathname);
  }

  globalThis.omnivyraProfileUrl = Object.freeze({ normalizeLinkedinUrl, classifyLinkedinProfile, isSalesNavigatorUrl });
})();
