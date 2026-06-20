"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { isRenderCancelled, renderPageToCanvas } from "@/lib/pdf/render";
import type { PageSize } from "@/lib/pdf/types";

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy;
  /** 1-based page number, matching pdf.js. */
  pageNumber: number;
  scale: number;
  /** Intrinsic page size (scale 1) — used to reserve layout space before render. */
  baseSize: PageSize;
}

/**
 * Renders one PDF page to a canvas, but only once it scrolls near the viewport
 * (lazy via IntersectionObserver) so large documents stay responsive. The
 * wrapper reserves the correct pixel box up-front from `baseSize` * `scale`, so
 * scroll position is stable whether or not the page has painted yet.
 */
export function PdfPageCanvas({ doc, pageNumber, scale, baseSize }: PdfPageCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [visible, setVisible] = useState(false);

  const cssWidth = Math.floor(baseSize.width * scale);
  const cssHeight = Math.floor(baseSize.height * scale);

  // Paint only when the page is near the viewport.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // (Re)render when visible or when the zoom changes.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
      renderTaskRef.current?.cancel();
      const task = renderPageToCanvas(page, canvasRef.current, scale);
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (err) {
        if (!isRenderCancelled(err)) throw err;
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [doc, pageNumber, scale, visible]);

  return (
    <div
      ref={wrapperRef}
      className="relative bg-white shadow-md ring-1 ring-black/5"
      style={{ width: cssWidth, height: cssHeight }}
    >
      <canvas ref={canvasRef} className="block" />
      <span className="pointer-events-none absolute bottom-1 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {pageNumber}
      </span>
    </div>
  );
}
