"use client";

// Home-screen entry to the native object editor (PDFium). Shown only in the Android app, since the
// engine is native-only; on the web it renders nothing.

import Link from "next/link";
import { Boxes } from "lucide-react";
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export function ObjectEditorLink() {
  const [native, setNative] = useState(false);
  useEffect(() => setNative(Capacitor.isNativePlatform()), []);
  if (!native) return null;
  return (
    <Link
      href="/object-editor"
      className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-neutral-300 bg-white p-4 text-center transition-colors active:bg-neutral-50 hover:border-neutral-400"
    >
      <Boxes className="h-5 w-5 text-blue-600" />
      <span className="text-sm font-semibold text-neutral-800">Nesne Düzenle (deneysel)</span>
    </Link>
  );
}
