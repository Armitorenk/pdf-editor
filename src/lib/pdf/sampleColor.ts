/**
 * Sample the background colour behind a text run, the run's own ink colour, and a
 * relative stroke-thickness measure — all from the rendered page bitmap. This lets a
 * text edit blend in: cover the old glyphs with the *real* background (e.g. a blue
 * panel) instead of a white box, redraw in the original colour, and match weight.
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

// A pixel counts as "ink" when it differs from the background by more than this.
const INK_THRESHOLD2 = 52 * 52;

/** Dominant colour of the bands just above/below the run — the local background. */
function localBg(data: ImageData, transform: number[], run: RunBox): Rgb {
  const ts = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const s: Rgb[] = [];
  for (const t of ts) {
    for (const dy of [1.15, 1.0, -0.45, -0.7]) {
      const p = pixelAt(data, ...toPixel(transform, run.x + t * run.width, run.y + dy * run.fontSize));
      if (p) s.push(p);
    }
  }
  return dominant(s) ?? [255, 255, 255];
}

/**
 * Returns the dominant background colour just outside the run and the ink colour of
 * the glyphs themselves. The ink colour comes from the glyph CORES (pixels furthest
 * from the background), not an average — an average is dragged toward the background
 * by anti-aliased edges and comes out a washed-out grey.
 */
export function sampleRunColors(sample: PageSample, run: RunBox): RunColors {
  const { data, transform } = sample;
  const bg = localBg(data, transform, run);

  const inkSamples: Rgb[] = [];
  for (let t = 0.02; t <= 0.99; t += 0.02) {
    for (let dy = 0.1; dy <= 0.72; dy += 0.06) {
      const p = pixelAt(data, ...toPixel(transform, run.x + t * run.width, run.y + dy * run.fontSize));
      if (p && dist2(p, bg) > INK_THRESHOLD2) inkSamples.push(p);
    }
  }
  let text: Rgb;
  if (inkSamples.length > 0) {
    inkSamples.sort((a, b) => dist2(b, bg) - dist2(a, bg));
    const core = inkSamples.slice(0, Math.max(1, Math.ceil(inkSamples.length * 0.45)));
    text = dominant(core) ?? core[0];
  } else {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    text = lum > 140 ? [0, 0, 0] : [255, 255, 255];
  }
  return { bg: toHex(bg), text: toHex(text) };
}

/**
 * Relative stroke thickness of a run: the median ink run-length along scanlines
 * across the x-height band, divided by the font size (scale-independent). Used for
 * RELATIVE bold detection — a run is bold when this is clearly above the page's body
 * baseline (see `isBold`). Absolute thresholds don't work because a regular sans
 * stem (~0.09 em) is close to where light bolds start; comparing to the page's own
 * body text is what reliably separates a bold heading from regular body text.
 */
export function runRelStem(sample: PageSample, run: RunBox): number | null {
  const { data, transform } = sample;
  const scaleX = Math.hypot(transform[0], transform[1]); // device px per point along x
  if (!(scaleX > 0) || run.width <= 0) return null;
  const bg = localBg(data, transform, run);
  // ~1.5 samples per device pixel so thin stems are resolved; capped for long runs.
  const steps = Math.max(24, Math.min(500, Math.round(run.width * scaleX * 1.5)));
  const runs: number[] = [];
  for (let dy = 0.2; dy <= 0.62; dy += 0.06) {
    const py = run.y + dy * run.fontSize;
    let len = 0;
    for (let s = 0; s <= steps; s++) {
      const px = run.x + (s / steps) * run.width;
      const p = pixelAt(data, ...toPixel(transform, px, py));
      if (p && dist2(p, bg) > INK_THRESHOLD2) len++;
      else {
        if (len > 0) runs.push(len);
        len = 0;
      }
    }
    if (len > 0) runs.push(len);
  }
  if (runs.length < 4) return null;
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  const stemPts = (median * run.width) / steps; // steps span run.width points
  return stemPts / run.fontSize;
}

/**
 * Decide whether a run is bold, given its own relative stem and the page's body
 * baseline (the median relative stem across the page's runs). Bold headings measure
 * ~1.6–2× the body weight, so a 1.5× margin catches them while leaving plenty of
 * room above the body's own variance (so regular text is never wrongly bolded).
 * Falls back to a conservative absolute threshold when there's no page baseline
 * (e.g. a one-run page).
 */
export function isBold(relStem: number | null, pageBaseline: number | null): boolean {
  if (relStem == null) return false;
  if (pageBaseline && pageBaseline > 0) return relStem > pageBaseline * 1.5;
  return relStem > 0.13;
}

/** Median of a numeric list, or null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
