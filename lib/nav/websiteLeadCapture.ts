/**
 * Website & lead-capture destinations (owner request 2026-11-20, via b3). They used to be the header's
 * "Web & Capture" menu. They now live in a "Website & lead capture" section at the BOTTOM of the Command Center,
 * for company admins only. Routes are unchanged: every old deep link still resolves. One list, used by that section
 * (and by any future Integrations page), so the destinations can't drift.
 */
export interface WebsiteLeadCaptureLink {
  label: string;
  href: string;
  description: string;
}

export const WEBSITE_LEAD_CAPTURE_LINKS: readonly WebsiteLeadCaptureLink[] = [
  { label: 'Website Setup', href: '/website-setup', description: 'Connect a website, verify your domain, install tracking, and activate lead capture.' },
  { label: 'Website Health', href: '/website-health', description: 'Integration, tracking, lead capture, intelligence & one-click validation.' },
  { label: 'Website Integrations', href: '/integrations?focus=website', description: 'Manage CMS connections and lead webhooks.' },
  { label: 'Forms', href: '/leads?tab=forms', description: 'Build and embed lead-capture forms.' },
  { label: 'Lead Capture', href: '/lead-capture', description: 'Capture topology, attribution continuity, and activation readiness.' },
];

/** Company-admin roles (the header's existing rule, now shared): COMPANY_ADMIN, SUPER_ADMIN, ADMIN. */
export function isCompanyAdminRole(role: string | null | undefined): boolean {
  const r = (role || '').toUpperCase();
  return r === 'COMPANY_ADMIN' || r === 'SUPER_ADMIN' || r === 'ADMIN';
}
