"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { PdfPageCanvas } from "./PdfPageCanvas";
import { TextLayer } from "./TextLayer";
import { ImageLayer } from "./ImageLayer";
import { AnnotationLayer } from "./AnnotationLayer";

/** Imperative API the parent uses to drive the scroll position. */
export interface ViewerApi {
  scrollToPage(slotIndex: number): void;
}

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  scale: number;
  editMode: EditMode;
  pageOrder: PageRef[];

  textEdits: Record<string, TextEdit>;
  onCommitTextEdit: (edit: TextEdit) => void;
  onRemoveTextEdit: (key: string) => void;

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
  const { doc, scale, editMode, pageOrder, apiRef, onActivePageChange } = props;
  const containerRef = useRef<HTMLDivElement>(null);
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
      className="relative h-full overflow-auto bg-neutral-200"
    >
      <div className="flex min-w-full flex-col items-center gap-6 p-6">
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
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
