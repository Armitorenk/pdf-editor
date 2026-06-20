/** Lifecycle of the currently-loaded PDF document. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Intrinsic page size in PDF points (1pt = 1/72 inch), at scale 1, unrotated-normalised. */
export interface PageSize {
  width: number;
  height: number;
}

/** Active editing tool. */
export type EditMode = "view" | "text" | "image" | "annotate";

/**
 * A page slot in the working document. Pages are referenced by a STABLE `id`, not
 * their position, so reordering/deleting keeps every edit attached to the right
 * page. Original pages map back to a source index; blank pages carry their size.
 */
export type PageRef =
  | { id: string; kind: "original"; originalIndex: number }
  | { id: string; kind: "blank"; width: number; height: number };

/**
 * A single text replacement. Geometry is in PDF user space (points, bottom-left
 * origin, scale 1), so it is zoom-independent and ready for pdf-lib.
 */
export interface TextEdit {
  pageId: string;
  itemIndex: number; // index within pdf.js getTextContent().items (stable per page)
  originalText: string;
  newText: string;
  x: number; // baseline-left x
  y: number; // baseline y, from the page bottom
  fontSize: number;
  width: number; // original run width in points
}

/** Stable map key for a text edit. */
export const textEditKey = (pageId: string, itemIndex: number): string =>
  `${pageId}:${itemIndex}`;

/**
 * An image (signature/logo) placed onto a page. Geometry is in PDF user space
 * (points, lower-left corner origin) so it maps straight to pdf-lib's `drawImage`.
 */
export interface ImageOverlay {
  id: string;
  pageId: string;
  x: number; // lower-left corner, points
  y: number;
  width: number; // points
  height: number;
  src: string; // object URL, for on-screen preview
  bytes: Uint8Array; // raw image bytes, for pdf-lib embedding
  format: "png" | "jpg";
  /** Natural pixel size — used to preserve aspect ratio while resizing. */
  aspect: number; // naturalWidth / naturalHeight
}

/** Annotation tools. */
export type AnnotationTool = "pen" | "highlight" | "rect" | "ellipse";

interface AnnotationBase {
  id: string;
  pageId: string;
  color: string; // hex, e.g. "#ef4444"
  strokeWidth: number; // PDF points
}

/** Freehand stroke: a polyline of points in PDF user space. */
export interface PenAnnotation extends AnnotationBase {
  kind: "pen";
  points: { x: number; y: number }[];
}

/** Rectangle/highlight/ellipse: a bounding box in PDF user space (lower-left origin). */
export interface BoxAnnotation extends AnnotationBase {
  kind: "highlight" | "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Annotation = PenAnnotation | BoxAnnotation;
