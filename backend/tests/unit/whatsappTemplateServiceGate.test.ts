/**
 * WhatsApp launch gate at the SERVICE layer of template submission (7c NB1, 2026-11-20).
 * submitTemplate is the fourth Meta egress function; like enqueueBroadcast / processBatch / retryFailed it asserts
 * the gate itself, so a caller other than the gated route (a backfill, a retry job, an admin tool) cannot submit a
 * template to Meta while WHATSAPP_CONNECT_ENABLED is not exactly 'true'.
 *   - OFF (unset, '1', 'TRUE', ' true'): throws WhatsAppNotAvailableError before ANY read or provider call;
 *   - CONTROL: ON ('true'): the function proceeds to its first read (the gate does not block a legitimate call).
 */
const reads: string[] = [];
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'update']) {
    b[m] = () => { if (m === 'select') reads.push(table); return b; };
  }
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'stop here' } }).then(res);
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => builder(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => builder(t) } }));
const tokenCalls: unknown[] = [];
jest.mock('../../auth/metaAuthService', () => ({ getValidAccessToken: async (...a: unknown[]) => { tokenCalls.push(a); return 'tok'; } }));
const fetchSpy = jest.fn();

import { submitTemplate } from '../../services/whatsappTemplateService';
import { WhatsAppNotAvailableError } from '../../services/whatsappAvailability';

const input = { company_id: 'co-1', template_name: 'welcome', language: 'en', category: 'MARKETING', components: [] } as any;
const prev = process.env.WHATSAPP_CONNECT_ENABLED;
beforeEach(() => { reads.length = 0; tokenCalls.length = 0; fetchSpy.mockReset(); (global as any).fetch = fetchSpy; });
afterAll(() => { if (prev === undefined) delete process.env.WHATSAPP_CONNECT_ENABLED; else process.env.WHATSAPP_CONNECT_ENABLED = prev; });

it.each([undefined, '1', 'TRUE', ' true', 'false'])('OFF (%s): throws WhatsAppNotAvailableError before any read or provider call', async (v) => {
  if (v === undefined) delete process.env.WHATSAPP_CONNECT_ENABLED; else process.env.WHATSAPP_CONNECT_ENABLED = v;
  await expect(submitTemplate(input)).rejects.toBeInstanceOf(WhatsAppNotAvailableError);
  expect(reads).toEqual([]);
  expect(tokenCalls).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('CONTROL: ON (exactly "true") the gate lets the call through to its first read', async () => {
  process.env.WHATSAPP_CONNECT_ENABLED = 'true';
  await submitTemplate(input).catch(() => undefined);
  expect(reads.length).toBeGreaterThan(0);
});
