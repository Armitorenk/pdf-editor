"use client";

// TEMP smoke-test screen for the native PDFium engine (object editing, Faz 0). Pick a PDF and it
// runs openDoc -> renderPage(0) -> listObjects(0) through the native plugin and shows the result.
// Only meaningful inside the Android app (Capacitor); on the web the plugin is unavailable.
// Reached via the native-only "PDFium Test" link on the home screen. Safe to delete once a real
// object-editing UI exists.

import { useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { PdfEngine, type PdfObject } from "@/lib/object/pdfEngine";

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function PdfEngineTestPage() {
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [img, setImg] = useState<string | null>(null);
  const [objects, setObjects] = useState<PdfObject[]>([]);

  useEffect(() => setNative(Capacitor.isNativePlatform()), []);

  const addLog = (line: string) => setLog((prev) => [...prev, line]);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setLog([]);
    setImg(null);
    setObjects([]);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      addLog(`Dosya: ${file.name} — ${bytes.length} bytes`);

      const t0 = performance.now();
      const { pages } = await PdfEngine.openDoc({ data: base64FromBytes(bytes) });
      addLog(`openDoc OK → ${pages} sayfa (${Math.round(performance.now() - t0)}ms)`);

      const t1 = performance.now();
      const page = await PdfEngine.renderPage({ page: 0, scale: 1.5 });
      addLog(
        `renderPage(0) OK → ${page.width}×${page.height}px, ` +
          `${page.pageWidth.toFixed(1)}×${page.pageHeight.toFixed(1)}pt (${Math.round(performance.now() - t1)}ms)`,
      );
      setImg(`data:image/png;base64,${page.data}`);

      const t2 = performance.now();
      const res = await PdfEngine.listObjects({ page: 0 });
      addLog(`listObjects(0) OK → ${res.objects.length} nesne (${Math.round(performance.now() - t2)}ms)`);
      setObjects(res.objects);

      await PdfEngine.closeDoc();
      addLog("closeDoc OK");
    } catch (err) {
      addLog(`HATA: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pt-safe">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">PDFium Engine Test</h1>
        <Link href="/" className="text-sm text-blue-600 underline">
          ← Geri
        </Link>
      </div>

      {!native && (
        <p className="rounded-md bg-amber-100 p-3 text-sm text-amber-900">
          Bu ekran native PDFium motorunu çağırır — yalnızca Android uygulamasında çalışır. Tarayıcıda
          eklenti yoktur, çağrılar hata döndürür.
        </p>
      )}

      <label className="inline-flex w-fit cursor-pointer items-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white">
        {busy ? "Çalışıyor…" : "PDF seç ve test et"}
        <input type="file" accept="application/pdf" className="hidden" onChange={onPick} disabled={busy} />
      </label>

      {log.length > 0 && (
        <pre className="overflow-x-auto rounded-md bg-neutral-900 p-3 text-xs leading-relaxed text-neutral-100">
          {log.join("\n")}
        </pre>
      )}

      {img && (
        <div>
          <h2 className="mb-1 text-sm font-medium">renderPage(0)</h2>
          <img src={img} alt="rendered page 0" className="w-full rounded-md border border-neutral-300" />
        </div>
      )}

      {objects.length > 0 && (
        <div>
          <h2 className="mb-1 text-sm font-medium">listObjects(0) — {objects.length} nesne</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-300 text-left">
                  <th className="py-1 pr-2">#</th>
                  <th className="py-1 pr-2">type</th>
                  <th className="py-1 pr-2">bounds [l,b,r,t]</th>
                </tr>
              </thead>
              <tbody>
                {objects.slice(0, 100).map((o) => (
                  <tr key={o.id} className="border-b border-neutral-100">
                    <td className="py-1 pr-2">{o.id}</td>
                    <td className="py-1 pr-2">{o.type}</td>
                    <td className="py-1 pr-2 font-mono">
                      {o.bounds.map((n) => n.toFixed(1)).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {objects.length > 100 && (
              <p className="mt-1 text-xs text-neutral-500">… ilk 100 gösteriliyor</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
