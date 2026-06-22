"use client";

// Home-screen entry to the native object editor (PDFium). Shown only in the Android app, since the
// engine is native-only; on the web it renders nothing.

import Link from "next/link";
import { Boxes, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export function ObjectEditorLink() {
  const [native, setNative] = useState(false);
  useEffect(() => setNative(Capacitor.isNativePlatform()), []);
  if (!native) return null;
  return (
    <Link
      href="/object-editor"
      className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-4 transition-colors active:bg-neutral-50 hover:border-neutral-400"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
        <Boxes className="h-5 w-5 text-blue-600" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-neutral-800">Object Editor</span>
        <span className="truncate text-xs text-neutral-500">Move, resize, recolour &amp; delete the objects on a page</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-neutral-400" />
    </Link>
  );
}
