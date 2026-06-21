"use client";

import { ChevronLeft, Crop, FileText, Layers, Pencil, Image as ImageIcon, Redo2, Type, Undo2, Upload, Eye } from "lucide-react";
import { ExportMenu } from "./ExportMenu";
import type { ExportFormat } from "@/lib/pdf/convert";
import type { EditMode } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

const MODES: { mode: EditMode; label: string; Icon: typeof Eye }[] = [
  { mode: "view", label: "View", Icon: Eye },
  { mode: "text", label: "Text", Icon: Type },
  { mode: "image", label: "Image", Icon: ImageIcon },
  { mode: "annotate", label: "Draw", Icon: Pencil },
  { mode: "object", label: "Object", Icon: Crop },
];

interface MobileToolbarProps {
  fileName: string | null;
  numPages: number;
  activePage: number;
  hasDoc: boolean;
  editMode: EditMode;
  editCount: number;
  isExporting: boolean;
  onUploadClick: () => void;
  onOpenPages: () => void;
  onSetMode: (mode: EditMode) => void;
  onExport: (format: ExportFormat) => void;
  onHome: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * Touch-first chrome shown below `md`. Two stacked rows that never overflow a phone:
 *   1. file name · page · Pages drawer · Export · Open
 *   2. a full-width segmented control for the edit modes (big tap targets)
 * The desktop {@link import("./Toolbar").Toolbar} is hidden at this breakpoint.
 */
export function MobileToolbar({
  fileName,
  numPages,
  activePage,
  hasDoc,
  editMode,
  editCount,
  isExporting,
  onUploadClick,
  onOpenPages,
  onSetMode,
  onExport,
  onHome,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: MobileToolbarProps) {
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white pt-safe md:hidden">
      <div className="flex h-14 items-center gap-2 px-3">
        {hasDoc ? (
          <button
            onClick={onHome}
            aria-label="Back to projects"
            className="-ml-1 flex h-11 w-9 items-center justify-center text-neutral-700 active:bg-neutral-100"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        ) : (
          <FileText className="h-6 w-6 shrink-0 text-blue-600" />
        )}

        <div className="min-w-0 flex-1">
          {fileName ? (
            <>
              <p className="truncate text-sm font-medium text-neutral-800" title={fileName}>
                {fileName}
              </p>
              {hasDoc && (
                <p className="text-xs text-neutral-500">
                  Page {activePage + 1} / {numPages}
                </p>
              )}
            </>
          ) : (
            <p className="text-base font-semibold text-neutral-900">PDF Editor</p>
          )}
        </div>

        {hasDoc && (
          <>
            <button
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo"
              className="flex h-11 w-9 items-center justify-center rounded-lg text-neutral-700 active:bg-neutral-100 disabled:opacity-30"
            >
              <Undo2 className="h-5 w-5" />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              aria-label="Redo"
              className="flex h-11 w-9 items-center justify-center rounded-lg text-neutral-700 active:bg-neutral-100 disabled:opacity-30"
            >
              <Redo2 className="h-5 w-5" />
            </button>
            <button
              onClick={onOpenPages}
              aria-label="Pages"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-700 active:bg-neutral-100"
            >
              <Layers className="h-5 w-5" />
            </button>
            <ExportMenu isExporting={isExporting} onExport={onExport} />
          </>
        )}

        <button
          onClick={onUploadClick}
          aria-label={hasDoc ? "Replace PDF" : "Open PDF"}
          className={cn(
            "flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium",
            hasDoc ? "text-neutral-700 active:bg-neutral-100" : "bg-blue-600 text-white active:bg-blue-700",
          )}
        >
          <Upload className="h-5 w-5" />
          {!hasDoc && "Open"}
        </button>
      </div>

      {hasDoc && (
        <nav className="grid grid-cols-5 border-t border-neutral-200">
          {MODES.map(({ mode, label, Icon }) => {
            const active = editMode === mode;
            return (
              <button
                key={mode}
                onClick={() => onSetMode(mode)}
                aria-pressed={active}
                className={cn(
                  "relative flex flex-col items-center gap-0.5 py-2 text-xs font-medium transition-colors",
                  active ? "text-blue-600" : "text-neutral-500 active:bg-neutral-100",
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
                {mode === "text" && editCount > 0 && (
                  <span className="absolute right-1/2 top-1 translate-x-4 rounded-full bg-blue-600 px-1.5 text-[10px] leading-4 text-white">
                    {editCount}
                  </span>
                )}
                {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-blue-600" />}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
}
