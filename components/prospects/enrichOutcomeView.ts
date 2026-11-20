/**
 * PI (c6 2026-11-20): what one "Enrich" press means to the user, in plain words.
 *
 * POST /api/prospects/:id/enrich answers in several shapes (route: pages/api/prospects/[id]/enrich.ts):
 *   200 { status:'not_planned', reason }                       - the planner declined this field
 *   200 { status:'executed', execution:{ outcome | refusal } } - the executor's own taxonomy
 *   4xx/5xx { error, code:'APOLLO_*', providerError, ... }     - the vendor's typed refusal, status mapped from the code
 *   401 / 403 / 404 / 503 / network failure
 *
 * CONTRACT: every reachable state is expressible. The OUTCOME and REFUSAL tables below are pinned, both ways, to the
 * backend unions (ENRICHMENT_OUTCOMES, PLAN_REFUSALS) by enrichOutcomeView.test.ts. Anything this module does not
 * recognise is 'unknown', never a success and never a definite failure: the field may or may not have been filled,
 * so the user is told to refresh rather than told a guess.
 *
 * Kept free of backend imports: it ships in the client bundle.
 */

export type EnrichTone = 'success' | 'info' | 'warning' | 'error' | 'unknown';
export interface EnrichView { readonly tone: EnrichTone; readonly message: string }

/** Every EnrichmentOutcome (backend/services/enrichment/providers/contract.ts). */
export const OUTCOME_VIEW: Readonly<Record<string, EnrichView>> = {
  enriched: { tone: 'success', message: 'Found and saved.' },
  no_match: { tone: 'info', message: 'The provider does not know this person or company.' },
  field_not_found: { tone: 'info', message: 'The provider matched them but does not hold this field.' },
  provider_declined: { tone: 'warning', message: 'The provider declined this request.' },
  provider_unavailable: { tone: 'warning', message: 'The provider is not answering right now. Try again later.' },
  credential_missing: { tone: 'warning', message: 'No provider key is set up. Add one under Integrations → Enrichment.' },
  not_implemented: { tone: 'info', message: 'This provider cannot fill this field yet.' },
  quota_exceeded: { tone: 'warning', message: "Your provider account's limit is used up." },
  cost_denied: { tone: 'warning', message: "Not run: today's enrichment limit for your company is reached, or none is set." },
  rate_limited: { tone: 'warning', message: 'The provider asked us to slow down. Try again in a few minutes.' },
  timeout: { tone: 'unknown', message: 'The provider took too long to answer. Refresh to see whether the field was filled.' },
  malformed_response: { tone: 'warning', message: 'The provider sent an answer we could not read. Nothing was saved.' },
  duplicate_suppressed: { tone: 'info', message: 'Already looked up recently. The current value stands.' },
};

/** Every PlanRefusal (backend/services/enrichment/execution.ts): the provider was never asked. */
export const REFUSAL_VIEW: Readonly<Record<string, EnrichView>> = {
  not_executable: { tone: 'info', message: 'This field is not planned for enrichment.' },
  internal_source: { tone: 'info', message: 'This field comes from your own data, not from a provider.' },
  entity_missing: { tone: 'info', message: 'There is no record yet for this person or company to enrich.' },
  entity_not_active: { tone: 'info', message: 'This record was merged, archived or suppressed, so it is not enriched.' },
  source_ineligible: { tone: 'info', message: 'No connected provider can fill this field.' },
  selector_missing: { tone: 'info', message: 'Not enough is known (for example a name or domain) for a provider to search on.' },
};

const UNKNOWN: EnrichView = {
  tone: 'unknown',
  message: 'We could not confirm what happened. Refresh to see whether the field was filled.',
};

const rec = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Map one HTTP answer to what the user sees. `httpStatus` null = the request never got an answer (network failure,
 * lost response) - the server may still have run it, so that is 'unknown', not 'error'.
 */
export function describeEnrichResponse(httpStatus: number | null, body: unknown): EnrichView {
  if (httpStatus === null) return UNKNOWN;
  const b = rec(body);

  // The vendor's own typed refusal (any status): show its message.
  const code = typeof b?.code === 'string' ? b.code : null;
  if (code && code.startsWith('APOLLO_')) {
    const msg = typeof b?.error === 'string' && b.error.trim() ? b.error.trim() : 'The provider refused this request.';
    return { tone: 'warning', message: `Provider: ${msg}` };
  }

  if (httpStatus === 401) return { tone: 'error', message: 'Your session has ended. Sign in again.' };
  if (httpStatus === 403) return { tone: 'info', message: 'Only company admins can run enrichment.' };
  if (httpStatus === 404) return { tone: 'error', message: 'This prospect is not available in this company.' };

  if (httpStatus === 200 && b) {
    if (b.status === 'not_planned') {
      const reason = typeof b.reason === 'string' && b.reason ? ` (${b.reason})` : '';
      return { tone: 'info', message: `Not planned for enrichment${reason}.` };
    }
    if (b.status === 'executed') {
      const ex = rec(b.execution);
      const refusal = typeof ex?.refusal === 'string' ? ex.refusal : null;
      if (refusal) return REFUSAL_VIEW[refusal] ?? UNKNOWN;
      const outcome = typeof ex?.outcome === 'string' ? ex.outcome : null;
      if (outcome) return OUTCOME_VIEW[outcome] ?? UNKNOWN;
    }
  }
  // 503 (unavailable) and anything unrecognised: the result is not known.
  return UNKNOWN;
}
