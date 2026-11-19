/**
 * CI-176 (HIGH, 2026-11-20): a USER creator template belongs to ONE company.
 *
 * User templates are loaded by id into ONE process-global registry (lib/creator-templates) so the renderer's
 * resolveTemplate() resolves them like system templates. Before this, nothing tied a registered template to its
 * company: a member of company A who put company B's template UUID into A's plan / asset had it loaded by id alone
 * and rendered A's content with B's design - and once B's template sat in a worker's registry, A's render resolved
 * it with no read at all.
 *
 * Pure (no DB): every server-side registration stamps `metadata.companyId` (userTemplateService.hydrate, the
 * version-snapshot loader, the preview renderer), and these helpers decide from that stamp. A user template with
 * no stamp, or a render with no company, is FOREIGN (fail closed). System and curated templates
 * (ownership !== 'user') are shared by design and never foreign.
 */
import type { CreatorTemplate } from '../../../lib/creator-templates';
import { getTemplateById } from '../../../lib/creator-templates';

/** The company a registered user template belongs to ('' when unstamped). */
export function userTemplateCompanyId(template: CreatorTemplate | null | undefined): string {
  const v = (template?.metadata as Record<string, unknown> | undefined)?.companyId;
  return typeof v === 'string' ? v.trim() : '';
}

/** Stamp the owning company on a template before it enters the registry. */
export function stampUserTemplateCompany(template: CreatorTemplate, companyId: string | null | undefined): CreatorTemplate {
  template.metadata = { ...(template.metadata ?? {}), companyId: typeof companyId === 'string' ? companyId.trim() : '' };
  return template;
}

/** True when `template` is a USER template that `companyId` does not own (unstamped / no company = foreign). */
export function isForeignUserTemplate(template: CreatorTemplate | null | undefined, companyId: string | null | undefined): boolean {
  if (!template || template.ownership !== 'user') return false;
  const owner = userTemplateCompanyId(template);
  const company = typeof companyId === 'string' ? companyId.trim() : '';
  return !owner || !company || owner !== company;
}

/** The registered template for an id, ONLY when it is a system template or a user template `companyId` owns. */
export function getTemplateForCompany(id: string, companyId: string | null | undefined): CreatorTemplate | null {
  const t = getTemplateById(String(id || '').trim());
  if (!t) return null;
  return isForeignUserTemplate(t, companyId) ? null : t;
}

/**
 * A clone source that is neither a system template nor a user template of the caller's company. ONE error for an
 * unknown id and another company's id alike, so the reply carries no existence signal.
 */
export class SourceTemplateNotFoundError extends Error {
  constructor() {
    super('Source template not found');
    this.name = 'SourceTemplateNotFoundError';
  }
}

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);

/**
 * THE render chokepoint (called by renderAsset before anything resolves a template): every template id field the
 * renderer reads (`templateIdForRender`: metadata.template_id, metadata.infographic_template_id,
 * metadata.creator_card.template_id) that resolves to a FOREIGN user template is cleared in place, so the render
 * falls back to the family's default style - exactly what an unknown id already does. Returns the dropped ids.
 * Ids that resolve to nothing are left alone (they already render the default).
 */
export function dropForeignUserTemplateRefs(assetPayload: unknown, companyId: string | null | undefined): string[] {
  const md = obj(obj(obj(assetPayload)?.media_bundle)?.metadata);
  if (!md) return [];
  const dropped: string[] = [];
  const check = (holder: Rec, key: string) => {
    const raw = holder[key];
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) return;
    if (isForeignUserTemplate(getTemplateById(id), companyId)) {
      holder[key] = null;
      dropped.push(id);
    }
  };
  check(md, 'template_id');
  check(md, 'infographic_template_id');
  const card = obj(md.creator_card);
  if (card) check(card, 'template_id');
  if (dropped.length > 0) {
    console.warn('[creator-template] creator_template_foreign_ref_dropped', {
      event: 'creator_template_foreign_ref_dropped',
      companyId: companyId ?? null,
      templateIds: [...new Set(dropped)],
    });
  }
  return dropped;
}
