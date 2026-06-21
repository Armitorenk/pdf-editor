import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type { Annotation, ImageOverlay, PageRef, TextEdit } from "./types";

export interface ExportPayload {
  pageOrder: PageRef[];
  textEdits: TextEdit[];
  images: ImageOverlay[];
  annotations: Annotation[];
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
  { pageOrder, textEdits, images, annotations }: ExportPayload,
): Promise<Uint8Array> {
  const [pdfLib, fontkitMod] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  const { PDFDocument, StandardFonts, rgb } = pdfLib;

  const out = await PDFDocument.create();
  const needsOriginal = pageOrder.some((p) => p.kind === "original");
  const src = needsOriginal ? await PDFDocument.load(originalBytes.slice()) : null;

  // Two embedded Unicode faces so a serif run exports serif and a sans run sans.
  // Both fall back to Helvetica if the bundled TTFs can't be fetched/embedded.
  let sansFont: PDFFont | null = null;
  let serifFont: PDFFont | null = null;
  if (textEdits.length > 0) {
    out.registerFontkit(fontkitMod.default ?? fontkitMod);
    const embed = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
      return out.embedFont(await res.arrayBuffer(), { subset: true });
    };
    try {
      sansFont = await embed("/fonts/editor-font.ttf");
    } catch {
      sansFont = await out.embedFont(StandardFonts.Helvetica);
    }
    try {
      serifFont = textEdits.some((t) => t.serif) ? await embed("/fonts/editor-serif.ttf") : sansFont;
    } catch {
      serifFont = await out.embedFont(StandardFonts.TimesRoman);
    }
  }

  for (const ref of pageOrder) {
    let page: PDFPage;
    if (ref.kind === "original" && src) {
      const [copied] = await out.copyPages(src, [ref.originalIndex]);
      page = out.addPage(copied);
    } else {
      page = out.addPage(ref.kind === "blank" ? [ref.width, ref.height] : A4);
    }

    if (sansFont && serifFont) {
      for (const edit of textEdits.filter((t) => t.pageId === ref.id)) {
        const font = edit.serif ? serifFont : sansFont;
        try {
          const newWidth = font.widthOfTextAtSize(edit.newText, edit.fontSize);
          page.drawRectangle({
            x: edit.x,
            y: edit.y - edit.fontSize * 0.25,
            width: Math.max(edit.width, newWidth),
            height: edit.fontSize * 1.2,
            color: hexToRgb(edit.bgColor ?? "#ffffff", rgb),
          });
          const color = hexToRgb(edit.textColor ?? "#000000", rgb);
          const drawAt = (dx: number, dy: number) =>
            page.drawText(edit.newText, {
              x: edit.x + dx,
              y: edit.y + dy,
              size: edit.fontSize,
              font,
              color,
            });
          drawAt(0, 0);
          if (edit.bold) {
            // No bold font embedded — fake weight by re-drawing with tiny offsets
            // so the strokes thicken (a long-standing PDF faux-bold trick).
            const d = edit.fontSize * 0.03;
            drawAt(d, 0);
            drawAt(0, d);
            drawAt(d, d);
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
