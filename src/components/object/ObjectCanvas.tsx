"use client";

// Object-editing canvas (Adım 2): renders a PDFium-rasterised page and supports two-finger
// pinch-zoom + pan. The page bitmap and the (future) object overlay live in ONE transformed layer
// so selection boxes / handles stay pinned to the page as it zooms and pans. Native-only (PDFium).

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize } from "lucide-react";
import { PdfEngine, type PdfObject, type RenderedPage } from "@/lib/object/pdfEngine";
import { base64FromBytes } from "@/lib/object/base64";
import { boundsToBitmapRect, hitTestObject } from "@/lib/object/objectCoords";

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
  const [objects, setObjects] = useState<PdfObject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

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
        setSelectedId(null);
        try {
          const res = await PdfEngine.listObjects({ page: pageIndex });
          if (!cancelled) setObjects(res.objects);
        } catch {
          if (!cancelled) setObjects([]);
        }
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
    moved: false, // pan travelled far enough to be a drag (not a tap)
    pinched: false, // a 2-finger pinch happened in this gesture
  });

  function onTouchStart(e: React.TouchEvent) {
    const v = viewRef.current;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      g.current = { ...g.current, mode: "pan", startX: t.clientX, startY: t.clientY, startTx: v.tx, startTy: v.ty, moved: false, pinched: false };
    } else if (e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const rect = containerRef.current!.getBoundingClientRect();
      g.current = {
        ...g.current,
        mode: "pinch",
        startTx: v.tx,
        startTy: v.ty,
        startScale: v.scale,
        startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        midX: (a.clientX + b.clientX) / 2 - rect.left,
        midY: (a.clientY + b.clientY) / 2 - rect.top,
        pinched: true,
        moved: true,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = g.current;
    if (s.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      if (!s.moved && Math.hypot(t.clientX - s.startX, t.clientY - s.startY) > 8) s.moved = true;
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
    const s = g.current;
    if (e.touches.length === 0) {
      // a clean single tap (no pan travel, no pinch) selects the object under the finger
      if (s.mode === "pan" && !s.moved && !s.pinched) handleTap(s.startX, s.startY);
      s.mode = "none";
    } else if (e.touches.length === 1) {
      // a finger lifted from a pinch — resume panning with the remaining one
      const t = e.touches[0];
      const v = viewRef.current;
      g.current = { ...g.current, mode: "pan", startX: t.clientX, startY: t.clientY, startTx: v.tx, startTy: v.ty };
    }
  }

  // Map a tapped screen point into bitmap px and select the topmost object there (or deselect).
  function handleTap(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el || !page) return;
    const rect = el.getBoundingClientRect();
    const v = viewRef.current;
    const bx = (clientX - rect.left - v.tx) / v.scale;
    const by = (clientY - rect.top - v.ty) / v.scale;
    const hit = hitTestObject(objects, page, bx, by);
    setSelectedId(hit ? hit.id : null);
  }

  const canPrev = pageIndex > 0;
  const canNext = pageIndex < pages - 1;
  const selectedObj = selectedId != null ? objects.find((o) => o.id === selectedId) ?? null : null;

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
          </div>
        )}
      </div>

      {/* selection bounding box (screen space, recomputed from the view transform) */}
      {page && selectedObj && (() => {
        const r = boundsToBitmapRect(selectedObj.bounds, page);
        const sl = view.tx + r.left * view.scale;
        const st = view.ty + r.top * view.scale;
        const sw = Math.max(2, r.width * view.scale);
        const sh = Math.max(2, r.height * view.scale);
        return (
          <div
            className="pointer-events-none absolute z-10 border-2 border-blue-500 bg-blue-500/5"
            style={{ left: sl, top: st, width: sw, height: sh }}
          >
            <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-blue-500 px-1 text-[10px] font-medium text-white">
              {selectedObj.type} #{selectedObj.id}
            </span>
          </div>
        );
      })()}

      {/* hint: object count + how to select */}
      {!loading && objects.length > 0 && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/55 px-2 py-1 text-[11px] text-white">
          {objects.length} nesne · dokunup seç
        </div>
      )}

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
