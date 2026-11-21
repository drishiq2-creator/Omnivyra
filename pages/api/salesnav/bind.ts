import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { bindHandler } from '../../../backend/apiHandlers/salesNav/extensionRoutes';

/** Sales Navigator route contract v0.3 (extension, HMAC-signed) - see backend/apiHandlers/salesNav/extensionRoutes.ts. */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  return bindHandler(req, res);
}

export default __createApiRoute(handler, { route: '/api/salesnav/bind' });
