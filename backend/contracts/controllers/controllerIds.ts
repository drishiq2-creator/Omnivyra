/**
 * Controller identities (Agent A, controller foundation, 2026-11-28).
 *
 * STRUCTURAL CONTRACT ONLY. Nothing at runtime imports this yet: no service is
 * wired to these ids, no bus carries these events, no table stores them. The
 * ids exist so the event catalogue, the controller register and the business
 * rules can refer to one closed set instead of free-form strings.
 *
 * See docs/adr/ADR-0001-five-controllers-and-shared-services.md.
 */

export const CONTROLLER_IDS = [
  'lead_intelligence',
  'engagement_intelligence',
  'outreach_orchestration',
  'voice_sdr',
  'channel_execution',
] as const;

export type ControllerId = (typeof CONTROLLER_IDS)[number];

export function isControllerId(value: unknown): value is ControllerId {
  return typeof value === 'string' && (CONTROLLER_IDS as readonly string[]).includes(value);
}
