import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The font that stands in for mupdf's built-in one when a book's text has letters the built-in one lacks (the dotted and
 * dashed letters of transliterated Sanskrit, Pali, Vietnamese...). A font already on this computer is used when there is a good one (Liberation, Noto, FreeSerif, DejaVu);
 * otherwise the one that comes with Shelf (fonts/, DejaVu Serif cut down to Latin, Greek and Cyrillic: see the licence there), so it never depends on what is installed.
 * Nothing is downloaded. mupdf can't fall back to a font by itself the way a browser does, which is why the viewer needs this and the reader doesn't.
 */
const BUNDLED = fileURLToPath(new URL('../fonts/', import.meta.url));

type Kind = 'serif' | 'sans';
type Style = 'r' | 'b' | 'i' | 'bi';

const DIRS = ['/usr/share/fonts/truetype', '/usr/share/fonts/opentype', '/usr/share/fonts', '/usr/local/share/fonts', '/usr/share/fonts/TTF', '/Library/Fonts', '/System/Library/Fonts/Supplemental'];
// Family by family, the file names of its four faces, best choice first. A face is used only if it has every transliteration letter (coversNeeded): older versions of some of these families lack them.
const FAMILIES: Record<Kind, Array<{ dirs: string[]; names: Record<Style, string> }>> = {
  serif: [
    { dirs: ['liberation', 'liberation2', 'liberation-fonts', 'liberation/liberation-serif'], names: { r: 'LiberationSerif-Regular.ttf', b: 'LiberationSerif-Bold.ttf', i: 'LiberationSerif-Italic.ttf', bi: 'LiberationSerif-BoldItalic.ttf' } },
    { dirs: ['noto', 'noto-serif', 'google-noto'], names: { r: 'NotoSerif-Regular.ttf', b: 'NotoSerif-Bold.ttf', i: 'NotoSerif-Italic.ttf', bi: 'NotoSerif-BoldItalic.ttf' } },
    { dirs: ['freefont', 'gnu-free'], names: { r: 'FreeSerif.ttf', b: 'FreeSerifBold.ttf', i: 'FreeSerifItalic.ttf', bi: 'FreeSerifBoldItalic.ttf' } },
    { dirs: ['dejavu', 'dejavu-sans-fonts', 'dejavu-serif-fonts', ''], names: { r: 'DejaVuSerif.ttf', b: 'DejaVuSerif-Bold.ttf', i: 'DejaVuSerif-Italic.ttf', bi: 'DejaVuSerif-BoldItalic.ttf' } },
  ],
  sans: [
    { dirs: ['liberation', 'liberation2', 'liberation-fonts', 'liberation/liberation-sans'], names: { r: 'LiberationSans-Regular.ttf', b: 'LiberationSans-Bold.ttf', i: 'LiberationSans-Italic.ttf', bi: 'LiberationSans-BoldItalic.ttf' } },
    { dirs: ['noto', 'noto-sans', 'google-noto'], names: { r: 'NotoSans-Regular.ttf', b: 'NotoSans-Bold.ttf', i: 'NotoSans-Italic.ttf', bi: 'NotoSans-BoldItalic.ttf' } },
    { dirs: ['dejavu', 'dejavu-sans-fonts', ''], names: { r: 'DejaVuSans.ttf', b: 'DejaVuSans-Bold.ttf', i: 'DejaVuSans-Oblique.ttf', bi: 'DejaVuSans-BoldOblique.ttf' } },
  ],
};

const BUNDLED_NAMES: Record<Style, string> = { r: 'DejaVuSerif.ttf', b: 'DejaVuSerif-Bold.ttf', i: 'DejaVuSerif-Italic.ttf', bi: 'DejaVuSerif-BoldItalic.ttf' };
const faces = new Map<string, Buffer>();
let loading: Promise<void> | null = null;

async function readFont(file: string): Promise<Buffer | null> {
  try {
    const b = await fs.readFile(file);
    return b.length > 0 && b.length < 20 * 1024 * 1024 ? b : null;
  } catch {
    return null;
  }
}

// The letters a stand-in must have: those of transliterated Sanskrit and Pali (macron, dot below, dot above, acute, tilde) and the combining marks that make them.
const NEEDED = [0x101, 0x12b, 0x16b, 0x15a, 0x15b, 0xf1, 0x1e0d, 0x1e25, 0x1e37, 0x1e39, 0x1e41, 0x1e43, 0x1e45, 0x1e47, 0x1e5b, 0x1e5d, 0x1e63, 0x1e6d, 0x1e6f, 0x301, 0x304, 0x307, 0x323];

/** Whether a TrueType font has a glyph for every one of those letters (read from its cmap: formats 4 and 12). A font that lacks some would show them as boxes. */
export function coversNeeded(font: Buffer): boolean {
  try {
    if (font.length < 12) return false;
    const n = font.readUInt16BE(4);
    let cmap = -1;
    for (let i = 0; i < n; i++) if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === 'cmap') cmap = font.readUInt32BE(20 + i * 16);
    if (cmap < 0) return false;
    const subs = font.readUInt16BE(cmap + 2);
    const has = new Set<number>();
    for (let i = 0; i < subs; i++) {
      const plat = font.readUInt16BE(cmap + 4 + i * 8);
      const off = cmap + font.readUInt32BE(cmap + 8 + i * 8);
      const fmt = font.readUInt16BE(off);
      if (fmt === 4 && (plat === 3 || plat === 0)) {
        const segX2 = font.readUInt16BE(off + 6);
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let sI = 0; sI < segX2 / 2; sI++) {
          const end = font.readUInt16BE(ends + sI * 2), start = font.readUInt16BE(starts + sI * 2), ro = font.readUInt16BE(ranges + sI * 2), delta = font.readInt16BE(deltas + sI * 2);
          for (const c of NEEDED) {
            if (c < start || c > end) continue;
            let g: number;
            if (ro === 0) g = (c + delta) & 0xffff;
            else { const at = ranges + sI * 2 + ro + (c - start) * 2; g = at + 2 <= font.length ? font.readUInt16BE(at) : 0; if (g) g = (g + delta) & 0xffff; }
            if (g) has.add(c);
          }
        }
      } else if (fmt === 12) {
        const groups = font.readUInt32BE(off + 12);
        for (let g = 0; g < groups; g++) {
          const start = font.readUInt32BE(off + 16 + g * 12), end = font.readUInt32BE(off + 20 + g * 12), gid = font.readUInt32BE(off + 24 + g * 12);
          for (const c of NEEDED) if (c >= start && c <= end && gid + (c - start) > 0) has.add(c);
        }
      }
    }
    return NEEDED.every((c) => has.has(c));
  } catch {
    return false;
  }
}

async function findFace(kind: Kind, style: Style): Promise<Buffer | null> {
  for (const fam of FAMILIES[kind]) {
    for (const root of DIRS) {
      for (const d of fam.dirs) {
        const b = await readFont(`${root}/${d ? d + '/' : ''}${fam.names[style]}`);
        if (b && coversNeeded(b)) return b; // a font on this computer that lacks some of the letters would draw them as boxes: not that one
      }
    }
  }
  // the one that comes with Shelf (serif only: a sans-serif request gets it too)
  return readFont(`${BUNDLED}${BUNDLED_NAMES[style]}`);
}

/** Looks for the fonts once (it is quick, but it is disk). Call before laying out a book that needs them. */
export function loadFallbackFonts(): Promise<void> {
  loading ??= (async () => {
    for (const kind of ['serif', 'sans'] as const) {
      const regular = await findFace(kind, 'r');
      if (!regular) continue;
      faces.set(`${kind}:r`, regular);
      for (const style of ['b', 'i', 'bi'] as const) faces.set(`${kind}:${style}`, (await findFace(kind, style)) ?? regular);
    }
  })();
  return loading;
}

/** The font file for a family name the book's CSS asked for, or null (a monospace family keeps the built-in one, and so does everything when nothing was found). */
export function fallbackFontFile(family: string, bold: boolean, italic: boolean): { key: string; data: Buffer } | null {
  if (/mono|courier|consol|typewriter/i.test(family)) return null;
  const kind: Kind = /sans|helvet|arial|verdana|tahoma/i.test(family) && !/serif\b/i.test(family.replace(/sans-?serif/i, '')) ? 'sans' : 'serif';
  const style: Style = bold ? (italic ? 'bi' : 'b') : italic ? 'i' : 'r';
  const key = `${kind}:${style}`;
  const data = faces.get(key) ?? faces.get(`${kind}:r`) ?? faces.get('serif:r');
  return data ? { key: faces.has(key) ? key : `${kind}:r`, data } : null;
}

/** The four faces of the stand-in serif (regular, bold, italic, bold italic) to put inside a book, or null when none could be found. */
export async function fallbackFaces(): Promise<Record<Style, Buffer> | null> {
  await loadFallbackFonts();
  const r = faces.get('serif:r');
  if (!r) return null;
  return { r, b: faces.get('serif:b') ?? r, i: faces.get('serif:i') ?? r, bi: faces.get('serif:bi') ?? r };
}
