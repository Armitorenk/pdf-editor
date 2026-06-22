"use client";

// Dev entry: a native-only floating link (home screen only) to the WIP object editor
// (/object-editor), which is built on the native PDFium engine. Kept separate from the existing
// editor UI while object editing is under construction. Remove once it ships as a normal entry.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export function DevEngineTestLink() {
  const pathname = usePathname();
  const [native, setNative] = useState(false);

  useEffect(() => setNative(Capacitor.isNativePlatform()), []);

  if (!native || pathname !== "/") return null;

  return (
    <Link
      href="/object-editor"
      className="fixed bottom-3 left-3 z-50 rounded-full bg-black/70 px-3 py-2 text-xs font-medium text-white shadow-lg"
    >
      Nesne Düzenle (WIP)
    </Link>
  );
}
