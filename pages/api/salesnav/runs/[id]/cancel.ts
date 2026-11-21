import { createApiRoute as __createApiRoute } from '../../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { cancelRunSessionHandler } from '../../../../../backend/apiHandlers/salesNav/uiRoutes';
import { cancelRunExtensionHandler } from '../../../../../backend/apiHandlers/salesNav/extensionRoutes';

/**
 * POST /api/salesnav/runs/:id/cancel - from the web app (browser session) OR the extension popup (a9: the popup has
 * no browser session). A request carrying the extension's v15 signature header is verified as the extension
 * (requireExtensionAuth); every other request goes through the session guard. Same effect either way.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const signed = Boolean(req.headers?.['x-omnivyra-signature']);
  return signed ? cancelRunExtensionHandler(req, res) : cancelRunSessionHandler(req, res);
}

export default __createApiRoute(handler, { route: '/api/salesnav/runs/[id]/cancel' });
