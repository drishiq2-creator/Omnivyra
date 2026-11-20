/**
 * Inline AI image budget (A8 step 2, b3 ruling 2026-11-20 - money exposure, BLOCKING class).
 *
 * POST /api/command-center/creator-content/render-inline is the LIVE AI image path. It called the paid
 * OpenAI image API with no cap and no charge. Until the guarded route (hold -> settle at a fixed per-image
 * price) replaces it, every PAID IMAGE it causes is counted against the company's daily budget:
 *
 *   - The route opens a REQUEST SCOPE (runWithInlineImageBudget). Only inside that scope does
 *     generateProviderImage take a unit (admitInlineImage) before building the OpenAI client. Every other
 *     path (worker, render-image) has no scope and is untouched.
 *   - One unit = one generateProviderImage call = one intended image. A carousel takes one per slide.
 *   - Per request: at most CREATOR_INLINE_IMAGE_REQUEST_CAP images (default 12).
 *   - Per company per UTC day: at most CREATOR_INLINE_IMAGE_DAILY_CAP images (default 40; 0 = AI images off).
 *     Counter: Redis INCR (lib/redis/canonicalClient), key per company per UTC day, TTL 26h.
 *   - FAIL CLOSED: Redis not configured, an error or a timeout -> refused (IMAGE_QUOTA_UNAVAILABLE). Never
 *     "allowed because we could not count".
 *   - A refusal is RECORDED in the scope (the renderer swallows provider failures into a non-AI fallback, so a
 *     throw would be lost); the route reads scope.refusal and answers the code instead of the fallback.
 *   - A unit taken for a call that then fails is NOT refunded (conservative: it also bounds retries).
 */
import { AsyncLocalStorage } from 'async_hooks';

export const IMAGE_DAILY_LIMIT_REACHED = 'IMAGE_DAILY_LIMIT_REACHED' as const;
export const IMAGE_REQUEST_LIMIT_REACHED = 'IMAGE_REQUEST_LIMIT_REACHED' as const;
export const IMAGE_QUOTA_UNAVAILABLE = 'IMAGE_QUOTA_UNAVAILABLE' as const;
/** Every refusal the budget can produce - exported as a VALUE so the route's status map is checked against it. */
export const INLINE_IMAGE_REFUSALS = [IMAGE_DAILY_LIMIT_REACHED, IMAGE_REQUEST_LIMIT_REACHED, IMAGE_QUOTA_UNAVAILABLE] as const;
export type InlineImageRefusal = (typeof INLINE_IMAGE_REFUSALS)[number];

export const DEFAULT_DAILY_CAP = 40;
export const DEFAULT_REQUEST_CAP = 12;
const QUOTA_TIMEOUT_MS = 2_500;
const KEY_TTL_MS = 26 * 3_600_000;

/** A malformed / negative value falls back to the default (never "unlimited"); 0 is a deliberate OFF. */
function capFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
export function dailyCap(): number { return capFrom(process.env.CREATOR_INLINE_IMAGE_DAILY_CAP, DEFAULT_DAILY_CAP); }
export function requestCap(): number { return capFrom(process.env.CREATOR_INLINE_IMAGE_REQUEST_CAP, DEFAULT_REQUEST_CAP); }

export interface InlineImageScope {
  readonly companyId: string;
  used: number;
  refusal: InlineImageRefusal | null;
  /** The daily count after the last admitted unit (evidence for logs). */
  dailyCount: number | null;
}

const storage = new AsyncLocalStorage<InlineImageScope>();

/** Run `fn` with a fresh image budget for `companyId`. The scope is returned alongside the result. */
export async function runWithInlineImageBudget<T>(companyId: string, fn: () => Promise<T>): Promise<{ result: T; scope: InlineImageScope }> {
  const scope: InlineImageScope = { companyId, used: 0, refusal: null, dailyCount: null };
  const result = await storage.run(scope, fn);
  return { result, scope };
}

/** UTC day number (the daily window resets at UTC midnight). */
export function utcDay(nowMs: number = Date.now()): number { return Math.floor(nowMs / 86_400_000); }
export function dailyKey(companyId: string, nowMs?: number): string { return `img:inline:co:${companyId}:${utcDay(nowMs)}`; }

/** Minimal surface of the Redis client we use (injected in tests). */
export interface QuotaRedis {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
}
type RedisSource = () => Promise<QuotaRedis | null>;

const defaultRedis: RedisSource = async () => {
  const { redisConfigured, getStandaloneRedis } = await import('../../../lib/redis/canonicalClient');
  if (!redisConfigured()) return null;
  return (await getStandaloneRedis('creator_inline_image_budget')) as unknown as QuotaRedis;
};
let redisSource: RedisSource = defaultRedis;
/** Test seam. */
export function __setInlineImageRedisForTests(src: RedisSource | null): void { redisSource = src ?? defaultRedis; }

function refuse(scope: InlineImageScope, code: InlineImageRefusal, detail: Record<string, unknown>): false {
  scope.refusal = code;
  console.warn('[creator-image] inline_image_refused', { event: 'inline_image_refused', code, companyId: scope.companyId, ...detail });
  return false;
}

/**
 * Called by generateProviderImage BEFORE any paid call. Outside a scope: true (not counted). Inside: takes one
 * unit or records the refusal and returns false (the caller must then make NO provider call).
 */
export async function admitInlineImage(): Promise<boolean> {
  const scope = storage.getStore();
  if (!scope) return true;
  if (scope.refusal) return false; // a refused request makes no further paid calls
  const perRequest = requestCap();
  if (scope.used >= perRequest) return refuse(scope, IMAGE_REQUEST_LIMIT_REACHED, { used: scope.used, cap: perRequest });
  const cap = dailyCap();
  if (cap === 0) return refuse(scope, IMAGE_DAILY_LIMIT_REACHED, { cap: 0, reason: 'disabled (cap 0)' });
  const key = dailyKey(scope.companyId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const count = await Promise.race([
      (async () => {
        const redis = await redisSource();
        if (!redis) throw new Error('redis_not_configured');
        const n = await redis.incr(key);
        if (n === 1) await redis.pexpire(key, KEY_TTL_MS);
        if (n > cap) { await redis.decr(key); return -n; }
        return n;
      })(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('quota_timeout')), QUOTA_TIMEOUT_MS); }),
    ]);
    if (count < 0) return refuse(scope, IMAGE_DAILY_LIMIT_REACHED, { count: -count, cap });
    scope.used += 1;
    scope.dailyCount = count;
    return true;
  } catch (err) {
    return refuse(scope, IMAGE_QUOTA_UNAVAILABLE, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTP mapping for every refusal - the route answers these instead of a silent non-AI fallback. */
export const INLINE_IMAGE_REFUSAL_HTTP: Readonly<Record<InlineImageRefusal, { status: number; message: string; retryAfterSeconds?: number }>> = {
  IMAGE_DAILY_LIMIT_REACHED: { status: 429, message: "Your company has reached today's AI image limit. It resets at midnight UTC." },
  IMAGE_REQUEST_LIMIT_REACHED: { status: 429, message: 'This request asks for more AI images than one request may generate.' },
  IMAGE_QUOTA_UNAVAILABLE: { status: 503, message: 'AI image generation is temporarily unavailable. Nothing was generated.', retryAfterSeconds: 30 },
};
