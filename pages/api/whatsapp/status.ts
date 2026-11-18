import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * GET /api/whatsapp/status  ->  200 { enabled: boolean }
 *
 * Launch gate (b3, 11-18): tells the UI whether WhatsApp connect / broadcast entry points may be shown.
 * GLOBAL (not per company): it reflects WHATSAPP_CONNECT_ENABLED === 'true' only, and reveals no tenant data.
 * Any signed-in user may call it (admin or not); unauthenticated -> 401. The UI must treat anything other
 * than a 200 with enabled === true as DISABLED (fail closed). The UI gate is cosmetic: the server routes
 * refuse with 409 WHATSAPP_NOT_AVAILABLE on their own while the flag is off.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSupabaseUserFromRequest } from '../../../backend/services/supabaseAuthService';
import { isWhatsAppEnabled } from '../../../backend/services/whatsappAvailability';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user, error: authError } = await getSupabaseUserFromRequest(req);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ enabled: isWhatsAppEnabled() });
}

export default __createApiRoute(handler, { route: '/api/whatsapp/status' });
