// Browser-only loader for pdf.js.
//
// pdf.js touches browser globals and spins up a Web Worker, so it must never be
// imported during server-side rendering. Keeping the import behind this async
// function (and only ever calling it from client effects/handlers) guarantees
// the module is evaluated in the browser, once, with the worker wired up.
import type * as PdfjsModule from "pdfjs-dist";

let pdfjsPromise: Promise<typeof PdfjsModule> | null = null;

/** Lazily import pdf.js and point it at the worker copied to `/public`. */
export function getPdfjs(): Promise<typeof PdfjsModule> {
  if (typeof window === "undefined") {
    throw new Error("getPdfjs() must only be called in the browser.");
  }
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}
