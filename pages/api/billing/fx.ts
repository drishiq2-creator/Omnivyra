import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
/**
 * GET /api/billing/fx — public read of the live FX config (rates + market
 * overrides) for multi-currency DISPLAY. Read-only. Empty config = defaults; an UNREADABLE config = 503
 * PRICE_CONFIG_UNAVAILABLE (c6 2026-11-20). Charge currency is INR regardless of display.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getFxConfig, PriceConfigUnavailableError } from '@/backend/services/pricingConfigService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const fx = await getFxConfig();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(fx);
  } catch (err: any) {
    // An unreadable config is 503 with a code - never the raw DB message, never default rates presented as live.
    if (err instanceof PriceConfigUnavailableError) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: 'price_config_unavailable', code: err.code });
    }
    return res.status(500).json({ error: 'fx_failed' });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/billing/fx' });
