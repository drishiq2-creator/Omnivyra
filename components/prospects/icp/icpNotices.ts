/**
 * What an ICP workspace action's refusal means to the user - CLIENT-OWNED copy (c6 2026-11-20, 7c on 604809f64).
 *
 * The notices used to interpolate the server's `code` and `error` into user copy. That is the class 04 removed from
 * Settings → Security today (212d4b393): no shape test can tell whether a server string was written for a user, so
 * server text is never user copy. Here the copy is keyed on the HTTP STATUS the ICP routes answer
 * (pages/api/prospect-icp/{propose,ratify}.ts: 400 / 403 / 404 / 409 / 422) and the server's detail goes to the
 * console only (logIcpRefusal). The ICP refusal CODES are not a closed exported union (propose's 422 carries the
 * generator's reason), so status - a closed set - is the key.
 */
export type IcpAction = 'propose' | 'edit' | 'ratify';

const VERB: Record<IcpAction, string> = {
  propose: 'Could not generate a proposal.',
  edit: 'Could not save this edit.',
  ratify: 'Could not ratify this version.',
};

export function icpActionNotice(action: IcpAction, status: number | null): string {
  switch (status) {
    case 401: return 'Your session has ended. Sign in again.';
    case 403: return 'Only company admins can change the Ideal Customer Profile.';
    case 404: return `${VERB[action]} That version no longer exists. Refresh to see the current versions.`;
    case 409: return `${VERB[action]} The ICP was changed by someone else meanwhile. Refresh to see the current state.`;
    case 422:
      return action === 'propose'
        ? 'Could not generate a proposal: your company profile does not yet hold enough to propose an ICP from. Add more detail to the company profile, then generate again.'
        : `${VERB[action]} The request was not accepted.`;
    case 400: return `${VERB[action]} The change is not valid as entered.`;
    default: return `${VERB[action]} We could not confirm what happened. Refresh to check.`;
  }
}

/** The server's detail is for developers: logged, never shown. */
export function logIcpRefusal(action: IcpAction, status: number | null, body: unknown): void {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; error?: unknown };
  // eslint-disable-next-line no-console
  console.warn('[icp-workspace] action refused', { action, status, code: b.code ?? null, error: b.error ?? null });
}
