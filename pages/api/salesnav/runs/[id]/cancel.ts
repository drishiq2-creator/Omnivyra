import { createApiRoute as __createApiRoute } from '../../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { cancelRunSessionHandler } from '../../../../../backend/apiHandlers/salesNav/uiRoutes';

/** Sales Navigator route contract v0.3 - see backend/apiHandlers/salesNav/uiRoutes.ts. */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  return cancelRunSessionHandler(req, res);
}

export default __createApiRoute(handler, { route: '/api/salesnav/runs/[id]/cancel' });
