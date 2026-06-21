import type { PDFPageProxy } from "pdfjs-dist";
import type { Rect } from "./coordinates";

/**
 * "Lift" an existing region of a page into editable pixels. Because objects baked
 * into a PDF's content stream can't be reliably moved/resized/deleted in place
 * (they're often nested inside Form XObjects), we instead rasterise the chosen
 * region to a PNG — which the editor then places as a normal, movable image — and
 * sample the colour around it so the original spot can be covered to match the page.
 *
 * `pdfRect` is the region in PDF user space (points, bottom-left origin).
 */
export interface LiftResult {
  /** PNG bytes of the cropped region (transparent where the page was transparent). */
  imageBytes: Uint8Array;
  /** Dominant colour just outside the region — used to cover the original. */
  bgColor: string;
  pixelWidth: number;
  pixelHeight: number;
}

// Cap the off-screen render so a huge page doesn't blow up memory on a phone.
const LIFT_MAX_SIDE = 2400;

type Rgb = [number, number, number];

const toHex = (c: Rgb) =>
  "#" + c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");

/** Most common colour among samples, quantised to group near-duplicates. */
function dominant(samples: Rgb[]): Rgb {
  if (samples.length === 0) return [255, 255, 255];
  const buckets = new Map<number, { sum: Rgb; n: number }>();
  for (const c of samples) {
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    const b = buckets.get(key) ?? { sum: [0, 0, 0], n: 0 };
    b.sum[0] += c[0];
    b.sum[1] += c[1];
    b.sum[2] += c[2];
    b.n += 1;
    buckets.set(key, b);
  }
  let best: { sum: Rgb; n: number } | null = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.sum[0] / best.n, best.sum[1] / best.n, best.sum[2] / best.n] : [255, 255, 255];
}

export async function liftRegion(
  page: PDFPageProxy,
  pdfRect: Rect,
  pageHeight: number,
): Promise<LiftResult> {
  const base = page.getViewport({ scale: 1 });
  const liftScale = Math.min(3, LIFT_MAX_SIDE / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale: liftScale });

  const full = document.createElement("canvas");
  full.width = Math.ceil(vp.width);
  full.height = Math.ceil(vp.height);
  const fctx = full.getContext("2d", { willReadFrequently: true });
  if (!fctx) throw new Error("no 2d context");
  await page.render({ canvas: full, viewport: vp }).promise;

  // Region top-left in viewport pixels (PDF +y is up, so the box top is y+height).
  const [sx, sy] = vp.convertToViewportPoint(pdfRect.x, pdfRect.y + pdfRect.height);
  const cropW = Math.max(1, Math.round(pdfRect.width * liftScale));
  const cropH = Math.max(1, Math.round(pdfRect.height * liftScale));
  const left = Math.round(sx);
  const top = Math.round(sy);

  // Crop the region into its own canvas -> PNG (keeps any transparency).
  const crop = document.createElement("canvas");
  crop.width = cropW;
  crop.height = cropH;
  const cctx = crop.getContext("2d");
  if (!cctx) throw new Error("no 2d context");
  cctx.drawImage(full, left, top, cropW, cropH, 0, 0, cropW, cropH);
  const blob: Blob = await new Promise((res, rej) =>
    crop.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
  );
  const imageBytes = new Uint8Array(await blob.arrayBuffer());

  // Sample a ring just OUTSIDE the region for the cover colour.
  const data = fctx.getImageData(0, 0, full.width, full.height);
  const at = (x: number, y: number): Rgb | null => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= data.width || y >= data.height) return null;
    const i = (y * data.width + x) * 4;
    if (data.data[i + 3] < 8) return null;
    return [data.data[i], data.data[i + 1], data.data[i + 2]];
  };
  const ring: Rgb[] = [];
  const pad = 4;
  for (let t = 0; t <= 1; t += 0.1) {
    const x = left + t * cropW;
    const y = top + t * cropH;
    for (const p of [at(x, top - pad), at(x, top + cropH + pad), at(left - pad, y), at(left + cropW + pad, y)]) {
      if (p) ring.push(p);
    }
  }

  return { imageBytes, bgColor: toHex(dominant(ring)), pixelWidth: cropW, pixelHeight: cropH };
}

/** A small solid-colour PNG, used to cover an original object after lifting it. */
export async function solidColorPng(hex: string): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 8, 8);
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
