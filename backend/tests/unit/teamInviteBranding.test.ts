/**
 * Invitation branding (owner ruling 2026-11-19): "You've been invited to join <Company name> on Omnivyra".
 *  - The template names the company and takes the platform name FROM THE PAYLOAD; a missing / blank
 *    company name falls back to "an <platform> workspace" - never a wrong or other company's name.
 *  - EVERY team invite payload carries companyName + platformName (the email_jobs path and the direct
 *    sendInvite path).
 *  - Both payload shapes render safely, so either deploy order of the edge function and the app is harmless.
 *
 * The edge function (supabase/functions/send-transactional-email, Deno) is a SEPARATE deploy unit. Its
 * index.ts imports npm:/Deno modules and cannot run under jest, so the copy lives in the pure
 * ./teamInvite.ts (exercised directly here) and index.ts's wiring is asserted at source level, the same
 * way sendTransactionalEmailEscape does.
 */
import fs from 'fs';
import path from 'path';

const mockInvoked: Array<{ fn: string; body: Record<string, unknown> }> = [];
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    functions: {
      invoke: async (fn: string, opts: { body: Record<string, unknown> }) => { mockInvoked.push({ fn, body: opts.body }); return { data: { ok: true }, error: null }; },
    },
    from: () => { throw new Error('no table access expected'); },
  },
}));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { teamInviteCopy, cleanDisplayName, MAX_COMPANY_NAME_LENGTH } from '../../../supabase/functions/send-transactional-email/teamInvite';
import { escapeHtml } from '../../../supabase/functions/send-transactional-email/escape';
import { buildSendEnvelopeFromClaim } from '../../services/emailJobsService';
import { sendInvite } from '../../services/emailService';

const FN_DIR = path.join(process.cwd(), 'supabase', 'functions', 'send-transactional-email');
const indexSrc = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
const OTHER_COMPANIES = ['Beta Labs', 'Shared Co', 'Victim Corp'];

describe('the team_invite copy names the company and the platform from the payload', () => {
  it('the new payload shape: names THAT company on the payload platform, and no other company', () => {
    const c = teamInviteCopy({ companyName: 'Fay Studio', platformName: 'Omnivyra' });
    expect(c.subject).toBe("You've been invited to join Fay Studio on Omnivyra");
    expect(c.bodyHtml).toContain('<strong>Fay Studio</strong> on Omnivyra');
    for (const other of OTHER_COMPANIES) expect(JSON.stringify(c)).not.toContain(other);
  });

  it('the platform name comes from the payload, not the template', () => {
    const c = teamInviteCopy({ companyName: 'Fay Studio', platformName: 'Example Platform' });
    expect(c.subject).toBe("You've been invited to join Fay Studio on Example Platform");
    expect(JSON.stringify(c)).not.toContain('Omnivyra');
  });

  it('the OLD payload shape (no companyName, no platformName) falls back to "an Omnivyra workspace"', () => {
    const c = teamInviteCopy({});
    expect(c.subject).toBe("You've been invited to join an Omnivyra workspace");
    expect(c.bodyHtml).toContain('an Omnivyra workspace');
  });

  it.each([[null], [''], ['   '], ['\n\t'], [42], [{ name: 'Fay Studio' }]])('a missing / blank / non-string company name (%p) falls back, naming no company', (companyName) => {
    const c = teamInviteCopy({ companyName, platformName: 'Omnivyra' });
    expect(c.subject).toBe("You've been invited to join an Omnivyra workspace");
    expect(c.bodyHtml).not.toContain('<strong>');
  });

  it('a hostile name is rendered inert: escaped in HTML, no line breaks in the subject', () => {
    const hostile = '<script>alert("x")</script>\r\nBcc: victim@example.test';
    const c = teamInviteCopy({ companyName: hostile, platformName: '<b>P</b>' });
    expect(c.bodyHtml).not.toMatch(/<script|<b>/i);
    expect(c.bodyHtml).toContain(escapeHtml('<script>alert("x")</script> Bcc: victim@example.test'));
    expect(c.bodyHtml).toContain('&lt;b&gt;P&lt;/b&gt;');
    expect(c.subject).not.toMatch(/[\r\n]/);
  });

  it('a name is trimmed, whitespace-collapsed and length-bounded', () => {
    expect(cleanDisplayName('  Fay   Studio  ', 120)).toBe('Fay Studio');
    expect(cleanDisplayName('Fay\u0007\u0000Studio\u007f', 120)).toBe('Fay Studio');
    const long = cleanDisplayName('x'.repeat(500), MAX_COMPANY_NAME_LENGTH) as string;
    expect(long.length).toBe(MAX_COMPANY_NAME_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('index.ts wires the team_invite branch to the copy (source level: index.ts imports Deno/npm modules)', () => {
  const branch = indexSrc.slice(indexSrc.indexOf('case "team_invite": {'), indexSrc.indexOf('case "company_referral"'));
  it('uses teamInviteCopy with the payload company and platform, and hard-codes no platform name', () => {
    expect(indexSrc).toMatch(/import \{ teamInviteCopy \} from "\.\/teamInvite\.ts";/);
    expect(branch).toMatch(/teamInviteCopy\(\{ companyName: t\.companyName, platformName: t\.platformName \}\)/);
    expect(branch).toMatch(/subject: copy\.subject,/);
    expect(branch).toMatch(/actionLayout\(copy\.heading, copy\.bodyHtml, "Accept invitation", t\.inviteUrl\)/);
    expect(branch).not.toMatch(/Omnivyra/);
  });
});

describe('every team invite payload carries companyName and platformName', () => {
  beforeEach(() => { mockInvoked.length = 0; });

  it('the email_jobs path: the claimed job payload company reaches the edge body', () => {
    const r = buildSendEnvelopeFromClaim({
      template_key: 'team_invite_magic_link',
      payload: { recipientEmail: 'fay@gmail.com', inviteUrl: 'https://app.example.test/auth/accept-invite?token=t', companyName: 'Fay Studio', role: 'COMPANY_ADMIN' },
      payload_encrypted: false,
      recipient_email: 'fay@gmail.com',
    });
    expect(r).toEqual({ ok: true, body: {
      type: 'team_invite', recipientEmail: 'fay@gmail.com', inviteUrl: 'https://app.example.test/auth/accept-invite?token=t',
      companyName: 'Fay Studio', platformName: 'Omnivyra',
    } });
  });

  it('the email_jobs path: a job without a company name sends companyName null (the template falls back)', () => {
    const r = buildSendEnvelopeFromClaim({
      template_key: 'team_invite_magic_link',
      payload: { recipientEmail: 'x@example.test', inviteUrl: 'https://app.example.test/x' },
      payload_encrypted: false,
      recipient_email: 'x@example.test',
    });
    expect(r.ok && r.body.companyName).toBeNull();
    expect(r.ok && r.body.platformName).toBe('Omnivyra');
  });

  it('the direct path (sendInvite, used by company/users/reinvite): the company name is in the body', async () => {
    await sendInvite('x@example.test', 'https://app.example.test/x', 'k-1', 'Fay Studio');
    expect(mockInvoked).toEqual([{ fn: 'send-transactional-email', body: expect.objectContaining({
      type: 'team_invite', companyName: 'Fay Studio', platformName: 'Omnivyra',
    }) }]);
  });

  it('reinvite passes the company it reinvites to (by its id) into sendInvite', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'pages/api/company/users/reinvite.ts'), 'utf8');
    expect(src).toMatch(/\.from\('companies'\)\s*\.select\('name'\)\s*\.eq\('id', companyId\)/);
    expect(src).toMatch(/`reinvite:\$\{companyId\}:\$\{userId\}`,\s*\(inviteCompany as \{ name\?: string \| null \} \| null\)\?\.name \?\? null,/);
  });
});
