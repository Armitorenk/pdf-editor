import { registerPlugin } from "@capacitor/core";

/**
 * Native PDF object-editing engine — the TypeScript contract for the Android PDFium plugin
 * (see docs/object-editing-architecture.md). The WebView UI drives object selection /
 * transform / editing through these methods; the native side wraps PDFium's FPDFEdit API.
 *
 * Phase 0: the methods are stubbed on the native side; this file pins the interface the rest
 * of the app codes against, so the UI and the engine can evolve independently.
 */

/** PDFium page-object kind (FPDFPageObj_GetType). */
export type PdfObjectType = "text" | "image" | "path" | "shading" | "form" | "unknown";

/** One editable object on a page, as reported by the engine. */
export interface PdfObject {
  /** Index in the page's object list — also the Z-order (paint order). */
  id: number;
  type: PdfObjectType;
  /** Bounds in PDF points, lower-left origin: [left, bottom, right, top]. */
  bounds: [number, number, number, number];
  /** Affine matrix [a, b, c, d, e, f] (FPDFPageObj_GetMatrix) — move/scale/rotate live here. */
  matrix: [number, number, number, number, number, number];
}

/** A rendered page bitmap plus the geometry needed to overlay the editing UI. */
export interface RenderedPage {
  /** Base64 PNG of the rendered page. */
  data: string;
  /** Bitmap size in device px. */
  width: number;
  height: number;
  /** Intrinsic page size in PDF points (for the px↔point overlay mapping). */
  pageWidth: number;
  pageHeight: number;
}

export interface PdfEnginePlugin {
  /** Load a document from base64 bytes; resolves the page count. */
  openDoc(options: { data: string }): Promise<{ pages: number }>;
  /** Rasterise a page at `scale` (default 1) for display under the editing overlay. */
  renderPage(options: { page: number; scale?: number }): Promise<RenderedPage>;
  /** List a page's editable objects, Z-ordered. */
  listObjects(options: { page: number }): Promise<{ objects: PdfObject[] }>;
  /** Pre-multiply an object's matrix by [a,b,c,d,e,f] (move/scale/rotate). */
  transformObject(options: {
    page: number;
    index: number;
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }): Promise<void>;
  /** Set an object's fill colour ("#rrggbb"). */
  setObjectColor(options: { page: number; index: number; color: string }): Promise<void>;
  /** Replace a text object's string (kept in its existing font). */
  setObjectText(options: { page: number; index: number; text: string }): Promise<void>;
  /** Delete an object; object indices shift afterwards, so re-list the page. */
  deleteObject(options: { page: number; index: number }): Promise<void>;
  /** Move an object to front/back (Z-order); resolves its new index. */
  reorderObject(options: { page: number; index: number; toFront: boolean }): Promise<{ index: number }>;
  /** Add an image object from base64 RGBA pixels (used to duplicate); resolves its index. */
  addImage(options: {
    page: number;
    rgba: string;
    width: number;
    height: number;
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }): Promise<{ index: number }>;
  /** Serialise the edited document to a base64 PDF. */
  saveDocument(): Promise<{ data: string }>;
  /** Release the open document and free native memory. */
  closeDoc(): Promise<void>;
}

/**
 * Native engine handle. Available on Android (Capacitor plugin "PdfEngine"); on the web it is
 * unavailable — callers should feature-detect via `Capacitor.isNativePlatform()` and fall back
 * to the existing pdf.js path until the native engine ships.
 */
export const PdfEngine = registerPlugin<PdfEnginePlugin>("PdfEngine");
