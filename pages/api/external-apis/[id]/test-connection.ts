import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * POST /api/external-apis/[id]/test-connection
 *
 * Lightweight connection test. Resolves credentials on backend, never returns secrets.
 * Returns { success, status, message, latency_ms }.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  PLATFORM_SOURCE_SUPER_ADMIN_ONLY,
  testApiConnection,
} from '../../../../backend/services/apiConnectionTestService';
import { redactDiagnosticMessage } from '../../../../backend/services/externalApi/credentialReference';
import { checkRateLimit } from '../../../../lib/auth/rateLimit';
import { getLegacySuperAdminSession } from '../../../../backend/services/superAdminSession';
import { getSupabaseUserFromRequest } from '../../../../backend/services/supabaseAuthService';
import {
  getUserRole,
  getCompanyRoleIncludingInvited,
  hasPermission,
  isPlatformSuperAdmin,
  isSuperAdmin,
  Role,
} from '../../../../backend/services/rbacService';

type TestConnectionAccess = { userId: string; isPlatformAdmin: boolean };

const requirePlatformAdmin = async (
  req: NextApiRequest,
  res: NextApiResponse
): Promise<TestConnectionAccess | null> => {
  const legacySession = getLegacySuperAdminSession(req);
  if (legacySession) return { userId: legacySession.userId, isPlatformAdmin: true };
  const { user, error } = await getSupabaseUserFromRequest(req);
  if (error || !user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  if (await isPlatformSuperAdmin(user.id)) return { userId: user.id, isPlatformAdmin: true };
  if (await isSuperAdmin(user.id)) return { userId: user.id, isPlatformAdmin: true };
  res.status(403).json({ error: 'FORBIDDEN_ROLE' });
  return null;
};

const requireExternalApiAccess = async (
  req: NextApiRequest,
  res: NextApiResponse,
  companyId?: string
): Promise<TestConnectionAccess | null> => {
  if (!companyId) {
    res.status(400).json({ error: 'companyId required' });
    return null;
  }
  const legacySession = getLegacySuperAdminSession(req);
  if (legacySession) return { userId: legacySession.userId, isPlatformAdmin: true };
  const { user, error } = await getSupabaseUserFromRequest(req);
  if (error || !user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  if (await isPlatformSuperAdmin(user.id)) return { userId: user.id, isPlatformAdmin: true };
  if (await isSuperAdmin(user.id)) return { userId: user.id, isPlatformAdmin: true };
  let { role, error: roleError } = await getUserRole(user.id, companyId);
  if (!role && (roleError === 'COMPANY_ACCESS_DENIED' || roleError === null)) {
    const fallbackRole = await getCompanyRoleIncludingInvited(user.id, companyId);
    if (fallbackRole === Role.COMPANY_ADMIN || fallbackRole === Role.ADMIN || fallbackRole === Role.SUPER_ADMIN) {
      role = fallbackRole;
      roleError = null;
    }
  }
  if (roleError || !role) {
    res.status(403).json({ error: 'FORBIDDEN_ROLE' });
    return null;
  }
  return { userId: user.id, isPlatformAdmin: false };
};

/**
 * Round 26 (H-3): each test spends a provider call (on the platform's credentials for a
 * platform row) and writes a health record. Per-user budget, reusing the shared limiter
 * (Redis sliding window with its in-process fallback).
 */
const TEST_CONNECTION_RATE_LIMIT = { keyPrefix: 'rl:uid:external-api-test-connection', limit: 10, windowSecs: 60 };

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'API ID is required' });
  }

  const companyId = (req.query.companyId as string) || (req.body?.companyId as string);
  const platformScope = req.query.scope === 'platform';

  if (!companyId && !platformScope) {
    return res.status(400).json({ error: 'companyId or scope=platform required' });
  }

  const access = platformScope
    ? await requirePlatformAdmin(req, res)
    : await requireExternalApiAccess(req, res, companyId);
  if (!access) return;

  const rl = await checkRateLimit(access.userId, TEST_CONNECTION_RATE_LIMIT);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(TEST_CONNECTION_RATE_LIMIT.windowSecs));
    return res.status(429).json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' });
  }

  try {
    const result = await testApiConnection({
      apiId: id,
      companyId: companyId || null,
      platformScope,
      allowPlatformRows: access.isPlatformAdmin,
    });
    if (result.code === PLATFORM_SOURCE_SUPER_ADMIN_ONLY) {
      return res.status(403).json({ error: 'FORBIDDEN_ROLE', code: result.code, message: result.message });
    }
    return res.status(200).json(result);
  } catch (err: any) {
    const message = redactDiagnosticMessage(err?.message ?? 'Test failed');
    console.error('[external-apis/test-connection]', message);
    return res.status(500).json({
      success: false,
      status: 500,
      message,
      latency_ms: 0,
    });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/external-apis/:id/test-connection' });
