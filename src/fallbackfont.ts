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
// Family by family, the file names of its four faces, best choice first. All of them cover Latin Extended Additional.
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

async function findFace(kind: Kind, style: Style): Promise<Buffer | null> {
  for (const fam of FAMILIES[kind]) {
    for (const root of DIRS) {
      for (const d of fam.dirs) {
        const b = await readFont(`${root}/${d ? d + '/' : ''}${fam.names[style]}`);
        if (b) return b;
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
