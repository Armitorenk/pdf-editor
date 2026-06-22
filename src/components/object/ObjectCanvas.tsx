"use client";

// Object-editing canvas. Renders a PDFium-rasterised page with two-finger pinch-zoom + pan
// (Adım 2), tap-to-select with a bounding box (Adım 3), and 48dp move/resize/rotate handles +
// a floating toolbar (delete / colour / edit-text) wired to the native edit ops (Adım 4–5).
// Gestures preview on the outline; on release the real PDFium transform is applied and the page
// re-rendered. Native-only (PDFium).

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize,
  Palette,
  Pencil,
  Redo2,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { PdfEngine, type PdfObject, type RenderedPage } from "@/lib/object/pdfEngine";
import { base64FromBytes } from "@/lib/object/base64";
import { boundsToBitmapRect, hitTestObject, pageScale } from "@/lib/object/objectCoords";
import { moveMatrix, rotateAboutMatrix, scaleAboutMatrix, type Matrix6 } from "@/lib/object/transforms";
import { NumberField } from "./NumberField";

const BASE_SCALE = 2; // PDFium rasterisation scale (px per PDF point); CSS transform zooms on top
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const SWATCHES = ["#000000", "#ffffff", "#e11d48", "#2563eb", "#16a34a", "#f59e0b"];

type Corner = "tl" | "tr" | "bl" | "br";
interface View {
  scale: number;
  tx: number;
  ty: number;
}
interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
type Preview = ScreenRect & { rotDeg: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Crop a region of a (PNG data-URL) bitmap into raw RGBA bytes — used to duplicate an object as
// a new raster image. `s*` are source px in the bitmap, `d*` the output size.
function cropToRgba(dataUrl: string, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
      const d = ctx.getImageData(0, 0, dw, dh).data;
      resolve(new Uint8Array(d.buffer.slice(0)));
    };
    img.onerror = () => reject(new Error("crop image load failed"));
    img.src = dataUrl;
  });
}
const BTN = "flex h-10 w-10 items-center justify-center rounded-md hover:bg-neutral-100 active:bg-neutral-200";

export function ObjectCanvas({ bytes }: { bytes: Uint8Array }) {
  const [pages, setPages] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [objects, setObjects] = useState<PdfObject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [textInput, setTextInput] = useState<{ value: string } | null>(null);
  // Undo/redo: snapshot the whole doc (base64) before each edit; restore by reopening.
  const [histVer, setHistVer] = useState(0);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const previewRef = useRef<Preview | null>(null);

  // Open the document once per file.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(null);
    undoRef.current = [];
    redoRef.current = [];
    setHistVer(0);
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

  // Render the current page whenever it changes (fit to width, fresh object list).
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

  // Re-render the current page + refresh objects after an edit, keeping the current zoom/pan.
  async function refresh(keepId: number | null) {
    try {
      const rp = await PdfEngine.renderPage({ page: pageIndex, scale: BASE_SCALE });
      setPage(rp);
      const res = await PdfEngine.listObjects({ page: pageIndex });
      setObjects(res.objects);
      setSelectedId(keepId != null && keepId < res.objects.length ? keepId : null);
    } catch (e) {
      setError(msg(e));
    }
  }

  // ---- pan / pinch / tap on the page ----
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
    moved: false,
    pinched: false,
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
      const px = (s.midX - s.startTx) / s.startScale;
      const py = (s.midY - s.startTy) / s.startScale;
      setView({ scale: newScale, tx: s.midX - px * newScale, ty: s.midY - py * newScale });
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    const s = g.current;
    if (e.touches.length === 0) {
      if (s.mode === "pan" && !s.moved && !s.pinched) handleTap(s.startX, s.startY);
      s.mode = "none";
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const v = viewRef.current;
      g.current = { ...g.current, mode: "pan", startX: t.clientX, startY: t.clientY, startTx: v.tx, startTy: v.ty };
    }
  }

  function handleTap(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el || !page || busy) return;
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
  const canUndo = histVer >= 0 && undoRef.current.length > 0; // histVer forces this to recompute
  const canRedo = redoRef.current.length > 0;

  // Base (unrotated) screen rect of the selection, recomputed from the view transform each render.
  const baseSelRect: ScreenRect | null =
    page && selectedObj
      ? (() => {
          const r = boundsToBitmapRect(selectedObj.bounds, page);
          return {
            left: view.tx + r.left * view.scale,
            top: view.ty + r.top * view.scale,
            width: Math.max(8, r.width * view.scale),
            height: Math.max(8, r.height * view.scale),
          };
        })()
      : null;

  // ---- edit gesture (move / resize / rotate) on the selection handles ----
  const eg = useRef<{
    type: "move" | "resize" | "rotate";
    corner?: Corner;
    sx: number;
    sy: number;
    base: ScreenRect;
    cx: number;
    cy: number;
    startAngle: number;
  } | null>(null);

  const localPoint = (e: React.TouchEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  };

  const onMoveStart = (e: React.TouchEvent) => {
    if (!baseSelRect || e.touches.length !== 1) return;
    e.stopPropagation();
    const p = localPoint(e);
    eg.current = { type: "move", sx: p.x, sy: p.y, base: baseSelRect, cx: 0, cy: 0, startAngle: 0 };
  };
  const onResizeStart = (corner: Corner) => (e: React.TouchEvent) => {
    if (!baseSelRect || e.touches.length !== 1) return;
    e.stopPropagation();
    const p = localPoint(e);
    eg.current = { type: "resize", corner, sx: p.x, sy: p.y, base: baseSelRect, cx: 0, cy: 0, startAngle: 0 };
  };
  const onRotateStart = (e: React.TouchEvent) => {
    if (!baseSelRect || e.touches.length !== 1) return;
    e.stopPropagation();
    const p = localPoint(e);
    const cx = baseSelRect.left + baseSelRect.width / 2;
    const cy = baseSelRect.top + baseSelRect.height / 2;
    eg.current = { type: "rotate", sx: p.x, sy: p.y, base: baseSelRect, cx, cy, startAngle: Math.atan2(p.y - cy, p.x - cx) };
  };

  const setPv = (pv: Preview) => {
    previewRef.current = pv;
    setPreview(pv);
  };

  const onEditMove = (e: React.TouchEvent) => {
    const s = eg.current;
    if (!s || e.touches.length !== 1) return;
    e.stopPropagation();
    const { x, y } = localPoint(e);
    const b = s.base;
    if (s.type === "move") {
      setPv({ left: b.left + (x - s.sx), top: b.top + (y - s.sy), width: b.width, height: b.height, rotDeg: 0 });
    } else if (s.type === "resize") {
      const right = b.left + b.width;
      const bottom = b.top + b.height;
      let left = b.left;
      let top = b.top;
      let w = b.width;
      let h = b.height;
      if (s.corner === "br") {
        w = Math.max(8, x - b.left);
        h = Math.max(8, y - b.top);
      } else if (s.corner === "tl") {
        left = Math.min(x, right - 8);
        top = Math.min(y, bottom - 8);
        w = right - left;
        h = bottom - top;
      } else if (s.corner === "tr") {
        top = Math.min(y, bottom - 8);
        w = Math.max(8, x - b.left);
        h = bottom - top;
      } else if (s.corner === "bl") {
        left = Math.min(x, right - 8);
        w = right - left;
        h = Math.max(8, y - b.top);
      }
      setPv({ left, top, width: w, height: h, rotDeg: 0 });
    } else if (s.type === "rotate") {
      const deg = ((Math.atan2(y - s.cy, x - s.cx) - s.startAngle) * 180) / Math.PI;
      setPv({ left: b.left, top: b.top, width: b.width, height: b.height, rotDeg: deg });
    }
  };

  const onEditEnd = (e: React.TouchEvent) => {
    const s = eg.current;
    if (!s) return;
    e.stopPropagation();
    eg.current = null;
    const pv = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    if (pv) applyEdit(s, pv);
  };

  // Convert the finished gesture into a PDFium transform and apply it.
  async function applyEdit(
    s: { type: "move" | "resize" | "rotate"; corner?: Corner; base: ScreenRect },
    pv: Preview,
  ) {
    if (!page || selectedId == null || !selectedObj) return;
    const [l, b, r, t] = selectedObj.bounds;
    const { sx, sy } = pageScale(page);
    const v = viewRef.current;
    let m: Matrix6 | null = null;

    if (s.type === "move") {
      const pdfDx = (pv.left - s.base.left) / v.scale / sx;
      const pdfDy = -((pv.top - s.base.top) / v.scale / sy); // screen-down = PDF −y
      m = moveMatrix(pdfDx, pdfDy);
    } else if (s.type === "resize") {
      const fx = pv.width / s.base.width;
      const fy = pv.height / s.base.height;
      // anchor = the corner OPPOSITE the dragged one, in PDF coords (screen-top = PDF-top)
      let ax = l;
      let ay = t;
      if (s.corner === "tl") { ax = r; ay = b; }
      else if (s.corner === "tr") { ax = l; ay = b; }
      else if (s.corner === "bl") { ax = r; ay = t; }
      else { ax = l; ay = t; } // br
      m = scaleAboutMatrix(fx, fy, ax, ay);
    } else if (s.type === "rotate") {
      const cx = (l + r) / 2;
      const cy = (b + t) / 2;
      m = rotateAboutMatrix((-pv.rotDeg * Math.PI) / 180, cx, cy); // screen-cw = PDF-ccw
    }
    if (!m) return;

    setBusy(true);
    try {
      await beforeEdit();
      await PdfEngine.transformObject({ page: pageIndex, index: selectedId, a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
      await refresh(selectedId);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  // Snapshot the document before a mutating edit, for undo. (saveDocument serialises the whole
  // doc; cheap enough per edit, robust for every op type incl. delete/colour.)
  async function beforeEdit() {
    try {
      const { data } = await PdfEngine.saveDocument();
      undoRef.current.push(data);
      if (undoRef.current.length > 20) undoRef.current.shift();
      redoRef.current = [];
      setHistVer((v) => v + 1);
    } catch {
      /* snapshot failed — this op just won't be undoable */
    }
  }

  async function undo() {
    if (!undoRef.current.length) return;
    setBusy(true);
    try {
      const { data: cur } = await PdfEngine.saveDocument();
      redoRef.current.push(cur);
      const prev = undoRef.current.pop()!;
      await PdfEngine.openDoc({ data: prev });
      await refresh(null);
      setHistVer((v) => v + 1);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function redo() {
    if (!redoRef.current.length) return;
    setBusy(true);
    try {
      const { data: cur } = await PdfEngine.saveDocument();
      undoRef.current.push(cur);
      const next = redoRef.current.pop()!;
      await PdfEngine.openDoc({ data: next });
      await refresh(null);
      setHistVer((v) => v + 1);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  // Z-order: bring the selected object to front / send to back.
  async function doReorder(toFront: boolean) {
    if (selectedId == null) return;
    setBusy(true);
    try {
      await beforeEdit();
      const { index } = await PdfEngine.reorderObject({ page: pageIndex, index: selectedId, toFront });
      await refresh(index);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  // Duplicate: rasterise the object's region and insert it as a new image, nudged by a few points.
  async function doDuplicate() {
    if (!page || selectedId == null || !selectedObj) return;
    setBusy(true);
    try {
      await beforeEdit();
      const rect = boundsToBitmapRect(selectedObj.bounds, page);
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      const rgba = await cropToRgba(`data:image/png;base64,${page.data}`, rect.left, rect.top, rect.width, rect.height, cw, ch);
      const [l, b, r2, t] = selectedObj.bounds;
      const off = 12;
      const res = await PdfEngine.addImage({
        page: pageIndex,
        rgba: base64FromBytes(rgba),
        width: cw,
        height: ch,
        a: r2 - l,
        b: 0,
        c: 0,
        d: t - b,
        e: l + off,
        f: b + off,
      });
      await refresh(res.index);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  // Apply an absolute transform matrix (from the typed value fields) + re-render.
  async function applyMatrix(m: Matrix6) {
    if (selectedId == null) return;
    setBusy(true);
    try {
      await beforeEdit();
      await PdfEngine.transformObject({ page: pageIndex, index: selectedId, a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
      await refresh(selectedId);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function doColor(hex: string) {
    if (selectedId == null) return;
    setBusy(true);
    try {
      await beforeEdit();
      await PdfEngine.setObjectColor({ page: pageIndex, index: selectedId, color: hex });
      await refresh(selectedId);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (selectedId == null) return;
    setBusy(true);
    try {
      await beforeEdit();
      await PdfEngine.deleteObject({ page: pageIndex, index: selectedId });
      await refresh(null); // indices shift after a delete → drop the selection
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function doText(text: string) {
    if (selectedId == null) return;
    setBusy(true);
    try {
      await beforeEdit();
      await PdfEngine.setObjectText({ page: pageIndex, index: selectedId, text });
      await refresh(selectedId);
      setTextInput(null);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  const box: Preview | null = baseSelRect ? preview ?? { ...baseSelRect, rotDeg: 0 } : null;

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
            style={{ width: page.width, height: page.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
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

      {/* selection: bounding box + 48dp move/resize/rotate handles (screen space) */}
      {box && (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            transform: box.rotDeg ? `rotate(${box.rotDeg}deg)` : undefined,
            transformOrigin: "center",
          }}
        >
          <div className="absolute inset-0 border-2 border-blue-500 bg-blue-500/5" />
          {/* move surface */}
          <div
            className="pointer-events-auto absolute inset-0"
            style={{ touchAction: "none" }}
            onTouchStart={onMoveStart}
            onTouchMove={onEditMove}
            onTouchEnd={onEditEnd}
          />
          {/* corner resize handles: 44px touch target, small visible dot */}
          {(["tl", "tr", "bl", "br"] as Corner[]).map((c) => (
            <div
              key={c}
              className="pointer-events-auto absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: c.includes("l") ? 0 : box.width, top: c.includes("t") ? 0 : box.height, touchAction: "none" }}
              onTouchStart={onResizeStart(c)}
              onTouchMove={onEditMove}
              onTouchEnd={onEditEnd}
            >
              <div className="h-3.5 w-3.5 rounded-full border-2 border-blue-500 bg-white shadow" />
            </div>
          ))}
          {/* rotate handle above the top edge */}
          <div
            className="pointer-events-auto absolute flex h-11 w-11 -translate-x-1/2 items-center justify-center"
            style={{ left: box.width / 2, top: -40, touchAction: "none" }}
            onTouchStart={onRotateStart}
            onTouchMove={onEditMove}
            onTouchEnd={onEditEnd}
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-blue-500 bg-white shadow">
              <RotateCw size={14} className="text-blue-600" />
            </div>
          </div>
        </div>
      )}

      {/* selection bottom sheet: actions + colour + typeable X/Y/size/angle */}
      {selectedObj && !textInput && (() => {
        const [ol, ob, or2, ot] = selectedObj.bounds;
        const w = or2 - ol;
        const h = ot - ob;
        const angle = (Math.atan2(selectedObj.matrix[1], selectedObj.matrix[0]) * 180) / Math.PI;
        const colorable = selectedObj.type === "text" || selectedObj.type === "path";
        return (
          <div className="pb-safe absolute inset-x-0 bottom-0 z-30 space-y-2 rounded-t-xl bg-white p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.15)]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-700">
                {selectedObj.type} #{selectedObj.id}
              </span>
              <div className="flex flex-wrap items-center justify-end gap-1">
                {selectedObj.type === "text" && (
                  <button className={BTN} title="Metni değiştir" onClick={() => setTextInput({ value: "" })}>
                    <Pencil size={18} />
                  </button>
                )}
                <button className={BTN} title="Öne getir" onClick={() => doReorder(true)}>
                  <ArrowUpToLine size={18} />
                </button>
                <button className={BTN} title="Arkaya gönder" onClick={() => doReorder(false)}>
                  <ArrowDownToLine size={18} />
                </button>
                <button className={BTN} title="Kopyala" onClick={doDuplicate}>
                  <Copy size={18} />
                </button>
                <button className={`${BTN} text-red-600`} title="Sil" onClick={doDelete}>
                  <Trash2 size={18} />
                </button>
                <button className={`${BTN} text-blue-600`} title="Bitti" onClick={() => setSelectedId(null)}>
                  <Check size={18} />
                </button>
              </div>
            </div>
            {colorable && (
              <div className="flex items-center gap-1 overflow-x-auto">
                <span className="shrink-0 pr-1 text-[11px] text-neutral-500">Renk</span>
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    title={c}
                    onClick={() => doColor(c)}
                    className="h-7 w-7 shrink-0 rounded-full ring-1 ring-black/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label className={`${BTN} relative shrink-0 cursor-pointer`} title="Renk seç">
                  <Palette size={18} />
                  <input
                    type="color"
                    defaultValue="#000000"
                    onChange={(e) => doColor(e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <NumberField label="X" suffix="pt" value={ol} step={5} onCommit={(nx) => applyMatrix(moveMatrix(nx - ol, 0))} />
              <NumberField label="Y" suffix="pt" value={ob} step={5} onCommit={(ny) => applyMatrix(moveMatrix(0, ny - ob))} />
              <NumberField label="En" suffix="pt" value={w} step={5} onCommit={(nw) => { if (w > 0) applyMatrix(scaleAboutMatrix(nw / w, 1, ol, ob)); }} />
              <NumberField label="Boy" suffix="pt" value={h} step={5} onCommit={(nh) => { if (h > 0) applyMatrix(scaleAboutMatrix(1, nh / h, ol, ob)); }} />
              <NumberField label="Açı" suffix="°" value={angle} step={5} onCommit={(nd) => applyMatrix(rotateAboutMatrix(((nd - angle) * Math.PI) / 180, (ol + or2) / 2, (ob + ot) / 2))} />
            </div>
          </div>
        );
      })()}

      {/* text replacement input */}
      {textInput && (
        <div className="absolute inset-x-2 top-2 z-40 flex items-center gap-2 rounded-lg bg-white p-2 shadow-lg ring-1 ring-black/10">
          <input
            autoFocus
            value={textInput.value}
            onChange={(e) => setTextInput({ value: e.target.value })}
            placeholder="Yeni metin"
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
          />
          <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => doText(textInput.value)}>
            Uygula
          </button>
          <button className="rounded px-2 py-1 text-sm text-neutral-600" onClick={() => setTextInput(null)}>
            İptal
          </button>
        </div>
      )}

      {/* undo / redo */}
      {(canUndo || canRedo) && (
        <div className="absolute right-2 top-2 z-30 flex gap-1">
          <button
            onClick={undo}
            disabled={!canUndo}
            aria-label="Geri al"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow disabled:opacity-30"
          >
            <Undo2 size={18} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            aria-label="Yinele"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow disabled:opacity-30"
          >
            <Redo2 size={18} />
          </button>
        </div>
      )}

      {/* hint */}
      {!loading && objects.length > 0 && !selectedObj && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/55 px-2 py-1 text-[11px] text-white">
          {objects.length} nesne · dokunup seç
        </div>
      )}

      {(loading || busy) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded bg-black/60 px-3 py-1 text-xs text-white">{loading ? "Yükleniyor…" : "İşleniyor…"}</span>
        </div>
      )}
      {error && <div className="absolute inset-x-3 top-3 z-40 rounded bg-red-600 px-3 py-2 text-xs text-white">{error}</div>}

      {/* page nav + fit (hidden while the selection sheet is open) */}
      {pages > 0 && !selectedObj && (
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
          <button className="ml-1 flex h-10 w-10 items-center justify-center rounded-full" onClick={() => page && fitToWidth(page)} aria-label="Sığdır">
            <Maximize size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
