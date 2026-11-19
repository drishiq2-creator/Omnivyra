/**
 * Catalog prices for one or more actions, from GET /api/billing/activity-cost-range (c6: the
 * org-scoped pricing catalog; never hard-coded on the client). Shared by ActivityCostRange
 * (the badge) and RunCostLine (the "this run uses N credits" line).
 *
 * `unknown` lists actions the catalog doesn't price yet (e.g. market_pulse before migration
 * 055): callers must say "price unavailable", never guess (c6).
 */
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../components/community-ai/fetchWithAuth';

export interface ActivityCreditRange {
  actionKey: string;
  minCredits: number;
  maxCredits: number;
  expectedCredits: number;
  tokenPriced: boolean;
  source: 'action_pricing_config' | 'credit_cost_config';
}

export function useActivityCostRanges(companyId: string, actions: string | string[]) {
  const list = Array.isArray(actions) ? actions : [actions];
  const key = list.join(',');
  const [ranges, setRanges] = useState<ActivityCreditRange[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!companyId || !key) return;
    setLoading(true);
    setError(null);
    fetchWithAuth(
      `/api/billing/activity-cost-range?companyId=${encodeURIComponent(companyId)}&actions=${encodeURIComponent(key)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((j) => {
        if (cancelled) return;
        setRanges(Array.isArray(j?.ranges) ? j.ranges : []);
        setUnknown(Array.isArray(j?.unknown) ? j.unknown.map(String) : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // key captures the actions list; companyId scopes the band.
  }, [companyId, key]);

  return { ranges, unknown, loading, error };
}
