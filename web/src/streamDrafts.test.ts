import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_TTL_MS, MAX_STORED_DRAFTS, getStreamDraft, selectDraftsToEvict, setStreamDraft, setStreamDraftStorage, type DraftStorage,
} from './streamDrafts.ts';
import { redactLocalPaths } from './stream/format.ts';

class MemStorage implements DraftStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const P = 'shoal.stream.draft.';

describe('selectDraftsToEvict', () => {
  const now = 1_000_000_000;
  it('drops expired entries and the oldest beyond the cap, never the kept key', () => {
    const entries = [
      { key: 'old', updatedAt: now - DRAFT_TTL_MS - 1 },
      { key: 'a', updatedAt: now - 300 },
      { key: 'b', updatedAt: now - 200 },
      { key: 'c', updatedAt: now - 100 },
    ];
    expect(selectDraftsToEvict(entries, now, 2, DRAFT_TTL_MS).sort()).toEqual(['a', 'old']);
    // The kept key survives even when it is the oldest.
    expect(selectDraftsToEvict(entries, now, 2, DRAFT_TTL_MS, 'a').sort()).toEqual(['b', 'old']);
  });
  it('evicts nothing when under the cap and fresh', () => {
    expect(selectDraftsToEvict([{ key: 'a', updatedAt: now }], now, 24, DRAFT_TTL_MS)).toEqual([]);
  });
});

describe('stream draft storage hygiene', () => {
  let store: MemStorage;
  beforeEach(() => {
    store = new MemStorage();
    setStreamDraftStorage(store);
  });
  afterEach(() => setStreamDraftStorage(undefined));

  it('keeps at most MAX_STORED_DRAFTS sessions, evicting the least recently updated, and never the one just written', () => {
    for (let i = 0; i < MAX_STORED_DRAFTS + 6; i++) {
      store.setItem(`${P}s${i}`, JSON.stringify({ text: `t${i}`, attachments: [], updatedAt: Date.now() - (100 - i) * 1000 }));
    }
    setStreamDraft('fresh', { text: 'hello', attachments: [] });
    const keys = [...store.map.keys()].filter((k) => k.startsWith(P));
    expect(keys.length).toBeLessThanOrEqual(MAX_STORED_DRAFTS);
    expect(keys).toContain(`${P}fresh`);
    expect(keys).not.toContain(`${P}s0`); // oldest went first
    expect(keys).toContain(`${P}s${MAX_STORED_DRAFTS + 5}`); // newest legacy entry survives
  });

  it('purges drafts older than the TTL and records updatedAt on write', () => {
    store.setItem(`${P}stale`, JSON.stringify({ text: 'x', attachments: [], updatedAt: Date.now() - DRAFT_TTL_MS - 5000 }));
    setStreamDraft('now', { text: 'y', attachments: [] });
    expect(store.getItem(`${P}stale`)).toBeNull();
    const saved = JSON.parse(store.getItem(`${P}now`)!) as { updatedAt: number };
    expect(Math.abs(saved.updatedAt - Date.now())).toBeLessThan(5000);
  });

  it('round-trips a draft through storage after the in-memory cache is gone', () => {
    setStreamDraft('rt', { text: 'keep me', attachments: [{ kind: 'uploaded', value: 'a.png', label: 'a.png' }] });
    setStreamDraftStorage(store); // clears the memory map, storage stays
    expect(getStreamDraft('rt')).toEqual({ text: 'keep me', attachments: [{ kind: 'uploaded', value: 'a.png', label: 'a.png' }] });
  });

  it('degrades to memory only when storage is unavailable', () => {
    setStreamDraftStorage(null);
    setStreamDraft('m', { text: 'mem', attachments: [] });
    expect(getStreamDraft('m').text).toBe('mem');
  });
});

describe('redactLocalPaths', () => {
  it('reduces absolute paths in error text to the file name', () => {
    expect(redactLocalPaths('添加附件失败：G:\\work\\secret dir\\a.png 不存在')).not.toContain('G:\\work');
    expect(redactLocalPaths('添加附件失败：G:\\work\\secret dir\\a.png 不存在')).not.toContain('secret dir');
    expect(redactLocalPaths('无法打开文件：文件不存在：C:\\Review Sample Folder\\private\\never-created-image-one.png')).toBe(
      '无法打开文件：文件不存在：已隐藏路径',
    );
    expect(redactLocalPaths('无法打开文件：文件不存在：C:\\Review Sample Folder\\private\\my secret shot 1.png')).toBe(
      '无法打开文件：文件不存在：已隐藏路径',
    );
    expect(redactLocalPaths('读取 C:\\Users\\bob\\x.txt 失败')).toBe('读取 …/x.txt 失败');
    expect(redactLocalPaths('open /home/bob/proj/a.ts failed')).toBe('open …/a.ts failed');
  });
  it('leaves path-free text alone', () => {
    expect(redactLocalPaths('图片过大（上限 20 MB）')).toBe('图片过大（上限 20 MB）');
  });
});
