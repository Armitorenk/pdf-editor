"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Rect } from "@/lib/pdf/coordinates";
import type {
  Annotation,
  AnnotationTool,
  EditMode,
  ImageOverlay,
  PageRef,
  PageSize,
  TextEdit,
} from "@/lib/pdf/types";
import type { FontStyleInfo } from "@/lib/pdf/fontStyles";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { TextLayer } from "./TextLayer";
import { ImageLayer } from "./ImageLayer";
import { AnnotationLayer } from "./AnnotationLayer";
import { ObjectLayer } from "./ObjectLayer";

/** Imperative API the parent uses to drive the scroll position. */
export interface ViewerApi {
  scrollToPage(slotIndex: number): void;
}

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  scale: number;
  /** Set the zoom level (used by the two-finger pinch gesture). */
  onZoom: (next: number) => void;
  editMode: EditMode;
  pageOrder: PageRef[];

  textEdits: Record<string, TextEdit>;
  onCommitTextEdit: (edit: TextEdit) => void;
  onRemoveTextEdit: (key: string) => void;
  fontStyleMap: Map<string, FontStyleInfo> | null;
  onRegisterFont: (psName: string, data: Uint8Array) => void;

  images: ImageOverlay[];
  selectedImageId: string | null;
  onSelectImage: (id: string | null) => void;
  onChangeImage: (id: string, rect: Rect) => void;
  onDeleteImage: (id: string) => void;

  annotations: Annotation[];
  annotationTool: AnnotationTool;
  annotationColor: string;
  annotationWidth: number;
  onAddAnnotation: (ann: Annotation) => void;
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  onMoveAnnotation: (id: string, dx: number, dy: number) => void;
  onDeleteAnnotation: (id: string) => void;

  /** Lift an existing object: a drawn box (DOM px) on an original page. */
  onLiftObject: (pageId: string, pageNumber: number, pageHeight: number, domRect: Rect) => void;

  apiRef?: React.RefObject<ViewerApi | null>;
  onActivePageChange?: (slotIndex: number) => void;
}

/**
 * Scrollable viewer that renders the working document slot-by-slot from
 * `pageOrder` (original pages via pdf.js, blank pages as white boxes), each with
 * its image / annotation / text overlays. Slot sizes are resolved up-front so
 * scroll position stays stable; rasterising is still deferred per page.
 */
export function PdfViewer(props: PdfViewerProps) {
  const { doc, scale, onZoom, editMode, pageOrder, apiRef, onActivePageChange } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Pinch-to-zoom -------------------------------------------------------
  // Two-finger pinch drives the same `scale` the toolbar buttons use, so pages
  // re-render crisply at the new zoom (no blurry CSS transform). The pinch midpoint
  // is kept anchored: we remember the content point under it and, after each scale
  // change, restore the scroll so that point stays under the fingers.
  const scaleRef = useRef(scale);
  const onZoomRef = useRef(onZoom);
  useEffect(() => {
    scaleRef.current = scale;
    onZoomRef.current = onZoom;
  });
  const anchorRef = useRef<{ ax: number; ay: number; midX: number; midY: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const p = { active: false, startDist: 0, startScale: 1 };
    let raf = 0;
    let pendingFactor = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const rect = el.getBoundingClientRect();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      p.active = true;
      p.startDist = dist(e.touches);
      p.startScale = scaleRef.current;
      // Content point (in scale-1 units) currently under the pinch midpoint.
      anchorRef.current = {
        ax: (el.scrollLeft + midX) / scaleRef.current,
        ay: (el.scrollTop + midY) / scaleRef.current,
        midX,
        midY,
      };
    };
    const onMove = (e: TouchEvent) => {
      if (!p.active || e.touches.length !== 2) return;
      e.preventDefault(); // stop native scroll/zoom fighting the gesture
      pendingFactor = dist(e.touches) / (p.startDist || 1);
      // Throttle to one zoom update per frame so pages don't re-render per touch event.
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          onZoomRef.current(p.startScale * pendingFactor);
        });
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        p.active = false;
        anchorRef.current = null;
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // After a pinch changes `scale`, re-anchor the scroll to the pinch midpoint.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = containerRef.current;
    if (!a || !el) return;
    el.scrollLeft = a.ax * scale - a.midX;
    el.scrollTop = a.ay * scale - a.midY;
  }, [scale]);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [slotSizes, setSlotSizes] = useState<PageSize[] | null>(null);

  // Resolve every slot's size (original -> pdf.js page size, blank -> stored size).
  useEffect(() => {
    let cancelled = false;
    setSlotSizes(null);
    (async () => {
      const sizes: PageSize[] = [];
      for (const ref of pageOrder) {
        if (ref.kind === "original") {
          const page = await doc.getPage(ref.originalIndex + 1);
          const { width, height } = page.getViewport({ scale: 1 });
          sizes.push({ width, height });
        } else {
          sizes.push({ width: ref.width, height: ref.height });
        }
      }
      if (!cancelled) setSlotSizes(sizes);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageOrder]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToPage(slotIndex) {
        const el = pageRefs.current[slotIndex];
        const container = containerRef.current;
        if (el && container) container.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, slotSizes]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !onActivePageChange) return;
    const midpoint = container.scrollTop + container.clientHeight / 2;
    let active = 0;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (el && el.offsetTop <= midpoint) active = i;
      else break;
    }
    onActivePageChange(active);
  }, [onActivePageChange]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      // `touch-pan-x/y` lets a one-finger drag pan both axes (the two-finger pinch is
      // handled in JS); `overscroll-contain` stops a pan at the edge from triggering
      // the system back-swipe. Crisp pages come from the DPR-aware canvas renderer.
      className="relative h-full overflow-auto overscroll-contain touch-pan-x touch-pan-y bg-neutral-200"
    >
      {/* `w-max` lets this grow to the widest page so a zoomed/wide page can be
          panned all the way to its LEFT edge. With a plain `min-w-full` block the
          container stays at viewport width and `items-center` pushes the page's left
          half into unreachable negative-scroll space. `min-w-full` still fills the
          width (centring pages) when everything fits. */}
      <div className="flex w-max min-w-full flex-col items-center gap-6 p-6">
        {slotSizes?.map((size, i) => {
          const ref = pageOrder[i];
          return (
            <div
              key={ref.id}
              ref={(el) => {
                pageRefs.current[i] = el;
              }}
              className="relative"
            >
              {ref.kind === "original" ? (
                <PdfPageCanvas
                  doc={doc}
                  pageNumber={ref.originalIndex + 1}
                  scale={scale}
                  baseSize={size}
                />
              ) : (
                <div
                  className="flex items-center justify-center bg-white text-sm text-neutral-300 shadow-md ring-1 ring-black/5"
                  style={{ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) }}
                >
                  Blank page
                </div>
              )}

              <ImageLayer
                pageId={ref.id}
                pageHeight={size.height}
                scale={scale}
                images={props.images}
                interactive={editMode === "image"}
                selectedId={props.selectedImageId}
                onSelect={props.onSelectImage}
                onChange={props.onChangeImage}
                onDelete={props.onDeleteImage}
              />

              <AnnotationLayer
                pageId={ref.id}
                pageHeight={size.height}
                scale={scale}
                annotations={props.annotations}
                active={editMode === "annotate"}
                tool={props.annotationTool}
                color={props.annotationColor}
                strokeWidth={props.annotationWidth}
                onAdd={props.onAddAnnotation}
                selectedId={props.selectedAnnotationId}
                onSelect={props.onSelectAnnotation}
                onMove={props.onMoveAnnotation}
                onDelete={props.onDeleteAnnotation}
              />

              {ref.kind === "original" && (
                <TextLayer
                  doc={doc}
                  pageNumber={ref.originalIndex + 1}
                  pageId={ref.id}
                  pageHeight={size.height}
                  scale={scale}
                  interactive={editMode === "text"}
                  edits={props.textEdits}
                  onCommit={props.onCommitTextEdit}
                  onRemove={props.onRemoveTextEdit}
                  fontStyleMap={props.fontStyleMap}
                  onRegisterFont={props.onRegisterFont}
                />
              )}

              {ref.kind === "original" && (
                <ObjectLayer
                  active={editMode === "object"}
                  onLift={(domRect) =>
                    props.onLiftObject(ref.id, ref.originalIndex + 1, size.height, domRect)
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
