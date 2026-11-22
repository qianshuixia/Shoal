import type http from 'node:http';
import fs from 'node:fs';
import { pipeline } from 'node:stream';

export type ByteRange = { start: number; end: number }; // inclusive, as in Content-Range

// Parses a single-range `Range: bytes=...` header (RFC 9110 §14.1.2). Returns null when the header should be ignored
// and the whole file sent (absent, malformed, another unit, several ranges, or a suffix range on an empty file, which
// has no byte to return in a 206), 'unsatisfiable' for a 416. Endpoints compare as BigInt so long digit strings never round.
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const len = BigInt(size);
  if (m[1] === '') {
    const suffix = BigInt(m[2]);
    if (suffix === 0n) return 'unsatisfiable';
    if (size === 0) return null;
    return { start: suffix >= len ? 0 : size - Number(suffix), end: size - 1 };
  }
  const start = BigInt(m[1]);
  if (m[2] !== '' && BigInt(m[2]) < start) return null;
  if (start >= len) return 'unsatisfiable';
  const last = m[2] === '' || BigInt(m[2]) >= len ? size - 1 : Number(m[2]);
  return { start: Number(start), end: last };
}

// Streams a whitelisted preview file from an already opened descriptor (see openRawPreview) and always closes it.
// Range support lets <video>/<audio> seek and is required by WKWebView (macOS) to play at all.
export function sendRawPreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: { fd: number; absPath: string; mime: string; size: number },
  logTag: string,
): void {
  let stream: fs.ReadStream | null = null;
  try {
    const headers: Record<string, string> = {
      'content-type': file.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    };
    // No validators (ETag / Last-Modified) are sent, so an If-Range can never match: answer with the whole file.
    const range = req.headers['if-range'] ? null : parseRange(req.headers.range, file.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}`, 'content-length': '0' });
      res.end();
      return;
    }
    if (range) {
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${file.size}`,
        'content-length': String(range.end - range.start + 1),
      });
    } else {
      res.writeHead(200, { ...headers, 'content-length': String(file.size) });
    }
    if (file.size === 0) {
      res.end();
      return;
    }
    stream = fs.createReadStream(file.absPath, { fd: file.fd, autoClose: true, start: range?.start ?? 0, end: range?.end ?? file.size - 1 });
    pipeline(stream, res, (e) => {
      if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn(logTag, file.absPath, e.message);
    });
  } finally {
    // Every path that does not hand the descriptor to a stream (416, empty file, a throw above) closes it here.
    if (!stream) fs.close(file.fd, () => {});
  }
}
