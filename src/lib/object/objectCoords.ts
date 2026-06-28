// Coordinate helpers for the object-editing canvas. PDFium reports object bounds in PDF points
// (lower-left origin); the rendered page is a bitmap in device px (top-left origin). These map
// between the two and hit-test a tapped point against a page's objects.

import type { PdfObject, PdfObjectType, RenderedPage } from "./pdfEngine";

export interface PxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** PDF-point → bitmap-px scale factors for a rendered page (derived, so rounding can't drift). */
export function pageScale(page: RenderedPage): { sx: number; sy: number } {
  return {
    sx: page.pageWidth > 0 ? page.width / page.pageWidth : 1,
    sy: page.pageHeight > 0 ? page.height / page.pageHeight : 1,
  };
}

/** Object bounds [left, bottom, right, top] (PDF points) → bitmap-px rect (top-left origin). */
export function boundsToBitmapRect(bounds: [number, number, number, number], page: RenderedPage): PxRect {
  const [l, b, r, t] = bounds;
  const { sx, sy } = pageScale(page);
  return {
    left: l * sx,
    top: (page.pageHeight - t) * sy,
    width: (r - l) * sx,
    height: (t - b) * sy,
  };
}

/**
 * The topmost object whose bounds contain the given bitmap-px point. Objects are Z-ordered
 * (paint order), so we scan from the end to pick the one drawn last (visually on top).
 */
export function hitTestObject(
  objects: PdfObject[],
  page: RenderedPage,
  bx: number,
  by: number,
  onlyType?: PdfObjectType,
): PdfObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    // In text mode we only select text runs, so an overlapping image/path behind the text doesn't
    // grab the tap (otherwise the user can't reach the text without moving the other object first).
    if (onlyType && objects[i].type !== onlyType) continue;
    const r = boundsToBitmapRect(objects[i].bounds, page);
    if (bx >= r.left && bx <= r.left + r.width && by >= r.top && by <= r.top + r.height) {
      return objects[i];
    }
  }
  return null;
}
