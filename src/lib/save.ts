import { Capacitor } from "@capacitor/core";
import { downloadBlob } from "./download";

/**
 * Save/export a generated file, the right way for the current platform.
 *
 * - **Web:** the classic `<a download>` browser download.
 * - **Native (Android/Capacitor):** that trick does nothing inside a WebView, so we
 *   write the bytes to the app's cache and open the system **Share sheet** — from
 *   there the user can "Save to Files", send to Drive, WhatsApp, etc. Sharing a
 *   cache file is what lets other apps read it (Capacitor routes it through a
 *   FileProvider content:// URI).
 *
 * Plugin modules are imported dynamically so the web bundle never needs them.
 */
export async function saveFile(filename: string, blob: Blob): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    downloadBlob(blob, filename);
    return;
  }

  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");

  const base64 = await blobToBase64(blob);
  // No `encoding` => Capacitor decodes the base64 and writes raw bytes (works for
  // PDF/PNG/JPEG/ZIP and, since text was base64-encoded too, for .txt as well).
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({ title: filename, url: uri });
  } catch {
    // User dismissed the share sheet — the file is still written; nothing to do.
  }
}

/** Read a Blob as a bare base64 string (no `data:...;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}
