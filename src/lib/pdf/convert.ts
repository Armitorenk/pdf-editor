import type { PDFDocumentProxy } from "pdfjs-dist";
import JSZip from "jszip";
import { getPdfjs } from "./pdfjs";
import { textEditKey, type PageRef, type TextEdit } from "./types";

/** Output formats the editor can convert the (edited) document to. */
export type ConvertFormat = "png" | "jpeg" | "txt";

/** Everything "Export" can produce: the edited PDF itself, plus conversions. */
export type ExportFormat = "pdf" | ConvertFormat;

/** One rendered page as an image blob, with a suggested filename. */
export interface PageImage {
  name: string;
  blob: Blob;
}

/**
 * Render every page of an (already exported) PDF to a raster image.
 *
 * Conversion deliberately goes through the EXPORTED PDF bytes — not the live
 * on-screen overlays — so the output faithfully includes every edit: text changes,
 * placed images, annotations, page reordering and blank pages. We rasterise with
 * pdf.js, the same engine the viewer uses, so what you download matches what you
 * see.
 *
 * pdf.js paints page content onto a transparent canvas, so we fill white first;
 * otherwise JPEG would turn empty areas black and PNG would be see-through.
 *
 * @param pdfBytes  PDF produced by {@link import("./export").exportPdf}.
 * @param format    `"png"` (lossless) or `"jpeg"` (smaller).
 * @param scale     Render scale. 2 ≈ 144 DPI — a good sharp default.
 */
export async function pdfToImages(
  pdfBytes: Uint8Array,
  format: "png" | "jpeg",
  scale = 2,
): Promise<PageImage[]> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({ data: pdfBytes.slice() });
  const doc = await loadingTask.promise;
  try {
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const pad = String(doc.numPages).length; // zero-pad so filenames sort naturally
    const images: PageImage[] = [];

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, viewport }).promise;
      const blob = await canvasToBlob(canvas, mime, 0.92);
      images.push({ name: `page-${String(n).padStart(pad, "0")}.${ext}`, blob });

      // Free the page's resources before moving on (large docs can be memory-heavy).
      page.cleanup();
    }
    return images;
  } finally {
    await loadingTask.destroy();
  }
}

/** Bundle rendered page images into a single ZIP blob. */
export async function imagesToZip(images: PageImage[]): Promise<Blob> {
  const zip = new JSZip();
  for (const img of images) zip.file(img.name, img.blob);
  return zip.generateAsync({ type: "blob" });
}

/**
 * Extract the document's text in reading order, honouring the working page order
 * (reordered / deleted / appended-blank pages) and any committed text edits.
 *
 * Text is read from the ORIGINAL pdf.js document (not the exported PDF): the export
 * "edits" text by covering the old glyphs with a white box and redrawing on top, so
 * the original characters still live in the exported content stream and would show
 * up twice. Reading the original and substituting edits by the same
 * `pageId:itemIndex` key the editor uses gives clean, de-duplicated output.
 */
export async function extractText(
  doc: PDFDocumentProxy,
  pageOrder: PageRef[],
  textEdits: Record<string, TextEdit>,
): Promise<string> {
  const pages: string[] = [];

  for (const ref of pageOrder) {
    if (ref.kind === "blank") {
      pages.push(""); // appended blank page — no text
      continue;
    }

    const page = await doc.getPage(ref.originalIndex + 1);
    const content = await page.getTextContent();

    const lines: string[] = [];
    let line = "";
    content.items.forEach((item, idx) => {
      if (!("str" in item)) return; // skip marked-content items (they still hold an index)
      const edit = textEdits[textEditKey(ref.id, idx)];
      line += edit ? edit.newText : item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    });
    if (line) lines.push(line);

    page.cleanup();
    pages.push(lines.join("\n"));
  }

  // Separate pages with a blank line.
  return pages.join("\n\n");
}

/** Promise wrapper around the callback-based `canvas.toBlob`. */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
      type,
      quality,
    );
  });
}
