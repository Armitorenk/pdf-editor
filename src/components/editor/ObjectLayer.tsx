"use client";

import { useState } from "react";
import type { Rect } from "@/lib/pdf/coordinates";

interface ObjectLayerProps {
  /** Whether this page's lift overlay is active (object mode). */
  active: boolean;
  /** Called with the drawn box in DOM px (relative to the page, at current zoom). */
  onLift: (domRect: Rect) => void;
}

interface DomPoint {
  x: number;
  y: number;
}

// Ignore tiny accidental taps; require a real drag before lifting.
const MIN_BOX_PX = 12;

/**
 * Object mode overlay: the user drags a box around an existing object (image, logo,
 * stamp, a block of graphics) and on release that region is "lifted" — rasterised
 * into a movable image and the original covered. A drag-box works for any object
 * type and needs no fragile content-stream parsing, and is the touch-friendly way
 * to pick something with a finger.
 */
export function ObjectLayer({ active, onLift }: ObjectLayerProps) {
  const [start, setStart] = useState<DomPoint | null>(null);
  const [current, setCurrent] = useState<DomPoint | null>(null);

  if (!active) return null;

  const local = (e: React.PointerEvent<HTMLDivElement>): DomPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const box: Rect | null =
    start && current
      ? {
          x: Math.min(start.x, current.x),
          y: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = local(e);
        setStart(p);
        setCurrent(p);
      }}
      onPointerMove={(e) => {
        if (start) setCurrent(local(e));
      }}
      onPointerUp={() => {
        if (box && box.width >= MIN_BOX_PX && box.height >= MIN_BOX_PX) onLift(box);
        setStart(null);
        setCurrent(null);
      }}
      className="absolute inset-0"
      style={{ zIndex: 20, cursor: "crosshair", touchAction: "none" }}
    >
      {box && (
        <div
          className="absolute border-2 border-dashed border-blue-500 bg-blue-400/15"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}
