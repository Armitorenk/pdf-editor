"use client";

// Object editor (WIP) — the real object-editing screen built on the native PDFium engine.
// Adım 2: open a PDF and render it on a pinch/pan canvas (ObjectCanvas). Selection, handles,
// floating toolbar and edit ops land here in the next steps. Native-only.

import { useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { ObjectCanvas } from "@/components/object/ObjectCanvas";

export default function ObjectEditorPage() {
  const [native, setNative] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [name, setName] = useState("");

  useEffect(() => setNative(Capacitor.isNativePlatform()), []);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setName(file.name);
    setBytes(new Uint8Array(await file.arrayBuffer()));
  }

  return (
    <main className="flex h-dvh flex-col pt-safe">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2">
        <Link href="/" className="text-sm text-blue-600">
          ← Geri
        </Link>
        <span className="truncate text-sm font-medium">{name || "Nesne Düzenleyici (WIP)"}</span>
        <label className="cursor-pointer whitespace-nowrap text-sm text-blue-600">
          PDF aç
          <input type="file" accept="application/pdf" className="hidden" onChange={onPick} />
        </label>
      </header>

      {!native && (
        <p className="bg-amber-100 p-3 text-sm text-amber-900">
          Native PDFium motoru gerekir — bu ekran yalnızca Android uygulamasında çalışır.
        </p>
      )}

      <div className="relative flex-1 overflow-hidden">
        {bytes ? (
          <ObjectCanvas bytes={bytes} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-500">
            <p>Başlamak için bir PDF aç.</p>
            <Link href="/pdf-engine-test" className="text-blue-600 underline">
              ham motor testi →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
