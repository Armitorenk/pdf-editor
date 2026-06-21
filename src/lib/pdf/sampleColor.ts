/**
 * Sample the background colour behind a text run, the run's own ink colour, and
 * whether it is bold — all from the rendered page bitmap. This lets a text edit
 * blend in: cover the old glyphs with the *real* background (e.g. a blue panel)
 * instead of a white box, and redraw in the original colour and weight.
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
  bold: boolean;
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

/**
 * Returns the dominant background colour just outside the run, the ink colour of
 * the glyphs themselves, and a bold flag. Falls back to white/black/normal if
 * sampling fails (e.g. a blank slot or an out-of-bounds run).
 */
export function sampleRunColors(sample: PageSample, run: RunBox): RunColors {
  const { data, transform } = sample;
  const ts = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const sx = (t: number) => run.x + t * run.width;

  // Background: bands above the cap height and below the descender — almost always
  // the page/panel behind the text, never a glyph.
  const bgSamples: Rgb[] = [];
  for (const t of ts) {
    for (const dy of [1.15, 1.0, -0.45, -0.7]) {
      const p = pixelAt(data, ...toPixel(transform, sx(t), run.y + dy * run.fontSize));
      if (p) bgSamples.push(p);
    }
  }
  const bg = dominant(bgSamples) ?? [255, 255, 255];

  // Ink: sample a dense grid over the glyph's cap-height band and keep pixels that
  // differ from the background. The KEY fix vs. naive averaging: an average over all
  // ink pixels is dragged toward the background by anti-aliased edge pixels, washing
  // the colour to grey. Instead, keep the pixels FURTHEST from the background (the
  // solid glyph cores) and take their dominant colour — crisp and saturated.
  const inkSamples: Rgb[] = [];
  for (let t = 0.02; t <= 0.99; t += 0.02) {
    for (let dy = 0.1; dy <= 0.72; dy += 0.06) {
      const p = pixelAt(data, ...toPixel(transform, sx(t), run.y + dy * run.fontSize));
      if (p && dist2(p, bg) > INK_THRESHOLD2) inkSamples.push(p);
    }
  }
  let text: Rgb;
  if (inkSamples.length > 0) {
    inkSamples.sort((a, b) => dist2(b, bg) - dist2(a, bg));
    const core = inkSamples.slice(0, Math.max(1, Math.ceil(inkSamples.length * 0.45)));
    text = dominant(core) ?? core[0];
  } else {
    // No ink found: pick black or white for contrast with the background.
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    text = lum > 140 ? [0, 0, 0] : [255, 255, 255];
  }

  return { bg: toHex(bg), text: toHex(text), bold: detectBold(data, transform, run, bg) };
}

/**
 * Estimate boldness from stroke thickness (scale-invariant). Walk several
 * horizontal scanlines across the x-height band and measure runs of consecutive
 * ink pixels; the median run length approximates the stem width. Dividing by the
 * font size gives a relative stem width that's larger for bold faces.
 */
function detectBold(data: ImageData, transform: number[], run: RunBox, bg: Rgb): boolean {
  const scaleX = Math.hypot(transform[0], transform[1]); // device px per point along x
  if (!(scaleX > 0) || run.width <= 0) return false;
  const steps = Math.max(12, Math.round(run.width * scaleX));
  const runs: number[] = [];
  for (let dy = 0.2; dy <= 0.62; dy += 0.06) {
    const py = run.y + dy * run.fontSize;
    let len = 0;
    for (let s = 0; s <= steps; s++) {
      const px = run.x + (s / steps) * run.width;
      const p = pixelAt(data, ...toPixel(transform, px, py));
      if (p && dist2(p, bg) > INK_THRESHOLD2) {
        len++;
      } else {
        if (len > 0) runs.push(len);
        len = 0;
      }
    }
    if (len > 0) runs.push(len);
  }
  if (runs.length < 4) return false;
  runs.sort((a, b) => a - b);
  const medianPx = runs[Math.floor(runs.length / 2)];
  const stemPts = medianPx / scaleX;
  // Regular stems ≈ 0.05–0.08 × font size; bold ≈ 0.10+. Threshold conservatively
  // so body text is never wrongly bolded.
  return stemPts / run.fontSize > 0.092;
}
