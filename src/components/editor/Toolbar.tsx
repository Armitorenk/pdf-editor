"use client";

import {
  ChevronLeft,
  Crop,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  Maximize,
  Pencil,
  Redo2,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "./ExportMenu";
import type { ExportFormat } from "@/lib/pdf/convert";
import type { EditMode } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

interface ToolbarProps {
  fileName: string | null;
  numPages: number;
  /** 0-based index of the page currently in view. */
  activePage: number;
  scale: number;
  hasDoc: boolean;
  editMode: EditMode;
  editCount: number;
  isExporting: boolean;
  onUploadClick: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFitWidth: () => void;
  onToggleTextMode: () => void;
  onToggleImageMode: () => void;
  onToggleAnnotateMode: () => void;
  onToggleObjectMode: () => void;
  onAddImage: () => void;
  onExport: (format: ExportFormat) => void;
  onHome: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

/** Top application bar: branding, file info, upload, and zoom controls. */
export function Toolbar({
  fileName,
  numPages,
  activePage,
  scale,
  hasDoc,
  editMode,
  editCount,
  isExporting,
  onUploadClick,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitWidth,
  onToggleTextMode,
  onToggleImageMode,
  onToggleAnnotateMode,
  onToggleObjectMode,
  onAddImage,
  onExport,
  onHome,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: ToolbarProps) {
  return (
    <header className="hidden h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-3 md:flex">
      {hasDoc ? (
        <button
          onClick={onHome}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          <ChevronLeft className="h-4 w-4" />
          Projects
        </button>
      ) : (
        <div className="flex items-center gap-2 font-semibold text-neutral-900">
          <FileText className="h-5 w-5 text-blue-600" />
          <span className="hidden sm:inline">PDF Editor</span>
        </div>
      )}

      {fileName && (
        <span className="max-w-[28ch] truncate text-sm text-neutral-500" title={fileName}>
          {fileName}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {hasDoc && (
          <>
            <span className="mr-1 hidden text-sm tabular-nums text-neutral-500 sm:inline">
              Page {activePage + 1} / {numPages}
            </span>

            <div className="mr-1 flex items-center rounded-md border border-neutral-200">
              <Button variant="ghost" size="icon" onClick={onZoomOut} aria-label="Zoom out">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <button
                onClick={onZoomReset}
                className="h-9 w-14 text-sm tabular-nums text-neutral-700 hover:bg-neutral-100"
                title="Reset zoom to 100%"
              >
                {Math.round(scale * 100)}%
              </button>
              <Button variant="ghost" size="icon" onClick={onZoomIn} aria-label="Zoom in">
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>

            <Button variant="ghost" size="icon" onClick={onFitWidth} aria-label="Fit width">
              <Maximize className="h-4 w-4" />
            </Button>

            <div className="mx-1 h-6 w-px bg-neutral-200" />

            <Button variant="ghost" size="icon" onClick={onUndo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRedo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
              <Redo2 className="h-4 w-4" />
            </Button>

            <div className="mx-1 h-6 w-px bg-neutral-200" />

            <Button
              variant={editMode === "text" ? "default" : "outline"}
              size="sm"
              onClick={onToggleTextMode}
              className={cn(editMode === "text" && "bg-blue-600 hover:bg-blue-500")}
              aria-pressed={editMode === "text"}
            >
              <Type className="h-4 w-4" />
              Edit text
              {editCount > 0 && (
                <span className="ml-1 rounded-full bg-white/25 px-1.5 text-xs tabular-nums">
                  {editCount}
                </span>
              )}
            </Button>

            <Button
              variant={editMode === "image" ? "default" : "outline"}
              size="sm"
              onClick={onToggleImageMode}
              className={cn(editMode === "image" && "bg-blue-600 hover:bg-blue-500")}
              aria-pressed={editMode === "image"}
            >
              <ImageIcon className="h-4 w-4" />
              Image
            </Button>

            {editMode === "image" && (
              <Button variant="outline" size="sm" onClick={onAddImage}>
                <ImagePlus className="h-4 w-4" />
                Add
              </Button>
            )}

            <Button
              variant={editMode === "annotate" ? "default" : "outline"}
              size="sm"
              onClick={onToggleAnnotateMode}
              className={cn(editMode === "annotate" && "bg-blue-600 hover:bg-blue-500")}
              aria-pressed={editMode === "annotate"}
            >
              <Pencil className="h-4 w-4" />
              Annotate
            </Button>

            <Button
              variant={editMode === "object" ? "default" : "outline"}
              size="sm"
              onClick={onToggleObjectMode}
              className={cn(editMode === "object" && "bg-blue-600 hover:bg-blue-500")}
              aria-pressed={editMode === "object"}
            >
              <Crop className="h-4 w-4" />
              Object
            </Button>

            <ExportMenu isExporting={isExporting} onExport={onExport} />
          </>
        )}

        <Button variant={hasDoc ? "outline" : "default"} size="sm" onClick={onUploadClick}>
          <Upload className="h-4 w-4" />
          {hasDoc ? "Replace" : "Open PDF"}
        </Button>
      </div>
    </header>
  );
}
