/**
 * THE ONE PORT for "which LinkedIn member does this USER use on the EXTENSION" (b3, 2026-11-21).
 *
 * PATH 1 (preferred, one store): read a9's extension_account_bindings (applied in production by EXPAND-35), written
 * by /api/extension/bind-account - which arrives on main with the stage-0 merge.
 * PATH 2 (ACTIVE until stage 0 is on main): salesnav_member_bindings via the store, written by /api/salesnav/bind,
 * with a9's exact rules (one active member per (company, user, transport); a different member -> 409).
 * In both paths the one-company-per-member owner row (073) is claimed, because the shared cap (074) keys on it.
 *
 * Switching path is ONE line: `activeExtensionBinding` below. Every route reads the binding through it (who the
 * user's member is, AND whether a member is bound in the company - resume and the quota reservation ask that), never
 * through a table directly, so the switch cannot leave a route reading the old store. `storeDepsFor` builds the
 * store deps that route every binding question through the port.
 */
import {
  bindSalesNavMember, boundMember, memberBoundInCompany, type BindOutcome, type SalesNavStoreDeps,
} from './store';
import type { SalesNavCallerContext } from './contract';

export interface ExtensionMemberBindingPort {
  readonly path: 'salesnav_member_bindings' | 'extension_account_bindings';
  /** The member the user has bound for the extension: the canonical id, null when none, or 'unreadable'. */
  memberFor(organizationId: string, userId: string, deps?: SalesNavStoreDeps): Promise<string | null | 'unreadable'>;
  /** Is the member bound for the extension by ANY user of the company? (resume, quota reservation) */
  boundInCompany(organizationId: string, member: string, deps?: SalesNavStoreDeps): Promise<boolean | 'unreadable'>;
  /** Bind the CALLING user's member (attested by the extension). */
  bind(ctx: SalesNavCallerContext, rawMemberId: unknown, deps?: SalesNavStoreDeps): Promise<BindOutcome>;
}

/** PATH 2: the store's own binding table, a9's rules. */
export const salesNavStoreBindingPort: ExtensionMemberBindingPort = {
  path: 'salesnav_member_bindings',
  memberFor: (org, userId, deps) => boundMember(org, userId, 'extension', deps),
  boundInCompany: (org, member, deps) => memberBoundInCompany(org, 'extension', member, deps),
  bind: (ctx, raw, deps) => bindSalesNavMember(ctx, 'extension', raw, deps),
};

/** THE switch (b3): path 2 until the stage-0 merge puts a9's writer on main; then a9's table reader goes here. */
export const activeExtensionBinding: ExtensionMemberBindingPort = salesNavStoreBindingPort;

/** Store deps that send EVERY binding question for the extension through the port (other transports: the store). */
export function storeDepsFor(port: ExtensionMemberBindingPort, base: SalesNavStoreDeps = {}): SalesNavStoreDeps {
  return {
    ...base,
    memberFor: (org, userId, transport) =>
      (transport === 'extension' ? port.memberFor(org, userId, base) : boundMember(org, userId, transport, base)),
    boundInCompany: (org, transport, member) =>
      (transport === 'extension' ? port.boundInCompany(org, member, base) : memberBoundInCompany(org, transport, member, base)),
  };
}
