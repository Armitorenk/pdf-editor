// Generates the source images @capacitor/assets needs (icon + splash), from one
// SVG logo mark so the brand stays consistent. Run: `node scripts/gen-assets.mjs`.
// Requires `sharp` (already present as a Next.js dependency).
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");

const BLUE = "#2563eb";
const BLUE_DARK = "#1d4ed8";
const DARK_BG = "#0f172a";

// The logo mark, designed in a 1024x1024 box (white page + amber pencil).
const GLYPH = `
  <path fill="#ffffff" d="M 352 232 L 584 232 L 704 352 L 704 760 Q 704 792 672 792 L 352 792 Q 320 792 320 760 L 320 264 Q 320 232 352 232 Z"/>
  <path fill="#cbd5e1" d="M 584 232 L 584 352 L 704 352 Z"/>
  <rect x="360" y="430" width="206" height="28" rx="14" fill="#93c5fd"/>
  <rect x="360" y="490" width="284" height="28" rx="14" fill="#bfdbfe"/>
  <rect x="360" y="550" width="240" height="28" rx="14" fill="#bfdbfe"/>
  <g transform="rotate(45 560 612)">
    <rect x="528" y="468" width="64" height="40" rx="14" fill="#f43f5e"/>
    <rect x="528" y="504" width="64" height="20" fill="#e2e8f0"/>
    <rect x="528" y="520" width="64" height="180" fill="#f59e0b"/>
    <path fill="#fcd34d" d="M 528 700 L 592 700 L 560 760 Z"/>
    <path fill="#1f2937" d="M 548 730 L 572 730 L 560 760 Z"/>
  </g>`;

const shadow = `
  <defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#0b1f4d" flood-opacity="0.30"/>
  </filter></defs>`;

/** Place the 1024-box glyph, scaled by `s` and centred, inside a `size` canvas. */
function placeGlyph(size, s, shadowed = true) {
  const scaled = s * (size / 1024);
  const offset = (size - 1024 * scaled) / 2;
  return `<g transform="translate(${offset} ${offset}) scale(${scaled})" ${
    shadowed ? 'filter="url(#ds)"' : ""
  }>${GLYPH}</g>`;
}

function blueBg(size, rx) {
  return `
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${BLUE_DARK}"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" ${rx ? `rx="${rx}"` : ""} fill="url(#bg)"/>`;
}

const svg = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${shadow}${inner}</svg>`;

// Full legacy/icon-only: blue square + large glyph.
const iconOnly = svg(1024, blueBg(1024, 180) + placeGlyph(1024, 0.78));
// Adaptive foreground: glyph only, inside the ~62% safe zone, transparent bg.
const iconFg = svg(1024, placeGlyph(1024, 0.62));
// Adaptive background: flat blue, full bleed.
const iconBg = svg(1024, blueBg(1024, 0));

function splash(size, bg, nameColor) {
  const name = `
    <text x="${size / 2}" y="${size / 2 + 360}" text-anchor="middle"
      font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="120"
      font-weight="700" fill="${nameColor}" letter-spacing="2">PDF Editor</text>`;
  return svg(size, bg + placeGlyph(size, 0.34) + name);
}
const splashLight = splash(2732, blueBg(2732, 0), "#ffffff");
const splashDark = splash(
  2732,
  `<rect width="2732" height="2732" fill="${DARK_BG}"/>`,
  "#e2e8f0",
);

async function png(svgStr, name, size) {
  await sharp(Buffer.from(svgStr)).resize(size, size).png().toFile(join(outDir, name));
  console.log("wrote", name);
}

await mkdir(outDir, { recursive: true });
await png(iconOnly, "icon-only.png", 1024);
await png(iconFg, "icon-foreground.png", 1024);
await png(iconBg, "icon-background.png", 1024);
await png(splashLight, "splash.png", 2732);
await png(splashDark, "splash-dark.png", 2732);
// A small preview strip so the design can be eyeballed quickly.
await png(iconOnly, "_preview-icon.png", 256);
console.log("done");
