"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { multiplyMatrix } from "@/lib/pdf/coordinates";
import { sampleRunColors, runRelStem, isBold, percentile, detectDecorations, type PageSample } from "@/lib/pdf/sampleColor";
import { lookupFontStyle, runIsSkewed, type FontStyleInfo } from "@/lib/pdf/fontStyles";
import { textEditKey, type TextEdit } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

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

/**
 * Per-font on-screen size correction. The Android WebView renders the raw pdf.js-
 * converted program non-em-normalised, so at a given CSS `font-size` its glyphs come out
 * 2–3× too big. We measure the injected face's REAL advance for an actual run and compare
 * it to pdf.js's known advance, yielding a scale `k = expected / measured`; rendering the
 * text at `fontSize * k` cancels the distortion. Same idea as export.ts's width
 * calibration, but measured live in the DOM via canvas `measureText`. Fonts that don't
 * load (or measure sanely) are simply left out → the caller uses the bundled face at 1×.
 */
async function calibrateFonts(
  raw: { str: string; transform: number[]; width: number; fontName?: string }[],
  cache: ReadonlyMap<string, { fontFamily?: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (typeof document === "undefined" || !document.fonts) return out;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return out;
  // Wait (bounded) for the injected faces so measureText uses them, not a fallback.
  const families = [...new Set(Array.from(cache.values()).map((c) => c.fontFamily).filter((f): f is string => !!f))];
  await Promise.race([
    Promise.allSettled(families.map((f) => injectedFonts.get(f) ?? Promise.resolve())),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  const M = 256; // large measuring size → a stable ratio
  const seen = new Set<string>();
  for (const r of raw) {
    const key = r.fontName ?? "";
    if (seen.has(key)) continue;
    const family = cache.get(key)?.fontFamily;
    if (!family) continue;
    const fs = Math.hypot(r.transform[2], r.transform[3]);
    if (fs <= 0 || r.width <= 0 || r.str.trim().length === 0) continue;
    seen.add(key);
    const spec = `${M}px "${family}"`;
    if (!document.fonts.check(spec)) continue; // face unavailable — fall back to bundled
    ctx.font = spec;
    const measured = ctx.measureText(r.str).width; // px the run actually spans at size M
    const expected = r.width * (M / fs); // px it SHOULD span (pdf.js advance, scaled to M)
    if (measured > 1 && expected > 1) {
      const k = expected / measured;
      if (k > 0.2 && k < 5) out.set(key, k);
    }
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
          // Same calibrated size as the interactive layer: original size × zoom × the
          // font's measured correction, so the preview matches the editor exactly.
          const dispFontPx = edit.fontSize * scale * (edit.sizeScale ?? 1);
          const baselineDomY = (pageHeight - edit.y) * scale; // flip Y (un-rotated)
          return (
            <span
              key={textEditKey(edit.pageId, edit.itemIndex)}
              style={{
                ...editTextStyle(edit, dispFontPx),
                left: edit.x * scale,
                // Place the box top an ascent above the baseline so the rendered
                // text sits exactly on the original baseline (line-height:1).
                top: baselineDomY - (edit.ascent ?? 0.8) * dispFontPx,
                minWidth: Math.max(edit.width * scale, dispFontPx * 0.4),
              }}
              className="absolute box-content whitespace-nowrap px-0.5 leading-none"
            >
              {edit.newText}
            </span>
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

        // Device-space (CSS px) box, from combining the viewport and text matrices.
        const tx = multiplyMatrix(viewport.transform, item.transform);
        // `fontPx` is the true on-screen size (= scale × transform[3]). When we render in
        // the run's OWN injected font we multiply by its calibration `sizeScale` so the
        // WebView's non-normalised program comes out at the right size; the bundled
        // fallback needs no correction (sizeScale stays 1).
        const dispFontPx = Math.hypot(tx[2], tx[3]) * item.sizeScale;
        const left = tx[4];
        // tx[5] is the baseline; drop by the font ascent so the box top is right and the
        // rendered text (line-height:1) sits on the original baseline. Use the calibrated
        // size so height/baseline track the actual glyph size and nothing overflows.
        const top = tx[5] - item.ascent * dispFontPx;
        const widthPx = Math.max(item.width * scale, dispFontPx * 0.4);
        const boxHeight = dispFontPx * 1.25;
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
                // Constrain the editor to the run's original box width (with a small
                // floor) and keep it on one line, so the replacement stays inside the
                // original glyph footprint instead of pushing the layout around.
                width: widthPx,
                height: boxHeight,
                fontSize: dispFontPx,
                fontFamily: originalFamily,
                fontWeight: item.bold ? 700 : undefined,
                fontStyle: item.italic ? "italic" : undefined,
              }}
              className="absolute z-20 box-content whitespace-nowrap border border-blue-500 bg-white px-0.5 leading-none text-black shadow-sm outline-none"
            />
          );
        }

        return (
          <button
            key={key}
            onClick={() => setEditingKey(key)}
            title={edit ? `${item.str} → ${edit.newText}` : item.str}
            style={
              edit
                ? { ...editTextStyle(edit, dispFontPx), left, top, width: "auto", minWidth: widthPx }
                : { left, top, minWidth: widthPx, height: boxHeight, fontSize: dispFontPx }
            }
            className={cn(
              "absolute z-10 box-content cursor-text overflow-hidden whitespace-nowrap text-left leading-none",
              !edit && "font-sans",
              edit
                ? "px-0.5 ring-1 ring-amber-400"
                : "rounded-sm text-black hover:bg-blue-400/20 hover:ring-1 hover:ring-blue-400",
            )}
          >
            {edit?.newText ?? ""}
          </button>
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

/**
 * Shared visual style for a committed edit's on-screen text: the document's own injected
 * font when we have it (else a correctly-sized bundled face), with detected colour /
 * weight / slant / decoration. `fontPx` is already the calibrated size. Bold also gets a
 * small `-webkit-text-stroke` so faux-bold runs (whose font has no real bold cut) still
 * read as bold instead of staying thin.
 */
function editTextStyle(edit: TextEdit, fontPx: number): CSSProperties {
  return {
    height: fontPx * 1.25,
    fontSize: fontPx,
    backgroundColor: edit.bgColor ?? "#ffffff",
    color: edit.textColor ?? "#000000",
    fontWeight: edit.bold ? 700 : undefined,
    fontStyle: edit.italic ? "italic" : undefined,
    fontFamily: edit.fontFamily ? `${edit.fontFamily}, ${editFamily(!!edit.serif)}` : editFamily(!!edit.serif),
    textDecorationLine: decorationLine(edit),
    WebkitTextStroke: edit.bold ? `${Math.max(0.3, fontPx * 0.02)}px currentColor` : undefined,
  };
}
