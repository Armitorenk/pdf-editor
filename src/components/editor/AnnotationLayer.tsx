"use client";

import { useState } from "react";
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

interface AnnotationLayerProps {
  pageId: string;
  /** Page height in PDF points — needed to flip the Y axis. */
  pageHeight: number;
  scale: number;
  annotations: Annotation[];
  /** Whether drawing is enabled (annotate mode). */
  active: boolean;
  tool: AnnotationTool;
  color: string;
  /** Stroke width in PDF points. */
  strokeWidth: number;
  onAdd: (ann: Annotation) => void;
}

/**
 * SVG overlay aligned to a page's canvas. Renders committed annotations and, in
 * annotate mode, captures pointer drawing. Everything is drawn in DOM pixels and
 * converted to PDF user space (points, bottom-left origin) on release.
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
}: AnnotationLayerProps) {
  const [drawing, setDrawing] = useState<Drawing>(null);
  const pageAnnotations = annotations.filter((a) => a.pageId === pageId);
  if (pageAnnotations.length === 0 && !active) return null;

  const localPoint = (e: React.PointerEvent<SVGSVGElement>): DomPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!active) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    setDrawing(tool === "pen" ? { kind: "pen", points: [p] } : { kind: "box", start: p, current: p });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
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
        const kind = tool === "pen" ? "rect" : tool; // pen handled above
        onAdd({ ...base, kind, x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    setDrawing(null);
  };

  return (
    <svg
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute inset-0 h-full w-full"
      style={{ zIndex: active ? 20 : 5, pointerEvents: active ? "auto" : "none", cursor: active ? "crosshair" : "default", touchAction: "none" }}
    >
      {pageAnnotations.map((ann) => (
        <AnnotationShape key={ann.id} ann={ann} pageHeight={pageHeight} scale={scale} />
      ))}
      {drawing && <DrawingPreview drawing={drawing} tool={tool} color={color} width={strokeWidth * scale} />}
    </svg>
  );
}

function normalize(a: DomPoint, b: DomPoint): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
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
