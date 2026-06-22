// In-memory hand-off of the currently open PDF from the main editor to the native Object Editor
// route. Both screens live in the same client-side SPA, so a module-level variable survives the
// client-side `router.push` navigation (no serialisation, no size limit). Consumed once — cleared
// on read — so a later direct visit to /object-editor falls back to its own file picker.

let pending: { bytes: Uint8Array; name: string } | null = null;

export function setHandoffPdf(bytes: Uint8Array, name: string) {
  pending = { bytes, name };
}

/** Returns the handed-off PDF once, then clears it. */
export function takeHandoffPdf(): { bytes: Uint8Array; name: string } | null {
  const p = pending;
  pending = null;
  return p;
}
