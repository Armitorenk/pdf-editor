"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { domRectToPdfRect, pdfRectToDomRect, type Rect } from "@/lib/pdf/coordinates";
import type { ImageOverlay } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

/** Minimum on-screen size (CSS px) an image can be resized to. */
const MIN_PX = 24;

interface ImageLayerProps {
  pageId: string;
  /** Page height in PDF points — needed to flip the Y axis. */
  pageHeight: number;
  scale: number;
  images: ImageOverlay[];
  /** Whether drag/resize/select is enabled (image edit mode). */
  interactive: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Reports a new rect in PDF user space (points, lower-left origin). */
  onChange: (id: string, rect: Rect) => void;
  onDelete: (id: string) => void;
}

/**
 * Overlay of placed images for one page. Images are always visible; they only
 * become selectable/draggable in image edit mode. All interaction happens in DOM
 * pixels and is converted back to PDF space on release via the coordinate helpers.
 */
export function ImageLayer({
  pageId,
  pageHeight,
  scale,
  images,
  interactive,
  selectedId,
  onSelect,
  onChange,
  onDelete,
}: ImageLayerProps) {
  const pageImages = images.filter((im) => im.pageId === pageId);
  if (pageImages.length === 0) return null;

  return (
    <div
      className={cn("absolute inset-0", interactive ? "z-10" : "pointer-events-none")}
      onPointerDown={(e) => {
        if (interactive && e.target === e.currentTarget) onSelect(null);
      }}
    >
      {pageImages.map((img) => (
        <ImageItem
          key={img.id}
          img={img}
          pageHeight={pageHeight}
          scale={scale}
          interactive={interactive}
          selected={interactive && selectedId === img.id}
          onSelect={onSelect}
          onChange={onChange}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

/** Which corner is being dragged; the opposite corner stays anchored. */
type Corner = "tl" | "tr" | "bl" | "br";
type DragState =
  | { kind: "move"; startX: number; startY: number; origin: Rect }
  | { kind: "resize"; corner: Corner; startX: number; startY: number; origin: Rect }
  | null;

interface ImageItemProps {
  img: ImageOverlay;
  pageHeight: number;
  scale: number;
  interactive: boolean;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onChange: (id: string, rect: Rect) => void;
  onDelete: (id: string) => void;
}

function ImageItem({
  img,
  pageHeight,
  scale,
  interactive,
  selected,
  onSelect,
  onChange,
  onDelete,
}: ImageItemProps) {
  const [drag, setDrag] = useState<DragState>(null);
  const [liveDom, setLiveDom] = useState<Rect | null>(null);

  const baseDom = pdfRectToDomRect(
    { x: img.x, y: img.y, width: img.width, height: img.height },
    pageHeight,
    scale,
  );
  const dom = liveDom ?? baseDom;

  const startMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(img.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "move", startX: e.clientX, startY: e.clientY, origin: baseDom });
    setLiveDom(baseDom);
  };

  const startResize = (corner: Corner) => (e: React.PointerEvent<HTMLElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(img.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", corner, startX: e.clientX, startY: e.clientY, origin: baseDom });
    setLiveDom(baseDom);
  };

  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const o = drag.origin;

    if (drag.kind === "move") {
      setLiveDom({ ...o, x: o.x + dx, y: o.y + dy });
      return;
    }

    // Free (non-aspect-locked) resize: drag a corner, the opposite corner stays put.
    const right = o.x + o.width;
    const bottom = o.y + o.height;
    const left = drag.corner === "tl" || drag.corner === "bl";
    const top = drag.corner === "tl" || drag.corner === "tr";

    let width = o.width + (left ? -dx : dx);
    let height = o.height + (top ? -dy : dy);
    width = Math.max(MIN_PX, width);
    height = Math.max(MIN_PX, height);
    // Anchor the side that isn't moving.
    const x = left ? right - width : o.x;
    const y = top ? bottom - height : o.y;
    setLiveDom({ x, y, width, height });
  };

  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (liveDom) onChange(img.id, domRectToPdfRect(liveDom, pageHeight, scale));
    setDrag(null);
    setLiveDom(null);
  };

  return (
    <div
      style={{ left: dom.x, top: dom.y, width: dom.width, height: dom.height }}
      className={cn(
        "absolute touch-none",
        selected ? "ring-2 ring-blue-500" : interactive && "ring-1 ring-blue-300/60",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img.src}
        alt=""
        draggable={false}
        onPointerDown={startMove}
        onPointerMove={move}
        onPointerUp={end}
        className={cn("h-full w-full select-none", interactive && "cursor-move")}
      />

      {selected && (
        <>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(img.id)}
            aria-label="Delete image"
            className="absolute -right-4 -top-4 flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white shadow-md active:bg-red-700 hover:bg-red-500"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          {/* Four corner handles — drag any to stretch freely (aspect not locked). */}
          {(["tl", "tr", "bl", "br"] as Corner[]).map((corner) => (
            <div
              key={corner}
              onPointerDown={startResize(corner)}
              onPointerMove={move}
              onPointerUp={end}
              className={cn(
                "absolute flex h-10 w-10 items-center justify-center",
                corner === "tl" && "-left-5 -top-5 cursor-nwse-resize",
                corner === "tr" && "-right-5 -top-5 cursor-nesw-resize",
                corner === "bl" && "-bottom-5 -left-5 cursor-nesw-resize",
                corner === "br" && "-bottom-5 -right-5 cursor-nwse-resize",
              )}
            >
              <span className="h-4 w-4 rounded-sm border-2 border-blue-500 bg-white shadow" />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
