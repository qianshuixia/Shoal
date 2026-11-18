let onUnauthorized: (() => void) | null = null;

export function setMobileUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    onUnauthorized?.();
  }
  const parsed = await res.json().then((v: unknown) => ({ ok: true as const, v }), () => ({ ok: false as const, v: undefined }));
  if (!res.ok) {
    const json = (parsed.ok && parsed.v && typeof parsed.v === 'object' ? parsed.v : {}) as { error?: string; code?: string };
    throw Object.assign(new Error(json.error ?? `请求失败 (${res.status})`), { status: res.status, code: json.code });
  }
  // 2xx with an unreadable body (truncated by a flaky link): not a conclusion, the caller may retry.
  if (!parsed.ok) throw Object.assign(new Error('响应不完整，请重试'), { status: res.status, code: 'bad-response' });
  return parsed.v as T;
}

export async function mobileGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  return handleResponse<T>(res);
}

export async function mobilePost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function mobilePatch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function mobileUploadImage(file: File): Promise<string> {
  const type = file.type || 'image/png';
  const res = await fetch('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': type, 'x-shoal-mobile': '1' },
    body: file,
  });
  const json = await handleResponse<{ name: string }>(res);
  return json.name;
}

/** True when the request never got an HTTP answer (offline, DNS, reset), the server answered 5xx, or a 2xx body was unreadable. */
export function isTransientError(e: unknown): boolean {
  const { status, code } = e as { status?: number; code?: string };
  return status === undefined || status >= 500 || code === 'bad-response';
}

/** Client-generated message id for idempotent sends: 8-64 chars of [A-Za-z0-9_-]. */
export function newClientMsgId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `m-${s}`;
}
