"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileText, FileType, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExportFormat } from "@/lib/pdf/convert";

const OPTIONS: { format: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
  { format: "pdf", label: "PDF", hint: "Edited document", Icon: FileText },
  { format: "png", label: "PNG image(s)", hint: "One per page · ZIP if multi-page", Icon: ImageIcon },
  { format: "jpeg", label: "JPEG image(s)", hint: "Smaller · ZIP if multi-page", Icon: ImageIcon },
  { format: "txt", label: "Plain text", hint: "Extracted text (.txt)", Icon: FileType },
];

interface ExportMenuProps {
  isExporting: boolean;
  onExport: (format: ExportFormat) => void;
}

/**
 * "Export ▾" split into output formats. A lightweight dropdown (no external menu
 * lib): closes on outside-click or Escape. Each item delegates to the parent's
 * `onExport`, which knows how to produce that format.
 */
export function ExportMenu({ isExporting, onExport }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        disabled={isExporting}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Export
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {OPTIONS.map(({ format, label, hint, Icon }) => (
            <button
              key={format}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(format);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-100"
            >
              <Icon className="h-4 w-4 shrink-0 text-neutral-500" />
              <span className="flex flex-col">
                <span className="text-sm text-neutral-900">{label}</span>
                <span className="text-xs text-neutral-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
