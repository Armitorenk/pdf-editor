"use client";

// TEMP dev entry: a native-only floating link (home screen only) to the PDFium engine smoke-test
// page. Lets us verify the native object-editing engine in the APK without touching the editor UI.
// Remove this component + its mount in layout.tsx + the /pdf-engine-test route once a real
// object-editing UI exists.

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
      href="/pdf-engine-test"
      className="fixed bottom-3 left-3 z-50 rounded-full bg-black/70 px-3 py-2 text-xs font-medium text-white shadow-lg"
    >
      PDFium Test
    </Link>
  );
}
