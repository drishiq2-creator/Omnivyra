import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * RAW BODY (Phase E). The extension signs sha256 of the EXACT string it sends (shared/requestSigner.js:
 * `sha256Hex(body || '')` over the same `bodyString` passed to fetch). Verification used to hash
 * JSON.stringify(req.body) - a re-serialisation of Next's parse - which differs from the sent bytes for an empty
 * body sent as application/json (Next parses it to {} -> "{}"), integer-like keys (JSON.parse reorders them),
 * number spellings (1.0, 1e3), escaped unicode (a backslash-u escape is re-emitted as the raw character), whitespace, and text/plain string bodies.
 *
 * Every route that calls requireExtensionAuth therefore:
 *   1. exports `export const config = { api: { bodyParser: false } }` (Next must not consume the stream), and
 *   2. wraps its handler with withExtensionRawBody, which reads the bytes ONCE, keeps them on the request
 *      (EXTENSION_RAW_BODY) and sets req.body exactly as Next's default parser would have (so handlers are unchanged).
 * requireExtensionAuth hashes those bytes. If they were not captured on a request that can carry a body, it answers
 * 500 RAW_BODY_UNAVAILABLE (a wiring fault) instead of falling back to a re-serialisation.
 */
export const EXTENSION_RAW_BODY = Symbol.for('omnivyra.extension.rawBody');
const RAW_BODY_LIMIT_BYTES = 1024 * 1024; // Next's default bodyParser sizeLimit ('1mb'), unchanged

type RawBodyRequest = NextApiRequest & { [EXTENSION_RAW_BODY]?: Buffer };

export function capturedRawBody(req: NextApiRequest): Buffer | undefined {
  const raw = (req as RawBodyRequest)[EXTENSION_RAW_BODY];
  return Buffer.isBuffer(raw) ? raw : undefined;
}

class RawBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message); }
}

function readStream(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: Error) => { if (!done) { done = true; reject(e); } };
    req.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buf.length;
      if (size > RAW_BODY_LIMIT_BYTES) { fail(new RawBodyError(413, 'Body exceeded 1mb limit')); return; }
      chunks.push(buf);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => fail(new RawBodyError(400, 'Invalid body')));
  });
}

/** Next.js's default API body parsing (next/dist/server/api-utils/node/parse-body.js), applied to captured bytes. */
function parseLikeNext(raw: Buffer, contentTypeHeader: string | undefined): unknown {
  const type = String(contentTypeHeader || 'text/plain').split(';')[0].trim().toLowerCase();
  const text = raw.toString('utf8');
  if (type === 'application/json' || type === 'application/ld+json') {
    if (text.length === 0) return {};
    try { return JSON.parse(text); } catch { throw new RawBodyError(400, 'Invalid JSON'); }
  }
  if (type === 'application/x-www-form-urlencoded') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('querystring').decode(text);
  }
  return text;
}

/**
 * Wrap an extension-signed route handler: capture the raw request bytes before the handler runs. Requires the
 * route's `config.api.bodyParser = false`. A request whose stream was already consumed (bodyParser left on) or that
 * has no stream (an in-process caller that set req.body) is passed through untouched: no bytes are captured, so
 * requireExtensionAuth refuses any body it cannot hash exactly.
 */
export function withExtensionRawBody<H extends (req: NextApiRequest, res: NextApiResponse) => unknown>(handler: H): H {
  const wrapped = async (req: NextApiRequest, res: NextApiResponse) => {
    const isStream = typeof (req as { on?: unknown }).on === 'function' && (req as { readableEnded?: boolean }).readableEnded !== true;
    // Keyed on the STREAM, not on req.body: an unread request stream is captured whatever req.body holds.
    if (!capturedRawBody(req) && isStream) {
      let raw: Buffer;
      try {
        raw = await readStream(req);
        (req as RawBodyRequest)[EXTENSION_RAW_BODY] = raw;
        (req as { body: unknown }).body = parseLikeNext(raw, req.headers?.['content-type'] as string | undefined);
      } catch (err) {
        if (err instanceof RawBodyError) {
          return res.status(err.status).json({ success: false, error: err.message });
        }
        throw err;
      }
    }
    return handler(req, res);
  };
  return wrapped as unknown as H;
}
