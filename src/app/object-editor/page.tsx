"use client";

// Object editor (WIP) — the real object-editing screen built on the native PDFium engine.
// Adım 2: open a PDF and render it on a pinch/pan canvas (ObjectCanvas). Selection, handles,
// floating toolbar and edit ops land here in the next steps. Native-only.

import { useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { ObjectCanvas } from "@/components/object/ObjectCanvas";
import { PdfEngine } from "@/lib/object/pdfEngine";
import { takeHandoffPdf } from "@/lib/object/handoff";
import { saveFile } from "@/lib/save";
import { canExport, recordExport } from "@/lib/pro";
import { Paywall } from "@/components/monetization/Paywall";

export default function ObjectEditorPage() {
  const [native, setNative] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  // "text" when opened from the main editor's Text tool → tap selects only text runs.
  const [textOnly, setTextOnly] = useState(false);

  // Pick up the document handed over from the main editor's "Object"/"Text" button; if there is none
  // (a direct visit), the user opens one with the picker in the header.
  useEffect(() => {
    setNative(Capacitor.isNativePlatform());
    const h = takeHandoffPdf();
    if (h) {
      setName(h.name);
      setBytes(h.bytes);
      setTextOnly(h.mode === "text");
    }
  }, []);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setName(file.name);
    setBytes(new Uint8Array(await file.arrayBuffer()));
  }

  async function onSave() {
    // Saving the edited PDF is an export — share the main editor's daily free quota / Pro gate.
    if (!canExport()) {
      setPaywallOpen(true);
      return;
    }
    setSaving(true);
    try {
      const { data } = await PdfEngine.saveDocument();
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "application/pdf" });
      const outName = (name.replace(/\.pdf$/i, "") || "document") + "-edited.pdf";
      await saveFile(outName, blob);
      recordExport();
    } catch (e) {
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex h-dvh flex-col pt-safe">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2">
        <Link href="/" className="text-sm text-blue-600">
          ← Back
        </Link>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-medium">{name || "Object Editor"}</span>
        <div className="flex items-center gap-3">
          {bytes && (
            <button
              className="flex items-center gap-1 whitespace-nowrap text-sm text-blue-600 disabled:opacity-40"
              onClick={onSave}
              disabled={saving}
            >
              <Download size={16} />
              {saving ? "…" : "Save"}
            </button>
          )}
          <label className="cursor-pointer whitespace-nowrap text-sm text-blue-600">
            Open PDF
            <input type="file" accept="application/pdf" className="hidden" onChange={onPick} />
          </label>
        </div>
      </header>

      {!native && (
        <p className="bg-amber-100 p-3 text-sm text-amber-900">
          Requires the native PDFium engine — this screen only works in the Android app.
        </p>
      )}

      <div className="relative flex-1 overflow-hidden">
        {bytes ? (
          <ObjectCanvas bytes={bytes} textOnly={textOnly} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-500">
            <p>Open a PDF to get started.</p>
          </div>
        )}
      </div>

      <Paywall
        open={paywallOpen}
        onClose={() => setPaywallOpen(false)}
        // Unlocked → close and immediately complete the save the user was trying to make.
        onUnlocked={() => {
          setPaywallOpen(false);
          void onSave();
        }}
      />
    </main>
  );
}
