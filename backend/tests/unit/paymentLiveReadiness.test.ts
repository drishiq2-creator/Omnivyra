/**
 * Go-live readiness (b3 2026-11-20): the owner's sitting must be "paste keys", and any mismatch must FAIL CLOSED with a
 * clear code - never a silent fallback to test keys. Env NAMES only; values here are fakes.
 */
import { getActiveMode, validateConfiguredProviders, requiredEnvNames, CRED_ENV, PaymentModeInvalidError } from '../../services/payments/orchestrator/providerConfig';
import { PROVIDER_REGISTRY } from '../../services/payments/orchestrator/providerRegistry';
import { checkPaymentReadiness } from '../../services/payments/paymentReadiness';

const NAMES = [
  'PAYMENT_PROVIDER_MODE',
  ...Object.values(CRED_ENV.test).flatMap((e) => [e!.id, e!.secret, e!.webhook]),
  ...Object.values(CRED_ENV.live).flatMap((e) => [e!.id, e!.secret, e!.webhook]),
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n]; } });
afterEach(() => { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } });

const LIVE_ALL = () => {
  process.env.PAYMENT_PROVIDER_MODE = 'live';
  process.env.RAZORPAY_LIVE_KEY_ID = 'rzp_live_x'; process.env.RAZORPAY_LIVE_KEY_SECRET = 's';
  process.env.RAZORPAY_LIVE_WEBHOOK_SECRET = 'w';
  process.env.CASHFREE_PROD_APP_ID = 'a'; process.env.CASHFREE_PROD_SECRET_KEY = 's';
};

describe('PAYMENT_PROVIDER_MODE is parsed strictly', () => {
  it.each(['LIVE', 'production', 'Live', 'lvie', 'true', 'live ', ' live', '  '])('%j -> PaymentModeInvalidError (never silently "test")', (v) => {
    process.env.PAYMENT_PROVIDER_MODE = v;
    expect(() => getActiveMode()).toThrow(PaymentModeInvalidError);
  });
  it('CONTROL: unset / empty -> test (today unchanged); exactly "test" / "live" accepted', () => {
    expect(getActiveMode()).toBe('test');
    process.env.PAYMENT_PROVIDER_MODE = '';
    expect(getActiveMode()).toBe('test');
    process.env.PAYMENT_PROVIDER_MODE = 'live';
    expect(getActiveMode()).toBe('live');
    process.env.PAYMENT_PROVIDER_MODE = 'test';
    expect(getActiveMode()).toBe('test');
  });
});

describe('live readiness - every enabled provider complete, incl. the razorpay webhook secret', () => {
  it('PREMISE: both providers are enabled in the registry', () => {
    expect(PROVIDER_REGISTRY.filter((p) => p.enabled).map((p) => p.provider_id).sort()).toEqual(['cashfree', 'razorpay']);
  });
  it('the live name list (the runbook) is exactly this', () => {
    expect(requiredEnvNames('razorpay', 'live')).toEqual(['RAZORPAY_LIVE_KEY_ID', 'RAZORPAY_LIVE_KEY_SECRET', 'RAZORPAY_LIVE_WEBHOOK_SECRET']);
    expect(requiredEnvNames('cashfree', 'live')).toEqual(['CASHFREE_PROD_APP_ID', 'CASHFREE_PROD_SECRET_KEY']);
  });
  it.each(['RAZORPAY_LIVE_KEY_ID', 'RAZORPAY_LIVE_KEY_SECRET', 'RAZORPAY_LIVE_WEBHOOK_SECRET', 'CASHFREE_PROD_APP_ID', 'CASHFREE_PROD_SECRET_KEY'])(
    'live without %s -> PAYMENT_CONFIG_INVALID naming it', (name) => {
      LIVE_ALL(); delete process.env[name];
      const r = checkPaymentReadiness();
      expect(r).toMatchObject({ ok: false, code: 'PAYMENT_CONFIG_INVALID' });
      expect((r as any).detail).toContain(name);
    });
  it('live with a TEST razorpay key id in the live slot -> PAYMENT_CONFIG_INVALID', () => {
    LIVE_ALL(); process.env.RAZORPAY_LIVE_KEY_ID = 'rzp_test_x';
    expect(checkPaymentReadiness()).toMatchObject({ ok: false, code: 'PAYMENT_CONFIG_INVALID' });
  });
  it('live NEVER reads test keys: test keys present, live absent -> refused', () => {
    process.env.PAYMENT_PROVIDER_MODE = 'live';
    process.env.RAZORPAY_TEST_KEY_ID = 'rzp_test_x'; process.env.RAZORPAY_TEST_KEY_SECRET = 's'; process.env.RAZORPAY_WEBHOOK_SECRET = 'w';
    process.env.CASHFREE_TEST_APP_ID = 'a'; process.env.CASHFREE_TEST_SECRET_KEY = 's';
    expect(checkPaymentReadiness()).toMatchObject({ ok: false, code: 'PAYMENT_CONFIG_INVALID' });
  });
  it('invalid mode -> PAYMENT_MODE_INVALID', () => {
    process.env.PAYMENT_PROVIDER_MODE = 'production';
    expect(checkPaymentReadiness()).toMatchObject({ ok: false, code: 'PAYMENT_MODE_INVALID' });
  });
  it('CONTROL: live with every name -> ok', () => {
    LIVE_ALL();
    expect(checkPaymentReadiness()).toEqual({ ok: true, mode: 'live' });
    expect(validateConfiguredProviders(PROVIDER_REGISTRY, 'live').ok).toBe(true);
  });
  it('CONTROL: test mode with NOTHING set is still ok here (today unchanged; routing skips unconfigured providers)', () => {
    expect(checkPaymentReadiness()).toEqual({ ok: true, mode: 'test' });
  });
});

describe('predeploy-check carries the same live name list as the code', () => {
  it('PAYMENT_LIVE_REQUIRED == requiredEnvNames(enabled, live)', () => {
    const src: string = require('fs').readFileSync(require('path').join(process.cwd(), 'scripts/predeploy-check.js'), 'utf8');
    const m = src.match(/const PAYMENT_LIVE_REQUIRED = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const inScript = [...m![1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]).sort();
    const inCode = PROVIDER_REGISTRY.filter((p) => p.enabled).flatMap((p) => requiredEnvNames(p.provider_id, 'live')).sort();
    expect(inScript).toEqual(inCode);
    expect(inScript.length).toBeGreaterThan(0); // not vacuous
  });
});

// b3/7c 2026-11-20: every webhook rejection reason, driven from the union (WEBHOOK_REJECT_REASONS as a value).
describe('classifyWebhookRejection - every reason in the union', () => {
  const { WEBHOOK_REJECT_REASONS, classifyWebhookRejection } = jest.requireActual('../../services/payments/paymentReadiness');
  const INPUT: Record<string, () => string | undefined> = {
    secret_unset: () => undefined,
    mode_invalid: () => { throw new PaymentModeInvalidError('production'); },
    signature_mismatch: () => 'whsec_x',
  };
  it('the input table covers EXACTLY the union', () => {
    expect(Object.keys(INPUT).sort()).toEqual([...WEBHOOK_REJECT_REASONS].sort());
  });
  it.each([...(jest.requireActual('../../services/payments/paymentReadiness').WEBHOOK_REJECT_REASONS as string[])])(
    '%s', (reason) => { expect(classifyWebhookRejection(INPUT[reason])).toBe(reason); });
  it('an empty-string secret is unset, not a mismatch', () => {
    expect(classifyWebhookRejection(() => '')).toBe('secret_unset');
  });
});
