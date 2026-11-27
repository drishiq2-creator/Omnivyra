/**
 * salesNavRouteGate - the ONE gate every Sales Navigator route passes before it reads anything (contract v2.2;
 * extension a9, RPA 89, API vendors c6). Default OFF. Allowed only when ALL hold, and it FAILS CLOSED on any lookup
 * error:
 *   1. LEGAL CLEARANCE for the transport (owner, after the per-transport legal review - PL-170): the platform switch
 *      SALESNAV_<TRANSPORT>_LEGAL_CLEARED === 'true' (strict; anything else is OFF);
 *   2. the company's `salesnav_extraction` flag AND its `salesnav_transport_<transport>` flag (featureFlagService; no
 *      row = OFF), flipped per company by the owner;
 *   3. a LinkedIn-restriction acknowledgement for (company, transport) at the CURRENT text version (restrictionAck).
 * The order is fixed so the first closed condition names itself in `reason`.
 */
import { evaluateFeatureFlag } from '../featureFlagService';
import type { SalesNavCallerContext, SalesNavGateDecision, SalesNavTransport } from './contract';
import { ackCoversCurrentText, readLatestSalesNavAck } from './restrictionAck';

export const SALESNAV_EXTRACTION_FLAG = 'salesnav_extraction';
export const salesNavTransportFlag = (t: SalesNavTransport): string => `salesnav_transport_${t}`;
export const salesNavLegalSwitch = (t: SalesNavTransport): string => `SALESNAV_${t.toUpperCase()}_LEGAL_CLEARED`;

/**
 * Round 30 / P0-1: the LEGAL switch alone, for the routes that must stop under the legal stop but cannot take the
 * whole gate (/ack records the acknowledgement the gate requires; /bind precedes it). STRICT and FAIL-CLOSED: only the
 * exact string 'true' clears; false, unset, '', 'TRUE', ' true', '1' - and an environment that cannot be read - do not.
 */
export function salesNavLegalCleared(
  transport: SalesNavTransport, env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    return env[salesNavLegalSwitch(transport)] === 'true';
  } catch {
    return false;
  }
}

/**
 * The ONE body a route answers while the legal switch is closed. It names the closed condition and nothing else:
 * no run, binding, member, acknowledgement or tenant state, so a refused caller learns nothing about the company.
 */
export const SALESNAV_LEGAL_STOP_BODY = Object.freeze({ error: 'GATE_CLOSED', reason: 'legal_not_cleared' });

export interface SalesNavGateDeps {
  readonly env?: Record<string, string | undefined>;
  readonly evaluate?: typeof evaluateFeatureFlag;
  readonly readAck?: typeof readLatestSalesNavAck;
}

export async function salesNavRouteGate(
  ctx: SalesNavCallerContext, transport: SalesNavTransport, deps: SalesNavGateDeps = {},
): Promise<SalesNavGateDecision> {
  if (!salesNavLegalCleared(transport, deps.env ?? process.env)) return { allowed: false, reason: 'legal_not_cleared' };

  const evaluate = deps.evaluate ?? evaluateFeatureFlag;
  for (const flagKey of [SALESNAV_EXTRACTION_FLAG, salesNavTransportFlag(transport)]) {
    try {
      const r = await evaluate({ organizationId: ctx.organizationId, flagKey, cohortKey: null });
      if (!r.enabled) return { allowed: false, reason: `tenant_flag_off:${flagKey}` };
    } catch {
      return { allowed: false, reason: `flag_unreadable:${flagKey}` };
    }
  }

  const latest = await (deps.readAck ?? readLatestSalesNavAck)(ctx.organizationId, transport);
  if (latest === 'unreadable') return { allowed: false, reason: 'ack_unreadable' };
  if (!ackCoversCurrentText(latest)) return { allowed: false, reason: latest ? 'ack_text_changed' : 'ack_missing' };
  return { allowed: true, reason: 'cleared' };
}
