import { createHmac, timingSafeEqual, randomBytes, createHash } from 'crypto';
import { resolveSigningSecret, isSigningSecretUnavailable } from '../auth/signingSecrets';
import { isExtensionHandshakeStoreUnavailable, sha256Hex, storeRecordRequestNonce } from './extensionHandshakeStore';

/**
 * The products a session can be redeemed for (the extension's shared/product.js PRODUCTS). A session with no
 * product is a LEGACY session (combined source build, or a build older than the product split): it keeps the
 * pre-split behaviour everywhere.
 */
export const EXTENSION_PRODUCTS = ['salesnav', 'linkedin_engagement'] as const;
export type ExtensionProduct = (typeof EXTENSION_PRODUCTS)[number];
export const isExtensionProduct = (v: unknown): v is ExtensionProduct =>
  typeof v === 'string' && (EXTENSION_PRODUCTS as readonly string[]).includes(v);

export type ExtensionSessionPayload = {
  userId: string;
  orgId: string;
  expiresAt: number;
  // Nonce bound into the session token so the server can re-derive the
  // extension's HMAC secret on every request without persisting raw secrets.
  hmacNonce?: string;
  // Phase E: the product the session was redeemed for, bound into the SIGNED token (so a route can trust it).
  // Absent = legacy session. Not part of the HMAC-secret derivation (unchanged).
  product?: ExtensionProduct;
};

/**
 * SEC91-B1: dedicated secret, then AUTH_SECRET — nothing else. The chain used to continue
 * into NEXTAUTH_SECRET, the Supabase service-role API key, the BROWSER-PUBLIC anon key and
 * finally a literal committed to this repository, so an unconfigured deployment signed
 * tokens with a value anyone could read. Production resolves AUTH_SECRET (the dedicated
 * variable is unset), exactly as before, so already-issued tokens keep verifying.
 * Missing both → SigningSecretUnavailableError (fail closed).
 */
const EXTENSION_SESSION_SECRET_ENV = ['EXTENSION_SESSION_SECRET', 'AUTH_SECRET'] as const;

function getExtensionSessionSecret() {
  return resolveSigningSecret('extension session tokens', EXTENSION_SESSION_SECRET_ENV);
}

function toBase64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(payloadBase64: string) {
  return createHmac('sha256', getExtensionSessionSecret()).update(payloadBase64).digest('base64url');
}

export function issueExtensionSessionToken(input: ExtensionSessionPayload) {
  const payloadBase64 = toBase64Url(JSON.stringify(input));
  const signature = signPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export function verifyExtensionSessionToken(token: string | null | undefined): ExtensionSessionPayload | null {
  if (!token) return null;

  const [payloadBase64, signature] = token.split('.');
  if (!payloadBase64 || !signature) return null;

  let expectedSignature: string;
  try {
    expectedSignature = signPayload(payloadBase64);
  } catch (err) {
    // No signing secret configured: nothing can be verified — reject (fail closed).
    if (isSigningSecretUnavailable(err)) return null;
    throw err;
  }
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadBase64)) as ExtensionSessionPayload;
    if (!payload.userId || !payload.orgId || !payload.expiresAt) {
      return null;
    }
    // A product we do not know cannot have been issued by this server: refuse rather than guess.
    if (payload.product !== undefined && !isExtensionProduct(payload.product)) {
      return null;
    }
    if (Date.now() > payload.expiresAt) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Derive the HMAC secret issued to the extension. Given a session's
 * (userId, orgId, expiresAt, nonce) tuple, the secret is deterministic —
 * the server can recompute it on every request to verify signatures
 * without persisting raw secrets in a database.
 */
export function deriveExtensionHmacSecret(input: ExtensionSessionPayload & { nonce: string }) {
  const basis = `${input.userId}:${input.orgId}:${input.expiresAt}:${input.nonce}`;
  return createHmac('sha256', getExtensionSessionSecret())
    .update(`hmac-derive:${basis}`)
    .digest('base64url');
}

export function generateHmacNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Verify an HMAC-signed extension request.
 *
 * Headers expected on inbound requests:
 *   X-Omnivyra-Timestamp (unix seconds; must be within ±5 min)
 *   X-Omnivyra-Nonce     (per-request nonce; reject repeats)
 *   X-Omnivyra-Signature (hex HMAC-SHA256 over METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body))
 *
 * rawBody is the EXACT request body bytes as received (the extension's shared/requestSigner.js hashes the string it
 * sends; UTF-8 on the wire), never a re-serialisation of a parsed body. PATH is the pathname only: the extension
 * signs the endpoint path and the service worker appends `?organization_id=` to GETs AFTER signing, so the query
 * string is NOT covered by the signature and no route may authorise on it (the session token is authoritative).
 *
 * Replay (Phase E): the nonce is recorded in the shared store (extension_request_nonces) only AFTER the signature
 * verifies - an unsigned caller cannot fill the store - in one atomic first-use statement, keyed by
 * sha256(session hmac nonce : request nonce) and kept for REQUEST_NONCE_RETENTION_SECONDS. Any timestamp the
 * window accepts is at most 5 min from the server clock, so a replay later than 10 min after first use is already
 * refused by the window; 15 min retention covers that with margin. Store unreadable -> status 503, never ok.
 */
export const REQUEST_NONCE_RETENTION_SECONDS = 15 * 60;
const TIMESTAMP_WINDOW_SECONDS = 5 * 60;

export type ExtensionSignatureResult =
  | { ok: true }
  | { ok: false; reason: string; status: 401 | 503 };

export async function verifyExtensionRequestSignature(params: {
  method: string;
  path: string;
  rawBody: Buffer | string;
  timestampHeader: string | string[] | undefined;
  nonceHeader: string | string[] | undefined;
  signatureHeader: string | string[] | undefined;
  session: ExtensionSessionPayload;
}): Promise<ExtensionSignatureResult> {
  const take = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) || '';
  const timestamp = take(params.timestampHeader).trim();
  const nonce = take(params.nonceHeader).trim();
  const signature = take(params.signatureHeader).trim();
  const refuse = (reason: string): ExtensionSignatureResult => ({ ok: false, reason, status: 401 });

  if (!timestamp || !nonce || !signature) return refuse('MISSING_SIGNATURE_HEADER');
  if (!params.session.hmacNonce) return refuse('SESSION_MISSING_HMAC_NONCE');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return refuse('BAD_TIMESTAMP');
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_WINDOW_SECONDS) return refuse('TIMESTAMP_OUT_OF_WINDOW');

  let secret: string;
  try {
    secret = deriveExtensionHmacSecret({
      userId: params.session.userId,
      orgId: params.session.orgId,
      expiresAt: params.session.expiresAt,
      nonce: params.session.hmacNonce,
    });
  } catch (err) {
    if (isSigningSecretUnavailable(err)) return refuse('SIGNING_SECRET_UNAVAILABLE');
    throw err;
  }

  const raw = params.rawBody ?? '';
  const bodyHash = createHash('sha256').update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).digest('hex');
  const canonical = [
    String(params.method || 'GET').toUpperCase(),
    params.path,
    timestamp,
    nonce,
    bodyHash,
  ].join('\n');
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse('SIGNATURE_MISMATCH');

  try {
    const recorded = await storeRecordRequestNonce(
      sha256Hex(`${params.session.hmacNonce}:${nonce}`),
      REQUEST_NONCE_RETENTION_SECONDS,
    );
    if (recorded === 'replayed') return refuse('NONCE_REPLAYED');
  } catch (err) {
    if (isExtensionHandshakeStoreUnavailable(err)) return { ok: false, reason: 'REPLAY_STORE_UNAVAILABLE', status: 503 };
    throw err;
  }
  return { ok: true };
}
