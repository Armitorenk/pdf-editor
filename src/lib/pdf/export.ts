import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type { Annotation, ImageOverlay, PageRef, TextEdit } from "./types";

export interface ExportPayload {
  pageOrder: PageRef[];
  textEdits: TextEdit[];
  images: ImageOverlay[];
  annotations: Annotation[];
  /** Original (pdf.js-converted) font programs by PostScript name, for font reuse. */
  originalFonts?: Map<string, Uint8Array>;
}

// Fallback size (A4 portrait, points) for a blank page with no recorded size.
const A4: [number, number] = [595.28, 841.89];

/**
 * Build a brand-new PDF that reflects the current page order, then bake in every
 * edit. Rebuilding from `pageOrder` (copying originals, inserting blanks) is what
 * makes page reorder / delete / append work; edits are matched to pages by stable
 * `pageId`, so they always land on the right page wherever it moved.
 *
 * Drawing order per page: text edits, then images, then annotations (so ink sits
 * on top). Text edits cover the original glyphs with a white box and redraw with an
 * embedded Unicode font (Noto Sans) so Turkish / non-Latin-1 text survives.
 */
export async function exportPdf(
  originalBytes: Uint8Array,
  { pageOrder, textEdits, images, annotations, originalFonts }: ExportPayload,
): Promise<Uint8Array> {
  const [pdfLib, fontkitMod] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  const { PDFDocument, StandardFonts, rgb } = pdfLib;

  const out = await PDFDocument.create();
  const needsOriginal = pageOrder.some((p) => p.kind === "original");
  const src = needsOriginal ? await PDFDocument.load(originalBytes.slice()) : null;

  // Bundled Unicode fallback faces: Source Sans 3 (sans) · Noto Serif (serif) · Cousine
  // (monospace), each in regular/bold/italic/bold-italic. A (family, style) face is only
  // embedded when some edit actually needs it; a failed fetch falls back to the family's
  // regular, which falls back to the sans regular (ultimately Helvetica).
  const faces = new Map<string, PDFFont>();
  let haveFaces = false;
  const FILES: Record<string, Record<string, string>> = {
    sans: { r: "editor-sans", b: "editor-sans-bold", i: "editor-sans-italic", bi: "editor-sans-bolditalic" },
    serif: { r: "editor-serif", b: "editor-serif-bold", i: "editor-serif-italic", bi: "editor-serif-bolditalic" },
    mono: { r: "editor-mono", b: "editor-mono-bold", i: "editor-mono-italic", bi: "editor-mono-bolditalic" },
  };
  const famOf = (t: TextEdit): "sans" | "serif" | "mono" => (t.mono ? "mono" : t.serif ? "serif" : "sans");
  const styleOf = (t: TextEdit) => (t.bold && t.italic ? "bi" : t.bold ? "b" : t.italic ? "i" : "r");
  if (textEdits.length > 0) {
    out.registerFontkit(fontkitMod.default ?? fontkitMod);
    const embedOr = async (file: string, fallback: () => Promise<PDFFont> | PDFFont) => {
      try {
        const res = await fetch(`/fonts/${file}.ttf`);
        if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
        return await out.embedFont(await res.arrayBuffer(), { subset: true });
      } catch {
        return fallback();
      }
    };
    faces.set("sans-r", await embedOr(FILES.sans.r, () => out.embedFont(StandardFonts.Helvetica)));
    const wanted = new Set(textEdits.map((t) => `${famOf(t)}-${styleOf(t)}`));
    for (const key of wanted) {
      const [fam, st] = key.split("-");
      const famReg = `${fam}-r`;
      if (!faces.has(famReg)) faces.set(famReg, await embedOr(FILES[fam].r, () => faces.get("sans-r")!));
      if (st !== "r" && !faces.has(key)) faces.set(key, await embedOr(FILES[fam][st], () => faces.get(famReg)!));
    }
    haveFaces = true;
  }

  // Pick the closest bundled face for an edit (family by serif/mono, style by bold/italic).
  const pickBundled = (edit: TextEdit): PDFFont => {
    const fam = edit.mono ? "mono" : edit.serif ? "serif" : "sans";
    const st = edit.bold && edit.italic ? "bi" : edit.bold ? "b" : edit.italic ? "i" : "r";
    return faces.get(`${fam}-${st}`) ?? faces.get(`${fam}-r`) ?? faces.get("sans-r")!;
  };

  // --- Font reuse -----------------------------------------------------------
  // Prefer the document's OWN font for an edit, so the typeface matches exactly.
  // The catch (proven): a PDF embeds only a font SUBSET, and pdf.js's converted
  // program may lack a Unicode glyph for a newly-typed character (which would draw
  // an invisible/.notdef box). So we gate strictly: reuse only when fontkit confirms
  // the font has a glyph for EVERY character in the new text; otherwise fall back to
  // the bundled close-match face. Embedded fonts are cached per PostScript name.
  const fontkit = (fontkitMod.default ?? fontkitMod) as { create: (b: Uint8Array) => { hasGlyphForCodePoint: (cp: number) => boolean } };
  const reuseCache = new Map<string, { pdfFont: PDFFont; fk: { hasGlyphForCodePoint: (cp: number) => boolean } } | null>();
  const reuseFontFor = async (edit: TextEdit): Promise<PDFFont | null> => {
    if (!edit.fontPsName || !originalFonts) return null;
    const bytes = originalFonts.get(edit.fontPsName);
    if (!bytes) return null;
    let entry = reuseCache.get(edit.fontPsName);
    if (entry === undefined) {
      try {
        entry = { fk: fontkit.create(bytes), pdfFont: await out.embedFont(bytes, { subset: true }) };
      } catch {
        entry = null;
      }
      reuseCache.set(edit.fontPsName, entry);
    }
    if (!entry) return null;
    for (const ch of edit.newText) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && !entry.fk.hasGlyphForCodePoint(cp)) return null;
    }
    return entry.pdfFont;
  };

  for (const ref of pageOrder) {
    let page: PDFPage;
    if (ref.kind === "original" && src) {
      const [copied] = await out.copyPages(src, [ref.originalIndex]);
      page = out.addPage(copied);
    } else {
      page = out.addPage(ref.kind === "blank" ? [ref.width, ref.height] : A4);
    }

    if (haveFaces) {
      for (const edit of textEdits.filter((t) => t.pageId === ref.id)) {
        // Reuse the original embedded font when it covers the text (exact match); otherwise
        // pick the closest bundled face — the right sans/serif/mono family AND bold/italic cut
        // (every family now ships a real bold/italic, so no faux-bold double-draw is needed).
        const reuse = await reuseFontFor(edit);
        const font = reuse ?? pickBundled(edit);
        try {
          // (1) Size calibration. A reused (pdf.js-converted) program can carry metrics
          // that make pdf-lib draw it over/undersized. Compare its width for the ORIGINAL
          // run text against pdf.js's measured advance (edit.width, in points) and rescale
          // so the glyphs land at the document's true size. Bundled faces are left as-is.
          let size = edit.fontSize;
          if (reuse && edit.originalText && edit.width > 0) {
            const w0 = reuse.widthOfTextAtSize(edit.originalText, edit.fontSize);
            if (w0 > 0) {
              const k = edit.width / w0;
              if (k > 0.25 && k < 4) size = edit.fontSize * k;
            }
          }
          // Manual size override (tap-to-resize on screen).
          size *= edit.userScale ?? 1;
          // (2) Cover the original glyphs at the ORIGINAL position/size so they stay hidden even
          // if the new text is moved away, then (3) draw the new text at its NATURAL spacing,
          // left-aligned, shifted by the user's position nudge. We deliberately do NOT stretch it
          // to the box width — spreading letters to fill a wider box produced the "M İ L L E N"
          // look in the exported PDF.
          const natural = font.widthOfTextAtSize(edit.newText, size);
          const boxW = Math.max(edit.width, natural);
          page.drawRectangle({
            x: edit.x,
            y: edit.y - edit.fontSize * 0.25,
            width: boxW,
            height: edit.fontSize * 1.2,
            color: hexToRgb(edit.bgColor ?? "#ffffff", rgb),
          });
          const color = hexToRgb(edit.userColor ?? edit.textColor ?? "#000000", rgb);
          const ux = edit.userDx ?? 0;
          const uy = edit.userDy ?? 0;
          // Manual letter/word spacing (em -> points). pdf-lib's drawText can't add spacing, so
          // when the user set any we draw char-by-char with explicit advances; otherwise keep the
          // single natural-spacing drawText (unchanged default — no letter spread).
          const letterPts = (edit.userLetterSpacing ?? 0) * size;
          const wordPts = (edit.userWordSpacing ?? 0) * size;
          const drawAt = (dx: number, dy: number) => {
            const y = edit.y + uy + dy;
            if (!letterPts && !wordPts) {
              page.drawText(edit.newText, { x: edit.x + ux + dx, y, size, font, color });
              return;
            }
            let cx = edit.x + ux + dx;
            for (const ch of edit.newText) {
              page.drawText(ch, { x: cx, y, size, font, color });
              cx += font.widthOfTextAtSize(ch, size) + letterPts + (ch === " " ? wordPts : 0);
            }
          };
          drawAt(0, 0);
          // Redraw underline / strikethrough across the new text (the white cover
          // erased the original vector line), so the decoration survives the edit.
          if (edit.underline || edit.strike) {
            const lineW = boxW;
            const thickness = Math.max(0.6, edit.fontSize * 0.05);
            if (edit.underline) {
              const y = edit.y + uy - edit.fontSize * 0.1;
              page.drawLine({ start: { x: edit.x + ux, y }, end: { x: edit.x + ux + lineW, y }, thickness, color });
            }
            if (edit.strike) {
              const y = edit.y + uy + edit.fontSize * 0.28;
              page.drawLine({ start: { x: edit.x + ux, y }, end: { x: edit.x + ux + lineW, y }, thickness, color });
            }
          }
        } catch {
          // Character not encodable by the fallback font — leave the original.
        }
      }
    }

    for (const img of images.filter((i) => i.pageId === ref.id)) {
      const embedded =
        img.format === "png"
          ? await out.embedPng(img.bytes.slice())
          : await out.embedJpg(img.bytes.slice());
      page.drawImage(embedded, { x: img.x, y: img.y, width: img.width, height: img.height });
    }

    for (const ann of annotations.filter((a) => a.pageId === ref.id)) {
      drawAnnotation(page, ann, hexToRgb(ann.color, rgb));
    }
  }

  return out.save();
}

/** Draw one annotation onto a pdf-lib page (PDF-space geometry already in points). */
function drawAnnotation(page: PDFPage, ann: Annotation, color: RGB): void {
  if (ann.kind === "pen") {
    for (let i = 1; i < ann.points.length; i++) {
      page.drawLine({
        start: ann.points[i - 1],
        end: ann.points[i],
        thickness: ann.strokeWidth,
        color,
      });
    }
    return;
  }

  if (ann.kind === "highlight") {
    page.drawRectangle({
      x: ann.x,
      y: ann.y,
      width: ann.width,
      height: ann.height,
      color,
      opacity: 0.35,
      borderWidth: 0,
    });
    return;
  }

  if (ann.kind === "rect") {
    page.drawRectangle({
      x: ann.x,
      y: ann.y,
      width: ann.width,
      height: ann.height,
      borderColor: color,
      borderWidth: ann.strokeWidth,
      opacity: 0, // no fill
    });
    return;
  }

  // ellipse
  page.drawEllipse({
    x: ann.x + ann.width / 2,
    y: ann.y + ann.height / 2,
    xScale: ann.width / 2,
    yScale: ann.height / 2,
    borderColor: color,
    borderWidth: ann.strokeWidth,
    opacity: 0,
  });
}

/** "#rrggbb" -> pdf-lib RGB (channels 0..1). */
function hexToRgb(hex: string, rgb: (r: number, g: number, b: number) => RGB): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
