/**
 * The creative-review persona a platform role acts as on the enterprise-governance approval routes
 * (pages/api/enterprise-governance/approvals/comment.ts and decide.ts - one map for both).
 *
 * EVERY canonical role is mapped EXPLICITLY (Record<CanonicalRole, ...>: omitting one is a compile error).
 * Before roles Approach A, CONTENT_MANAGER / CONTENT_PLANNER reached these routes only as CONTENT_CREATOR
 * (normalizeRole rewrote them) and CONTENT_ENGAGER / VIEWER as VIEW_ONLY; after it they keep their identity,
 * and their persona was 'creative_operator' only because each route's `default:` happened to return it
 * (7c, 2026-11-20). The personas below are exactly the ones in force before this map: a change to the
 * fallback can no longer move a known role.
 *
 * 'creative_operator' is the least-privileged persona (cannot approve, reject or bypass review).
 *
 * CONTENT_MANAGER -> 'compliance_reviewer' (b3 ruling 2026-11-20, STATED behaviour change vs main): the owner ruled
 * CONTENT_MANAGER may "create, approve, publish". Of the two candidate personas, by their PERMISSIONS bodies
 * (creativeReviewRoles.ts): compliance_reviewer = approve_qa, approve_governance, reject, escalate;
 * campaign_manager = submit_for_review, reject, request_regeneration, manual_override, escalate, publish,
 * archive, campaign_lock - and NO approve_* action at any stage. So compliance_reviewer is the only one that can
 * approve, and the smaller set (it is also CONTENT_REVIEWER's persona, one of MANAGER's base tiers). On main a
 * CONTENT_MANAGER was refused 403 on decide (it read as CONTENT_CREATOR). Not granted here: publish /
 * manual_override (campaign_manager), approve_brand / approve_legal (no candidate has them).
 * The fallback applies ONLY to a value that is not a canonical role (null, the ADMIN alias, a stray string).
 */
import type { CanonicalRole } from '../../security/capabilityRegistry';
import type { CreativeReviewRole } from './creativeReviewRoles';

export const GOVERNANCE_REVIEW_PERSONA: Readonly<Record<CanonicalRole, CreativeReviewRole>> = Object.freeze({
  SUPER_ADMIN:       'executive_reviewer',
  COMPANY_ADMIN:     'campaign_manager',
  CONTENT_REVIEWER:  'compliance_reviewer',
  CONTENT_PUBLISHER: 'campaign_manager',
  CONTENT_CREATOR:   'creative_operator',
  CONTENT_MANAGER:   'compliance_reviewer', // b3 ruling 2026-11-20 - see below
  CONTENT_PLANNER:   'creative_operator',
  CONTENT_ENGAGER:   'creative_operator',
  VIEWER:            'creative_operator',
  VIEW_ONLY:         'creative_operator',
  CONTENT_ARCHITECT: 'creative_operator',
});

export const GOVERNANCE_REVIEW_PERSONA_FALLBACK: CreativeReviewRole = 'creative_operator';

export function governanceReviewPersona(role: string | null | undefined): CreativeReviewRole {
  if (typeof role === 'string' && Object.prototype.hasOwnProperty.call(GOVERNANCE_REVIEW_PERSONA, role)) {
    return GOVERNANCE_REVIEW_PERSONA[role as CanonicalRole];
  }
  return GOVERNANCE_REVIEW_PERSONA_FALLBACK;
}
