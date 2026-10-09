/** Shareable `?a=` ids: a signal id from any source, e.g. `ocearch:3470603` or `whoi:maca2606_maca`. */
const FOCUS_ID = /^(ocearch|wildlife|ghri|sharksmart|whoi|acartia|inat):[\w .:,()'/-]{1,200}$/;

export function parseFocus(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return FOCUS_ID.test(raw) ? raw : null;
}
