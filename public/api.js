let csrfToken = null;
export function setCsrf(value) { csrfToken = value || null; }
export function getCsrf() { return csrfToken; }

export async function request(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (csrfToken && !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers['x-csrf-token'] = csrfToken;
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  } catch {
    const error = new Error(navigator.onLine === false ? 'You are offline. Check your connection and try again.' : 'Could not reach Circle. Check your connection and try again.');
    error.network = true;
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

/** `meta` may carry width/height/durationMs so the server can store them with the file. */
export async function upload(file, purpose, meta = {}) {
  const headers = { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name || 'recording') };
  if (meta.width) headers['x-media-width'] = String(Math.round(meta.width));
  if (meta.height) headers['x-media-height'] = String(Math.round(meta.height));
  if (meta.durationMs) headers['x-media-duration'] = String(Math.round(meta.durationMs));
  return request(`/api/media?purpose=${encodeURIComponent(purpose)}`, { method: 'POST', headers, body: file });
}
