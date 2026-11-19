/**
 * The platform's display name as it appears in transactional email copy.
 *
 * Owner ruling 2026-11-19 (invitation branding): the send-transactional-email template never hard-codes
 * the platform name for a team invite - it takes it from the payload. This is the ONE app-side source
 * the payload builders read (emailJobsService.buildSendEnvelopeFromClaim, emailService.sendInvite).
 */
export const PLATFORM_DISPLAY_NAME = 'Omnivyra';
