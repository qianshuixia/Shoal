import { describe, expect, it } from 'vitest';
import { parseRange } from './raw-stream.ts';

describe('parseRange', () => {
  it('parses the single ranges media elements send', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange(' Bytes = 5 - 9 ', 1000)).toEqual({ start: 5, end: 9 });
  });

  it('answers 416 for ranges past the end, a zero suffix, or a start range on an empty file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=1000-1200', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    // A non-zero suffix on an empty file selects the whole (empty) representation: plain 200.
    expect(parseRange('bytes=-10', 0)).toBeNull();
  });

  it('compares numbers beyond 2^53 exactly instead of rounding them', () => {
    expect(parseRange('bytes=99999999999999999999-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-99999999999999999999', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=-99999999999999999999', 1000)).toEqual({ start: 0, end: 999 });
    // Both ends round to the same double; exact comparison still sees end < start, so the header is ignored.
    expect(parseRange('bytes=99999999999999999999-99999999999999999998', 1000)).toBeNull();
    expect(parseRange('bytes=9007199254740993-9007199254740992', 2 ** 60)).toBeNull();
  });

  it('ignores absent, malformed, multi-range and non-byte headers so the whole file is sent', () => {
    for (const h of [undefined, '', 'bytes=', 'bytes=-', 'bytes=9-3', 'bytes=0-1,5-9', 'items=0-5', 'bytes=a-b', 'bytes=1.5-2']) {
      expect(parseRange(h, 1000)).toBeNull();
    }
  });
});
