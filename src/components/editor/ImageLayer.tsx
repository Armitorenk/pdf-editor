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

type DragState = { kind: "move" | "resize"; startX: number; startY: number; origin: Rect } | null;

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

  const start = (kind: "move" | "resize") => (e: React.PointerEvent<HTMLElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(img.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind, startX: e.clientX, startY: e.clientY, origin: baseDom });
    setLiveDom(baseDom);
  };

  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.kind === "move") {
      setLiveDom({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy });
    } else {
      // Aspect-locked resize from the bottom-right corner; top-left stays put.
      const aspect = drag.origin.width / drag.origin.height;
      const width = Math.max(MIN_PX, drag.origin.width + dx);
      setLiveDom({ x: drag.origin.x, y: drag.origin.y, width, height: width / aspect });
    }
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
        onPointerDown={start("move")}
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
          {/* Big invisible touch target around a small visible nub. */}
          <div
            onPointerDown={start("resize")}
            onPointerMove={move}
            onPointerUp={end}
            className="absolute -bottom-5 -right-5 flex h-10 w-10 cursor-nwse-resize items-center justify-center"
          >
            <span className="h-5 w-5 rounded-sm border-2 border-blue-500 bg-white shadow" />
          </div>
        </>
      )}
    </div>
  );
}
