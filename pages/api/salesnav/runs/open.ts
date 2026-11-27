import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { openRunHandler } from '../../../../backend/apiHandlers/salesNav/extensionRoutes';
import { withExtensionRawBody } from '../../../../backend/middleware/extensionRawBody';

/** Sales Navigator route contract v0.3 (extension, HMAC-signed) - see backend/apiHandlers/salesNav/extensionRoutes.ts. */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  return openRunHandler(req, res);
}

// Phase E: the extension request signature covers the RAW body bytes - Next must not consume the stream;
// withExtensionRawBody captures them and parses req.body exactly as the default parser did.
export const config = { api: { bodyParser: false } };
export default __createApiRoute(withExtensionRawBody(handler), { route: '/api/salesnav/runs/open' });
