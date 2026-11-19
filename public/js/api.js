async function call(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    // A Blob (an image, say) goes as it is; everything else is JSON.
    headers: body instanceof Blob ? { 'Content-Type': body.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // The pass key was needed (or the login expired): reload to get the login page.
    location.reload();
    throw new Error('locked: enter the pass key');
  }
  if (!res.ok) {
    let msg = res.statusText;
    let body = {};
    try {
      body = await res.json();
      msg = body.error || msg;
    } catch {
      /* not JSON */
    }
    throw Object.assign(new Error(msg), { status: res.status, code: body.code });
  }
  return res.json();
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  put: (p, b = {}) => call('PUT', p, b),
  patch: (p, b = {}) => call('PATCH', p, b),
  del: (p) => call('DELETE', p),
};

/** After a cover changed on the server: replace the copy the browser keeps (the URL stays the same, and is cached for good). */
export const refreshCover = (b) => fetch(coverUrl(b), { cache: 'reload' }).catch(() => {});

// ?v=<fingerprint> makes these URLs content-addressed, so the server marks them cache-forever.
export const coverUrl = (b) => `/api/books/${b.id}/cover?v=${b.fingerprint}-4`; // any {id, fingerprint}. The server makes the browser re-check covers; the suffix only retires copies kept for good by older versions.
export const pageUrl = (b, n) => `/api/books/${b.id}/pages/${n}?v=${b.fingerprint}`;
export const fileUrl = (b, download = false) =>
  `/api/books/${b.id}/file?v=${b.fingerprint}${download ? '&download=1' : ''}`;
