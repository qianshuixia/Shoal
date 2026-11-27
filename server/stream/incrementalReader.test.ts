import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readTranscriptRaw } from './incrementalReader.ts';

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fileFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-reader-'));
  tempDirs.push(directory);
  return path.join(directory, 'transcript.jsonl');
}

it('only reads new bytes, retains a split UTF-8 character, and resets on inode replacement', () => {
  const file = fileFixture();
  const head = Buffer.from('{"role":"user"}\n');
  const line = Buffer.from('{"text":"虾"}\n');
  const split = line.indexOf(Buffer.from('虾')) + 1;
  fs.writeFileSync(file, Buffer.concat([head, line.subarray(0, split)]));
  const initial = readTranscriptRaw(file)!;
  fs.appendFileSync(file, line.subarray(split));
  const readSync = vi.spyOn(fs, 'readSync');
  const next = readTranscriptRaw(file, initial)!;
  expect(readSync.mock.calls).toHaveLength(1);
  expect(readSync.mock.calls[0].slice(2)).toEqual([0, line.length - split, head.length + split]);
  expect(next).toMatchObject({ appended: true, added: line.toString(), raw: head.toString() + line.toString() });
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, Buffer.concat([head, head, head]));
  fs.renameSync(replacement, file);
  expect(readTranscriptRaw(file, next)).toMatchObject({ appended: false, raw: head.toString().repeat(3) });
});

it('marks head and tail slicing and retains the absolute tail byte offset', () => {
  const file = fileFixture();
  const line = '{"role":"user","text":"hello"}\n';
  const raw = line.repeat(150_000);
  fs.writeFileSync(file, raw);
  const result = readTranscriptRaw(file)!;
  expect(result.truncated).toBe(true);
  expect(result.raw.length).toBeLessThan(raw.length);
  expect(result.tail!.offset % line.length).toBe(0);
  expect(result.tail!.raw).toBe(raw.slice(result.tail!.offset));
});
