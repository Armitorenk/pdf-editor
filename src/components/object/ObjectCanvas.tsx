"use client";

// Object-editing canvas (Adım 2): renders a PDFium-rasterised page and supports two-finger
// pinch-zoom + pan. The page bitmap and the (future) object overlay live in ONE transformed layer
// so selection boxes / handles stay pinned to the page as it zooms and pans. Native-only (PDFium).

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize } from "lucide-react";
import { PdfEngine, type RenderedPage } from "@/lib/object/pdfEngine";
import { base64FromBytes } from "@/lib/object/base64";

// PDFium rasterisation scale (px per PDF point). Higher = crisper bitmap; CSS transform zooms on
// top of this. (A future refinement re-renders at the live zoom for full crispness.)
const BASE_SCALE = 2;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ObjectCanvas({ bytes }: { bytes: Uint8Array }) {
  const [pages, setPages] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Open the document once per file.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(null);
    (async () => {
      try {
        const { pages } = await PdfEngine.openDoc({ data: base64FromBytes(bytes) });
        if (cancelled) return;
        setPages(pages);
        setPageIndex(0);
      } catch (e) {
        if (!cancelled) {
          setError(msg(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      PdfEngine.closeDoc().catch(() => {});
    };
  }, [bytes]);

  // Render the current page whenever it changes.
  useEffect(() => {
    if (pages === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rp = await PdfEngine.renderPage({ page: pageIndex, scale: BASE_SCALE });
        if (cancelled) return;
        setPage(rp);
        fitToWidth(rp);
      } catch (e) {
        if (!cancelled) setError(msg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, pageIndex]);

  function fitToWidth(rp: RenderedPage) {
    const el = containerRef.current;
    if (!el || rp.width === 0) return;
    const scale = el.clientWidth / rp.width;
    const ty = Math.max(0, (el.clientHeight - rp.height * scale) / 2);
    setView({ scale, tx: 0, ty });
  }

  // ---- gestures: 1 finger = pan, 2 fingers = pinch (midpoint-anchored) + pan ----
  const g = useRef({
    mode: "none" as "none" | "pan" | "pinch",
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    startScale: 1,
    startDist: 0,
    midX: 0,
    midY: 0,
  });

  function onTouchStart(e: React.TouchEvent) {
    const v = viewRef.current;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      g.current = { ...g.current, mode: "pan", startX: t.clientX, startY: t.clientY, startTx: v.tx, startTy: v.ty };
    } else if (e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const rect = containerRef.current!.getBoundingClientRect();
      g.current = {
        mode: "pinch",
        startX: 0,
        startY: 0,
        startTx: v.tx,
        startTy: v.ty,
        startScale: v.scale,
        startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        midX: (a.clientX + b.clientX) / 2 - rect.left,
        midY: (a.clientY + b.clientY) / 2 - rect.top,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = g.current;
    if (s.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      setView((v) => ({ ...v, tx: s.startTx + (t.clientX - s.startX), ty: s.startTy + (t.clientY - s.startY) }));
    } else if (s.mode === "pinch" && e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const newScale = clamp((s.startScale * dist) / s.startDist, MIN_ZOOM, MAX_ZOOM);
      // Keep the content point under the pinch midpoint fixed: screen = t + p*scale.
      const px = (s.midX - s.startTx) / s.startScale;
      const py = (s.midY - s.startTy) / s.startScale;
      setView({ scale: newScale, tx: s.midX - px * newScale, ty: s.midY - py * newScale });
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (e.touches.length === 0) {
      g.current.mode = "none";
    } else if (e.touches.length === 1) {
      // a finger lifted from a pinch — resume panning with the remaining one
      const t = e.touches[0];
      const v = viewRef.current;
      g.current = { ...g.current, mode: "pan", startX: t.clientX, startY: t.clientY, startTx: v.tx, startTy: v.ty };
    }
  }

  const canPrev = pageIndex > 0;
  const canNext = pageIndex < pages - 1;

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden bg-neutral-300"
        style={{ touchAction: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {page && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: page.width,
              height: page.height,
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/png;base64,${page.data}`}
              width={page.width}
              height={page.height}
              alt={`page ${pageIndex + 1}`}
              draggable={false}
              className="block select-none shadow-md"
            />
            {/* Object overlay (selection box / handles) will mount here in Adım 3–4 — same coord space. */}
          </div>
        )}
      </div>

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded bg-black/60 px-3 py-1 text-xs text-white">Yükleniyor…</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-x-3 top-3 rounded bg-red-600 px-3 py-2 text-xs text-white">{error}</div>
      )}

      {/* floating controls: page nav + fit */}
      {pages > 0 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-white shadow-lg">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full disabled:opacity-30"
            onClick={() => canPrev && setPageIndex((i) => i - 1)}
            disabled={!canPrev}
            aria-label="Önceki sayfa"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="min-w-16 text-center text-xs tabular-nums">
            {pageIndex + 1} / {pages}
          </span>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full disabled:opacity-30"
            onClick={() => canNext && setPageIndex((i) => i + 1)}
            disabled={!canNext}
            aria-label="Sonraki sayfa"
          >
            <ChevronRight size={20} />
          </button>
          <button
            className="ml-1 flex h-10 w-10 items-center justify-center rounded-full"
            onClick={() => page && fitToWidth(page)}
            aria-label="Sığdır"
          >
            <Maximize size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
