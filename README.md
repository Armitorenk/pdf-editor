# PDF Editor

Browser-based PDF viewer/editor. Everything runs client-side — no file ever leaves the browser.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn-style UI · `pdfjs-dist` (render) · `pdf-lib` (export, upcoming).

## Run

```bash
npm install
npm run dev      # http://localhost:3000  (auto-copies the pdf.js worker first)
npm run build    # production build (typechecks + lints)
```

## Architecture

UI components are kept separate from PDF logic.

```
src/
  app/
    page.tsx                  # renders <PdfEditor/>
    layout.tsx, globals.css
  components/
    ui/button.tsx             # shadcn-style primitive (cn + variants)
    editor/
      PdfEditor.tsx           # top-level: owns bytes + view state, composes everything
      Toolbar.tsx             # upload, zoom, page indicator
      ThumbnailSidebar.tsx    # lazy page thumbnails; click to jump
      PdfViewer.tsx           # scrollable multi-page canvas; reports/drives scroll
      PdfPageCanvas.tsx       # one page -> canvas, lazy (IntersectionObserver), HiDPI
  hooks/
    usePdfDocument.ts         # File bytes -> pdf.js document (race-safe, cleans up)
  lib/
    pdf/
      pdfjs.ts                # browser-only lazy loader; wires the worker
      render.ts               # renderPageToCanvas() — DPR-aware, cancellable
      coordinates.ts          # *** DOM <-> PDF coordinate mapping (read this) ***
      types.ts
    utils.ts                  # cn()
  scripts/copy-pdf-worker.mjs # copies the worker into /public (offline, version-locked)
```

### pdf.js worker

pdf.js parses PDFs in a Web Worker referenced by URL. `scripts/copy-pdf-worker.mjs`
copies the worker out of `node_modules` into `public/pdf.worker.min.mjs` (run
automatically via the `predev`/`prebuild` npm hooks), so the app works offline and
the worker version can never drift from the installed `pdfjs-dist`.

pdf.js is only ever imported through `getPdfjs()` (a lazy, browser-only `import()`),
so it never runs during server-side rendering.

### Coordinate system (DOM ⇄ PDF)

The single source of truth is **`src/lib/pdf/coordinates.ts`**. The key fact:

| | DOM / canvas | PDF user space (pdf-lib) |
|---|---|---|
| origin | **top**-left | **bottom**-left |
| Y axis | points **down** | points **up** |
| unit | CSS pixel (× zoom) | point = 1/72 inch (scale 1) |

So the vertical axis is flipped between the two — the classic source of
"placed in the wrong spot / upside-down" bugs.

- **Point conversions** delegate to pdf.js's `PageViewport.convertToPdfPoint` /
  `convertToViewportPoint`, which already account for zoom **and** page rotation.
- **Rectangle conversion** (`domRectToPdfRect`) — for placing images/shapes with
  pdf-lib, which anchors at the rectangle's **lower-left** corner — un-zooms and
  flips Y explicitly: `pdfY = pageHeight − domTop/scale − height`.

Every editing feature (text, images, annotations) must route through this module so
the two coordinate systems never drift.

## Status

- [x] **Step 1 — Rendering engine:** upload (button + drag/drop), multi-page canvas
      with smooth scroll, zoom (in/out/reset/fit-width), HiDPI-crisp output, lazy
      per-page rendering, clickable thumbnail navigation, active-page tracking.
- [x] **Step 2 — Text editing:** "Edit text" mode overlays detected text runs
      (`getTextContent`); click a run to edit inline (Enter saves, Esc cancels) with
      a live white-cover preview. **Download** bakes edits into a new PDF via pdf-lib,
      embedding a Unicode font (Noto Sans) so Turkish/non-Latin-1 text exports
      correctly. Edits are keyed `pageId:itemIndex` and reset on file change.
      _Limits: edits one detected run (≈word/line fragment) at a time; export assumes
      black text on light background and does not reproduce the original font face._
- [x] **Step 3 — Image placement:** "Image" mode + "Add" uploads a PNG/JPG, placed
      centred on the active page. Drag to move, aspect-locked corner handle to resize,
      trash to delete. Geometry stored in PDF points; export embeds the image
      (`embedPng`/`embedJpg`) and draws it via the unified `exportPdf` pipeline.
- [x] **Step 4 — Annotations:** "Annotate" mode opens a sub-toolbar (tool · colour ·
      width · undo · clear page). Freehand **pen**, semi-transparent **highlight**,
      **rectangle**, and **ellipse**, drawn on an overlay and stored in PDF points.
      Export bakes them via `drawLine` / filled-rect-with-opacity / border-rect /
      `drawEllipse`.
- [x] **Step 5 — Page management:** thumbnail rail supports drag-to-reorder, per-page
      delete (with confirm hover-X), and append blank page. Pages carry a **stable
      `id`** (`PageRef`), so every edit stays bound to its page across reordering.
- [x] **Step 6 — Unified export:** `exportPdf(bytes, { pageOrder, textEdits, images,
      annotations })` rebuilds the document from `pageOrder` (copying originals,
      inserting blanks) and bakes all edits, matched to pages by `pageId`. Verified
      in Node against a 509-page PDF (reorder + blank + Turkish text + image + all
      four annotation kinds → valid `%PDF`).
