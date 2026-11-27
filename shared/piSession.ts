import fs from 'node:fs';
import path from 'node:path';

// Pi stores cwd in the header and may change its working directory when loading a session.
export function samePiWorkspace(a: string, b: string): boolean {
  const canonical = (dir: string) => {
    let resolved = path.resolve(dir);
    try { resolved = fs.realpathSync(resolved); } catch { /* missing path: compare its normalized spelling */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(a) === canonical(b);
}

export function piSessionHeader(file: string): { id: string; cwd: string } | undefined {
  if (!path.isAbsolute(file) || !file.endsWith('.jsonl')) return undefined;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      if (!fs.fstatSync(fd).isFile()) return undefined;
      const buffer = Buffer.alloc(16 * 1024);
      const bytes = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
      const newline = bytes.indexOf(10);
      if (newline < 0) return undefined;
      const header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
      if (header?.type === 'session' && typeof header.id === 'string' && typeof header.cwd === 'string') {
        return { id: header.id, cwd: header.cwd };
      }
    } finally { fs.closeSync(fd); }
  } catch { /* missing or invalid session */ }
  return undefined;
}
