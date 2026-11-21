/**
 * The Sales Navigator Extract PAGE is default OFF (b3's default-off rule, as for the import wizard): the page does not
 * exist until NEXT_PUBLIC_SALESNAV_UI_ENABLED is exactly 'true'. The server gate (legal switch + company flags + the
 * acknowledgement) is the real control; this only hides the screen.
 */
export function isSalesNavUiEnabled(value: string | undefined = process.env.NEXT_PUBLIC_SALESNAV_UI_ENABLED): boolean {
  return value === 'true';
}
