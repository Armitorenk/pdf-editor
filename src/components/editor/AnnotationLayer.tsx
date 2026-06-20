"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { domRectToPdfRect, pdfRectToDomRect, type Rect } from "@/lib/pdf/coordinates";
import type { Annotation, AnnotationTool } from "@/lib/pdf/types";

interface DomPoint {
  x: number;
  y: number;
}

type Drawing =
  | { kind: "pen"; points: DomPoint[] }
  | { kind: "box"; start: DomPoint; current: DomPoint }
  | null;

/** Live move of a selected object (deltas in PDF points). */
type Move = { id: string; startX: number; startY: number; dx: number; dy: number } | null;

interface AnnotationLayerProps {
  pageId: string;
  /** Page height in PDF points — needed to flip the Y axis. */
  pageHeight: number;
  scale: number;
  annotations: Annotation[];
  /** Whether drawing/selecting is enabled (annotate mode). */
  active: boolean;
  tool: AnnotationTool;
  color: string;
  /** Stroke width in PDF points. */
  strokeWidth: number;
  onAdd: (ann: Annotation) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onDelete: (id: string) => void;
}

/**
 * SVG overlay aligned to a page's canvas. Renders committed annotations and, in
 * annotate mode, either captures pointer drawing or — with the **select** tool —
 * lets the user tap an object to pick it, drag to move it, and delete it. The
 * select tool exists because deleting a single drawing is otherwise impossible on
 * touch (no per-object handle, no right-click). Geometry is in DOM pixels while
 * interacting and converted to PDF user space (points, bottom-left origin) on release.
 */
export function AnnotationLayer({
  pageId,
  pageHeight,
  scale,
  annotations,
  active,
  tool,
  color,
  strokeWidth,
  onAdd,
  selectedId,
  onSelect,
  onMove,
  onDelete,
}: AnnotationLayerProps) {
  const [drawing, setDrawing] = useState<Drawing>(null);
  const [move, setMove] = useState<Move>(null);
  const pageAnnotations = annotations.filter((a) => a.pageId === pageId);
  if (pageAnnotations.length === 0 && !active) return null;

  const localPoint = (e: React.PointerEvent<SVGSVGElement>): DomPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!active) return;
    const p = localPoint(e);

    if (tool === "select") {
      // Topmost (last drawn) object under the finger wins.
      const hit = [...pageAnnotations].reverse().find((a) => hitTest(a, p, scale, pageHeight));
      onSelect(hit ? hit.id : null);
      if (hit) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setMove({ id: hit.id, startX: p.x, startY: p.y, dx: 0, dy: 0 });
      }
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing(tool === "pen" ? { kind: "pen", points: [p] } : { kind: "box", start: p, current: p });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (move) {
      const p = localPoint(e);
      setMove({ ...move, dx: (p.x - move.startX) / scale, dy: -(p.y - move.startY) / scale });
      return;
    }
    if (!drawing) return;
    const p = localPoint(e);
    if (drawing.kind === "pen") {
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) {
        setDrawing({ kind: "pen", points: [...drawing.points, p] });
      }
    } else {
      setDrawing({ ...drawing, current: p });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (move) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (move.dx !== 0 || move.dy !== 0) onMove(move.id, move.dx, move.dy);
      setMove(null);
      return;
    }
    if (!drawing) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const base = { id: crypto.randomUUID(), pageId, color, strokeWidth };

    if (drawing.kind === "pen") {
      const points = drawing.points.map((p) => ({ x: p.x / scale, y: pageHeight - p.y / scale }));
      if (points.length >= 2) onAdd({ ...base, kind: "pen", points });
    } else {
      const dom = normalize(drawing.start, drawing.current);
      if (dom.width >= 3 || dom.height >= 3) {
        const r = domRectToPdfRect(dom, pageHeight, scale);
        // Box branch only runs for highlight/rect/ellipse; default keeps types happy.
        const kind = tool === "highlight" || tool === "ellipse" ? tool : "rect";
        onAdd({ ...base, kind, x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    setDrawing(null);
  };

  const selected = pageAnnotations.find((a) => a.id === selectedId) ?? null;
  // While moving, draw the selected object (and its chrome) at the live offset.
  const liveShift = move && selected && move.id === selected.id ? { dx: move.dx, dy: move.dy } : null;

  return (
    <>
      <svg
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="absolute inset-0 h-full w-full"
        style={{
          zIndex: active ? 20 : 5,
          pointerEvents: active ? "auto" : "none",
          cursor: active ? (tool === "select" ? "default" : "crosshair") : "default",
          touchAction: "none",
        }}
      >
        {pageAnnotations.map((ann) => {
          const shown = liveShift && ann.id === selected?.id ? shiftAnnotation(ann, liveShift.dx, liveShift.dy) : ann;
          return <AnnotationShape key={ann.id} ann={shown} pageHeight={pageHeight} scale={scale} />;
        })}
        {drawing && <DrawingPreview drawing={drawing} tool={tool} color={color} width={strokeWidth * scale} />}
      </svg>

      {active && tool === "select" && selected && (
        <SelectionChrome
          ann={liveShift ? shiftAnnotation(selected, liveShift.dx, liveShift.dy) : selected}
          pageHeight={pageHeight}
          scale={scale}
          onDelete={() => onDelete(selected.id)}
        />
      )}
    </>
  );
}

// --- geometry helpers --------------------------------------------------------

/** Bounding box of an annotation in PDF user space (bottom-left origin). */
function bbox(ann: Annotation): Rect {
  if (ann.kind === "pen") {
    const xs = ann.points.map((p) => p.x);
    const ys = ann.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
}

/** Is the DOM point inside the annotation's (padded) bounding box? */
function hitTest(ann: Annotation, p: DomPoint, scale: number, pageHeight: number): boolean {
  const r = pdfRectToDomRect(bbox(ann), pageHeight, scale);
  const pad = 12; // generous for fingers / thin strokes
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

/** Return a copy of the annotation translated by (dx, dy) PDF points. */
function shiftAnnotation(ann: Annotation, dx: number, dy: number): Annotation {
  if (ann.kind === "pen") {
    return { ...ann, points: ann.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
  return { ...ann, x: ann.x + dx, y: ann.y + dy };
}

function normalize(a: DomPoint, b: DomPoint): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

// --- rendering ---------------------------------------------------------------

/** Dashed box + delete button around the selected object. */
function SelectionChrome({
  ann,
  pageHeight,
  scale,
  onDelete,
}: {
  ann: Annotation;
  pageHeight: number;
  scale: number;
  onDelete: () => void;
}) {
  const r = pdfRectToDomRect(bbox(ann), pageHeight, scale);
  const pad = 6;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 25 }}>
      <div
        className="absolute rounded-sm border-2 border-dashed border-blue-500"
        style={{ left: r.x - pad, top: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }}
      >
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
          aria-label="Delete object"
          className="pointer-events-auto absolute -right-4 -top-4 flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white shadow-md active:bg-red-700 hover:bg-red-500"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** Render one committed annotation (PDF space -> DOM). */
function AnnotationShape({
  ann,
  pageHeight,
  scale,
}: {
  ann: Annotation;
  pageHeight: number;
  scale: number;
}) {
  const strokeW = ann.strokeWidth * scale;
  if (ann.kind === "pen") {
    const pts = ann.points.map((p) => `${p.x * scale},${(pageHeight - p.y) * scale}`).join(" ");
    return (
      <polyline points={pts} fill="none" stroke={ann.color} strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round" />
    );
  }
  const r = pdfRectToDomRect({ x: ann.x, y: ann.y, width: ann.width, height: ann.height }, pageHeight, scale);
  if (ann.kind === "highlight") {
    return <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={ann.color} fillOpacity={0.35} />;
  }
  if (ann.kind === "rect") {
    return <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="none" stroke={ann.color} strokeWidth={strokeW} />;
  }
  return (
    <ellipse
      cx={r.x + r.width / 2}
      cy={r.y + r.height / 2}
      rx={r.width / 2}
      ry={r.height / 2}
      fill="none"
      stroke={ann.color}
      strokeWidth={strokeW}
    />
  );
}

/** Live preview while the user is drawing (DOM coordinates). */
function DrawingPreview({
  drawing,
  tool,
  color,
  width,
}: {
  drawing: NonNullable<Drawing>;
  tool: AnnotationTool;
  color: string;
  width: number;
}) {
  if (drawing.kind === "pen") {
    const pts = drawing.points.map((p) => `${p.x},${p.y}`).join(" ");
    return <polyline points={pts} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />;
  }
  const r = normalize(drawing.start, drawing.current);
  if (tool === "highlight") {
    return <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={color} fillOpacity={0.35} />;
  }
  if (tool === "ellipse") {
    return (
      <ellipse cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={r.width / 2} ry={r.height / 2} fill="none" stroke={color} strokeWidth={width} />
    );
  }
  return <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="none" stroke={color} strokeWidth={width} />;
}
