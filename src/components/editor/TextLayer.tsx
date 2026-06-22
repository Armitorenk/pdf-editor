"use client";

import { type CSSProperties, Fragment, useEffect, useRef, useState } from "react";
import { Check, Minus, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { multiplyMatrix } from "@/lib/pdf/coordinates";
import { sampleRunColors, runRelStem, isBold, percentile, detectDecorations, type PageSample } from "@/lib/pdf/sampleColor";
import { lookupFontStyle, runIsSkewed, type FontStyleInfo } from "@/lib/pdf/fontStyles";
import { textEditKey, type TextEdit } from "@/lib/pdf/types";

/** A text run detected by pdf.js, with its matrix kept in PDF user space. */
interface DetectedText {
  itemIndex: number;
  str: string;
  /** pdf.js text-space matrix `[a,b,c,d,e,f]` (PDF user space, bottom-left origin). */
  transform: number[];
  /** Run width in PDF points. */
  width: number;
  /** Original style, detected from the PDF's font metadata (see fontStyles.ts). */
  serif: boolean;
  bold: boolean;
  italic: boolean;
  /** Font ascent (fraction of em) for baseline-correct overlay placement. */
  ascent: number;
  /** CSS family of the document's own font, injected via FontFace (when calibrated). */
  fontFamily?: string;
  /** Per-font size correction `k` (see {@link calibrateFonts}); 1 when not calibrated. */
  sizeScale: number;
  /** pdf.js internal font id + resolved PostScript name (for font reuse on export). */
  fontName?: string;
  psName?: string;
}

// Cap the off-screen sampling bitmap so colour detection stays cheap on big pages.
const SAMPLE_MAX_SIDE = 1400;

// Bundled fallback faces (the SAME ones export embeds) for runs whose own font we can't
// inject/calibrate — correctly sized, close match, and never the platform UI font.
const editFamily = (serif: boolean) => (serif ? "EditorSerif, serif" : "EditorSans, sans-serif");

// --- Manual edit controls (tap an edited run -> move / resize / recolour / spacing) ---
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clampUserScale = (n: number) => clamp(n, 0.2, 5);
// Base word-spacing nudge baked into the on-screen glyphs (the WebView paints spaces a hair
// narrow); the user's adjustment is added on top of this.
const BASE_WORD_SPACING_EM = 0.16;
const SWATCHES = ["#000000", "#ffffff", "#e11d48", "#2563eb", "#16a34a", "#f59e0b"];
// Floating-toolbar buttons: a 44dp-ish target, and a tighter one for the numeric steppers.
const TOOL_BTN = "flex h-10 w-10 items-center justify-center rounded-md hover:bg-neutral-100 active:bg-neutral-200";
const TOOL_BTN_SM = "flex h-8 w-7 items-center justify-center rounded hover:bg-neutral-100 active:bg-neutral-200";

// A whisper of optical trim (1.5%) baked into the visual scale: with geometricPrecision +
// the real font metrics the injected glyphs read a touch heavy; 0.985 takes off that "fat"
// look without dwarfing the text. Static — NOT a box-fit/slack adjustment.
const OPTICAL = 0.985;

// Document fonts injected into the DOM so the editor shows the run's REAL typeface.
// Keyed by CSS family; the value is a promise that resolves true once the face loads,
// so the calibration pass can wait for it before measuring.
const injectedFonts = new Map<string, Promise<boolean>>();
function ensureFontFace(psName: string, data: Uint8Array): string {
  const family = `pdffont-${psName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (!injectedFonts.has(family) && typeof FontFace !== "undefined") {
    const load = (async () => {
      try {
        // Copy the bytes — pdf.js may reuse/detach the underlying buffer.
        const face = new FontFace(family, data.slice().buffer as ArrayBuffer);
        await face.load();
        document.fonts.add(face);
        return true;
      } catch {
        return false;
      }
    })();
    injectedFonts.set(family, load);
  }
  return family;
}

// A single persistent off-screen probe for live text measurement (visibility:hidden keeps
// layout — display:none would have no box). Reused for calibration AND letter-spacing fit.
let probeEl: HTMLSpanElement | null = null;
function measureTextPx(cssFamily: string, text: string, sizePx: number): number {
  if (typeof document === "undefined") return 0;
  if (!probeEl) {
    probeEl = document.createElement("span");
    probeEl.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;padding:0;margin:0;border:0;line-height:1;";
    document.body.appendChild(probeEl);
  }
  probeEl.style.fontFamily = cssFamily;
  probeEl.style.fontSize = `${sizePx}px`;
  probeEl.textContent = text;
  return probeEl.getBoundingClientRect().width;
}

/**
 * Per-font on-screen size correction `k`. The Android WebView renders the raw pdf.js-
 * converted program non-em-normalised, so at a given CSS font-size its glyphs come out
 * 2–3× too big. For each run we measure the injected face's REAL advance (hidden <span> +
 * getBoundingClientRect — NOT canvas measureText, which mis-sizes freshly-injected fonts)
 * and compare to pdf.js's advance → a per-run ratio. We keep the MEDIAN across the font's
 * runs so a single run with custom PDF tracking (Tc/Tz) can't skew k and vertically squish
 * the text — k stays uniform, height is exactly fontPx × k, and horizontal fit is handled
 * separately by letter-spacing. Fonts that don't load are left out → bundled face at 1×.
 */
async function calibrateFonts(
  raw: { str: string; transform: number[]; width: number; fontName?: string }[],
  cache: ReadonlyMap<string, { fontFamily?: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (typeof document === "undefined" || !document.fonts) return out;
  const families = [...new Set(Array.from(cache.values()).map((c) => c.fontFamily).filter((f): f is string => !!f))];
  await Promise.race([
    Promise.allSettled(families.map((f) => injectedFonts.get(f) ?? Promise.resolve())),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  // Timing fix: document.fonts.check can report a face "loaded" a frame or two before the
  // WebView PAINTS it; measuring then returns the fallback width and inflates k. Wait for
  // fonts.ready + two animation frames (a full paint), each bounded by a timeout.
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  await Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    new Promise((r) => setTimeout(r, 300)),
  ]);
  const M = 256; // large measuring size → a stable ratio
  const samples = new Map<string, number[]>();
  for (const r of raw) {
    const key = r.fontName ?? "";
    const family = cache.get(key)?.fontFamily;
    if (!family || (samples.get(key)?.length ?? 0) >= 8) continue;
    const fs = Math.hypot(r.transform[2], r.transform[3]);
    if (fs <= 0 || r.width <= 0 || r.str.trim().length === 0) continue;
    if (!document.fonts.check(`${M}px "${family}"`)) continue; // face unavailable → bundled
    const measured = measureTextPx(`"${family}"`, r.str, M); // px the engine actually paints
    const expected = r.width * (M / fs); // px it SHOULD span (pdf.js advance, scaled to M)
    if (measured > 1 && expected > 1) {
      const k = expected / measured;
      if (k > 0.2 && k < 5) {
        const arr = samples.get(key) ?? [];
        arr.push(k);
        samples.set(key, arr);
      }
    }
  }
  for (const [key, arr] of samples) {
    const med = arr.length ? percentile(arr, 0.5) : null;
    if (med != null) out.set(key, med);
  }
  return out;
}

interface TextLayerProps {
  doc: PDFDocumentProxy;
  /** 1-based original page number, for pdf.js `getPage`. */
  pageNumber: number;
  /** Stable id of the page slot this layer belongs to. */
  pageId: string;
  /** Page height in PDF points — used to place edits when not detecting text. */
  pageHeight: number;
  scale: number;
  /** When false, the layer is a read-only WYSIWYG preview (no hit-boxes). */
  interactive: boolean;
  edits: Record<string, TextEdit>;
  onCommit: (edit: TextEdit) => void;
  onRemove: (key: string) => void;
  /** Document-wide font metadata (FontDescriptor → bold/italic/serif), or null. */
  fontStyleMap: Map<string, FontStyleInfo> | null;
  /** Register a run's original font program (converted OpenType) for reuse on export. */
  onRegisterFont: (psName: string, data: Uint8Array) => void;
}

/**
 * Editable overlay aligned to a page's canvas.
 *
 * - **Interactive (text mode):** detects runs with `getTextContent()`, draws a
 *   transparent hit-box over each, and on click swaps in an input.
 * - **Always (every mode):** committed edits are painted as a white cover + the new
 *   text, exactly as the pdf-lib export bakes them — so the page is WYSIWYG and the
 *   user can see what the downloaded PDF will look like without staying in text mode.
 *
 * The read-only preview is drawn from each edit's stored PDF-space geometry, so
 * pages with no edits cost nothing (no text detection).
 */
export function TextLayer({
  doc,
  pageNumber,
  pageId,
  pageHeight,
  scale,
  interactive,
  edits,
  onCommit,
  onRemove,
  fontStyleMap,
  onRegisterFont,
}: TextLayerProps) {
  const pageRef = useRef<PDFPageProxy | null>(null);
  // Off-screen render of the page, used to sample real bg/text colours on commit.
  const sampleRef = useRef<PageSample | null>(null);
  // The page's regular-body stem width (low percentile of its runs) = the baseline
  // bold detection compares against (so a heading reads bold but body text doesn't).
  const pageStemRef = useRef<number | null>(null);
  const [items, setItems] = useState<DetectedText[] | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // Tap-selected edit (shows the floating move/size/colour toolbar; drag to move).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const dragRef = useRef<{ key: string; startX: number; startY: number } | null>(null);
  const [liveShift, setLiveShift] = useState<{ dx: number; dy: number } | null>(null);

  // Drag the selected edit to move it (only once selected, so the first tap just selects).
  function onTextPointerDown(e: React.PointerEvent, key: string) {
    if (selectedKey !== key) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { key, startX: e.clientX, startY: e.clientY };
  }
  function onTextPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setLiveShift({ dx: (e.clientX - d.startX) / scale, dy: -(e.clientY - d.startY) / scale });
  }
  function onTextPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = -(e.clientY - d.startY) / scale;
    dragRef.current = null;
    setLiveShift(null);
    const edit = edits[d.key];
    if (edit && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) {
      onCommit({ ...edit, userDx: (edit.userDx ?? 0) + dx, userDy: (edit.userDy ?? 0) + dy });
    }
  }

  // Detect text runs once per page — only needed while editing.
  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      if (cancelled) return;
      pageRef.current = page;

      // Raw runs first; styles are resolved below once fonts are loaded.
      const raw = content.items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item }) => "str" in item && item.str.trim().length > 0)
        .map(({ item, idx }) => ({
          idx,
          str: (item as { str: string }).str,
          transform: (item as { transform: number[] }).transform,
          width: (item as { width: number }).width,
          fontName: (item as { fontName?: string }).fontName,
        }));

      // Rasterise the page once (capped). Doubles as: colour sampling on commit, the
      // pixel bold-fallback baseline, AND it loads fonts into `commonObjs` so we can
      // read each run's real PostScript name. Best-effort.
      let sample: PageSample | null = null;
      try {
        const base = page.getViewport({ scale: 1 });
        const s = Math.min(2, SAMPLE_MAX_SIDE / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale: s });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          await page.render({ canvas, viewport: vp }).promise;
          if (cancelled) return;
          sample = { data: ctx.getImageData(0, 0, canvas.width, canvas.height), transform: vp.transform };
          sampleRef.current = sample;
          const stems: number[] = [];
          for (const r of raw) {
            const fs = Math.hypot(r.transform[2], r.transform[3]);
            if (fs <= 0 || r.width <= 0) continue;
            const rs = runRelStem(sample, { x: r.transform[4], y: r.transform[5], width: r.width, fontSize: fs });
            if (rs != null) stems.push(rs);
            if (stems.length >= 120) break;
          }
          pageStemRef.current = percentile(stems, 0.3); // ≈ regular-body stem
        }
      } catch {
        sampleRef.current = null;
      }

      // Resolve each font's base style from the PDF's metadata (cached per font).
      // pdf.js `commonObjs` (populated by the render above) gives the real PostScript
      // name + serif flag; the document-wide map gives bold/italic/serif.
      const cache = new Map<
        string,
        { bold: boolean; italic: boolean; serif: boolean; hasMeta: boolean; psName: string | null; ascent: number; fontFamily?: string }
      >();
      const baseStyle = (fontName: string | undefined) => {
        const key = fontName ?? "";
        const hit = cache.get(key);
        if (hit) return hit;
        let psName: string | null = null;
        let serifFlag: boolean | null = null;
        let fontFamily: string | undefined;
        try {
          const fo = fontName && page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
          if (fo) {
            psName = (fo.name as string) ?? null;
            if (typeof fo.isSerifFont === "boolean") serifFlag = fo.isSerifFont;
            // Inject the document's own font so the editor shows the real typeface; its
            // on-screen size is corrected by the calibration pass below.
            if (fo.data && psName) fontFamily = ensureFontFace(psName, fo.data as Uint8Array);
          }
        } catch {
          /* font not resolved — fall through to family/heuristics */
        }
        const meta = lookupFontStyle(fontStyleMap, psName);
        const styleEntry = fontName ? content.styles[fontName] : undefined;
        const family = styleEntry?.fontFamily || "";
        const familySerif = /serif/i.test(family) && !/sans/i.test(family);
        const ascent = typeof styleEntry?.ascent === "number" && styleEntry.ascent > 0 ? styleEntry.ascent : 0.8;
        const out = {
          bold: meta?.bold ?? false,
          italic: meta?.italic ?? false,
          serif: meta?.serif ?? serifFlag ?? familySerif,
          hasMeta: !!meta,
          psName,
          ascent,
          fontFamily,
        };
        cache.set(key, out);
        return out;
      };

      const detected: DetectedText[] = raw.map((r) => {
        const b = baseStyle(r.fontName);
        // Bold: trust metadata; if the font has no descriptor, fall back to the pixel
        // stem-thickness heuristic against the page baseline.
        let bold = b.bold;
        if (!b.hasMeta && sample) {
          const fs = Math.hypot(r.transform[2], r.transform[3]);
          bold = isBold(
            runRelStem(sample, { x: r.transform[4], y: r.transform[5], width: r.width, fontSize: fs }),
            pageStemRef.current,
          );
        }
        // Italic: metadata, or a sheared text matrix (faux italic in the content stream).
        const italic = b.italic || runIsSkewed(r.transform);
        return {
          itemIndex: r.idx,
          str: r.str,
          transform: r.transform,
          width: r.width,
          serif: b.serif,
          bold,
          italic,
          ascent: b.ascent,
          fontFamily: b.fontFamily,
          sizeScale: 1,
          fontName: r.fontName,
          psName: b.psName ?? undefined,
        };
      });

      // Calibrate each injected font's on-screen size (see calibrateFonts). A run keeps
      // its OWN typeface only when we measured a sane scale; otherwise it falls back to
      // the bundled face at 1× so it's never left oversized.
      const scaleByFont = await calibrateFonts(raw, cache);
      if (cancelled) return;
      for (const d of detected) {
        const k = scaleByFont.get(d.fontName ?? "");
        if (k !== undefined) d.sizeScale = k;
        else d.fontFamily = undefined;
      }
      if (!cancelled) setItems(detected);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, interactive, fontStyleMap]);

  // --- Read-only preview (any non-text mode): paint committed edits only. --------
  if (!interactive) {
    const pageEdits = Object.values(edits).filter((e) => e.pageId === pageId);
    if (pageEdits.length === 0) return null;
    return (
      <div className="pointer-events-none absolute inset-0">
        {pageEdits.map((edit) => {
          // Layout at the ORIGINAL size (font-independent PDF math). The cover box hides the
          // original glyphs; the inner text is size-corrected by a baseline-pinned transform.
          const fontPx = edit.fontSize * scale;
          const baselineDomY = (pageHeight - edit.y) * scale; // flip Y (un-rotated)
          const ascent = edit.ascent ?? 0.8;
          // Pure ascent drop onto the baseline (no manual lift — the loaded font's own metrics
          // are correct); shared by `top` and the transform pivot so scaling stays on the line.
          const baselinePx = ascent * fontPx;
          const kVis = (edit.sizeScale ?? 1) * OPTICAL * (edit.userScale ?? 1);
          const baseLeft = edit.x * scale;
          const baseTop = baselineDomY - baselinePx;
          const coverW = Math.max(edit.width * scale, fontPx * 0.4);
          return (
            <Fragment key={textEditKey(edit.pageId, edit.itemIndex)}>
              {/* cover stays over the ORIGINAL glyphs */}
              <div
                style={{ ...coverStyle(edit), left: baseLeft, top: baseTop, minWidth: coverW, height: fontPx * 1.25 }}
                className="absolute box-content"
              />
              {/* new text — moved by the user's position nudge */}
              <div
                style={{ position: "absolute", left: baseLeft + (edit.userDx ?? 0) * scale, top: baseTop - (edit.userDy ?? 0) * scale }}
                className="box-content"
              >
                <span style={{ position: "absolute", left: 0, top: 0, ...glyphStyle(edit, fontPx), ...scaleStyle(kVis, baselinePx) }}>
                  {edit.newText}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    );
  }

  if (!items || !pageRef.current) return null;
  const viewport = pageRef.current.getViewport({ scale });

  return (
    <div className="absolute inset-0">
      {items.map((item) => {
        const key = textEditKey(pageId, item.itemIndex);
        const edit = edits[key];
        const isEditing = editingKey === key;

        // Device-space (CSS px) box, from combining the viewport and text matrices. Layout
        // uses the TRUE on-screen size (= scale × transform[3]) — font-independent, so the
        // box/baseline never depend on the injected font's (broken) metrics. The glyph size
        // error is corrected separately by a baseline-pinned transform (see scaleStyle).
        const tx = multiplyMatrix(viewport.transform, item.transform);
        const fontPx = Math.hypot(tx[2], tx[3]);
        const left = tx[4];
        // tx[5] is the PDF baseline; drop by the font ascent so the box top is right. No manual
        // lift: the run's OWN font is FontFace-loaded, so its ascent is already correct (an extra
        // offset over-corrected and pushed text up). `top` and the transform pivot share
        // `baselinePx` so scaling stays locked to the line.
        const baselinePx = item.ascent * fontPx;
        const top = tx[5] - baselinePx;
        const widthPx = Math.max(item.width * scale, fontPx * 0.4);
        const boxHeight = fontPx * 1.25;
        // Visual scale = calibration × the 1.5% optical trim. Drives the glyph transform and
        // the input anti-scale (box stays put); layout top/baseline use fontPx, never k.
        const k = item.sizeScale * OPTICAL;
        const originalFamily = item.fontFamily
          ? `${item.fontFamily}, ${editFamily(item.serif)}`
          : editFamily(item.serif);

        // PDF-space font size (zoom-independent), captured for export.
        const pdfFontSize = Math.hypot(item.transform[2], item.transform[3]);

        const commit = (value: string) => {
          setEditingKey(null);
          if (value === item.str) {
            onRemove(key);
            return;
          }
          // Sample the page so the edit blends in (real bg colour + ink colour). Style
          // (bold/italic/serif) was already resolved from the font metadata.
          const sample = sampleRef.current;
          const runBox = { x: item.transform[4], y: item.transform[5], width: item.width, fontSize: pdfFontSize };
          const colors = sample ? sampleRunColors(sample, runBox) : undefined;
          const deco = sample ? detectDecorations(sample, runBox) : undefined;
          // Capture the run's original (converted) font program so export can reuse it.
          if (item.psName && item.fontName && pageRef.current) {
            try {
              const fo = pageRef.current.commonObjs.has(item.fontName)
                ? pageRef.current.commonObjs.get(item.fontName)
                : null;
              if (fo?.data) onRegisterFont(item.psName, fo.data as Uint8Array);
            } catch {
              /* font program unavailable — export falls back to the bundled face */
            }
          }
          onCommit({
            pageId,
            itemIndex: item.itemIndex,
            originalText: item.str,
            newText: value,
            x: item.transform[4],
            y: item.transform[5],
            fontSize: pdfFontSize,
            width: item.width,
            bgColor: colors?.bg,
            textColor: colors?.text,
            serif: item.serif,
            bold: item.bold,
            italic: item.italic,
            underline: deco?.underline,
            strike: deco?.strike,
            fontPsName: item.psName,
            ascent: item.ascent,
            fontFamily: item.fontFamily,
            sizeScale: item.sizeScale,
            // Keep any manual move/size/colour/spacing the user already applied to this run.
            userDx: edit?.userDx,
            userDy: edit?.userDy,
            userScale: edit?.userScale,
            userColor: edit?.userColor,
            userLetterSpacing: edit?.userLetterSpacing,
            userWordSpacing: edit?.userWordSpacing,
          });
          // Select the just-edited run so its tune toolbar appears right below it (discoverable).
          setSelectedKey(key);
        };

        if (isEditing) {
          return (
            <input
              key={key}
              autoFocus
              defaultValue={edit?.newText ?? item.str}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setEditingKey(null);
                }
              }}
              style={{
                left,
                top,
                // Anti-scale: the whole input is shrunk by `scale(k)` (baseline-pinned), so
                // pre-divide width/height by k. After the transform the box is back at its
                // physical 1× size, while the oversized injected font shrinks to fit — no
                // tiny typing box, no horizontal scroll while editing.
                width: widthPx / k,
                height: boxHeight / k,
                fontSize: fontPx,
                fontFamily: originalFamily,
                fontWeight: item.bold ? 700 : undefined,
                fontStyle: item.italic ? "italic" : undefined,
                textRendering: "geometricPrecision",
                WebkitFontSmoothing: "antialiased",
                MozOsxFontSmoothing: "grayscale",
                wordSpacing: `${BASE_WORD_SPACING_EM + (edit?.userWordSpacing ?? 0)}em`,
                letterSpacing: edit?.userLetterSpacing ? `${edit.userLetterSpacing}em` : undefined,
                WebkitTextStroke: `${Math.min(0.25, fontPx * (item.bold ? 0.014 : 0.009))}px currentColor`,
                ...scaleStyle(k, baselinePx),
              }}
              className="absolute z-20 box-content whitespace-nowrap border border-blue-500 bg-white px-0.5 leading-none text-black shadow-sm outline-none"
            />
          );
        }

        // Committed edit: a fixed cover (over the original glyphs) + a separately-positioned
        // text element that the user can tap to select, then drag to move, resize and recolour
        // via a floating toolbar. The cover never moves, so the original stays hidden.
        if (edit) {
          const isSelected = selectedKey === key;
          const sh = isSelected ? liveShift : null;
          const effDx = (edit.userDx ?? 0) + (sh ? sh.dx : 0);
          const effDy = (edit.userDy ?? 0) + (sh ? sh.dy : 0);
          const kC = item.sizeScale * OPTICAL * (edit.userScale ?? 1);
          const textLeft = left + effDx * scale;
          const textTop = top - effDy * scale;
          const colorNow = edit.userColor ?? edit.textColor ?? "#000000";
          const toolbarTop = textTop + boxHeight + 8; // a small toolbar BELOW the text
          return (
            <Fragment key={key}>
              <div
                style={{ ...coverStyle(edit), left, top, minWidth: widthPx, height: boxHeight }}
                className="pointer-events-none absolute z-10 box-content"
              />
              <div
                onClick={() => {
                  if (!isSelected) setSelectedKey(key);
                }}
                onPointerDown={(e) => onTextPointerDown(e, key)}
                onPointerMove={onTextPointerMove}
                onPointerUp={onTextPointerUp}
                title={`${item.str} → ${edit.newText}`}
                style={{
                  left: textLeft,
                  top: textTop,
                  minWidth: widthPx,
                  height: boxHeight,
                  touchAction: isSelected ? "none" : undefined,
                }}
                className={`absolute z-20 box-content whitespace-nowrap text-left ${
                  isSelected ? "cursor-move ring-2 ring-blue-500" : "cursor-pointer ring-1 ring-amber-400"
                }`}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    ...glyphStyle(edit, fontPx),
                    ...scaleStyle(kC, baselinePx),
                  }}
                >
                  {edit.newText}
                </span>
              </div>
              {/* alignment guides + coordinate badge while dragging to reposition */}
              {isSelected && sh && (
                <Fragment>
                  <div className="pointer-events-none absolute bottom-0 top-0 z-20 border-l border-dashed border-blue-500/60" style={{ left: textLeft }} />
                  <div className="pointer-events-none absolute left-0 right-0 z-20 border-t border-dashed border-blue-500/60" style={{ top: textTop + baselinePx }} />
                  <div
                    className="pointer-events-none absolute z-30 whitespace-nowrap rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white"
                    style={{ left: textLeft, top: Math.max(0, textTop - 18) }}
                  >
                    x {Math.round(edit.x + effDx)} · y {Math.round(edit.y + effDy)} pt
                  </div>
                </Fragment>
              )}
              {isSelected && !sh && (
                <div
                  className="absolute z-30 flex max-w-[92vw] flex-wrap items-center gap-1 rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-black/10"
                  style={{ left: Math.max(2, textLeft), top: toolbarTop }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button className={TOOL_BTN} title="Metni düzenle" onClick={() => { setSelectedKey(null); setEditingKey(key); }}>
                    <Pencil size={18} />
                  </button>
                  <NumberField
                    label="boyut"
                    suffix="pt"
                    value={edit.fontSize * (edit.userScale ?? 1)}
                    decimals={1}
                    step={0.5}
                    min={edit.fontSize * 0.2}
                    max={edit.fontSize * 5}
                    onChange={(pt) => onCommit({ ...edit, userScale: clampUserScale(pt / edit.fontSize) })}
                  />
                  <NumberField
                    label="harf"
                    suffix="em"
                    value={edit.userLetterSpacing ?? 0}
                    decimals={2}
                    step={0.02}
                    min={-0.2}
                    max={1}
                    onChange={(em) => onCommit({ ...edit, userLetterSpacing: em })}
                  />
                  <NumberField
                    label="kelime"
                    suffix="em"
                    value={edit.userWordSpacing ?? 0}
                    decimals={2}
                    step={0.05}
                    min={-0.2}
                    max={2}
                    onChange={(em) => onCommit({ ...edit, userWordSpacing: em })}
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        title={c}
                        onClick={() => onCommit({ ...edit, userColor: c })}
                        className="h-7 w-7 shrink-0 rounded-full ring-1 ring-black/20"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <label className={`${TOOL_BTN} relative cursor-pointer`} title="Renk seç">
                      <Palette size={18} />
                      <input
                        type="color"
                        value={colorNow}
                        onChange={(e) => onCommit({ ...edit, userColor: e.target.value })}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                  </div>
                  <button className={`${TOOL_BTN} text-red-600`} title="Sil" onClick={() => { setSelectedKey(null); onRemove(key); }}>
                    <Trash2 size={18} />
                  </button>
                  <button className={`${TOOL_BTN} text-blue-600`} title="Bitti" onClick={() => setSelectedKey(null)}>
                    <Check size={18} />
                  </button>
                </div>
              )}
            </Fragment>
          );
        }

        // Unedited run: a transparent hit-box at the original layout (no text, no scale).
        return (
          <button
            key={key}
            onClick={() => setEditingKey(key)}
            title={item.str}
            style={{ left, top, minWidth: widthPx, height: boxHeight }}
            className="absolute z-10 box-content cursor-text rounded-sm hover:bg-blue-400/20 hover:ring-1 hover:ring-blue-400"
          />
        );
      })}
    </div>
  );
}

/**
 * A compact numeric stepper with a typeable field — taps on −/+ nudge by `step`, but the user
 * can also focus the field and type an exact value (e.g. 36 → 36.5). While focused it shows the
 * raw `draft` string so decimals/minus survive; on blur it reverts to the formatted value.
 */
function NumberField({
  label,
  suffix,
  value,
  onChange,
  step,
  min,
  max,
  decimals = 2,
}: {
  label: string;
  suffix?: string;
  value: number;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
  decimals?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const fmt = (n: number) => String(Number(n.toFixed(decimals)));
  const set = (n: number) => onChange(clamp(n, min, max));
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span className="px-0.5 text-[10px] leading-none text-neutral-500">{label}</span>
      <button className={TOOL_BTN_SM} title={`${label} azalt`} onClick={() => set(value - step)}>
        <Minus size={14} />
      </button>
      <input
        value={draft ?? fmt(value)}
        inputMode="decimal"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) set(n);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-11 rounded border border-neutral-300 px-1 py-1 text-center text-xs tabular-nums outline-none focus:border-blue-500"
      />
      <button className={TOOL_BTN_SM} title={`${label} artır`} onClick={() => set(value + step)}>
        <Plus size={14} />
      </button>
      {suffix && <span className="pr-0.5 text-[10px] text-neutral-400">{suffix}</span>}
    </div>
  );
}

/** CSS `text-decoration-line` for an edit's underline/strikethrough, or undefined. */
function decorationLine(edit: TextEdit): string | undefined {
  const parts = [edit.underline ? "underline" : "", edit.strike ? "line-through" : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** Background cover for a committed edit (hides the original glyphs underneath). It is laid
 *  out at the ORIGINAL size and never scaled, so it always covers the run regardless of the
 *  glyph transform. */
function coverStyle(edit: TextEdit): CSSProperties {
  return { backgroundColor: edit.bgColor ?? "#ffffff" };
}

/**
 * Glyph-only style for a committed edit's text: the document's own injected font (else a
 * bundled face) with detected colour / weight / slant / decoration, at the ORIGINAL `fontPx`.
 * The injected font's on-screen size error is corrected by {@link scaleStyle}'s transform,
 * NEVER by font-size — changing font-size would drag the broken vertical metrics with it and
 * throw off the baseline. Bold also gets a small `-webkit-text-stroke` for faux-bold runs.
 */
function glyphStyle(edit: TextEdit, fontPx: number): CSSProperties {
  return {
    fontSize: fontPx,
    lineHeight: 1,
    // `pre` (not `nowrap`) keeps the run on one line BUT preserves the exact widths of the
    // PDF's space characters (nowrap collapses runs of spaces, which shrank the box / shifted
    // it left). No newlines in a run, so it never wraps.
    whiteSpace: "pre",
    // Geometric precision: stop the engine snapping/hinting glyphs to the pixel grid, which
    // nudged the size a hair off the exact PDF math at high zoom.
    textRendering: "geometricPrecision",
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    color: edit.userColor ?? edit.textColor ?? "#000000",
    fontWeight: edit.bold ? 700 : undefined,
    fontStyle: edit.italic ? "italic" : undefined,
    fontFamily: edit.fontFamily ? `${edit.fontFamily}, ${editFamily(!!edit.serif)}` : editFamily(!!edit.serif),
    // Word spacing: a static base nudge (DOM paints spaces a hair narrow) PLUS the user's
    // manual adjustment. Letter spacing is purely the user's (0 by default). Em-based so both
    // track the font size and stay proportional between screen and the exported PDF.
    wordSpacing: `${BASE_WORD_SPACING_EM + (edit.userWordSpacing ?? 0)}em`,
    letterSpacing: edit.userLetterSpacing ? `${edit.userLetterSpacing}em` : undefined,
    textDecorationLine: decorationLine(edit),
    // A hairline same-colour stroke on ALL runs adds the requested touch of weight (the
    // injected glyphs read a hair thin on screen). Capped at 0.25px so it never fills glyph
    // counters / muddies; bold runs get a touch more. It also scales with the glyph transform.
    WebkitTextStroke: `${Math.min(0.25, fontPx * (edit.bold ? 0.014 : 0.009))}px currentColor`,
  };
}

/**
 * Visual-only size correction. The injected pdf.js program renders 2–3× off in the WebView,
 * but we DON'T touch font-size (that drifts the baseline via the font's broken vertical
 * metrics). Instead we keep layout at the true size and scale just the glyphs by `k`,
 * pinned to the baseline (`0 baselinePx`) — so the run's bottom-left stays exactly on the PDF
 * coordinate while the letters shrink/grow into the right size. `k≈1` → no transform.
 */
function scaleStyle(k: number, baselinePx: number): CSSProperties {
  return Math.abs(k - 1) < 0.002 ? {} : { transform: `scale(${k})`, transformOrigin: `0 ${baselinePx}px` };
}
