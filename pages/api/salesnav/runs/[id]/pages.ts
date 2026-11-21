import { createApiRoute as __createApiRoute } from '../../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { pagesHandler } from '../../../../../backend/apiHandlers/salesNav/extensionRoutes';

/** Sales Navigator route contract v0.3 (extension, HMAC-signed) - see backend/apiHandlers/salesNav/extensionRoutes.ts. */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  return pagesHandler(req, res);
}

export default __createApiRoute(handler, { route: '/api/salesnav/runs/[id]/pages' });
