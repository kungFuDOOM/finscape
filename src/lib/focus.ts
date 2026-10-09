/** Shareable `?a=` ids: an OCEARCH tag, an iNaturalist observation, or a WHOI detection. */
export const FOCUS_ID = /^((ocearch|inat):\d{1,12}|whoi:[a-z0-9_-]{1,80})$/;

export function parseFocus(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return FOCUS_ID.test(raw) ? raw : null;
}
