import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSendId, resolveSendId } from './drafts.ts';

describe('pending send ids', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a newer pending send when an older one is confirmed late', () => {
    let n = 0;
    const makeId = () => `id-000000${++n}`;
    const a = resolveSendId('t1', '{"text":"A"}', makeId);
    const b = resolveSendId('t1', '{"text":"B"}', makeId);
    expect(b).not.toBe(a);
    // A's response arrives after B was sent (B's response lost): B's retry must reuse B's id.
    clearSendId('t1', a);
    expect(resolveSendId('t1', '{"text":"B"}', makeId)).toBe(b);
    clearSendId('t1', b);
    expect(resolveSendId('t1', '{"text":"B"}', makeId)).not.toBe(b);
  });
});
