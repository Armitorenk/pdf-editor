import type { PDFPageProxy, RenderTask } from "pdfjs-dist";

/**
 * Rasterise a pdf.js page onto a canvas at the given zoom, crisp on HiDPI screens.
 *
 * The canvas backing store is sized to `cssSize * devicePixelRatio` while its CSS
 * box stays at `cssSize`, and the extra DPR scale is pushed into pdf.js via the
 * `transform` matrix. This keeps text sharp on Retina/4K displays without making
 * the page physically larger.
 *
 * Returns the {@link RenderTask} so the caller can `.cancel()` it — important when
 * the zoom changes mid-render, otherwise pdf.js throws "Cannot use the same canvas
 * during multiple render() operations".
 */
export function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
): RenderTask {
  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio || 1;

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
  return page.render({ canvas, viewport, transform });
}

/** True for the benign exception pdf.js raises when a render is cancelled. */
export function isRenderCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "RenderingCancelledException";
}
