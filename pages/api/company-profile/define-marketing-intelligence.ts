import { createApiRoute as __createApiRoute } from '../../../lib/platform/routeFactory';
import { NextApiRequest, NextApiResponse } from 'next';
import { runCompletion } from '../../../backend/services/aiGateway';
import { getCanonicalProfile as getProfile } from '@/backend/services/context/canonicalProfileAdapter';
import { resolveCompanyAccess } from '../../../backend/services/contentArchitectService';
import { MARKETING_INTELLIGENCE_FIELDS } from '../../../lib/companyProfile/aiOutputFields';
import { finalizeConversationFields } from '../../../backend/services/companyProfile/aiProfileMerge';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const companyId =
    (req.query.companyId as string) ||
    (req.body?.companyId as string) ||
    (req.body?.company_id as string);
  const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation : [];
  const currentFields = (req.body?.currentFields ?? req.body?.currentMarketingIntelligence) as Record<string, string> | undefined;

  if (!companyId) {
    return res.status(400).json({ error: 'companyId required' });
  }
  const access = await resolveCompanyAccess(req, res, companyId);
  if (!access) return;

  try {
    const profile = await getProfile(companyId, { autoRefine: false });
    const companyContext = profile
      ? `Company: ${profile.name || companyId}. Industry: ${profile.industry || 'Not set'}. Category: ${profile.category || 'Not set'}. Commercial: ${[profile.target_customer_segment, profile.pricing_model, profile.sales_motion].filter(Boolean).join(', ') || 'Not set'}.`
      : 'Company not yet profiled.';

    const companyName = profile?.name || 'the company';
    // One definition shared with the client's advisory merge (lib/companyProfile/aiOutputFields).
    const FIELD_ORDER = MARKETING_INTELLIGENCE_FIELDS;
    const FIELD_QUESTIONS: Record<string, string> = {
      marketing_channels: `Which marketing channels does ${companyName} rely on most (social, email, events, paid, SEO, community)?`,
      content_strategy: `What is ${companyName}'s content approach — main formats, themes, and cadence?`,
      campaign_focus: `What do ${companyName}'s campaigns usually focus on (launches, offers, demand gen, thought leadership)?`,
      key_messages: `What core messages should every ${companyName} campaign convey?`,
      brand_positioning: `In one line, how does ${companyName} want to be perceived — its brand positioning?`,
      competitive_advantages: `What genuinely sets ${companyName} apart from competitors?`,
      growth_priorities: `What are ${companyName}'s top marketing / growth priorities right now?`,
    };

    // Deterministic question flow: the SERVER picks the next field from how many
    // answers the user has given, so the model can never loop or repeat a question
    // (that is what made "which field to refine first" keep reappearing).
    const answersGiven = conversation.filter((m: { role?: string }) => m.role === 'user').length;
    if (answersGiven < FIELD_ORDER.length) {
      const field = FIELD_ORDER[answersGiven];
      const cur = String(currentFields?.[field] ?? '').trim();
      const base = FIELD_QUESTIONS[field];
      return res.status(200).json({
        nextQuestion: cur
          ? `${base}\n\nCurrent: "${cur}" — refine it, or reply "keep" to leave it as is.`
          : base,
      });
    }

    // Every field now has an answer (one question per field, in order), so we know
    // exactly which answer maps to which field and label them for the model.
    const userAnswers = conversation
      .filter((m: { role?: string }) => m.role === 'user')
      .map((m: { content?: string }) => String(m.content ?? '').trim());
    const KEEP = /^(keep|same|fine|ok|okay|no ?change|leave it|leave as is|good|n\/?a|skip|-)\.?$/i;

    const systemPrompt =
      "You refine a company's marketing intelligence. You are given, per field, the current value and the user's answer. " +
      'For each field, MERGE the current value with the answer into a concise improved value (1–2 sentences). ' +
      'If the answer is empty or says to keep it, return the current value unchanged. Never invent facts the user did not imply.\n' +
      'Return JSON ONLY: { "structuredFields": { "marketing_channels": "...", "content_strategy": "...", "campaign_focus": "...", "key_messages": "...", "brand_positioning": "...", "competitive_advantages": "...", "growth_priorities": "..." } }.';

    const perField = FIELD_ORDER.map((field, i) => {
      const cur = String(currentFields?.[field] ?? '').trim();
      const ans = userAnswers[i] ?? '';
      return `- ${field}\n    current: ${cur || '(empty)'}\n    answer: ${ans || '(none)'}`;
    }).join('\n');

    const completion = await runCompletion({
      companyId,
      operation: 'defineMarketingIntelligence',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Company: ${companyName}\nContext: ${companyContext}\n\nFields:\n${perField}` },
      ],
    });

    const raw = (completion.output ?? '').trim() || '{}';
    let structuredFields: Record<string, string> = {};
    try {
      const parsed = JSON.parse(raw) as { structuredFields?: Record<string, string> } & Record<string, string>;
      structuredFields = (parsed.structuredFields ?? parsed) as Record<string, string>;
    } catch {
      return res.status(500).json({ error: 'Invalid AI response' });
    }

    // Deterministic guard: never lose a field. If the model left one empty, fall
    // back to the user's answer, else the current value; "keep" forces current.
    // The shared guard (aiProfileMerge): "current" = the caller's value, else the STORED profile's, so a
    // caller short a field can no longer blank a stored value; an all-empty field is omitted, never ''.
    const finalFields = finalizeConversationFields({
      fields: FIELD_ORDER,
      userAnswers,
      modelFields: structuredFields,
      callerCurrent: currentFields,
      stored: profile as unknown as Record<string, unknown> | null,
      keep: KEEP,
    });

    return res.status(200).json({ done: true, structuredFields: finalFields });
  } catch (err: any) {
    console.error('Define marketing intelligence failed:', err);
    return res.status(500).json({
      error: 'Failed to run define marketing intelligence',
      details: err?.message || null,
    });
  }
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/company-profile/define-marketing-intelligence' });
