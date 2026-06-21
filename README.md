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

# 2. build the debug APK. Run Gradle on JDK 21-23 (NOT 25 — Gradle 8.14 tops out
#    at JDK 24). The Capacitor plugins pin a Java 21 toolchain, which Gradle
#    auto-downloads (foojay resolver in settings.gradle) if you don't have it.
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
      ProjectLibrary.tsx      # home screen: open PDF + saved-project grid (open/delete)
      Toolbar.tsx             # desktop: upload, zoom, mode toggles, page indicator
      MobileToolbar.tsx       # touch: two-row toolbar, full-width mode switcher
      ExportMenu.tsx          # "Export ▾" dropdown: PDF / PNG / JPEG / text
      ThumbnailSidebar.tsx    # pages: desktop rail + mobile drawer; reorder/delete/insert-blank
      PdfViewer.tsx           # scrollable viewer; renders slot-by-slot from pageOrder
      PdfPageCanvas.tsx       # one page -> canvas, lazy (IntersectionObserver), HiDPI
      TextLayer.tsx           # detect text runs; click to edit; samples bg/ink colour; WYSIWYG
      ImageLayer.tsx          # placed images: drag-move, free corner resize, delete
      ObjectLayer.tsx         # "Object" mode: draw a box to lift an existing object
      AnnotationLayer.tsx     # pen / highlight / rect / ellipse + select/move/delete
      AnnotationToolbar.tsx   # annotation sub-toolbar (tool · colour · width · undo · clear)
  hooks/
    usePdfDocument.ts         # File bytes -> pdf.js document (race-safe, cleans up)
  lib/
    pdf/
      pdfjs.ts                # browser-only lazy loader; wires the worker
      render.ts               # renderPageToCanvas() — DPR-aware, cancellable
      coordinates.ts          # *** DOM <-> PDF coordinate mapping (read this) ***
      sampleColor.ts          # sample real bg/ink colour behind a text run (for blend-in edits)
      lift.ts                 # rasterise a page region to a movable PNG + cover colour
      export.ts               # rebuild PDF from pageOrder + bake every edit (pdf-lib)
      convert.ts              # edited PDF -> PNG/JPEG (pdf.js + JSZip) and text extraction
      types.ts                # PageRef, TextEdit, ImageOverlay, Annotation, …
    projects.ts               # IndexedDB project store (meta + data); save/list/load/delete
    save.ts                   # platform save: Capacitor Share on native, download on web
    download.ts               # downloadBlob() / downloadBytes()
    utils.ts                  # cn()
  scripts/copy-pdf-worker.mjs # copies the worker into /public (offline, version-locked)
  scripts/gen-assets.mjs      # one SVG logo -> icon/splash source PNGs (sharp), for @capacitor/assets
  assets/                     # generated icon/splash sources (+ source/glyph.svg)
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
- [x] **Step 2 — Text editing (colour/font-aware):** "Edit text" mode overlays
      detected text runs (`getTextContent`); click a run to edit inline (Enter saves,
      Esc cancels). On commit the page is sampled off-screen (`src/lib/pdf/sampleColor.ts`)
      to capture the **real background colour behind the run** (so a blue panel stays
      blue instead of a white box) and the **original ink colour** — both stored on the
      edit and used in the WYSIWYG preview and the export. Serif vs. sans is detected
      from the run's font family and the export embeds **two Unicode faces** (Noto Sans
      + a serif), so a serif run stays serif. Committed edits render in **every mode**
      from stored PDF-space geometry (untouched pages cost nothing). Edits keyed
      `pageId:itemIndex`, reset on file change. _Limits: edits one detected run
      (≈word/line fragment) at a time; matches family class + size + colour, not the
      exact original typeface; bold/italic not reproduced._
- [x] **Step 3 — Image placement:** "Image" mode + "Add" uploads a PNG/JPG, placed
      centred on the active page. Drag to move, **four corner handles for free
      (non-aspect-locked) resize** — the opposite corner stays anchored, so a square
      can be stretched into any rectangle — trash to delete. Geometry stored in PDF
      points; export embeds the image (`embedPng`/`embedJpg`) and draws it via the
      unified `exportPdf` pipeline.
- [x] **Step 4 — Annotations:** "Annotate" mode opens a sub-toolbar (tool · colour ·
      width · undo · clear page). Freehand **pen**, semi-transparent **highlight**,
      **rectangle**, and **ellipse**, drawn on an overlay and stored in PDF points.
      A **Select tool** lets you tap an individual object to pick it (topmost wins),
      drag to move it, and delete it with one button — the touch-friendly way to
      remove a single drawing (no per-object handle / right-click on a phone).
      Export bakes them via `drawLine` / filled-rect-with-opacity / border-rect /
      `drawEllipse`.
- [x] **Step 5 — Page management:** thumbnail rail supports reorder (▲/▼), per-page
      delete, **insert a blank page at any position** (the `+` on each thumbnail drops a
      blank directly below it; the bottom button appends), and append blank. Pages carry
      a **stable `id`** (`PageRef`), so every edit stays bound to its page across reordering.
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
- [x] **Step 8 — Project library (on-device persistence):** the home screen is a
      **library** of saved projects (thumbnail · name · page count) plus "Open PDF".
      Opening a file creates a project; all edits (page order, text, images,
      annotations) **auto-save debounced** to **IndexedDB** — works identically in
      the browser and inside the Android WebView (no server). Reopen to continue
      where you left off, or delete when done. A first-page JPEG thumbnail is
      generated on load. See `src/lib/projects.ts` (two stores: tiny `meta` for the
      list, `data` for the PDF bytes + edits) and `src/components/editor/ProjectLibrary.tsx`.
- [x] **Step 9 — Save/share on Android:** `<a download>` does nothing inside a
      WebView, so `src/lib/save.ts` routes every export through the **Capacitor
      Filesystem + Share** plugins on native (write to cache → system share sheet →
      "Save to Files" / Drive / WhatsApp), falling back to the browser download on
      web.
- [x] **Step 10 — Edit existing objects (lift):** content baked into a PDF's stream
      (often nested in Form XObjects) can't be reliably moved/resized/deleted in place,
      so "Object" mode instead **lifts** a region: draw a box around any existing object
      and it's rasterised to a movable image (`src/lib/pdf/lift.ts`) while a solid cover
      sampled from the surrounding colour is dropped underneath to hide the original.
      The lifted copy lands selected in image mode — drag, free-resize, or delete it
      like any placed image. _Trade-off: the lifted object becomes raster (not live
      text/vector); clean removal depends on background colour detection._
- [x] **Step 11 — Undo / redo:** a single snapshot history over all four edit state
      pieces (page order, text, images, annotations) in `PdfEditor`. Every user edit —
      including multi-field atomic ones like delete-page — is one history entry; toolbar
      buttons and **Ctrl/Cmd+Z / Ctrl+Shift+Z (or Ctrl+Y)** replay snapshots. Object
      URLs are kept alive until document switch so an undone image delete still renders.
      A fresh document starts a new baseline (`epoch`).
- [x] **Step 12 — Brand, app icon & splash:** one SVG logo mark (dog-eared page +
      editing pencil) drives every asset via `scripts/gen-assets.mjs` (sharp) →
      `@capacitor/assets generate`, producing all Android launcher densities (adaptive
      icon: amber pencil on blue) and a launch **splash** (logo + "PDF Editor", with a
      dark-mode variant). The splash shows on cold start via the `Theme.SplashScreen`
      launch theme and clears once the WebView paints — no web changes.
