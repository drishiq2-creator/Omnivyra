/**
 * b3 standing rule (2026-11-20): on a DB-FAILURE path, never await a durable write into the same failing database
 * before answering. The durable failure record (notificationFailureRecord) is therefore:
 *   - FIRE-AND-FORGET when the undeliverable reason IS a database failure (membership_unreadable, insert_failed) and
 *     in reportNotificationInsertFailure (its path is always a failed insert);
 *   - AWAITED when the database answered (no_active_recipient, invalid_input), so the record lands even on serverless.
 * Proven with a record write that NEVER settles: the fire-and-forget paths still answer; the awaited path does not.
 */
jest.mock('../../db/supabaseClient', () => {
  const from = (t: string) => require('../helpers/fakeWhatsappDb').fakeTable(t);
  return { supabase: { from }, default: { from } };
});
jest.mock('../../observability', () => ({ recordRawCounter: jest.fn() }));
const recordCalls: Array<Record<string, unknown>> = [];
jest.mock('../../services/notificationFailureRecord', () => ({
  recordNotificationFailure: (input: Record<string, unknown>) => { recordCalls.push(input); return new Promise(() => undefined); },
}));

import { resetFakeDb, failNext } from '../helpers/fakeWhatsappDb';
import { notifyCompanyEvent, reportNotificationInsertFailure } from '../../services/userNotificationService';

const CO = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const event = { companyId: CO, type: 'credit_alert', title: 'Credit alert', message: 'm' } as const;
const settlesWithin = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
let err: jest.SpyInstance;
beforeEach(() => { recordCalls.length = 0; err = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => err.mockRestore());

it('membership_unreadable (a DB failure): answers WITHOUT waiting for the durable record', async () => {
  resetFakeDb({ notifications: [], user_company_roles: [{ user_id: ADMIN, company_id: CO, role: 'COMPANY_ADMIN', status: 'active' }] });
  failNext('user_company_roles', 'select');
  await expect(settlesWithin(notifyCompanyEvent(event as never), 200)).resolves.toBe('settled');
  expect(recordCalls).toEqual([expect.objectContaining({ reason: 'membership_unreadable' })]);
});

it('insert_failed (a DB failure): answers WITHOUT waiting for the durable record', async () => {
  resetFakeDb({ notifications: [], user_company_roles: [{ user_id: ADMIN, company_id: CO, role: 'COMPANY_ADMIN', status: 'active' }] });
  failNext('notifications', 'insert');
  await expect(settlesWithin(notifyCompanyEvent(event as never), 200)).resolves.toBe('settled');
  expect(recordCalls).toEqual([expect.objectContaining({ reason: 'insert_failed' })]);
});

it('reportNotificationInsertFailure (always a failed insert): returns WITHOUT waiting', async () => {
  await expect(settlesWithin(reportNotificationInsertFailure('assignment', { message: 'refused' }, 'x.ts:1'), 200)).resolves.toBe('settled');
  expect(recordCalls).toEqual([expect.objectContaining({ reason: 'insert_failed', type: 'assignment' })]);
});

it('CONTROL - no_active_recipient (the DB answered): the durable record IS awaited (still pending here)', async () => {
  resetFakeDb({ notifications: [], user_company_roles: [] });
  await expect(settlesWithin(notifyCompanyEvent(event as never), 200)).resolves.toBe('pending');
  expect(recordCalls).toEqual([expect.objectContaining({ reason: 'no_active_recipient', companyId: CO })]);
});
