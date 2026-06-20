/** Trigger a browser download for in-memory bytes (client-side only). */
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = "application/pdf",
): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
