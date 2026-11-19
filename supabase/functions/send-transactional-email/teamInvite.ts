// team_invite copy (owner ruling 2026-11-19): "You've been invited to join <Company name> on <Platform>".
//
// The company and the platform display name come FROM THE PAYLOAD (emailJobsService.buildSendEnvelopeFromClaim
// passes companyName and platformName for every team invite). Both payload shapes render safely, so either
// deploy order of this function and the app is harmless:
//   - the old shape { recipientEmail, inviteUrl } (no companyName / platformName) -> "an <Platform> workspace",
//     with the platform name falling back to DEFAULT_PLATFORM_NAME;
//   - the new shape -> the company named in the payload, never any other.
// A missing / blank / non-string name falls back; a name is trimmed, stripped of control characters,
// whitespace-collapsed and length-bounded, and it reaches HTML only through escapeHtml.
//
// Dependency-free apart from ./escape.ts, so it is unit-tested under Node/jest.

import { escapeHtml } from "./escape.ts";

/** Used only when the payload carries no usable platform name (the pre-ruling payload shape). */
export const DEFAULT_PLATFORM_NAME = "Omnivyra";
export const MAX_COMPANY_NAME_LENGTH = 120;
export const MAX_PLATFORM_NAME_LENGTH = 60;

/** A display name fit for a subject line and a text node, or null when there is none. */
export function cleanDisplayName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  // deno-lint-ignore no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export type TeamInviteCopy = {
  /** Plain text (a mail header): no HTML, no line breaks. */
  subject: string;
  /** Plain text heading (the layout escapes it). */
  heading: string;
  /** HTML: every interpolated value is escaped here. */
  bodyHtml: string;
};

export function teamInviteCopy(input: { companyName?: unknown; platformName?: unknown }): TeamInviteCopy {
  const platform = cleanDisplayName(input.platformName, MAX_PLATFORM_NAME_LENGTH) ?? DEFAULT_PLATFORM_NAME;
  const company = cleanDisplayName(input.companyName, MAX_COMPANY_NAME_LENGTH);
  const subject = company
    ? `You've been invited to join ${company} on ${platform}`
    : `You've been invited to join an ${platform} workspace`;
  const target = company
    ? `<strong>${escapeHtml(company)}</strong> on ${escapeHtml(platform)}`
    : `an ${escapeHtml(platform)} workspace`;
  return {
    subject,
    heading: "You have been invited",
    bodyHtml: `You've been invited to join ${target}. Use the invitation link below to accept.`,
  };
}
