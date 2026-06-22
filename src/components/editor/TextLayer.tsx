"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
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
    // Measure ONLY space-free runs of >=2 chars: a run's spaces make pdf.js's advance
    // (edit.width) and the DOM's natural width disagree (space-advance differs), which skews
    // k below 1 and dwarfs the text. Pure-glyph runs give the font's true scale.
    if (fs <= 0 || r.width <= 0 || r.str.includes(" ") || r.str.trim().length < 2) continue;
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
          const kVis = (edit.sizeScale ?? 1) * OPTICAL;
          return (
            <div
              key={textEditKey(edit.pageId, edit.itemIndex)}
              style={{
                ...coverStyle(edit),
                left: edit.x * scale,
                top: baselineDomY - baselinePx,
                minWidth: Math.max(edit.width * scale, fontPx * 0.4),
                height: fontPx * 1.25,
              }}
              className="absolute box-content"
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  ...glyphStyle(edit, fontPx),
                  ...scaleStyle(kVis, baselinePx),
                  ...spacingStyle(edit, scale, kVis),
                }}
              >
                {edit.newText}
              </span>
            </div>
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
          // Natural advance of the new text at the corrected size (PDF points), so the preview
          // can distribute slack as letter/word-spacing to match the original box width. The
          // probe renders the injected font oversized by 1/k, so scale the measured px by k.
          const fam = item.fontFamily ? `"${item.fontFamily}"` : editFamily(item.serif);
          const wPx = measureTextPx(fam, value, 256);
          const naturalWidth = wPx > 0 ? (wPx * item.sizeScale * pdfFontSize) / 256 : undefined;
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
            naturalWidth,
          });
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
                WebkitTextStroke: `${Math.min(0.25, fontPx * (item.bold ? 0.014 : 0.009))}px currentColor`,
                ...scaleStyle(k, baselinePx),
                ...(edit ? spacingStyle(edit, scale, k) : {}),
              }}
              className="absolute z-20 box-content whitespace-nowrap border border-blue-500 bg-white px-0.5 leading-none text-black shadow-sm outline-none"
            />
          );
        }

        // Committed edit: a clickable cover (original size, unscaled — always hides the
        // original) carrying the baseline-scaled glyphs.
        if (edit) {
          return (
            <button
              key={key}
              onClick={() => setEditingKey(key)}
              title={`${item.str} → ${edit.newText}`}
              style={{ ...coverStyle(edit), left, top, minWidth: widthPx, height: boxHeight }}
              className="absolute z-10 box-content cursor-text whitespace-nowrap text-left ring-1 ring-amber-400"
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  ...glyphStyle(edit, fontPx),
                  ...scaleStyle(k, baselinePx),
                  ...spacingStyle(edit, scale, k),
                }}
              >
                {edit.newText}
              </span>
            </button>
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
    color: edit.textColor ?? "#000000",
    fontWeight: edit.bold ? 700 : undefined,
    fontStyle: edit.italic ? "italic" : undefined,
    fontFamily: edit.fontFamily ? `${edit.fontFamily}, ${editFamily(!!edit.serif)}` : editFamily(!!edit.serif),
    // Word/letter spacing is supplied separately by spacingStyle (box-fit), so the run fills
    // its original footprint and matches the page's justification.
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

/**
 * Distribute the slack between the run's box width (edit.width) and the new text's natural
 * width so the run fits the original box — without touching the font size. Multi-word strings
 * open `word-spacing` (the gaps between words); single words open `letter-spacing`. Caps are
 * VERY tight (0.25em / 0.05em) so it nudges alignment without ever gum-stretching. Stretch-only
 * (never condense). Values are local px (÷k, since the glyph element is scaled by k).
 */
function spacingStyle(edit: TextEdit, scale: number, k: number): CSSProperties {
  const n = edit.naturalWidth;
  if (n == null || !edit.width || k <= 0) return {};
  const slackPdf = edit.width - n;
  if (slackPdf <= 0) return {};
  const em = edit.fontSize ?? 12;
  const localPx = (gapPdf: number) => `${(gapPdf * scale) / k}px`;
  const chars = Array.from(edit.newText);
  const spaces = chars.filter((c) => c === " ").length;
  if (spaces > 0) {
    const gap = Math.min(slackPdf / spaces, em * 0.25);
    return { wordSpacing: localPx(gap) };
  }
  if (chars.length < 2) return {};
  const gap = Math.min(slackPdf / (chars.length - 1), em * 0.05);
  return { letterSpacing: localPx(gap) };
}
