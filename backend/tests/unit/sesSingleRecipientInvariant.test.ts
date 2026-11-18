/**
 * Invariant (7c, email re-land 11e77eca5): every send-transactional-email send is ONE message to ONE recipient.
 *
 * Why it is load-bearing: the merged sendOnce re-raises a CLASS-2 D3 `not_sent` failure (an SES 4xx ANSWER) as a
 * PreSendError, which RELEASES the idempotency reservation so a retry may send. That is only safe because nothing can
 * have been delivered when SES answers 4xx. With one recipient and a non-bulk SendEmail that holds structurally. Add
 * Cc / Bcc, a second To, or move to SendBulkEmail and a 4xx can follow PARTIAL delivery: the retry would send again to
 * people who already received it. This pin makes that change fail here instead of shipping as a "harmless" edit.
 *
 * The edge function runs under Deno and cannot be executed in this suite, so the property is asserted on its source.
 */
export {};
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/send-transactional-email/index.ts'), 'utf8');

describe('send-transactional-email sends exactly one message to exactly one recipient', () => {
  it('only the single-message SendEmail commands are used - never a bulk send', () => {
    expect(src).not.toMatch(/SendBulk/);
    expect(src).toMatch(/new SendEmailCommand\(/);
    expect(src).toMatch(/new SendEmailV2Command\(/);
  });

  it('every Destination is ToAddresses: [envelope.to] - one address, no Cc, no Bcc', () => {
    const destinations = src.match(/Destination:\s*\{[^}]*\}/g) ?? [];
    expect(destinations.length).toBeGreaterThanOrEqual(2);              // non-vacuous: v1 and v2 senders both found
    for (const d of destinations) {
      expect(d.replace(/\s+/g, ' ')).toBe('Destination: { ToAddresses: [envelope.to] }');
    }
    expect(src).not.toMatch(/CcAddresses|BccAddresses/);
  });

  it('CONTROL: the matcher would catch a widened destination', () => {
    const widened = 'Destination: { ToAddresses: [envelope.to], CcAddresses: [x] }';
    expect(widened.replace(/\s+/g, ' ')).not.toBe('Destination: { ToAddresses: [envelope.to] }');
  });
});
