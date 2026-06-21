// Generates the source images @capacitor/assets needs (icon + splash) from one
// logo design so the brand stays consistent: a red PDF "page" — folded top-right
// corner, bold white "PDF", and a small white edit-pencil. Run: `node scripts/gen-assets.mjs`.
// Requires `sharp` (already a Next.js dependency).
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");

const RED = "#d83a32";
const RED_DARK = "#c22f28";
const FOLD = "#f4bcb5"; // lighter underside of the folded corner
const RED_NIGHT = "#7f1d1d";
const RED_NIGHT_DARK = "#5f1414";

const pencil = (tx, ty, s) =>
  `<g transform="translate(${tx} ${ty}) scale(${s})" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5 19 9"/></g>`;

// Full-bleed mark in a 1024 box: folded corner + big PDF + pencil bottom-right.
const markFull = `
  <path fill="${FOLD}" d="M812 70 L954 212 L812 212 Z"/>
  <text x="512" y="620" text-anchor="middle" font-family="Arial, 'Segoe UI', sans-serif" font-size="300" font-weight="800" fill="#ffffff" letter-spacing="2">PDF</text>
  ${pencil(648, 648, 9.2)}`;

// Centred emblem (no corner) for the adaptive foreground + splash, sized to stay
// inside the adaptive safe zone / round masks.
const markCentered = `
  <text x="512" y="525" text-anchor="middle" font-family="Arial, 'Segoe UI', sans-serif" font-size="235" font-weight="800" fill="#ffffff" letter-spacing="2">PDF</text>
  ${pencil(452, 580, 6.6)}`;

const redBg = (size, rx, c0 = RED, c1 = RED_DARK) => `
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/>
  </linearGradient></defs>
  <rect width="${size}" height="${size}" ${rx ? `rx="${rx}"` : ""} fill="url(#bg)"/>`;

const svg = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${inner}</svg>`;

const iconOnly = svg(1024, redBg(1024, 180) + markFull);
const iconFg = svg(1024, markCentered); // transparent background
const iconBg = svg(1024, redBg(1024, 0));

function splash(size, c0, c1, nameColor) {
  const s = 1.4; // scale the 1024 emblem onto the splash canvas
  const off = (size - 1024 * s) / 2;
  const emblem = `<g transform="translate(${off} ${off - size * 0.06}) scale(${s})">${markCentered}</g>`;
  const name = `<text x="${size / 2}" y="${size / 2 + size * 0.18}" text-anchor="middle"
    font-family="Segoe UI, Roboto, Arial, sans-serif" font-size="120" font-weight="700"
    fill="${nameColor}" letter-spacing="2">PDF Editor</text>`;
  return svg(size, redBg(size, 0, c0, c1) + emblem + name);
}
const splashLight = splash(2732, RED, RED_DARK, "#ffffff");
const splashDark = splash(2732, RED_NIGHT, RED_NIGHT_DARK, "#fee2e2");

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
console.log("done");
