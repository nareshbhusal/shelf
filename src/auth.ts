import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PASSKEY, PORT, SHELF_NAME } from './config.js';

// A single pass key. Not accounts, not a user database: one shared secret that keeps other people on
// your network out. Anyone who knows it gets in; anyone who doesn't gets a login page and nothing else.
//
// The session cookie is an HMAC of the pass key (so it survives restarts, and changing the pass key
// logs everyone out). Cookies don't isolate by port, so the name includes the port: two instances on
// localhost with different pass keys won't overwrite each other's login.
export const AUTH_ON = PASSKEY !== '';

const COOKIE = `shelf_session_${PORT}`;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const token = AUTH_ON ? crypto.createHmac('sha256', PASSKEY).update(`shelf-session-v1:${PORT}`).digest('hex') : '';
const same = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

function cookieOf(req: Request): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
const authed = (req: Request) => !AUTH_ON || same(cookieOf(req), token);

// Wrong guesses: after 8 in ten minutes from one address, wait. Slows down guessing without any state on disk.
const fails = new Map<string, number[]>();
const WINDOW = 10 * 60 * 1000;
const LIMIT = 8;
function waitMs(ip: string): number {
  const now = Date.now();
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < WINDOW);
  fails.set(ip, recent);
  return recent.length >= LIMIT ? WINDOW - (now - recent[0]) : 0;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(error = '') {
  const title = SHELF_NAME ? `Shelf (${esc(SHELF_NAME)})` : 'Shelf';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark light;--bg:#14161b;--fg:#e8eaf0;--mut:#9aa1b2;--card:#1c1f27;--line:#2c303b;--acc:#6c8cff;--err:#ff7a7a}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f8;--fg:#1b1e26;--mut:#6a7183;--card:#fff;--line:#d9dce5;--err:#c62828}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px system-ui,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;color:var(--mut);font-size:14px}.err{color:var(--err)}
input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
button{font:inherit;padding:10px;border-radius:8px;border:0;background:var(--acc);color:#fff;font-weight:600;cursor:pointer}
</style></head><body>
<form method="post" action="/login">
<h1>${title}</h1>
<p${error ? ' class="err" role="alert"' : ''}>${error ? esc(error) : 'Enter the pass key to continue.'}</p>
<input type="password" name="passkey" placeholder="Pass key" autocomplete="current-password" autofocus required>
<button type="submit">Unlock</button>
</form></body></html>`;
}

/** Everything except /login needs the cookie. API calls get a 401 the page can react to; page loads get the login form. */
export function authGate(app: express.Express) {
  if (!AUTH_ON) return;
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  app.post('/login', (req: Request, res: Response) => {
    const ip = req.socket.remoteAddress ?? '?';
    const wait = waitMs(ip);
    if (wait > 0) {
      res.status(429).type('html').send(loginPage(`Too many wrong guesses. Try again in ${Math.ceil(wait / 60000)} minute(s).`));
      return;
    }
    const given = typeof req.body?.passkey === 'string' ? req.body.passkey : '';
    if (!same(given, PASSKEY)) {
      fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
      res.status(401).type('html').send(loginPage('Wrong pass key.'));
      return;
    }
    fails.delete(ip);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: MAX_AGE_MS });
    res.redirect(303, '/');
  });

  app.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/');
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (authed(req)) return next();
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      res.status(401).json({ error: 'locked', locked: true });
      return;
    }
    res.status(401).type('html').set('Cache-Control', 'no-store').send(loginPage());
  });
}
