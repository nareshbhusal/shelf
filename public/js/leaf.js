import { settings } from './settings.js';

// The page-turn itself, shared by the flip-through viewer (flip.js) and the reader's flip mode. A leaf is two plain pages, one per side, hinged at the spine:
// the page being left swings from flat to edge-on, and from there the page arriving swings from edge-on to flat on the other side. Only one of them is ever
// on show, so nothing depends on how a browser hides "the far side" of a 3D plane or on animating visibility, which engines treat differently.

export const bez = (x1, y1, x2, y2) => {
  const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
  return (x) => {
    let t = x;
    for (let k = 0; k < 8; k++) { // Newton's method on the curve's x
      const e = ((ax * t + bx) * t + cx) * t - x;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(e) < 1e-5 || !d) break;
      t -= e / d;
    }
    t = Math.min(1, Math.max(0, t));
    return ((ay * t + by) * t + cy) * t;
  };
};
export const easeTurn = bez(0.45, 0.05, 0.25, 1); // the same curve as the rest of the book's movement
export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A duration, made shorter or longer by the speed setting (100% is as designed). */
export const turnMs = (ms) => Math.round(ms * 100 / Math.min(250, Math.max(40, Number(settings.flipSpeed) || 100)));

/** Puts a leaf `at` of the way round (0 lies on the right, 1 on the left). `f` is the page on the right-hand side at the start, `b` the one on the left at the
 *  end. Sets --shade on each (a page darkens as it turns away from the light) and returns how far round it is, in degrees, for whoever wants to cast a shadow. */
export function swing(f, b, forward, at) {
  const turned = (forward ? at : 1 - at) * 180;
  const first = turned < 90;
  f.style.display = first ? '' : 'none';
  b.style.display = first ? 'none' : '';
  f.style.transform = `rotateY(${-turned}deg)`;
  b.style.transform = `rotateY(${180 - turned}deg)`;
  f.style.setProperty('--shade', String(Math.min(1, turned / 90) * 0.2));
  b.style.setProperty('--shade', String(Math.min(1, (180 - turned) / 90) * 0.2));
  return turned;
}

/** Runs one turn: calls draw(at) every frame with the eased progress, 0 to 1, and resolves after the last one. A hidden tab pauses frames; the turn still finishes. */
export function sweep(ms, draw) {
  if (reduceMotion()) { draw(1); return Promise.resolve(); }
  return new Promise((done) => {
    const t0 = performance.now();
    let ended = false;
    const end = () => { if (!ended) { ended = true; draw(1); done(); } };
    const frame = (now) => {
      if (ended) return;
      const p = Math.min(1, (now - t0) / ms);
      draw(easeTurn(p));
      if (p < 1) requestAnimationFrame(frame);
      else end();
    };
    requestAnimationFrame(frame);
    setTimeout(end, ms + 150);
  });
}

/** How hard the crease and the page it lands on are shaded: nothing at rest, most when the leaf stands up, so it comes and goes smoothly. */
export const castOf = (turned) => Math.sin((turned * Math.PI) / 180);
