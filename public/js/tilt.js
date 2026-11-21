import { settings } from './settings.js';

// Covers lean a few degrees toward the pointer, with a patch of light that follows it. Pure decoration: nothing
// is stored and nothing changes in a book. Off with a setting, with "reduce motion", on touch screens and in the list layout.
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(hover: hover)');
let current = null;
let frame = 0;
let settle = 0;

function release() {
  if (!current) return;
  current.classList.remove('tilting', 'entering');
  current.style.removeProperty('--rx');
  current.style.removeProperty('--ry');
  for (const v of ['--vx', '--vy', '--dr', '--dl', '--db', '--dt', '--ll', '--lr', '--lt', '--lb']) current.style.removeProperty(v);
  clearTimeout(settle);
  current = null;
}

export function startTilt() {
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !settings.cardTilt || calm.matches || !fine.matches) return release();
    const wrap = e.target instanceof Element ? e.target.closest('.book-stage, .series-stack') : null;
    if (!wrap || wrap.closest('.view-list') || wrap.querySelector('.cover-wrap.flipping')) return release();
    if (current && current !== wrap) release();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = wrap.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      if (current !== wrap) {
        // the first moments over a book ease into the pose instead of snapping to wherever the pointer came in
        wrap.classList.add('entering');
        clearTimeout(settle);
        settle = setTimeout(() => wrap.classList.remove('entering'), 450);
      }
      current = wrap;
      wrap.classList.add('tilting');
      wrap.style.setProperty('--ry', `${((x - 0.5) * 5).toFixed(2)}deg`);
      wrap.style.setProperty('--rx', `${((0.5 - y) * 4).toFixed(2)}deg`);
      // The camera goes the way the book turns away from it: pointer right = right side recedes = the spine comes forward (camera left of
      // the book); pointer left = the page edges come forward (camera right of it). Top and bottom likewise. The square root makes the
      // faces show well before the pointer reaches the edge of the cover, so there is hardly a dead zone in the middle.
      const ox = 2 * x - 1;
      const oy = 2 * y - 1;
      const curve = (o) => Math.sign(o) * Math.sqrt(Math.abs(o));
      wrap.style.setProperty('--vx', `${(50 - 150 * curve(ox)).toFixed(1)}%`);
      wrap.style.setProperty('--vy', `${(50 - 150 * curve(oy)).toFixed(1)}%`);
      // Light on a matte cover is not a hotspot: the side turning away from you goes a little darker, the side coming forward a little lighter.
      const set = (name, v) => wrap.style.setProperty(name, v.toFixed(3));
      if (settings.cardShade) {
      set('--dr', Math.max(ox, 0) * 0.2); set('--dl', Math.max(-ox, 0) * 0.2);
      set('--db', Math.max(oy, 0) * 0.18); set('--dt', Math.max(-oy, 0) * 0.18);
      set('--ll', Math.max(ox, 0) * 0.08); set('--lr', Math.max(-ox, 0) * 0.08);
      set('--lt', Math.max(oy, 0) * 0.07); set('--lb', Math.max(-oy, 0) * 0.07);
      }
    });
  });
  document.addEventListener('pointerleave', release);
  window.addEventListener('blur', release);
}
