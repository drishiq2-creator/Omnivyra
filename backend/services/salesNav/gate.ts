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

export interface SalesNavGateDeps {
  readonly env?: Record<string, string | undefined>;
  readonly evaluate?: typeof evaluateFeatureFlag;
  readonly readAck?: typeof readLatestSalesNavAck;
}

export async function salesNavRouteGate(
  ctx: SalesNavCallerContext, transport: SalesNavTransport, deps: SalesNavGateDeps = {},
): Promise<SalesNavGateDecision> {
  const env = deps.env ?? process.env;
  if (env[salesNavLegalSwitch(transport)] !== 'true') return { allowed: false, reason: 'legal_not_cleared' };

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
