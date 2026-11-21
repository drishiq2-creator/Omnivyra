/**
 * Tenant DATA-CONTROLLER ACKNOWLEDGEMENT (owner requirement, 2026-11-11).
 *
 * Data a tenant brings in from a data vendor (Apollo, with the tenant's own key) or as contact data, is stored in the
 * tenant's
 * workspace with the TENANT as controller and Omnivyra as processor. A tenant
 * ADMIN accepts the notice ONCE per wording version and category; the notice is
 * still shown on every connect/fetch (informational). Omnivyra's own central
 * data is NOT covered here.
 *
 * STORAGE: the existing consent ledger (`consent_records` via consentLedgerService),
 * not a parallel table - one row per acceptance: capability
 * 'tenant_data_controller_ack', platform 'pi_data', consent_version = wording
 * version, scope_snapshot = categories accepted, metadata = { text_sha256,
 * wording_status, previous_version, grace_* }. The ledger already feeds the
 * compliance evidence export.
 *
 * PER CATEGORY (coordinator ruling 2026-11-11):
 *   required      never accepted (or a NEW category)        -> BLOCKED
 *   current       accepted at this version + text hash      -> allowed
 *   grace         accepted at an OLDER version, within graceDays of the new
 *                 version's publishedAt                       -> allowed, re-accept prompted
 *   expired       older version, grace over                   -> BLOCKED
 *   text_changed  same version, different text hash (wording edited without a
 *                 version bump)                               -> BLOCKED
 *   unknown       the ledger could not be read                -> BLOCKED (fail closed)
 */
import { createHash } from 'crypto';
import notice from '../../../config/compliance/tenant-data-controller-notice.json';
import { ownedDbTable } from '../../db/writeOwner';
import { recordConsent } from '../consentLedgerService';
import { normalizeRole, Role } from '../rbacPrimitives';

export const TENANT_DATA_ACK_CAPABILITY = 'tenant_data_controller_ack';
export const TENANT_DATA_ACK_PLATFORM = 'pi_data';
// 'salesnav_capture' removed with Sales Navigator capture (owner 2026-11-20; PL-170 restores it with the capture).
export const DATA_CATEGORIES = ['vendor_data', 'contact_data'] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];
export type CategoryState = 'required' | 'current' | 'grace' | 'expired' | 'text_changed' | 'unknown';

export interface TenantDataNotice {
  version: string;
  status: string;
  publishedAt: string;
  graceDays: number;
  title: string;
  intro: string;
  categories: Record<DataCategory, string>;
  textSha256: string;
}

interface RawNotice {
  version: string; status: string; publishedAt: string; graceDays: number;
  title: string; intro: string; categories: Record<string, string>;
}

/** Canonical sha256 over the wording (version, title, intro, categories in a fixed order). */
export function noticeTextHash(n: Pick<RawNotice, 'version' | 'title' | 'intro' | 'categories'>): string {
  const canonical = JSON.stringify({
    version: n.version, title: n.title, intro: n.intro,
    categories: DATA_CATEGORIES.map((c) => [c, n.categories[c] ?? null]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function loadTenantDataNotice(raw: RawNotice = notice as RawNotice): TenantDataNotice {
  if (!raw.version?.trim() || !raw.title?.trim() || !raw.intro?.trim()) throw new Error('tenant data notice: version, title and intro are required');
  for (const c of DATA_CATEGORIES) if (!raw.categories?.[c]?.trim()) throw new Error(`tenant data notice: category '${c}' has no text`);
  if (!Number.isFinite(Date.parse(raw.publishedAt))) throw new Error('tenant data notice: publishedAt is not a date');
  const graceDays = Number.isInteger(raw.graceDays) && raw.graceDays >= 0 ? raw.graceDays : 14;
  return {
    version: raw.version, status: raw.status, publishedAt: raw.publishedAt, graceDays,
    title: raw.title, intro: raw.intro,
    categories: Object.fromEntries(DATA_CATEGORIES.map((c) => [c, raw.categories[c]])) as Record<DataCategory, string>,
    textSha256: noticeTextHash(raw),
  };
}

/**
 * A ledger or role read that did not ANSWER (error, non-2xx such as a blank 204, non-array, throw). A typed state, never
 * null / [] / false: an unreadable ack must never read as "not acknowledged" OR "acknowledged" (b3 class ruling; cb on
 * the dropped-error gate, 2026-11-21). Enforcement answers it 503 DATA_CONTROLLER_ACK_UNREADABLE.
 */
export const ACK_UNREADABLE = 'unreadable' as const;
export type AckUnreadable = typeof ACK_UNREADABLE;

export interface AckRow {
  consent_version: string;
  granted_by: string | null;
  granted_at: string;
  scope_snapshot: unknown;
  metadata: unknown;
}

export interface CategoryStatus {
  state: CategoryState;
  allowed: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  graceEndsAt: string | null;
}

/** Pure: the state of one category given the notice and the tenant's acceptance rows (newest first). */
export function categoryStatus(n: TenantDataNotice, rows: readonly AckRow[] | AckUnreadable, c: DataCategory, now: Date): CategoryStatus {
  const none = (state: CategoryState): CategoryStatus => ({ state, allowed: false, acceptedVersion: null, acceptedAt: null, acceptedBy: null, graceEndsAt: null });
  if (rows === ACK_UNREADABLE || !Array.isArray(rows)) return none('unknown');
  const row = rows.find((r) => Array.isArray(r.scope_snapshot) && (r.scope_snapshot as unknown[]).includes(c));
  if (!row) return none('required');
  const meta = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const base = { acceptedVersion: row.consent_version, acceptedAt: row.granted_at, acceptedBy: row.granted_by };
  if (row.consent_version === n.version) {
    return meta.text_sha256 === n.textSha256
      ? { state: 'current', allowed: true, ...base, graceEndsAt: null }
      : { state: 'text_changed', allowed: false, ...base, graceEndsAt: null };
  }
  const graceEnds = new Date(Date.parse(n.publishedAt) + n.graceDays * 86_400_000);
  return now < graceEnds
    ? { state: 'grace', allowed: true, ...base, graceEndsAt: graceEnds.toISOString() }
    : { state: 'expired', allowed: false, ...base, graceEndsAt: graceEnds.toISOString() };
}

/** The tenant's acceptance rows, newest first; ACK_UNREADABLE when the ledger did not answer (a null error is not an answer). */
export async function readAckRows(organizationId: string): Promise<AckRow[] | AckUnreadable> {
  try {
    const res = await ownedDbTable('consent_records')
      .select('consent_version, granted_by, granted_at, scope_snapshot, metadata')
      .eq('organization_id', organizationId)
      .eq('capability', TENANT_DATA_ACK_CAPABILITY)
      .is('revoked_at', null)
      .order('granted_at', { ascending: false })
      .limit(50);
    const { data, error, status } = res as { data: unknown; error: unknown; status?: number };
    if (error || (status !== 200 && status !== 206) || !Array.isArray(data)) return ACK_UNREADABLE;
    return data as AckRow[];
  } catch {
    return ACK_UNREADABLE;
  }
}

export interface TenantDataAckStatus {
  notice: TenantDataNotice;
  readable: boolean;
  categories: Record<DataCategory, CategoryStatus>;
}

export async function getTenantDataAckStatus(
  organizationId: string, now: Date = new Date(), deps: { read?: typeof readAckRows; notice?: TenantDataNotice } = {},
): Promise<TenantDataAckStatus> {
  const n = deps.notice ?? loadTenantDataNotice();
  const rows = await (deps.read ?? readAckRows)(organizationId);
  return {
    notice: n,
    readable: rows !== ACK_UNREADABLE,
    categories: Object.fromEntries(DATA_CATEGORIES.map((c) => [c, categoryStatus(n, rows, c, now)])) as Record<DataCategory, CategoryStatus>,
  };
}

/** Thrown by enforcement points; routes map it to 403 with the category and state. */
export class TenantDataAckRequired extends Error {
  constructor(readonly category: DataCategory, readonly state: CategoryState) {
    super(`data-controller acknowledgement required for '${category}' (${state})`);
    this.name = 'TenantDataAckRequired';
  }
}

/** Thrown when the ledger did not answer: routes map it to 503 DATA_CONTROLLER_ACK_UNREADABLE, never to 403 "required". */
export class TenantDataAckUnreadable extends Error {
  constructor(readonly category: DataCategory) {
    super(`data-controller acknowledgement for '${category}' could not be read`);
    this.name = 'TenantDataAckUnreadable';
  }
}

/**
 * The ONE decision from a category status: allowed -> the status; unreadable ('unknown') -> TenantDataAckUnreadable
 * (503); otherwise -> TenantDataAckRequired (403). Every enforcement point goes through here.
 */
export function requireCategoryAck(s: CategoryStatus, category: DataCategory): CategoryStatus {
  if (s.allowed) return s;
  if (s.state === 'unknown') throw new TenantDataAckUnreadable(category);
  throw new TenantDataAckRequired(category, s.state);
}

/** Enforcement: allowed only when the category is current or in grace. */
export async function assertTenantDataAck(
  organizationId: string, category: DataCategory, now: Date = new Date(), deps: { read?: typeof readAckRows; notice?: TenantDataNotice } = {},
): Promise<CategoryStatus> {
  const n = deps.notice ?? loadTenantDataNotice();
  return requireCategoryAck(categoryStatus(n, await (deps.read ?? readAckRows)(organizationId), category, now), category);
}

export class TenantDataAckRefused extends Error {
  constructor(readonly code: 'not_company_admin' | 'membership_unknown' | 'stale_notice' | 'invalid_categories' | 'write_failed') {
    super(`acknowledgement refused: ${code}`);
    this.name = 'TenantDataAckRefused';
  }
}

/** The acceptor's role in THIS tenant: COMPANY_ADMIN only (Super Admin excluded, as in CPG-058). ACK_UNREADABLE = no answer. */
export async function isTenantCompanyAdmin(userId: string, organizationId: string): Promise<boolean | AckUnreadable> {
  try {
    const res = await ownedDbTable('user_company_roles').select('role')
      .eq('user_id', userId).eq('company_id', organizationId).eq('status', 'active').limit(5);
    const { data, error, status } = res as { data: unknown; error: unknown; status?: number };
    if (error || (status !== 200 && status !== 206) || !Array.isArray(data)) return ACK_UNREADABLE;
    return (data as Array<{ role: string }>).some((r) => normalizeRole(r.role) === Role.COMPANY_ADMIN);
  } catch {
    return ACK_UNREADABLE;
  }
}

/**
 * Record an acceptance. The client must echo the wording version + text hash
 * it SHOWED; anything else is a stale screen and is refused, so nobody accepts
 * text they did not see.
 */
export async function recordTenantDataAck(input: {
  organizationId: string; userId: string; categories: readonly string[];
  shownVersion: string; shownTextSha256: string; now?: Date;
}, deps: {
  notice?: TenantDataNotice; isAdmin?: typeof isTenantCompanyAdmin; read?: typeof readAckRows; record?: typeof recordConsent;
} = {}): Promise<{ acceptedVersion: string; categories: DataCategory[] }> {
  const n = deps.notice ?? loadTenantDataNotice();
  const now = input.now ?? new Date();
  const cats = [...new Set(input.categories)];
  if (cats.length === 0 || !cats.every((c): c is DataCategory => (DATA_CATEGORIES as readonly string[]).includes(c))) {
    throw new TenantDataAckRefused('invalid_categories');
  }
  if (input.shownVersion !== n.version || input.shownTextSha256 !== n.textSha256) throw new TenantDataAckRefused('stale_notice');
  const admin = await (deps.isAdmin ?? isTenantCompanyAdmin)(input.userId, input.organizationId);
  // Only a real boolean is an answer: ACK_UNREADABLE, or anything else, is membership_unknown - never "not admin".
  if (admin !== true && admin !== false) throw new TenantDataAckRefused('membership_unknown');
  if (!admin) throw new TenantDataAckRefused('not_company_admin');

  // The grace window this acceptance closes, when it is a RE-acceptance.
  const rows = await (deps.read ?? readAckRows)(input.organizationId);
  const prev = (Array.isArray(rows) ? rows : []).find((r) => Array.isArray(r.scope_snapshot) && (r.scope_snapshot as unknown[]).some((c) => cats.includes(c as DataCategory)));
  const graceEnds = new Date(Date.parse(n.publishedAt) + n.graceDays * 86_400_000).toISOString();
  try {
    await (deps.record ?? recordConsent)({
      organizationId: input.organizationId,
      platform: TENANT_DATA_ACK_PLATFORM,
      capability: TENANT_DATA_ACK_CAPABILITY as never,
      grantedBy: input.userId,
      grantedAt: now.toISOString(),
      scopeSnapshot: cats as DataCategory[],
      source: 'ui',
      consentVersion: n.version as never,
      metadata: {
        text_sha256: n.textSha256,
        wording_status: n.status,
        ...(prev && prev.consent_version !== n.version
          ? { previous_version: prev.consent_version, grace_started_at: n.publishedAt, grace_ends_at: graceEnds }
          : {}),
      },
    });
  } catch {
    throw new TenantDataAckRefused('write_failed');
  }
  return { acceptedVersion: n.version, categories: cats as DataCategory[] };
}
