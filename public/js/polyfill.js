// pdf.js uses the newest Map methods (getOrInsert, getOrInsertComputed) that only the latest browsers have: Firefox does, a Chrome a few months old does not, and the
// first book that needs them fails with "getOrInsertComputed is not a function". Loaded before pdf.js on the page and in its worker (pdfworker.js).
for (const C of [Map, WeakMap]) {
  const p = C.prototype;
  if (!p.getOrInsert) {
    Object.defineProperty(p, 'getOrInsert', { configurable: true, writable: true, value: function getOrInsert(key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); } });
  }
  if (!p.getOrInsertComputed) {
    Object.defineProperty(p, 'getOrInsertComputed', { configurable: true, writable: true, value: function getOrInsertComputed(key, fn) { if (!this.has(key)) this.set(key, fn(key)); return this.get(key); } });
  }
}
