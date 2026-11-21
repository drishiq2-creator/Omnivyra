/**
 * The prospect import wizard's UI visibility (client-safe). Read ONLY here (c6 2026-11-20, b3 ruling: default OFF).
 * Controls the /prospects/import page, the empty-state link on /prospects, and 04's Prospect-menu entry.
 * The server routes are gated separately and per company (backend/services/leadIngestion/prospectImportGate.ts);
 * this flag only decides whether the surface is shown at all.
 */
export function isProspectImportUiEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED,
): boolean {
  // STRICT, like piLdbSchemaReady: only the exact string 'true' shows the surface.
  return value === 'true';
}
