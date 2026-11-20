/**
 * Trusted-device revoke (b3 ruling 3, 2026-11-20). Before: the session cascade's failure was swallowed (200 with
 * "0 sessions revoked" while the device's live cookie kept authenticating) and a retry got 409 ALREADY_REVOKED, so the
 * cascade NEVER re-ran. Now: a cascade failure is reported (200 + cascade.failed + DEVICE_SESSIONS_NOT_REVOKED), and
 * revoking an already-revoked device is idempotent and RE-RUNS the cascade - the retry finishes the job.
 * REAL: the route, TrustedDeviceService.revoke. FAKED: principal, device repository, session/step-up revokes, audit.
 */
export {};
type Device = { id: string; userId: string; revokedAt: string | null };
let mockDevice: Device | null = null;
const mockLiveSessions: string[] = [];
let mockCascadeFails = false;
jest.mock('../../security/IdentityResolver', () => ({
  resolvePrincipal: async () => ({ ok: true, principal: { userId: 'user-1', legacyCookieSuperAdmin: false } }),
}));
jest.mock('../../security/devices/DeviceSessionRepository', () => ({
  findByIdForUser: async (id: string) => (mockDevice && mockDevice.id === id ? { ...mockDevice } : null),
  revokeDevice: async () => { if (!mockDevice || mockDevice.revokedAt) return false; mockDevice.revokedAt = '2026-11-20T00:00:00Z'; return true; },
  findActiveByFingerprint: jest.fn(), insertDevice: jest.fn(), listForUser: jest.fn(), touchLastSeen: jest.fn(), reviveDormantTrustedDevice: jest.fn(),
}));
jest.mock('../../security/SessionAuthorityService', () => ({
  revokeSessionsForDevice: async () => {
    if (mockCascadeFails) throw new Error('SECURITY_READ_FAILED:auth_sessions:revokeSessionsForDevice');
    const ids = mockLiveSessions.splice(0);
    return ids;
  },
}));
jest.mock('../../security/stepup/StepUpSessionService', () => ({ revokeForAuthSession: jest.fn(async () => 1) }));
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

/* eslint-disable @typescript-eslint/no-var-requires */
const handler = require('../../../pages/api/auth/devices/revoke').default;

async function revokeDevice() {
  const res: any = { statusCode: 200, body: null, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body: { id: 'dev-1' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

beforeEach(() => {
  mockDevice = { id: 'dev-1', userId: 'user-1', revokedAt: null };
  mockLiveSessions.length = 0; mockLiveSessions.push('s-1', 's-2');
  mockCascadeFails = false;
});

describe('trusted-device revoke: a failed cascade is reported, and a retry finishes it', () => {
  it('cascade FAILS -> 200 revoked + cascade.failed + DEVICE_SESSIONS_NOT_REVOKED; then the RETRY revokes the sessions', async () => {
    mockCascadeFails = true;
    const first = await revokeDevice();
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ revoked: true, alreadyRevoked: false, cascade: { failed: true, code: 'DEVICE_SESSIONS_NOT_REVOKED' } });
    expect(mockDevice!.revokedAt).not.toBeNull();
    expect(mockLiveSessions).toEqual(['s-1', 's-2']); // still live

    mockCascadeFails = false;
    const retry = await revokeDevice();
    expect(retry.statusCode).toBe(200); // not 409
    expect(retry.body).toMatchObject({ revoked: true, alreadyRevoked: true, cascade: { authSessionsRevoked: 2 } });
    expect(mockLiveSessions).toEqual([]); // the sessions are gone
  });

  it('CONTROL: a normal revoke cascades in one go', async () => {
    const r = await revokeDevice();
    expect(r.body).toMatchObject({ revoked: true, alreadyRevoked: false, cascade: { authSessionsRevoked: 2, stepUpSessionsRevoked: 2 } });
  });

  it('an unknown device is still 404', async () => {
    mockDevice = null;
    expect((await revokeDevice()).statusCode).toBe(404);
  });
});
