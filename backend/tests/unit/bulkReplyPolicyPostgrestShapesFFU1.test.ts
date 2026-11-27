/**
 * F-FU1 (part C, owner 2026-11-27): the bulk-reply policy reader against the
 * ACTUAL response shapes produced by the installed @supabase/postgrest-js.
 *
 * No double of the client here: ownedDbTable returns a real PostgrestClient
 * builder whose fetch is faked at the HTTP layer, so every case below goes
 * through the library's own processResponse. That matters because the client
 * rewrites two non-answers into error-free results on its !res.ok path:
 *   - 404 with an empty body       -> { status: 204, data: null, error: null }
 *   - 404 with a JSON-array body   -> { status: 200, data: [],  error: null }
 * and a 200 with an empty body (an intermediary, not PostgREST) also yields
 * { status: 200, data: null }. Only a counted 200 from PostgREST
 * (Content-Range "* /0") proves "no row".
 *
 * Required semantics:
 *   genuine missing row        -> enabled (product default)
 *   read error / ambiguous     -> EngagementControlsUnreadableError (fail closed)
 *   disabled row               -> false
 */

jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));

jest.mock('../../db/writeOwner', () => {
  const { PostgrestClient } = jest.requireActual('@supabase/postgrest-js');
  const mockState = {
    next: null as null | (() => Response | Promise<Response>),
    calls: [] as { url: string; method: string; prefer: string | null }[],
  };
  const client = new PostgrestClient('http://postgrest.invalid', {
    // retry:false only removes backoff delays from the 5xx cases; the final
    // response is classified identically with retries on.
    retry: false,
    fetch: async (input: unknown, init?: { method?: string; headers?: HeadersInit }) => {
      mockState.calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        prefer: new Headers(init?.headers).get('Prefer'),
      });
      if (!mockState.next) throw new Error('test did not set a response');
      return mockState.next();
    },
  });
  return {
    ownedDbTable: (table: string) => client.from(table),
    __mockState: mockState,
  };
});

import {
  readBulkReplyEnabled,
  EngagementControlsUnreadableError,
} from '../../services/engagementGovernanceService';

const { __mockState: state } = jest.requireMock('../../db/writeOwner') as {
  __mockState: {
    next: null | (() => Response | Promise<Response>);
    calls: { url: string; method: string; prefer: string | null }[];
  };
};

const ORG = '11111111-1111-4111-8111-111111111111';
const json = { 'content-type': 'application/json; charset=utf-8' };

function respond(body: string, status: number, headers: Record<string, string> = {}) {
  state.next = () => new Response(body, { status, headers });
}

async function expectUnreadable(pattern?: RegExp) {
  const p = readBulkReplyEnabled(ORG);
  await expect(p).rejects.toBeInstanceOf(EngagementControlsUnreadableError);
  if (pattern) await expect(p).rejects.toThrow(pattern);
}

beforeEach(() => {
  state.next = null;
  state.calls.length = 0;
});

describe('genuine answers from PostgREST', () => {
  it('missing row: counted 200 "[]" with Content-Range */0 -> enabled (product default)', async () => {
    respond('[]', 200, { ...json, 'content-range': '*/0' });
    await expect(readBulkReplyEnabled(ORG)).resolves.toBe(true);
  });

  it('row disabled -> false', async () => {
    respond('[{"bulk_reply_enabled":false}]', 200, { ...json, 'content-range': '0-0/1' });
    await expect(readBulkReplyEnabled(ORG)).resolves.toBe(false);
  });

  it('row enabled -> true', async () => {
    respond('[{"bulk_reply_enabled":true}]', 200, { ...json, 'content-range': '0-0/1' });
    await expect(readBulkReplyEnabled(ORG)).resolves.toBe(true);
  });

  it('row with NULL value -> true (same as getControls `?? true`)', async () => {
    respond('[{"bulk_reply_enabled":null}]', 200, { ...json, 'content-range': '0-0/1' });
    await expect(readBulkReplyEnabled(ORG)).resolves.toBe(true);
  });

  it('the request asks for an exact count and is filtered to the organization', async () => {
    respond('[]', 200, { ...json, 'content-range': '*/0' });
    await readBulkReplyEnabled(ORG);
    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.method).toBe('GET');
    expect(call.prefer ?? '').toContain('count=exact');
    expect(call.url).toContain('/engagement_system_controls?');
    expect(call.url).toContain('select=bulk_reply_enabled');
    expect(call.url).toContain(`organization_id=eq.${ORG}`);
  });
});

describe('ambiguous responses fail CLOSED (the client reports no error for these)', () => {
  it('blank 404 (edge / WAF / paused project) -> client rewrites to 204 -> unreadable', async () => {
    respond('', 404);
    await expectUnreadable(/status 204/);
  });

  it('404 with a JSON-array body -> client rewrites to 200 + [] -> unreadable', async () => {
    respond('[]', 404, json);
    await expectUnreadable(/shape/);
  });

  it('200 with an EMPTY body (not a PostgREST answer) -> unreadable', async () => {
    respond('', 200);
    await expectUnreadable(/count missing/);
  });

  it('200 "[]" WITHOUT Content-Range (count not proven) -> unreadable', async () => {
    respond('[]', 200, json);
    await expectUnreadable(/count missing/);
  });

  it('a non-boolean value in the row -> unreadable', async () => {
    respond('[{"bulk_reply_enabled":"yes"}]', 200, { ...json, 'content-range': '0-0/1' });
    await expectUnreadable(/malformed/);
  });
});

describe('errors fail CLOSED', () => {
  it('two rows for one organization -> PGRST116 -> unreadable', async () => {
    respond('[{"bulk_reply_enabled":true},{"bulk_reply_enabled":false}]', 200, {
      ...json,
      'content-range': '0-1/2',
    });
    await expectUnreadable(/multiple/);
  });

  it('PostgREST JSON error (permission denied, 401) -> unreadable', async () => {
    respond('{"code":"42501","message":"permission denied for table engagement_system_controls"}', 401, json);
    await expectUnreadable(/permission denied/);
  });

  it('server error 500 with JSON body -> unreadable', async () => {
    respond('{"message":"internal error"}', 500, json);
    await expectUnreadable();
  });

  it('503 with an HTML body (gateway) -> unreadable', async () => {
    respond('<html>Service Unavailable</html>', 503, { 'content-type': 'text/html' });
    await expectUnreadable();
  });

  it('network failure (fetch rejects) -> the read never yields "enabled"', async () => {
    state.next = () => {
      throw new TypeError('fetch failed');
    };
    await expect(readBulkReplyEnabled(ORG)).rejects.toBeTruthy();
  });

  it('an empty organization id is refused before any request', async () => {
    await expect(readBulkReplyEnabled('')).rejects.toBeInstanceOf(EngagementControlsUnreadableError);
    expect(state.calls).toHaveLength(0);
  });
});
