/**
 * Coordinate-system mapping: browser DOM  <->  PDF user space.
 * ---------------------------------------------------------------------------
 * This is THE single source of truth for converting between where the user
 * clicks/drags (the DOM) and where things live inside the PDF (pdf-lib). Every
 * editing feature added later (text, images, annotations) must route through
 * here so the two systems never drift.
 *
 *   DOM / canvas space          PDF user space (pdf-lib)
 *   ------------------          ------------------------
 *   origin = TOP-left           origin = BOTTOM-left
 *   x -> right, y -> DOWN        x -> right, y -> UP
 *   unit  = CSS pixel           unit  = point (1/72 inch)
 *   scaled by the zoom level    always at scale 1 (intrinsic)
 *
 * The vertical axis is flipped between the two, which is the classic source of
 * "my signature is upside-down / off the page" bugs.
 *
 * pdf.js gives us a `PageViewport` that already encodes scale + rotation, so for
 * point conversions we delegate to its `convertToPdfPoint` / `convertToViewportPoint`
 * helpers — they handle rotated pages correctly. For axis-aligned rectangles on
 * unrotated pages (the common case for placing images/shapes with pdf-lib) we
 * also expose an explicit, rotation-free formula in `domRectToPdfRect` so the
 * math is auditable.
 */
import type { PageViewport } from "pdfjs-dist";

export interface Point {
  x: number;
  y: number;
}

/** Affine 2D transform `[a, b, c, d, e, f]`, as used throughout PDF/pdf.js. */
export type Matrix = [number, number, number, number, number, number];

/**
 * Compose two affine matrices — equivalent to pdf.js's `Util.transform(m1, m2)`.
 * Used to map a text item's matrix into device/viewport space:
 * `multiplyMatrix(viewport.transform, item.transform)`.
 */
export function multiplyMatrix(m1: number[], m2: number[]): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Axis-aligned rectangle. In DOM space the origin is the TOP-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * DOM point -> PDF point.
 * @param domX  X offset in CSS px, relative to the page canvas's top-left, at current zoom.
 * @param domY  Y offset in CSS px, relative to the page canvas's top-left, at current zoom.
 * @returns PDF-space point in points, measured from the bottom-left, Y pointing up.
 */
export function domPointToPdf(domX: number, domY: number, viewport: PageViewport): Point {
  const [x, y] = viewport.convertToPdfPoint(domX, domY);
  return { x, y };
}

/**
 * PDF point -> DOM point. Inverse of {@link domPointToPdf}; use it to position a
 * DOM overlay (text box, resize handle) on top of a PDF coordinate.
 * @returns CSS-px offset from the page canvas's top-left, at current zoom.
 */
export function pdfPointToDom(pdfX: number, pdfY: number, viewport: PageViewport): Point {
  const [x, y] = viewport.convertToViewportPoint(pdfX, pdfY);
  return { x, y };
}

/**
 * DOM rectangle (top-left origin, CSS px at `scale`) -> pdf-lib draw rectangle
 * (bottom-left origin, points). pdf-lib's `drawImage` / `drawRectangle` anchor at
 * the rectangle's LOWER-left corner, so we both un-zoom and flip the Y axis.
 *
 * Assumes an unrotated page. For rotated pages, convert the corner points with
 * {@link domPointToPdf} instead.
 *
 * @param rect          The element's box in DOM space (px at the current zoom).
 * @param pageHeightPt  The page height in points (intrinsic, scale 1).
 * @param scale         The current zoom factor the DOM rect was measured at.
 */
export function domRectToPdfRect(rect: Rect, pageHeightPt: number, scale: number): Rect {
  const width = rect.width / scale;
  const height = rect.height / scale;
  const x = rect.x / scale;
  // DOM `y` is the distance of the box's TOP from the page top. pdf-lib wants the
  // BOTTOM edge's distance from the page bottom: flip, then drop by the height.
  const y = pageHeightPt - rect.y / scale - height;
  return { x, y, width, height };
}

/**
 * pdf-lib draw rectangle (bottom-left origin, points) -> DOM rectangle (top-left
 * origin, CSS px at `scale`). Inverse of {@link domRectToPdfRect}; use it to render
 * a placed image/shape overlay on top of the canvas at the current zoom.
 */
export function pdfRectToDomRect(rect: Rect, pageHeightPt: number, scale: number): Rect {
  const width = rect.width * scale;
  const height = rect.height * scale;
  const x = rect.x * scale;
  // PDF `y` is the bottom edge from the page bottom; DOM wants the top edge from
  // the page top: flip and account for the height.
  const y = (pageHeightPt - rect.y - rect.height) * scale;
  return { x, y, width, height };
}
