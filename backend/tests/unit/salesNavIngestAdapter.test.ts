/**
 * The Sales Navigator ingestion adapter, LANDED from salesNavCapture @ 37759f971 with its ORIGINAL tests
 * (backend/tests/unit/salesNavCapture.test.ts: "translation (pure adapter)" and "what may be STORED as evidence").
 * The assertions are the original's; only the wire-lead construction changed (R1/R3: the shared contract's
 * SalesNavLead via fromWire, with the transport passed to toBatchRecord). Plus: the raw-evidence keys are pinned to
 * the original set, so evidence hashes stay comparable with the reviewed design.
 */
import { fromWire, toBatchRecord, translateSalesNavLead, checkLeadKey, capturedUrl } from '../../services/salesNav/ingestAdapter';
import { redactSecrets } from '../../services/prospectIdentity/ingestionBoundary';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const KEY_A = 'ACwAAAbcDEF123';
const WIRE = {
  lead_key: KEY_A,
  raw_urn: `urn:li:fs_salesProfile:(${KEY_A},NAME_SEARCH,abc)`,
  public_profile_url: 'https://www.linkedin.com/in/jane-doe/',
  full_name: 'Jane Doe',
  headline: 'Growth leader',
  title: 'VP Marketing',
  company_name: 'Acme',
  account_external_id: 'urn:li:fs_salesCompany:12345',
  company_linkedin_url: 'https://www.linkedin.com/company/acme',
  location: 'London, United Kingdom',
  connection_degree: 2,
  saved_at: '2026-11-01T00:00:00.000Z',
};
const lead = (w: Record<string, unknown> = WIRE, at = '2026-11-10T11:59:00.000Z') => {
  const r = fromWire(w, at);
  if ('reason' in r) throw new Error(r.reason);
  return r.lead;
};

describe('translation (pure adapter) - original tests', () => {
  it('member identity, namespaced apart from core LinkedIn ids; title mapped; nothing invented', () => {
    const { normalized } = translateSalesNavLead(toBatchRecord(lead(), 'extension'), ORG);
    expect(normalized).toEqual({
      organizationId: ORG,
      source: 'linkedin_sales_navigator',
      entityType: 'person',
      externalId: `salesnav:${KEY_A}`,
      person: {
        fullName: 'Jane Doe',
        jobTitle: 'VP Marketing',
        externalKeys: { linkedin_sales_navigator: { external_id: KEY_A } },
      },
      account: { externalId: '12345', name: 'Acme' },
      observedAt: '2026-11-10T11:59:00.000Z',
      confidence: null,
    });
  });

  it('the company LinkedIn URL is NEVER a domain or website (would merge every employer on linkedin.com)', () => {
    const { normalized } = translateSalesNavLead(toBatchRecord(lead(), 'extension'), ORG);
    expect(normalized.account?.domain).toBeUndefined();
    expect(normalized.account?.websiteUrl).toBeUndefined();
  });

  it('a company name with no Sales Navigator company id does not anchor an employer', () => {
    expect(translateSalesNavLead(toBatchRecord(lead({ lead_key: KEY_A, company_name: 'Acme' }), 'extension'), ORG).normalized.account).toBeNull();
  });

  it('raw evidence excludes per-capture and per-viewer fields, so a re-capture hashes the same', () => {
    const first = lead();
    const again = { ...first, captured_at: '2026-11-11T09:00:00.000Z' };
    const a = translateSalesNavLead(toBatchRecord(first, 'extension'), ORG).raw;
    const b = translateSalesNavLead(toBatchRecord(again, 'extension'), ORG).raw;
    expect(a).toEqual(b);
    for (const k of ['__observed_at', 'captured_at', 'saved_at', 'connection_degree', 'list_name', 'page_index', 'raw_urn']) {
      expect(a).not.toHaveProperty(k);
    }
    expect(a).toMatchObject({ lead_key: KEY_A, capture_transport: 'extension', headline: 'Growth leader', location: 'London, United Kingdom' });
  });

  it('evidence is stored EXACTLY as captured; nothing is normalised before LI-2 hashes it (review F1)', () => {
    const asSent = {
      lead_key: KEY_A,
      public_profile_url: 'https://www.LinkedIn.com/in/Jane-Doe/?trk=abc',
      company_linkedin_url: 'http://linkedin.com/company/acme/',
      account_external_id: 'urn:li:fs_salesCompany:12345',
      full_name: '  Jane Doe ',
    };
    const raw = translateSalesNavLead(toBatchRecord(lead(asSent, NOW.toISOString()), 'extension'), ORG).raw;
    expect(raw).toMatchObject({
      public_profile_url: asSent.public_profile_url,
      company_linkedin_url: asSent.company_linkedin_url,
      company_salesnav_urn: asSent.account_external_id,
      full_name: asSent.full_name,
    });
    expect(raw).not.toHaveProperty('company_salesnav_id');
    const { normalized } = translateSalesNavLead(toBatchRecord(lead(asSent, NOW.toISOString()), 'extension'), ORG);
    expect(normalized.account).toEqual({ externalId: '12345', name: null });
    expect(normalized.person?.fullName).toBe('Jane Doe');
  });

  it('no email or phone is ever produced (owner P-3)', () => {
    const { normalized } = translateSalesNavLead({ ...toBatchRecord(lead(), 'extension'), email: 'a@b.c', phone: '+44 1' }, ORG);
    expect(normalized.person?.email).toBeUndefined();
    expect(normalized.person?.phone).toBeUndefined();
  });

  it('the adapter throws on a bad key, which the orchestrator reports per record', () => {
    expect(() => translateSalesNavLead({ lead_key: 'urn:li:x' }, ORG)).toThrow('lead_key_is_full_urn');
  });
});

describe('per-lead validation - original tests', () => {
  it('rejects a full fs_salesProfile URN as lead_key (identity-splitting defence)', () => {
    expect(checkLeadKey(`urn:li:fs_salesProfile:(${KEY_A},NAME_SEARCH,abc)`)).toEqual({ reason: 'lead_key_is_full_urn' });
    expect(fromWire({ lead_key: `(${KEY_A},x)` }, NOW.toISOString())).toEqual({ reason: 'lead_key_is_full_urn' });
  });
  it('rejects a lead whose raw URN does not contain its key', () => {
    expect(fromWire({ lead_key: KEY_A, raw_urn: 'urn:li:fs_salesProfile:(SOMEONEELSE1,x,y)' }, NOW.toISOString()))
      .toEqual({ reason: 'lead_key_urn_mismatch' });
  });
});

describe('what may be STORED as evidence (review NEW 1) - original tests', () => {
  it('a Sales Navigator app URL (it can carry an auth token) is never stored', () => {
    const raw = translateSalesNavLead(toBatchRecord(lead({
      lead_key: KEY_A,
      public_profile_url: 'https://www.linkedin.com/sales/lead/ACwAAAbcDEF123,NAME_SEARCH,secretAuthToken',
      company_linkedin_url: 'https://www.linkedin.com/sales/company/12345',
    }, NOW.toISOString()), 'extension'), ORG).raw;
    expect(raw.public_profile_url).toBeNull();
    expect(raw.company_linkedin_url).toBeNull();
    expect(JSON.stringify(raw)).not.toContain('secretAuthToken');
  });

  it('a URL with credentials in the authority is never stored', () => {
    expect(lead({ lead_key: KEY_A, public_profile_url: 'https://u:p@www.linkedin.com/in/jane' }, NOW.toISOString()).public_profile_url).toBeNull();
  });

  it('control: an ordinary /in/ profile URL IS stored, verbatim', () => {
    expect(capturedUrl('https://www.linkedin.com/in/jane-doe/')).toBe('https://www.linkedin.com/in/jane-doe/');
  });

  it('every stored evidence key is snake_case, so the boundary redactor can reach it', () => {
    for (const k of Object.keys(translateSalesNavLead(toBatchRecord(lead(), 'extension'), ORG).raw)) {
      expect(k).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('lead_key survives the boundary redactor (bare "key" is not a secret name)', () => {
    const redacted = redactSecrets(translateSalesNavLead(toBatchRecord(lead({ lead_key: KEY_A }, NOW.toISOString()), 'extension'), ORG).raw) as Record<string, unknown>;
    expect(redacted.lead_key).toBe(KEY_A);
  });
});

describe('R1 parity: the raw-evidence KEYS are exactly the original set', () => {
  it('toBatchRecord emits the original ten evidence keys plus __observed_at', () => {
    expect(Object.keys(toBatchRecord(lead(), 'unipile')).sort()).toEqual([
      '__observed_at', 'capture_transport', 'company_linkedin_url', 'company_name', 'company_salesnav_urn',
      'full_name', 'headline', 'lead_key', 'location', 'public_profile_url', 'title',
    ]);
  });
  it('a nameless lead stores full_name null, as the original did', () => {
    expect(toBatchRecord(lead({ lead_key: KEY_A }), 'extension').full_name).toBeNull();
  });
});
