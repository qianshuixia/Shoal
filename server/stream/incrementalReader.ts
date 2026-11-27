import fs from 'node:fs';

const FULL_READ = 4 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 3 * 1024 * 1024;

export interface TranscriptRead {
  file: string;
  ino: bigint;
  dev: bigint;
  size: number;
  raw: string;
  truncated: boolean;
  complete: string;
  partial: Buffer;
  added: string;
  appended: boolean;
  tail?: { raw: string; offset: number };
}

function readBytes(fd: number, size: number, position: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, bytes, read, size - read, position + read);
    if (!count) break;
    read += count;
  }
  return bytes.subarray(0, read);
}

export function readTranscriptRaw(file: string, previous?: TranscriptRead): TranscriptRead | null {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile()) return null;
      const size = Number(stat.size);
      const identity = { file, ino: stat.ino, dev: stat.dev };
      if (size <= FULL_READ) {
        const prior = previous && !previous.truncated && previous.file === file
          && previous.dev === stat.dev && previous.ino === stat.ino && previous.size < size ? previous : undefined;
        const delta = readBytes(fd, size - (prior?.size ?? 0), prior?.size ?? 0);
        const bytes = prior?.partial.length ? Buffer.concat([prior.partial, delta]) : delta;
        const boundary = bytes.lastIndexOf(10) + 1;
        const added = bytes.toString('utf8', 0, boundary);
        const partial = Buffer.from(bytes.subarray(boundary));
        const complete = (prior?.complete ?? '') + added;
        return { ...identity, size: (prior?.size ?? 0) + delta.length, raw: complete + partial.toString('utf8'), truncated: false,
          complete, partial, added, appended: prior !== undefined };
      }
      const head = readBytes(fd, HEAD_BYTES, 0);
      const tailStart = size - TAIL_BYTES;
      const tailBytes = readBytes(fd, TAIL_BYTES, tailStart);
      const complete = head.toString('utf8', 0, head.lastIndexOf(10) + 1);
      const firstTailLine = tailBytes.indexOf(10);
      const tail = { raw: firstTailLine < 0 ? '' : tailBytes.toString('utf8', firstTailLine + 1), offset: tailStart + firstTailLine + 1 };
      return { ...identity, size, raw: complete + tail.raw, truncated: true, complete, partial: Buffer.alloc(0), added: complete, appended: false, tail };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
