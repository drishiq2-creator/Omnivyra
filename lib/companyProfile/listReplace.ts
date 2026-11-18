/**
 * D2 (CI-397): a profile list item can be DELETED. The server (backend/services/companyProfile/savePayload +
 * /api/company-profile) replaces only the lists a user save NAMES in `replace_lists`, and refuses a bulk
 * removal without `confirm_bulk_removal: true` (409 BULK_LIST_REMOVAL_UNCONFIRMED, listing what would go).
 * This module is the ONE definition of which lists are replaceable (the server imports it) plus the client's
 * rebasing rule. Pure: safe for the API route and the browser bundle.
 */

/** Replaceable profile lists -> their legacy text column. Competitors are NOT replaceable (own ranking/cap path). */
export const REPLACEABLE_LISTS = {
  industry_list: 'industry',
  category_list: 'category',
  geography_list: 'geography',
  content_themes_list: 'content_themes',
  products_services_list: 'products_services',
  target_audience_list: 'target_audience',
  goals_list: 'goals',
  brand_voice_list: 'brand_voice',
} as const;
export type ReplaceableList = keyof typeof REPLACEABLE_LISTS;

const norm = (s: string) => s.trim().toLowerCase();
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];

/**
 * Three-way rebase for one list ("re-read at save time", 05): `base` = the stored list the user started editing
 * from, `mine` = what the user has now, `fresh` = the list re-read from the server at save time. Sends
 * fresh - (base - mine) + (mine - base), so a stale tab never silently drops an item another tab added.
 * Returns null when the user removed nothing (a plain union-merge save already handles additions).
 */
export function rebaseListEdit(base: unknown, mine: unknown, fresh: unknown): string[] | null {
  const b = asList(base);
  const m = asList(mine);
  const f = asList(fresh);
  const mineKeys = new Set(m.map(norm));
  const baseKeys = new Set(b.map(norm));
  const removed = new Set(b.filter((x) => !mineKeys.has(norm(x))).map(norm));
  if (removed.size === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (x: string) => {
    const k = norm(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  };
  for (const x of f) if (!removed.has(norm(x))) push(x);
  for (const x of m) if (!baseKeys.has(norm(x))) push(x);
  return out;
}

/** The lists to replace and their rebased values; empty when the user deleted nothing. */
export function planListReplacements(
  base: Record<string, unknown> | null | undefined,
  mine: Record<string, unknown>,
  fresh: Record<string, unknown> | null | undefined,
): { replace_lists: ReplaceableList[]; lists: Partial<Record<ReplaceableList, string[]>> } {
  const replace_lists: ReplaceableList[] = [];
  const lists: Partial<Record<ReplaceableList, string[]>> = {};
  if (!base) return { replace_lists, lists };
  for (const field of Object.keys(REPLACEABLE_LISTS) as ReplaceableList[]) {
    const next = rebaseListEdit(base[field], mine[field], fresh?.[field] ?? base[field]);
    if (next) {
      replace_lists.push(field);
      lists[field] = next;
    }
  }
  return { replace_lists, lists };
}

/** b3's plain confirm for 409 BULK_LIST_REMOVAL_UNCONFIRMED: "This removes N items: a, b. Remove them?" */
export function bulkRemovalConfirmText(lists: Array<{ field?: string; removed?: unknown }>): string {
  const items = lists.flatMap((l) => asList(l.removed));
  return `This removes ${items.length} item${items.length === 1 ? '' : 's'}: ${items.join(', ')}. Remove them?`;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export type ProfileSaveOutcome =
  | { kind: 'saved'; data: any }
  | { kind: 'cancelled' } // the user declined the bulk-removal confirm: nothing saved
  | { kind: 'reread_failed' } // a removal could not be rebased on the latest lists: nothing saved
  | { kind: 'failed'; error: string };

/**
 * The profile save request with D2 list deletion. Lists where the user removed something are sent as
 * `replace_lists`, rebased on the list RE-READ now; a 409 BULK_LIST_REMOVAL_UNCONFIRMED asks `confirm` with
 * b3's plain sentence and, on yes, resends with `confirm_bulk_removal: true`.
 */
export async function saveProfileWithListEdits(args: {
  fetch: FetchLike;
  companyId: string;
  base: Record<string, unknown> | null; // the stored profile the user started editing from
  payload: Record<string, unknown>; // what the user is saving
  confirm: (text: string) => boolean;
}): Promise<ProfileSaveOutcome> {
  const { fetch, companyId, base, payload, confirm } = args;
  let body: Record<string, unknown> = payload;
  if (planListReplacements(base, payload, null).replace_lists.length > 0) {
    let fresh: Record<string, unknown> | null = null;
    try {
      const latest = await fetch(`/api/company-profile?companyId=${encodeURIComponent(companyId)}`);
      if (latest.ok) fresh = ((await latest.json().catch(() => null))?.profile ?? null) as Record<string, unknown> | null;
    } catch {
      fresh = null;
    }
    // Without the latest list a removal could drop someone else's addition: save nothing.
    if (!fresh) return { kind: 'reread_failed' };
    const plan = planListReplacements(base, payload, fresh);
    if (plan.replace_lists.length > 0) body = { ...payload, ...plan.lists, replace_lists: plan.replace_lists };
  }
  const post = (b: Record<string, unknown>) =>
    fetch('/api/company-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let response = await post(body);
  if (response.status === 409) {
    const conflict = await response.json().catch(() => null);
    if (conflict?.code !== 'BULK_LIST_REMOVAL_UNCONFIRMED') {
      return { kind: 'failed', error: conflict?.error || 'Failed to save profile' };
    }
    if (!confirm(bulkRemovalConfirmText(Array.isArray(conflict.lists) ? conflict.lists : []))) return { kind: 'cancelled' };
    response = await post({ ...body, confirm_bulk_removal: true });
  }
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    return { kind: 'failed', error: errorBody?.error || errorBody?.details || 'Failed to save profile' };
  }
  return { kind: 'saved', data: await response.json() };
}
