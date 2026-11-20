import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
/**
 * GET /api/billing/topup/catalog
 *
 * Returns the top-up catalog (single source of truth — `lib/billing/topupCatalog.ts`)
 * so the UI never hardcodes packs. Read-only; no auth-sensitive data.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { TOPUP_PACKS } from '@/lib/billing/topupCatalog';
import { isTopUpPurchaseOpen } from '../../../../backend/services/billing/topUpAvailability';

function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  // no-store (04, 2026-11-20; 7c): `purchases_open` depends on the environment's payment mode. A shared 5-minute cache
  // would keep offering Buy for up to 5 minutes after a switch BACK to test, when no purchase can complete.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    packs: TOPUP_PACKS.map((p) => ({
      id: p.id,
      credits: p.credits,
      price: p.price,
      currency: p.currency,
      label: p.label,
    })),
    note: 'Top-up credits are consumed after monthly plan credits and never expire.',
    // false in production until live payments (backend/services/billing/topUpAvailability.ts): a purchase started
    // there could never complete (completePurchase refuses test-mode grants in prod), so the panel shows no Buy.
    purchases_open: isTopUpPurchaseOpen(),
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/billing/topup/catalog' });
