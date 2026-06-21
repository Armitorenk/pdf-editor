// Copies the pdf.js worker into /public so the browser can load it at
// `/pdf.worker.min.mjs`.
//
// Why: pdf.js parses/rasterises PDFs inside a Web Worker, which the main thread
// references by URL (see `GlobalWorkerOptions.workerSrc`). Copying the file out
// of node_modules (instead of pointing at a CDN) means:
//   1. the app works fully offline, and
//   2. the worker version can never drift from the installed `pdfjs-dist`.
//
// Runs automatically via the `predev` / `prebuild` npm hooks.
import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const dest = resolve(root, "public", "pdf.worker.min.mjs");

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`[copy-pdf-worker] copied worker -> ${dest}`);

// Also copy pdf.js's standard (base-14) font data. With `disableFontFace: true`
// (needed so we can reuse a document's own embedded fonts) pdf.js renders
// non-embedded base-14 fonts (Helvetica/Times/Courier/Symbol) from these files,
// referenced via `standardFontDataUrl`. Without them such text renders blank.
const fontsSrc = resolve(root, "node_modules", "pdfjs-dist", "standard_fonts");
const fontsDest = resolve(root, "public", "standard_fonts");
await cp(fontsSrc, fontsDest, { recursive: true });
console.log(`[copy-pdf-worker] copied standard fonts -> ${fontsDest}`);
