/**
 * Text Style Detection Engine — reads the PDF's OWN font metadata instead of
 * guessing from rendered pixels. For every `FontDescriptor` in the document it
 * derives bold / italic / serif from the authoritative sources defined by the PDF
 * spec, so a heading reads bold and an emphasised word reads italic regardless of
 * how the renderer drew it.
 *
 * Signals (per the PDF spec, §9.8.1 Font Descriptors):
 *  - FontName          — subset-prefixed PostScript name; "...-Bold"/"...Italic" etc.
 *  - Flags (integer)   — bit 2 Serif, bit 7 Italic, bit 19 ForceBold.
 *  - ItalicAngle       — non-zero (usually negative) ⇒ italic/oblique.
 *  - StemV / FontWeight— thick stems / weight ≥ 600 ⇒ bold.
 *
 * Faux styles (stroke-bold via the `Tr` operator, skew-italic via the `Tm` matrix)
 * are detected separately at the run level — see `runIsSkewed` and the live layer.
 */
import { PDFDict, PDFName, PDFNumber, type PDFDocument } from "pdf-lib";

export interface FontStyleInfo {
  psName: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  italicAngle: number;
  stemV: number | null;
  weight: number | null;
  flags: number | null;
}

// PDF FontDescriptor Flags (1-based bit numbers in the spec → 0-based shifts here).
const FLAG_SERIF = 1 << 1; // bit 2
const FLAG_ITALIC = 1 << 6; // bit 7
const FLAG_FORCE_BOLD = 1 << 18; // bit 19

const NAME_BOLD = /bold|black|heavy|semibold|demibold|extrabold|\bbd\b|cmbx/i;
const NAME_ITALIC = /italic|oblique|cmmi|cmti/i;

const stripSubset = (n: string) => n.replace(/^[A-Z]{6}\+/, "");

function numOf(v: unknown): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** Derive a {@link FontStyleInfo} from one FontDescriptor dictionary. */
function fromDescriptor(psName: string, desc: PDFDict): FontStyleInfo {
  const flags = numOf(desc.get(PDFName.of("Flags")));
  const italicAngle = numOf(desc.get(PDFName.of("ItalicAngle"))) ?? 0;
  const stemV = numOf(desc.get(PDFName.of("StemV")));
  const weight = numOf(desc.get(PDFName.of("FontWeight")));
  const f = flags ?? 0;

  const bold =
    NAME_BOLD.test(psName) ||
    (f & FLAG_FORCE_BOLD) !== 0 ||
    (weight != null && weight >= 600) ||
    (stemV != null && stemV >= 120);
  const italic =
    NAME_ITALIC.test(psName) ||
    (f & FLAG_ITALIC) !== 0 ||
    Math.abs(italicAngle) > 1;
  const serif = (f & FLAG_SERIF) !== 0;

  return { psName, bold, italic, serif, italicAngle, stemV, weight, flags };
}

/**
 * Parse every FontDescriptor in the document into a lookup keyed by PostScript
 * name — both the subset-prefixed name (e.g. `ABCDEF+Myriad-Bold`) and the bare
 * name (`Myriad-Bold`), so a run can be matched however its name is reported.
 */
export function buildFontStyleMap(doc: PDFDocument): Map<string, FontStyleInfo> {
  const map = new Map<string, FontStyleInfo>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Type"))?.toString() !== "/FontDescriptor") continue;
    const nameObj = obj.get(PDFName.of("FontName"));
    if (!nameObj) continue;
    const psName = nameObj.toString().replace(/^\//, "");
    const info = fromDescriptor(psName, obj);
    map.set(psName, info);
    map.set(stripSubset(psName), info);
  }
  return map;
}

/** Look up a run's style by its (possibly subset-prefixed) PostScript name. */
export function lookupFontStyle(
  map: Map<string, FontStyleInfo> | null,
  psName: string | null | undefined,
): FontStyleInfo | null {
  if (!map || !psName) return null;
  return map.get(psName) ?? map.get(stripSubset(psName)) ?? null;
}

/**
 * Faux-italic test from a run's text matrix `[a,b,c,d,e,f]`: a non-trivial shear
 * (c/d) with no rotation (b≈0) means upright glyphs were slanted by the content
 * stream — visually italic even when the font itself isn't.
 */
export function runIsSkewed(transform: number[]): boolean {
  const [a, b, c, d] = transform;
  if (Math.abs(b) > 0.01 * Math.abs(a || 1)) return false; // rotated, not a shear
  const denom = Math.abs(d) || Math.abs(a) || 1;
  return Math.abs(c) / denom > 0.2;
}
