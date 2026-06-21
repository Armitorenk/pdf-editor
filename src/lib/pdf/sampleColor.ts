/**
 * Sample the background colour behind a text run and the run's own text colour
 * from the rendered page bitmap. This lets a text edit blend in — covering the old
 * glyphs with the *real* background (e.g. a blue panel) instead of a white box, and
 * redrawing in the original ink colour instead of plain black.
 *
 * Coordinates: `run` is in PDF user space (points, bottom-left origin). `transform`
 * is the pdf.js viewport transform that maps PDF user space to the bitmap's device
 * pixels (top-left origin, y-down) — i.e. `getViewport({ scale }).transform`.
 */
export interface PageSample {
  data: ImageData;
  transform: number[]; // [a,b,c,d,e,f]
}

export interface RunBox {
  x: number; // baseline-left, points
  y: number; // baseline y, points (from page bottom)
  width: number; // points
  fontSize: number; // points
}

export interface RunColors {
  bg: string; // "#rrggbb"
  text: string; // "#rrggbb"
}

type Rgb = [number, number, number];

/** Map a PDF-space point to an integer device pixel on the sample bitmap. */
function toPixel(t: number[], px: number, py: number): [number, number] {
  return [Math.round(t[0] * px + t[2] * py + t[4]), Math.round(t[1] * px + t[3] * py + t[5])];
}

/** Read one pixel; returns null when out of bounds or transparent. */
function pixelAt(img: ImageData, x: number, y: number): Rgb | null {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  if (img.data[i + 3] < 8) return null; // effectively transparent
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

const dist2 = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const toHex = (c: Rgb) => "#" + c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");

/** Most common colour among samples, quantised to 16 levels/channel to group near-duplicates. */
function dominant(samples: Rgb[]): Rgb | null {
  if (samples.length === 0) return null;
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
  return best ? [best.sum[0] / best.n, best.sum[1] / best.n, best.sum[2] / best.n] : null;
}

/**
 * Returns the dominant background colour just outside the run, and the ink colour
 * of the glyphs themselves. Falls back to white/black if sampling fails (e.g. a
 * blank slot or an out-of-bounds run).
 */
export function sampleRunColors(sample: PageSample, run: RunBox): RunColors {
  const { data, transform } = sample;
  const ts = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const sx = (t: number) => run.x + t * run.width;

  // Background: a band above the cap height and below the descender — almost always
  // the page/panel behind the text, never a glyph.
  const bgSamples: Rgb[] = [];
  for (const t of ts) {
    for (const dy of [1.05, -0.5]) {
      const p = pixelAt(data, ...toPixel(transform, sx(t), run.y + dy * run.fontSize));
      if (p) bgSamples.push(p);
    }
  }
  const bg = dominant(bgSamples) ?? [255, 255, 255];

  // Text: sample across the glyph band; keep pixels that differ clearly from the
  // background (the actual ink). Average them for a stable colour.
  const inkSamples: Rgb[] = [];
  for (let t = 0.04; t <= 0.96; t += 0.06) {
    for (const dy of [0.25, 0.45]) {
      const p = pixelAt(data, ...toPixel(transform, sx(t), run.y + dy * run.fontSize));
      if (p && dist2(p, bg) > 60 * 60) inkSamples.push(p);
    }
  }
  let text: Rgb;
  if (inkSamples.length > 0) {
    text = inkSamples.reduce<Rgb>((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]).map((s) => s / inkSamples.length) as Rgb;
  } else {
    // No ink found near the background colour: pick black or white for contrast.
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    text = lum > 140 ? [0, 0, 0] : [255, 255, 255];
  }

  return { bg: toHex(bg), text: toHex(text) };
}
