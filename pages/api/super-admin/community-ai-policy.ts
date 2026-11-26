import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../../backend/db/supabaseClient';
import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';
import { isPlatformSuperAdmin } from '../../../backend/services/rbacService';
import { getLegacySuperAdminSession } from '../../../backend/services/superAdminSession';
import { requireCapability } from '../../../backend/security/requireCapability';
import { requireAdminRateLimit } from '../../../backend/services/requestAccessService';
import { INTELLIGENCE_OVERRIDE_MANAGE } from '../../../shared/contracts/security';
import { getTrustedClientIpOrNull } from '../../../lib/security/clientIp';

type PolicyInput = {
  execution_enabled?: boolean;
  auto_rules_enabled?: boolean;
  require_human_approval?: boolean;
};

/**
 * R26 F-1: values a save persists for fields the request does not name.
 *
 * With no policy row these are exactly the runtime's no-row defaults
 * (communityAiPlatformPolicyService DEFAULT_POLICY), so a save changes only
 * the field it names:
 *   - auto_rules_enabled: false. An absent field must never enable automatic
 *     execution (it was `?? true`, so the first save of ANY toggle - e.g.
 *     "require human approval" - also switched platform-wide auto rules on).
 *   - execution_enabled: true. Manual (human-initiated) sends stay available;
 *     defaulting false would silently kill the live inbox.
 *   - require_human_approval: false. Defaulting true would make every live
 *     inbox reply (pages/api/engagement/reply.ts executes source 'manual'
 *     with no approved_at) skip with HUMAN_APPROVAL_REQUIRED.
 * With an existing row its values are preserved; a non-boolean stored
 * auto_rules_enabled is never read as an authorisation (=== true).
 */
const NO_ROW_DEFAULTS = {
  execution_enabled: true,
  auto_rules_enabled: false,
  require_human_approval: false,
} as const;

type StoredPolicy = {
  execution_enabled?: unknown;
  auto_rules_enabled?: unknown;
  require_human_approval?: unknown;
} | null;

const resolveNextPolicy = (input: PolicyInput, existing: StoredPolicy) => {
  const stored = (key: 'execution_enabled' | 'require_human_approval'): boolean => {
    const value = existing?.[key];
    return typeof value === 'boolean' ? value : NO_ROW_DEFAULTS[key];
  };
  return {
    execution_enabled:
      typeof input.execution_enabled === 'boolean' ? input.execution_enabled : stored('execution_enabled'),
    auto_rules_enabled:
      typeof input.auto_rules_enabled === 'boolean'
        ? input.auto_rules_enabled
        : existing
          ? existing.auto_rules_enabled === true
          : NO_ROW_DEFAULTS.auto_rules_enabled,
    require_human_approval:
      typeof input.require_human_approval === 'boolean'
        ? input.require_human_approval
        : stored('require_human_approval'),
  };
};

// READ guard: bridge accepted via centralized helper (signature-validated +
// dry-run-aware). Mutations gate separately on `requireCapability`.
const requireSuperAdminRead = async (
  req: NextApiRequest,
  res: NextApiResponse
): Promise<{ userId: string; email: string | null } | null> => {
  const { user, error } = await getSupabaseUserFromRequest(req);
  if (!error && user?.id) {
    const isAdmin = await isPlatformSuperAdmin(user.id);
    if (isAdmin) return { userId: user.id, email: user.email || null };
  }
  const legacy = getLegacySuperAdminSession(req);
  if (legacy) {
    return { userId: legacy.userId, email: 'superadmin' };
  }
  res.status(401).json({ error: 'UNAUTHORIZED' });
  return null;
};

const fetchCurrentPolicy = async () => {
  // A thrown read is the same as an errored read: unreadable, never "no row".
  try {
    const { data, error } = await supabase
      .from('community_ai_platform_policy')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { policy: null, error };
    }
    return { policy: data || null, error: null };
  } catch (thrown) {
    return { policy: null, error: { code: (thrown as { code?: unknown })?.code ?? 'THREW' } };
  }
};

const resolveUpdatedByEmail = async (userId?: string | null) => {
  if (!userId) return null;
  const { data, error } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  if (error) return null;
  return data?.email || null;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const admin = await requireSuperAdminRead(req, res);
    if (!admin) return;
    const { policy, error } = await fetchCurrentPolicy();
    if (error) {
      // R26 F-1: a read failure is not "no policy". Answering 200 + null made
      // the console render the no-row defaults over a row it could not read,
      // and the next toggle saved those defaults over the real row.
      console.warn('[community-ai-policy] policy read failed', { code: (error as { code?: unknown })?.code ?? null });
      return res.status(503).json({ error: 'POLICY_UNREADABLE', policy: null, updated_by_email: null });
    }
    const updatedByEmail = await resolveUpdatedByEmail(policy?.updated_by);
    return res.status(200).json({
      policy: policy || null,
      updated_by_email: updatedByEmail,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Closure-014 (D): per-route write rate limit (before authorization and any business work).
  if (!(await requireAdminRateLimit(req, res, 'rl:super-admin:community-ai-policy', 10, 60, { sensitive: true }))) return;

  // Phase 2 mutation gate. INTELLIGENCE_OVERRIDE_MANAGE is held only by
  // canonical SUPER_ADMIN; bridge principals receive 403
  // CAPABILITY_NOT_HELD.
  const guard = await requireCapability(req, res, {
    capability: INTELLIGENCE_OVERRIDE_MANAGE,
    reason: 'community-AI platform policy mutation',
  });
  if (guard.ok !== true) return;
  const admin = { userId: guard.principal.userId, email: guard.principal.email || null };

  const input = (req.body || {}) as PolicyInput;
  const allowedKeys = ['execution_enabled', 'auto_rules_enabled', 'require_human_approval'];
  const hasUnknownKey = Object.keys(input).some((key) => !allowedKeys.includes(key));
  if (hasUnknownKey) {
    return res.status(400).json({ error: 'INVALID_FIELDS' });
  }
  const hasValidValue = Object.values(input).some((value) => typeof value === 'boolean');
  if (!hasValidValue) {
    return res.status(400).json({ error: 'NO_VALID_FIELDS' });
  }

  const { policy: existing, error: loadError } = await fetchCurrentPolicy();
  if (loadError) {
    // Refuse to write: without the current row we cannot preserve its values.
    return res.status(500).json({ error: 'FAILED_TO_LOAD_POLICY' });
  }

  const nextPolicy = resolveNextPolicy(input, existing);

  const updatedBy = admin.userId === 'super_admin_session' ? null : admin.userId;
  let savedPolicy = null;
  if (existing?.id) {
    const { data, error } = await supabase
      .from('community_ai_platform_policy')
      .update({
        ...nextPolicy,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      })
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_UPDATE_POLICY' });
    }
    savedPolicy = data;
  } else {
    const { data, error } = await supabase
      .from('community_ai_platform_policy')
      .insert({
        ...nextPolicy,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      })
      .select('*')
      .maybeSingle();
    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_CREATE_POLICY' });
    }
    savedPolicy = data;
  }

  await supabase.from('audit_logs').insert({
    actor_user_id: updatedBy,
    action: 'UPDATE_COMMUNITY_AI_PLATFORM_POLICY',
    metadata: {
      previous: existing || null,
      next: savedPolicy || null,
    },
    created_at: new Date().toISOString(),
  });

  await supabase.from('super_admin_audit_logs').insert({
    username: admin.email || admin.userId,
    action: 'update_policy',
    // SEC91-W2E: platform-trusted client IP, or null (was the raw client-written XFF header).
    ip_address: getTrustedClientIpOrNull(req),
    user_agent: req.headers['user-agent'] || null,
    created_at: new Date().toISOString(),
  });

  const updatedByEmail = await resolveUpdatedByEmail(savedPolicy?.updated_by);
  return res.status(200).json({ policy: savedPolicy, updated_by_email: updatedByEmail });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/super-admin/community-ai-policy' });
