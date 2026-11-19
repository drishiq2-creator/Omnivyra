/**
 * Phase 7 — Company identity drift detection regression suite.
 *
 * Owner ruling 2026-11-19: a company's identity is its WEBSITE domain; several companies may share an
 * ADMIN email domain, and a free-mail (vetted) company has none. Drift is therefore ONLY a violation of
 * the companyIdentityWriter invariants (website <-> website_domain consistent and normalised);
 * admin_email_domain is never compared.
 */

import {
  checkCompanyIdentityDrift,
  monitorCompanyIdentityDrift,
  type CompanyIdentityInput,
} from '../../services/companyIdentityDriftService';

const company = (over: Partial<CompanyIdentityInput>): CompanyIdentityInput => ({
  id: 'co_1', name: 'Test Co', website: null, website_domain: null, admin_email_domain: null, ...over,
});

describe('checkCompanyIdentityDrift — spec cases', () => {
  it('PASS: drishiq.com / drishiq.com (consistent) → no drift', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'drishiq.com', website_domain: 'drishiq.com', website: 'https://www.drishiq.com',
    }));
    expect(r.hasDrift).toBe(false);
    expect(r.driftReasons).toEqual([]);
  });

  it('PASS: afrost.org / afrost.org (consistent) → no drift', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'afrost.org', website_domain: 'afrost.org', website: 'https://www.afrost.org',
    }));
    expect(r.hasDrift).toBe(false);
  });

  it('NO DRIFT (owner ruling): admin email root != website root is legal - a shared admin email domain', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'shared.test', website_domain: 'beta.test', website: 'https://www.beta.test',
    }));
    expect(r.hasDrift).toBe(false);
    expect(r.driftReasons).toEqual([]);
  });

  it('DRIFT: infitoo.com / NULL → MISSING_WEBSITE_DOMAIN', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'infitoo.com', website_domain: null, website: 'https://www.infitoo.com',
    }));
    expect(r.hasDrift).toBe(true);
    expect(r.driftReasons).toContain('MISSING_WEBSITE_DOMAIN');
  });

  it('NO DRIFT (owner ruling): no admin email domain (a free-mail vetted company) is legal', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: null, website_domain: 'solo.test', website: 'https://solo.test',
    }));
    expect(r.hasDrift).toBe(false);
    expect(r.driftReasons).toEqual([]);
  });
});

describe('checkCompanyIdentityDrift — additional coverage', () => {
  it('normalizes www / subdomain before comparing (no false mismatch)', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'mail.acme.com', website_domain: 'acme.com', website: 'https://www.shop.acme.com',
    }));
    expect(r.driftReasons).toEqual([]);
  });

  it('flags MISSING_WEBSITE for a UUID placeholder website', () => {
    const r = checkCompanyIdentityDrift(company({
      id: 'co_1', admin_email_domain: 'acme.com', website_domain: 'acme.com',
      website: '4dae7f7a-b518-4557-b8cb-5c6123ff9658',
    }));
    expect(r.driftReasons).toContain('MISSING_WEBSITE');
  });

  it('flags INVALID_WEBSITE_DOMAIN for unparseable website_domain', () => {
    const r = checkCompanyIdentityDrift(company({
      admin_email_domain: 'acme.com', website_domain: 'not-a-domain', website: 'https://www.acme.com',
    }));
    expect(r.driftReasons).toContain('INVALID_WEBSITE_DOMAIN');
  });

  it('no website and no website_domain (both null) is consistent - no drift, whatever the admin domain', () => {
    expect(checkCompanyIdentityDrift(company({})).driftReasons).toEqual([]);
    expect(checkCompanyIdentityDrift(company({ admin_email_domain: 'shared.test' })).hasDrift).toBe(false);
  });

  it('flags MISSING_WEBSITE when website_domain is set without a website (Invariant A)', () => {
    const r = checkCompanyIdentityDrift(company({ website_domain: 'beta.test', website: null }));
    expect(r.driftReasons).toEqual(['MISSING_WEBSITE']);
  });

  it('flags WEBSITE_DOMAIN_MISMATCH when website_domain is not the root of the website', () => {
    const r = checkCompanyIdentityDrift(company({ website_domain: 'beta.test', website: 'https://www.gamma.test' }));
    expect(r.driftReasons).toEqual(['WEBSITE_DOMAIN_MISMATCH']);
  });

  it('flags WEBSITE_DOMAIN_NOT_NORMALIZED for a host-stamped website_domain (Invariant C)', () => {
    const r = checkCompanyIdentityDrift(company({ website_domain: 'mail.beta.test', website: 'https://beta.test' }));
    expect(r.driftReasons).toEqual(['WEBSITE_DOMAIN_NOT_NORMALIZED']);
  });

  it('flags INVALID_WEBSITE_FORMAT when no domain can be extracted from the website', () => {
    const r = checkCompanyIdentityDrift(company({ website_domain: 'beta.test', website: 'not a url' }));
    expect(r.driftReasons).toContain('INVALID_WEBSITE_FORMAT');
  });

  it('admin_email_domain is never consulted: null / same / different give the identical verdict', () => {
    for (const base of [
      { website_domain: 'beta.test', website: 'https://beta.test' },
      { website_domain: 'beta.test', website: 'https://gamma.test' },
      { website_domain: null, website: 'https://beta.test' },
    ]) {
      const verdicts = [null, 'beta.test', 'shared.test', 'not-a-domain'].map(
        (admin) => checkCompanyIdentityDrift(company({ ...base, admin_email_domain: admin })).driftReasons,
      );
      for (const v of verdicts) expect(v).toEqual(verdicts[0]);
    }
  });

  it('returns the full payload shape', () => {
    const r = checkCompanyIdentityDrift(company({ id: 'co_9', name: 'Acme', admin_email_domain: 'acme.com', website_domain: 'acme.com', website: 'https://www.acme.com' }));
    expect(r).toMatchObject({
      hasDrift: false, companyId: 'co_9', companyName: 'Acme',
      adminEmailDomain: 'acme.com', websiteDomain: 'acme.com', website: 'https://www.acme.com', driftReasons: [],
    });
  });
});

describe('monitorCompanyIdentityDrift — telemetry, never throws', () => {
  it('emits only on drift and returns the result', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const clean = monitorCompanyIdentityDrift(company({ admin_email_domain: 'shared.test', website_domain: 'acme.com', website: 'https://www.acme.com' }));
      expect(clean?.hasDrift).toBe(false);
      const before = warn.mock.calls.length;
      const drift = monitorCompanyIdentityDrift(company({ admin_email_domain: 'acme.com', website_domain: 'other.com', website: 'https://www.acme.com' }));
      expect(drift?.hasDrift).toBe(true);
      expect(warn.mock.calls.length).toBeGreaterThan(before); // warned on drift
    } finally {
      warn.mockRestore();
    }
  });

  it('never throws on malformed input', () => {
    expect(() => monitorCompanyIdentityDrift({} as any)).not.toThrow();
    expect(() => monitorCompanyIdentityDrift({ website: 123 } as any)).not.toThrow();
  });
});
