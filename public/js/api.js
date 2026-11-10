async function call(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // The pass key was needed (or the login expired): reload to get the login page.
    location.reload();
    throw new Error('locked: enter the pass key');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
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

// ?v=<fingerprint> makes these URLs content-addressed, so the server marks them cache-forever.
export const coverUrl = (b) => `/api/books/${b.id}/cover?v=${b.fingerprint}`; // any {id, fingerprint}
export const pageUrl = (b, n) => `/api/books/${b.id}/pages/${n}?v=${b.fingerprint}`;
export const fileUrl = (b, download = false) =>
  `/api/books/${b.id}/file?v=${b.fingerprint}${download ? '&download=1' : ''}`;
