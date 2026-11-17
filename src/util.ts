import crypto from 'node:crypto';
import fs from 'node:fs/promises';

/** "page2" sorts before "page10". */
export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const natCompare = (a: string, b: string): number => collator.compare(a, b);

const CHUNK = 64 * 1024;

/**
 * Cheap content identity: size + three 64KB samples (start, middle, end).
 * Survives moves, renames and copies; changes when the content changes.
 * Reads at most 192KB per file, so fingerprinting 1500 books takes seconds.
 */
export async function fingerprint(file: string, size: number): Promise<string> {
  const h = crypto.createHash('sha1');
  h.update(`${size}:`);
  if (size === 0) return h.digest('hex');
  const small = size <= CHUNK * 3;
  const offsets = small ? [0] : [0, Math.floor(size / 2) - CHUNK / 2, size - CHUNK];
  const len = small ? size : CHUNK;
  const buf = Buffer.allocUnsafe(len);
  const fh = await fs.open(file, 'r');
  try {
    for (const off of offsets) {
      const { bytesRead } = await fh.read(buf, 0, len, off);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/**
 * A PDF's own document ID: the first string of the /ID entry in the file's trailer. The PDF spec makes it the
 * permanent identifier, kept when the file is updated (annotations, form fields), so it survives edits that
 * change the size and content. Returns '' when the file has none (or a useless one). Reads about 40 KB.
 */
export async function pdfFileId(file: string, size: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const tail = Buffer.allocUnsafe(Math.min(size, 32768));
    const head = Buffer.allocUnsafe(Math.min(size, 8192));
    await fh.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    await fh.read(head, 0, head.length, 0);
    const re = /\/ID\s*\[\s*<([0-9A-Fa-f]{16,64})>/g;
    let id = '';
    for (const buf of [head, tail]) {
      // The last one wins in the tail (the newest trailer); the head only serves linearized files.
      for (const m of buf.toString('latin1').matchAll(re)) id = m[1].toLowerCase();
      if (id && buf === tail) break;
    }
    return /^(.)\1*$/.test(id) ? '' : id; // all zeros and the like say nothing
  } catch {
    return '';
  } finally {
    await fh.close();
  }
}

/** Run fn over items with at most `limit` in flight. */
export async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Counting semaphore; the freed slot is handed straight to the next waiter. */
export function semaphore(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

export function titleFromFilename(filename: string): string {
  let t = filename.replace(/\.[^.]+$/, '');
  // "The_Pragmatic_Programmer" -> "The Pragmatic Programmer"
  if (!/\s/.test(t) && (t.match(/_/g)?.length ?? 0) >= 2) t = t.replace(/_+/g, ' ');
  return (t.trim() || filename).normalize('NFC');
}

/** Same idea for authors: "anonymous", "admin", "Unknown" are what tools write when nobody filled it in. */
export function usableAuthor(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const a = raw.replace(/\s+/g, ' ').trim();
  if (a.length < 2 || a.length > 200 || a.includes('�')) return undefined;
  if (/^(anonymous|unknown|admin(istrator)?|user|owner|author|n\/a|none|null|default|-+)$/i.test(a)) return undefined;
  return a.normalize('NFC');
}

/** PDF/EPUB metadata titles are often junk ("Microsoft Word - foo.docx"). Filter those out. */
export function usableTitle(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 200) return undefined;
  if (t.includes('�')) return undefined;
  if (/^(microsoft word|untitled|document\d*|unknown|title|new document|powerpoint presentation)\b/i.test(t)) return undefined;
  if (/\.(docx?|indd|qxd|tex|pdf|pub|odt|rtf|txt|pages|ps|dvi|epub)$/i.test(t)) return undefined;
  if (/^[\d\W_]+$/.test(t)) return undefined;
  return t.normalize('NFC');
}
