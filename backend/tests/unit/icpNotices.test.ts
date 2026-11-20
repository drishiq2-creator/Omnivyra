/**
 * ICP workspace refusal copy is CLIENT-OWNED and keyed on status (c6 2026-11-20, 7c on 604809f64): server `code` /
 * `error` never reach the screen; they are logged.
 */
import { icpActionNotice, logIcpRefusal, type IcpAction } from '../../../components/prospects/icp/icpNotices';

const ACTIONS: IcpAction[] = ['propose', 'edit', 'ratify'];
// Every status the ICP routes answer for a refused action (propose.ts / ratify.ts), plus "no answer".
const STATUSES: Array<number | null> = [400, 401, 403, 404, 409, 422, 500, 503, null];

describe('icpActionNotice', () => {
  it.each(ACTIONS.flatMap((a) => STATUSES.map((s) => [a, s] as const)))('%s / %s -> a non-empty client sentence', (a, s) => {
    const n = icpActionNotice(a, s);
    expect(n.length).toBeGreaterThan(10);
    expect(n).not.toMatch(/[A-Z]{3,}_[A-Z_]+|[a-z]+_[a-z_]+/); // no UPPER_SNAKE / lower_snake identifiers
  });
  it('403 is the admin-only sentence for every action', () => {
    for (const a of ACTIONS) expect(icpActionNotice(a, 403)).toBe('Only company admins can change the Ideal Customer Profile.');
  });
  it('a 422 on propose explains the evidence gap; unknown statuses never claim success', () => {
    expect(icpActionNotice('propose', 422)).toMatch(/company profile/);
    for (const a of ACTIONS) expect(icpActionNotice(a, 503)).toMatch(/could not confirm/i);
  });
});

describe('logIcpRefusal', () => {
  it('logs the server code and error (for developers) - the only place they go', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    logIcpRefusal('ratify', 409, { code: 'already_ratified', error: 'version 2 is already ratified' });
    expect(warn).toHaveBeenCalledWith('[icp-workspace] action refused',
      { action: 'ratify', status: 409, code: 'already_ratified', error: 'version 2 is already ratified' });
    warn.mockRestore();
  });
});
