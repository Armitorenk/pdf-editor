# PDF Editor

Browser-based PDF viewer/editor with a **touch-first UI**, packaged as an **Android app** via Capacitor. Everything runs client-side — no file ever leaves the device.

**Stack:** Next.js 16 (App Router, static export) · React 19 · TypeScript · Tailwind v4 · shadcn-style UI · `pdfjs-dist` (render) · `pdf-lib` + `@pdf-lib/fontkit` (export) · `jszip` (image bundles) · **Capacitor 8** (Android shell).

## Run (web)

```bash
npm install
npm run dev      # http://localhost:3000  (auto-copies the pdf.js worker first)
npm run build    # static export to ./out  (typechecks + lints)
```

## Android app (Capacitor)

The web build is a static export (`out/`) that Capacitor wraps into an APK.

```bash
# 1. build the web assets and copy them into the native project
npm run cap:sync                 # = next build && cap sync android

# 2. build the debug APK (needs Android SDK + a JDK Gradle supports — JDK 21-23,
#    NOT 25; Gradle 8.14 here tops out at JDK 24)
cd android
JAVA_HOME="/c/Program Files/Java/jdk-23" \
ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" \
  ./gradlew assembleDebug

# → android/app/build/outputs/apk/debug/app-debug.apk   (sideload onto a phone)
```

App id `com.armitorenk.pdfeditor`, `compileSdk`/`targetSdk` 36, `minSdk` 24. The
`android/` native project is committed; build outputs and the copied web assets
(`app/src/main/assets/public`) are gitignored, so run `npm run cap:sync` after a
fresh clone before building.

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
      PdfEditor.tsx           # top-level: owns bytes + all edit state, composes everything
      Toolbar.tsx             # upload, zoom, mode toggles, page indicator
      ExportMenu.tsx          # "Export ▾" dropdown: PDF / PNG / JPEG / text
      ThumbnailSidebar.tsx    # page thumbnails: click to jump, drag-reorder, delete, +blank
      PdfViewer.tsx           # scrollable viewer; renders slot-by-slot from pageOrder
      PdfPageCanvas.tsx       # one page -> canvas, lazy (IntersectionObserver), HiDPI
      TextLayer.tsx           # detect text runs; click to edit inline
      ImageLayer.tsx          # placed images: drag-move, aspect-locked resize, delete
      AnnotationLayer.tsx     # pen / highlight / rect / ellipse drawing overlay
      AnnotationToolbar.tsx   # annotation sub-toolbar (tool · colour · width · undo · clear)
  hooks/
    usePdfDocument.ts         # File bytes -> pdf.js document (race-safe, cleans up)
  lib/
    pdf/
      pdfjs.ts                # browser-only lazy loader; wires the worker
      render.ts               # renderPageToCanvas() — DPR-aware, cancellable
      coordinates.ts          # *** DOM <-> PDF coordinate mapping (read this) ***
      export.ts               # rebuild PDF from pageOrder + bake every edit (pdf-lib)
      convert.ts              # edited PDF -> PNG/JPEG (pdf.js + JSZip) and text extraction
      types.ts                # PageRef, TextEdit, ImageOverlay, Annotation, …
    download.ts               # downloadBlob() / downloadBytes()
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
- [x] **Step 7 — Format conversion:** the "Export ▾" menu offers **PDF**, **PNG**,
      **JPEG**, and **plain text**. Image formats rasterise the *edited* PDF with
      pdf.js (so they include every edit) — one page downloads directly, multiple
      pages are bundled into a ZIP (JSZip). Text extraction reads the *original*
      document (the cover-box export leaves old glyphs in the stream) and applies
      text edits + page order by the same `pageId:itemIndex` key. See
      `src/lib/pdf/convert.ts`.
