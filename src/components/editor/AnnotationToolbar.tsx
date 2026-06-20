"use client";

import { Circle, Highlighter, Pen, Square, Trash2, Undo2 } from "lucide-react";
import type { AnnotationTool } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

const TOOLS: { tool: AnnotationTool; label: string; Icon: typeof Pen }[] = [
  { tool: "pen", label: "Pen", Icon: Pen },
  { tool: "highlight", label: "Highlight", Icon: Highlighter },
  { tool: "rect", label: "Rectangle", Icon: Square },
  { tool: "ellipse", label: "Ellipse", Icon: Circle },
];

const WIDTHS = [1, 2, 4, 6];

interface AnnotationToolbarProps {
  tool: AnnotationTool;
  color: string;
  strokeWidth: number;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onUndo: () => void;
  onClearPage: () => void;
}

/** Secondary bar shown in annotate mode: tool picker, colour, width, undo, clear. */
export function AnnotationToolbar({
  tool,
  color,
  strokeWidth,
  onToolChange,
  onColorChange,
  onWidthChange,
  onUndo,
  onClearPage,
}: AnnotationToolbarProps) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-3 text-sm">
      <div className="flex shrink-0 items-center gap-1">
        {TOOLS.map(({ tool: t, label, Icon }) => (
          <button
            key={t}
            onClick={() => onToolChange(t)}
            aria-pressed={tool === t}
            title={label}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
              tool === t ? "bg-blue-600 text-white" : "text-neutral-600 active:bg-neutral-200 hover:bg-neutral-200",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>

      <div className="mx-1 h-6 w-px shrink-0 bg-neutral-200" />

      <label className="flex shrink-0 items-center gap-1.5 text-neutral-600">
        Color
        <input
          type="color"
          value={color}
          onChange={(e) => onColorChange(e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-neutral-300 bg-white p-0.5"
        />
      </label>

      <label className="flex shrink-0 items-center gap-1.5 text-neutral-600">
        Width
        <select
          value={strokeWidth}
          onChange={(e) => onWidthChange(Number(e.target.value))}
          className="h-9 rounded-md border border-neutral-300 bg-white px-2"
        >
          {WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w}pt
            </option>
          ))}
        </select>
      </label>

      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <button
          onClick={onUndo}
          title="Undo last annotation"
          className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-neutral-600 active:bg-neutral-200 hover:bg-neutral-200"
        >
          <Undo2 className="h-4 w-4" />
          Undo
        </button>
        <button
          onClick={onClearPage}
          title="Clear annotations on this page"
          className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-red-600 active:bg-red-50 hover:bg-red-50"
        >
          <Trash2 className="h-4 w-4" />
          <span className="whitespace-nowrap">Clear page</span>
        </button>
      </div>
    </div>
  );
}
