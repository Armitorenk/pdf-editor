// Builds the @capacitor/assets source images (icon + splash) from the chosen logo
// PNG at `assets/source/logo.png` — the red "PDF" page mark the user selected.
// Run: `node scripts/gen-assets.mjs` then `npx @capacitor/assets generate --android`.
// Requires `sharp` (already a Next.js dependency).
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");
const LOGO = join(outDir, "source", "logo.png"); // chosen design: square, transparent corners

const RED = "#d83a32";
const RED_DARK = "#c22f28";
const RED_NIGHT = "#7f1d1d";
const RED_NIGHT_DARK = "#5f1414";

// A brand-red diagonal gradient fill of `size`² — matches the logo's own body, so
// the logo blends seamlessly when composited onto it.
const gradient = (size, c0 = RED, c1 = RED_DARK) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/>
      </linearGradient></defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>`,
  );

// The logo re-rendered onto a transparent square of `size` (source is 512²).
const logoAt = (size) =>
  sharp(LOGO)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

await mkdir(outDir, { recursive: true });
const logo1024 = await logoAt(1024);

// Legacy square icon: the logo flattened on the brand red (opaque corners).
await sharp(gradient(1024)).composite([{ input: logo1024 }]).png().toFile(join(outDir, "icon-only.png"));
console.log("wrote icon-only.png");

// Adaptive icon: full-bleed logo as the foreground, brand red as the (masked) background.
await sharp(logo1024).toFile(join(outDir, "icon-foreground.png"));
console.log("wrote icon-foreground.png");
await sharp(gradient(1024)).png().toFile(join(outDir, "icon-background.png"));
console.log("wrote icon-background.png");

// Splash: the emblem centred small on the brand red + the app name. The logo's own
// red body blends into the matching background, so the white "PDF" mark stands out.
async function splash(name, c0, c1, nameColor) {
  const SIZE = 2732;
  const EMB = Math.round(SIZE * 0.26);
  const emblem = await sharp(LOGO)
    .resize(EMB, EMB, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pos = Math.round((SIZE - EMB) / 2);
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
      <text x="${SIZE / 2}" y="${SIZE / 2 + SIZE * 0.2}" text-anchor="middle"
        font-family="Segoe UI, Roboto, Arial, sans-serif" font-size="120" font-weight="700"
        fill="${nameColor}" letter-spacing="2">PDF Editor</text>
    </svg>`,
  );
  await sharp(gradient(SIZE, c0, c1))
    .composite([{ input: emblem, left: pos, top: pos - Math.round(SIZE * 0.05) }, { input: label }])
    .png()
    .toFile(join(outDir, name));
  console.log("wrote", name);
}
await splash("splash.png", RED, RED_DARK, "#ffffff");
await splash("splash-dark.png", RED_NIGHT, RED_NIGHT_DARK, "#fee2e2");
console.log("done");
