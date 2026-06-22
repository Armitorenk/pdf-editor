// Builds Google Play store graphics from the brand logo (assets/source/logo.png):
//   - store/feature-graphic.png  (1024×500, required by Play)
//   - store/icon-512.png         (512×512 store icon)
// Run: `node scripts/gen-store-assets.mjs`. Requires `sharp` (already a dependency).
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO = join(root, "assets", "source", "logo.png");
const outDir = join(root, "store");
await mkdir(outDir, { recursive: true });

const RED = "#d83a32";
const RED_DARK = "#b8281f";

const logoAt = (size) =>
  sharp(LOGO).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

// ---- Feature graphic (1024×500) -----------------------------------------------------------
const W = 1024;
const H = 500;
const featBg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${RED}"/><stop offset="1" stop-color="${RED_DARK}"/>
    </linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
  </svg>`,
);
const featText = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <style>
      .t { font-family: 'Segoe UI', Arial, sans-serif; fill: #ffffff; }
    </style>
    <text class="t" x="392" y="210" font-size="62" font-weight="800">PDF Text Editor</text>
    <text class="t" x="392" y="284" font-size="62" font-weight="800">&amp; Converter</text>
    <text class="t" x="394" y="346" font-size="28" font-weight="500" fill="#ffe2de">Edit text, images &amp; objects · Convert · 100% offline</text>
  </svg>`,
);
const featLogo = await logoAt(300);

await sharp(featBg)
  .composite([
    { input: featLogo, left: 56, top: Math.round((H - 300) / 2) },
    { input: featText, left: 0, top: 0 },
  ])
  .png()
  .toFile(join(outDir, "feature-graphic.png"));

// ---- Store icon (512×512): logo on the brand gradient ----------------------------------------
const S = 512;
const iconBg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${RED}"/><stop offset="1" stop-color="${RED_DARK}"/>
    </linearGradient></defs>
    <rect width="${S}" height="${S}" fill="url(#g)"/>
  </svg>`,
);
const iconLogo = await logoAt(Math.round(S * 0.7));
await sharp(iconBg)
  .composite([{ input: iconLogo, gravity: "center" }])
  .flatten({ background: RED })
  .png()
  .toFile(join(outDir, "icon-512.png"));

console.log("Wrote store/feature-graphic.png (1024×500) and store/icon-512.png (512×512)");
