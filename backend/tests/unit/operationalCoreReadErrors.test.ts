/**
 * operationalCoreService: a failed database read/write is a FAILURE, never "no row" (dropped-error class, b3 2026-11-20).
 *
 * The decision site: setStatus validates the transition against the CURRENT status, and validateTransition lets
 * ANY known state through when the previous status is null (first assignment). Before this fix a failed status read
 * returned null, so a terminal lead ('won' -> only 'archived') could be moved to 'working': the guard failed open.
 * Each failure assertion is paired with a control that passes through the same path with a successful read.
 */
export {}; // an ES module: a require-only test file is a global script, and its helpers collide with other files' (CI-496)

type Resp = { data: unknown; error: unknown };
const calls: Array<{ table: string; verb: string }> = [];
let responses: Record<string, Resp> = {};

function builder(table: string) {
  let verb = '';
  const proxy: any = new Proxy(function () { /* chain */ }, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const r = responses[`${table}:${verb}`] ?? { data: null, error: null };
        return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(r).then(res, rej);
      }
      return (..._args: unknown[]) => {
        if (!verb && ['select', 'insert', 'update', 'upsert'].includes(prop)) {
          verb = prop;
          calls.push({ table, verb });
        }
        return proxy;
      };
    },
  });
  return proxy;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => builder(t) }));
jest.mock('../../services/leadIntelligence/leadIntelligenceRepository', () => ({ appendLeadEvent: jest.fn() }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ops = require('../../services/operations/operationalCoreService');

const REF = { companyId: 'co-1', entityType: 'canonical_lead', entityId: 'lead-1' };
const ALIASED = { ...REF, aliasEntityIds: ['lead-old'] };
const ACTOR = { userId: 'u-1' };
const FAIL = { data: null, error: { message: 'connection reset' } };
const wrote = (table: string, verb: string) => calls.some((c) => c.table === table && c.verb === verb);

beforeEach(() => { calls.length = 0; responses = {}; });

describe('setStatus: the transition guard must not fail open', () => {
  it('CONTROL (scenario exists): a terminal "won" lead cannot move to "working" (409, nothing written)', async () => {
    responses['operational_states:select'] = { data: { status: 'won', changed_at: '2026-11-01T00:00:00Z' }, error: null };
    await expect(ops.setStatus(REF, ACTOR, 'working')).rejects.toMatchObject({ code: 'invalid_transition:not_allowed', httpStatus: 409 });
    expect(wrote('operational_states', 'upsert')).toBe(false);
  });
  it('a FAILED status read refuses with 503 and writes nothing (was: read as null -> any transition allowed)', async () => {
    responses['operational_states:select'] = FAIL;
    await expect(ops.setStatus(REF, ACTOR, 'working')).rejects.toMatchObject({ code: 'status_read_failed', httpStatus: 503 });
    expect(wrote('operational_states', 'upsert')).toBe(false);
  });
  it('same on the alias path (several keys)', async () => {
    responses['operational_states:select'] = FAIL;
    await expect(ops.setStatus(ALIASED, ACTOR, 'working')).rejects.toMatchObject({ code: 'status_read_failed', httpStatus: 503 });
    expect(wrote('operational_states', 'upsert')).toBe(false);
  });
  it('CONTROL (genuinely empty): no status row yet -> the first status is written', async () => {
    responses['operational_states:select'] = { data: null, error: null };
    await expect(ops.setStatus(REF, ACTOR, 'working')).resolves.toEqual({ status: 'working', previous: null });
    expect(wrote('operational_states', 'upsert')).toBe(true);
  });
});

describe('assign: one active assignment', () => {
  it('a FAILED deactivation stops the insert (was: a second active row)', async () => {
    responses['operational_assignments:update'] = FAIL;
    await expect(ops.assign(REF, ACTOR, 'u-2')).rejects.toMatchObject({ code: 'assignment_deactivate_failed', httpStatus: 500 });
    expect(wrote('operational_assignments', 'insert')).toBe(false);
  });
  it('CONTROL: a successful deactivation inserts the new assignment', async () => {
    await expect(ops.assign(REF, ACTOR, 'u-2')).resolves.toBeUndefined();
    expect(wrote('operational_assignments', 'insert')).toBe(true);
  });
  it('unassign: a failed insert is reported, not swallowed', async () => {
    responses['operational_assignments:insert'] = FAIL;
    await expect(ops.unassign(REF, ACTOR)).rejects.toMatchObject({ code: 'unassign_write_failed' });
  });
});

describe('reads: a failure is 503, an empty success is empty', () => {
  const cases: Array<[string, string, () => Promise<unknown>]> = [
    ['getAssignment', 'operational_assignments', () => ops.getAssignment(REF)],
    ['getAssignment (aliases)', 'operational_assignments', () => ops.getAssignment(ALIASED)],
    ['listAssignmentsForUser', 'operational_assignments', () => ops.listAssignmentsForUser('co-1', 'u-1')],
    ['listNotes', 'operational_notes', () => ops.listNotes(REF)],
    ['listTasks', 'operational_tasks', () => ops.listTasks(REF)],
  ];
  it.each(cases)('%s: failure -> 503', async (_n, table, run) => {
    responses[`${table}:select`] = FAIL;
    await expect(run()).rejects.toMatchObject({ httpStatus: 503 });
  });
  it.each(cases)('%s: CONTROL empty success resolves', async (_n, table, run) => {
    responses[`${table}:select`] = { data: [], error: null };
    await expect(run()).resolves.not.toBeUndefined();
  });
  it('the workspace overlay surfaces a failed read instead of rendering an empty operational layer', async () => {
    responses['operational_notes:select'] = FAIL;
    await expect(ops.getOperationalOverlay(REF)).rejects.toMatchObject({ code: 'notes_read_failed', httpStatus: 503 });
  });
  it('note pin/delete failures are reported', async () => {
    responses['operational_notes:update'] = FAIL;
    await expect(ops.setNotePinned('co-1', 'n-1', ACTOR, true)).rejects.toMatchObject({ code: 'note_update_failed' });
    await expect(ops.deleteNote('co-1', 'n-1', ACTOR)).rejects.toMatchObject({ code: 'note_update_failed' });
  });
});
