// What makes the flip-through book a book: the board (cloth cover) under the pages, the paper stacks beside them and the bottom edge of the block. Shared by the
// flip-through viewer (flip.js) and by the reader's flip mode (reader.js, readerflip.js), so both look the same. The pieces are plain elements styled in app.css
// (.flip-board / .flip-stack / .flip-tail); this only says where they go. Everything is measured from the book's own box: its left page's top-left corner, two pages wide.

export const MARGIN = 7; // the board around the pages, in px

/** How thick a book of this many pages is, 0..1 (as on the card). */
export const bulkOf = (total) => Math.min(1, Math.max(0, Math.log(total / 20) / Math.log(100)));

/** How thick the paper is on each side of a spread, and the bottom edge of the block. `leftN` pages lie on the left (none: the closed book). */
export function edgesOf({ pw, total, bulk, leftN }) {
  const closed = leftN <= 0;
  const T = pw * (0.012 + 0.05 * bulk); // thickness of all the paper
  const rightN = total - Math.min(total, leftN);
  return { T, L: closed ? 0 : Math.max(2, T * Math.sqrt(Math.min(total, leftN) / total)), R: rightN <= 0 ? 0 : Math.max(2, T * Math.sqrt(rightN / total)), tail: Math.max(2, Math.round(T * 0.28)) };
}

const px = (v) => `${v}px`;

/** Puts the pieces where they belong for pages `pw` wide, with stacks `L` and `R` thick and a bottom edge `tail` high. Pass the elements as {boardL, boardR, stackL, stackR, tailL, tailR}. */
export function placeDecor(d, { pw, L, R, tail }) {
  const m = MARGIN;
  Object.assign(d.boardR.style, { top: px(-m), bottom: px(-m - tail), left: px(pw), right: px(-R - m) });
  Object.assign(d.boardL.style, { top: px(-m), bottom: px(-m - tail), left: px(-L - m), right: px(pw) });
  Object.assign(d.stackL.style, { left: px(-L), width: px(L) });
  Object.assign(d.stackR.style, { right: px(-R), width: px(R) });
  Object.assign(d.tailR.style, { left: px(pw), right: px(-R), height: px(tail), bottom: px(-tail) });
  Object.assign(d.tailL.style, { left: px(-L), right: px(pw), height: px(tail), bottom: px(-tail) });
}

/** The six pieces, in the order they are stacked (the board underneath). */
export function makeDecor() {
  const mk = (cls) => Object.assign(document.createElement('div'), { className: cls });
  const d = { boardL: mk('flip-board l'), boardR: mk('flip-board r'), tailL: mk('flip-tail l'), tailR: mk('flip-tail r'), stackL: mk('flip-stack l'), stackR: mk('flip-stack r') };
  d.all = [d.boardL, d.boardR, d.tailL, d.tailR, d.stackL, d.stackR];
  return d;
}

/** The colour of the hardcover's cloth: the book's spine colour (the average of its cover, the one the card's spine already shows), deepened so it reads as
   *  cloth. A book with no colour yet is measured from its cover here; and failing that, it gets a steady colour of its own from its name, never one shared by all. */
export function clothOf(book, { spineText, coverImg } = {}) {
  let rgb = null;
  const fromText = (t) => { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(t || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
  rgb = fromText(spineText) || fromText(book.spine);
  if (!rgb && coverImg?.complete && coverImg.naturalWidth) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(coverImg, 0, 0, 4, 4);
      const d = g.getImageData(0, 0, 4, 4).data;
      rgb = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { rgb[0] += d[i]; rgb[1] += d[i + 1]; rgb[2] += d[i + 2]; }
      rgb = rgb.map((v) => Math.round(v / 16));
    } catch { rgb = null; }
  }
  let hue;
  let sat;
  let lig;
  if (rgb) {
    const [r, g, b] = rgb.map((v) => v / 255);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    lig = (mx + mn) / 2;
    const d = mx - mn;
    sat = d === 0 ? 0 : d / (1 - Math.abs(2 * lig - 1));
    hue = d === 0 ? 0 : mx === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
    sat = sat < 0.08 ? sat : Math.min(0.7, sat * 1.12 + 0.03); // a little richer, if it has any colour at all
  } else {
    let hsh = 0;
    for (const ch of `${book.title || ''}${book.filename || book.path || ''}`) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    hue = hsh % 360;
    sat = 0.32;
    lig = 0.3;
  }
  lig = Math.min(0.4, Math.max(0.2, lig)); // cloth is never white and never black
  return `hsl(${Math.round(hue)} ${Math.round(sat * 100)}% ${Math.round(lig * 100)}%)`;
}
