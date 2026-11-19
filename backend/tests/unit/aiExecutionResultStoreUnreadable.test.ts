/**
 * loadAiExecutionResult: a FAILED stored-result read is AiResultUnreadableError in BOTH forms - an error object AND a
 * thrown read (b3 standing rule, 2026-11-19; CI-609). Answered as "no stored result", the runtime re-ran the AI work
 * uncharged; a thrown read escaped as a raw error and became a 500 echoing its text. A row that WAS read but holds no
 * result is a real absence (null), and a readable stored result is returned.
 */
const mockRead = { mode: 'none' as 'none' | 'row' | 'error' | 'throw', row: null as unknown };

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (mockRead.mode === 'throw') throw new Error('socket hang up');
            if (mockRead.mode === 'error') return { data: null, error: { message: 'canceling statement due to statement timeout' } };
            return { data: mockRead.mode === 'row' ? mockRead.row : null, error: null };
          },
        }),
      }),
    }),
  },
}));
jest.mock('../../services/billing/enterpriseBillingOrchestrator', () => ({ openBillingOperation: jest.fn() }));

import { AiResultUnreadableError, loadAiExecutionResult } from '../../services/ai/aiExecutionResultStore';

beforeEach(() => { mockRead.mode = 'none'; mockRead.row = null; });

it.each(['error', 'throw'] as const)('the read FAILS (%s) -> AiResultUnreadableError, never "no stored result"', async (mode) => {
  mockRead.mode = mode;
  const p = loadAiExecutionResult('key-1');
  await expect(p).rejects.toBeInstanceOf(AiResultUnreadableError);
  await expect(p).rejects.toMatchObject({ code: 'AI_RESULT_UNREADABLE', retryable: true });
});

it('NEGATIVE CONTROL: a readable read with no row is a real absence -> null', async () => {
  await expect(loadAiExecutionResult('key-1')).resolves.toBeNull();
});

it('NEGATIVE CONTROL: a readable row with a v1 result returns it', async () => {
  mockRead.mode = 'row';
  mockRead.row = { metadata: { ai_result: { v: 1, action: 'content_basic', saved_at: '2026-11-19T00:00:00Z', payload: { a: 'b' } } } };
  await expect(loadAiExecutionResult('key-1')).resolves.toMatchObject({ v: 1, payload: { a: 'b' } });
});
