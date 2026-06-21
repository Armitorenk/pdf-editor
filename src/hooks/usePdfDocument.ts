"use client";

import { useEffect, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { getPdfjs } from "@/lib/pdf/pdfjs";
import type { LoadStatus } from "@/lib/pdf/types";

export interface PdfDocumentState {
  doc: PDFDocumentProxy | null;
  numPages: number;
  status: LoadStatus;
  error: string | null;
}

const IDLE: PdfDocumentState = { doc: null, numPages: 0, status: "idle", error: null };

/**
 * Load a PDF from raw bytes into a pdf.js document, keyed on the `bytes` reference.
 *
 * The caller keeps ownership of `bytes` (the master copy used later by pdf-lib for
 * export). pdf.js detaches the buffer it parses, so we hand it a *copy* and leave
 * the original untouched. The previous document is destroyed when bytes change or
 * the component unmounts, and in-flight loads are guarded against races.
 */
export function usePdfDocument(bytes: Uint8Array | null): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>(IDLE);

  useEffect(() => {
    if (!bytes) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setState({ doc: null, numPages: 0, status: "loading", error: null });

    (async () => {
      try {
        const pdfjs = await getPdfjs();
        // `fontExtraProperties` retains each loaded font's converted program bytes
        // (`fontObj.data`) so text edits can re-embed and reuse the document's own
        // font. `disableFontFace` keeps that data intact (it isn't consumed by a
        // system FontFace) and renders glyphs directly — fine for canvas output.
        loadingTask = pdfjs.getDocument({
          data: bytes.slice(),
          fontExtraProperties: true,
          disableFontFace: true,
          // base-14 font data for `disableFontFace` (copied to /public by the
          // copy-pdf-worker script); the trailing slash is required by pdf.js.
          standardFontDataUrl: "/standard_fonts/",
        });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        setState({ doc, numPages: doc.numPages, status: "ready", error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          doc: null,
          numPages: 0,
          status: "error",
          error: err instanceof Error ? err.message : "Failed to load PDF.",
        });
      }
    })();

    return () => {
      cancelled = true;
      // Destroying the loading task tears down the document and its worker.
      void loadingTask?.destroy();
    };
  }, [bytes]);

  return state;
}
