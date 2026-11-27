import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';

/**
 * Admin Intelligence API Presets API
 * Phase-2: Super Admin Governance
 * GET, POST, PUT, PATCH for external_api_sources where is_preset = true
 * Coexists with code-defined presets in externalApiPresets.ts
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { requireSuperAdmin } from '../../../../backend/middleware/requireSuperAdmin';
import {
  listApiPresets,
  createApiPreset,
  updateApiPreset,
  setApiPresetEnabled,
} from '../../../../backend/services/intelligenceGovernanceService';
// Round 26 (H-2 / H-4 for this route): presets are platform rows whose credential reference,
// headers and query params are served to tenant roles and whose base_url receives platform
// credentials. Validate them, and gate destination writes like credential writes.
import {
  checkConfigRecord,
  checkCredentialReference,
  checkDestinationUrl,
  type CredentialInputProblem,
} from '../../../../lib/security/credentialInputValidation';
import { requireCredentialDestinationWriteAuthority } from '../../../../backend/security/superAdminCredentialWriteGuards';

/** 400 naming the field and the rule — never the submitted value. */
function reject(res: NextApiResponse, problem: CredentialInputProblem) {
  return res.status(400).json({ error: problem.code, field: problem.field, detail: problem.message });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    switch (req.method) {
      case 'GET': {
        const presets = await listApiPresets();
        return res.status(200).json({ presets });
      }
      case 'POST': {
        const body = (req.body ?? {}) as {
          name: string;
          base_url: string;
          purpose?: string;
          category?: string | null;
          is_active?: boolean;
          method?: string;
          auth_type?: string;
          api_key_env_name?: string | null;
          headers?: Record<string, string>;
          query_params?: Record<string, string | number>;
        };
        // H-4: creating a preset sets a credential DESTINATION (base_url) and the credential
        // reference/templates resolved for it, so it needs step-up + platform write authority.
        if (!(await requireCredentialDestinationWriteAuthority(req, res, 'intelligence.api_presets.create'))) return;
        if (typeof body?.name !== 'string' || !body.name.trim() || typeof body?.base_url !== 'string' || !body.base_url.trim()) {
          return res.status(400).json({ error: 'name and base_url are required' });
        }
        // H-2: no raw key in the reference field, headers, query params or the URL itself.
        const problem =
          checkDestinationUrl('base_url', body.base_url) ??
          checkCredentialReference('api_key_env_name', body.api_key_env_name) ??
          checkConfigRecord('headers', body.headers) ??
          checkConfigRecord('query_params', body.query_params);
        if (problem) return reject(res, problem);
        const preset = await createApiPreset({
          name: body.name,
          base_url: body.base_url,
          purpose: body.purpose,
          category: body.category,
          is_active: body.is_active,
          method: body.method,
          auth_type: body.auth_type,
          api_key_env_name: body.api_key_env_name,
          headers: body.headers,
          query_params: body.query_params,
        });
        return res.status(201).json({ preset });
      }
      case 'PUT': {
        const body = (req.body ?? {}) as {
          id?: string;
          name?: string;
          base_url?: string;
          purpose?: string;
          category?: string | null;
          is_active?: boolean;
        };
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        // Only the fields the service updates are forwarded (explicit, not `...rest`).
        const params: { name?: string; base_url?: string; purpose?: string; category?: string | null; is_active?: boolean } = {};
        if (body.name !== undefined) params.name = body.name;
        if (body.purpose !== undefined) params.purpose = body.purpose;
        if (body.category !== undefined) params.category = body.category;
        if (body.is_active !== undefined) params.is_active = body.is_active;
        if (body.base_url !== undefined) {
          // H-4: moving a preset's base_url redirects every platform credential resolved for
          // it (account keys and env templates) — same custody as writing the credential.
          if (!(await requireCredentialDestinationWriteAuthority(req, res, 'intelligence.api_presets.base_url'))) return;
          const problem = checkDestinationUrl('base_url', body.base_url);
          if (problem) return reject(res, problem);
          params.base_url = body.base_url;
        }
        const preset = await updateApiPreset(id, params);
        return res.status(200).json({ preset });
      }
      case 'PATCH': {
        const { id, is_active } = req.body as { id: string; is_active: boolean };
        if (!id || typeof is_active !== 'boolean') {
          return res.status(400).json({ error: 'id and is_active (boolean) are required' });
        }
        const preset = await setApiPresetEnabled(id, is_active);
        return res.status(200).json({ preset });
      }
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    const message = (err as Error)?.message ?? 'Internal server error';
    return res.status(500).json({ error: message });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/admin/intelligence/api-presets' });
