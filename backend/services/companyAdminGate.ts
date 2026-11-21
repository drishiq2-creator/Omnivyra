/**
 * requireCompanyAdmin — the server gate for admin-only pages (owner ruling 2026-11-20, via b3).
 *
 * It IS enforceRole([COMPANY_ADMIN, SUPER_ADMIN]): the same role read, the same super-admin / content-architect rules,
 * the same 401 / 400 / COMPANY_SCOPE_VIOLATION answers. The only difference is the member refusal, which carries a
 * machine code and the copy the pages render:
 *   403 { error: 'FORBIDDEN_ROLE', code: 'COMPANY_ADMIN_REQUIRED', message: 'Only company admins can manage this' }
 * (`error` is kept, so anything already matching enforceRole's FORBIDDEN_ROLE still matches.)
 *
 * Callers run enforceCompanyAccess FIRST, so a member of another company is refused as a non-member before this runs.
 *
 * DELIBERATELY NOT GATED, and why (7c NB2): GET /api/integrations and GET /api/integrations/[id] stay member-readable
 * because member pages use them (blogs/new, /leads). That is safe ONLY because their credentials are redacted for
 * non-admins (backend/services/integrationSecretRedaction.ts, hotfix #82). If that redaction is reverted or narrowed,
 * this decision is wrong and those GETs must be gated here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { enforceRole, Role } from './rbacService';
import { COMPANY_ADMIN_REQUIRED, COMPANY_ADMIN_REQUIRED_MESSAGE } from '../../shared/auth/companyAdminRequired';

export async function requireCompanyAdmin(input: {
  req: NextApiRequest;
  res: NextApiResponse;
  companyId: string | null;
}): Promise<{ userId: string; role: string } | null> {
  // enforceRole writes its refusal itself; capture it so the member case can be re-answered with the code.
  let captured: { status: number; body: unknown } | null = null;
  const capture = {
    status(code: number) { captured = { status: code, body: undefined }; return capture; },
    json(body: unknown) { if (captured) captured.body = body; return capture; },
    setHeader(name: string, value: string | number | readonly string[]) { input.res.setHeader(name, value); return capture; },
  };
  const ok = await enforceRole({
    req: input.req,
    res: capture as unknown as NextApiResponse,
    companyId: input.companyId,
    allowedRoles: [Role.COMPANY_ADMIN, Role.SUPER_ADMIN],
  });
  if (ok) return ok;

  const refusal = captured as { status: number; body: unknown } | null;
  if (!refusal) {
    // enforceRole returned null without answering: refuse closed, never fall through to the handler.
    input.res.status(403).json({ error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE });
    return null;
  }
  const body = refusal.body as { error?: unknown } | undefined;
  if (refusal.status === 403 && body?.error === 'FORBIDDEN_ROLE') {
    input.res.status(403).json({ error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE });
    return null;
  }
  input.res.status(refusal.status).json(refusal.body);
  return null;
}
