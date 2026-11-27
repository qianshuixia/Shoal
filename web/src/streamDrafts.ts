// Per-session desktop StreamView composer drafts, preserved across 终端 <-> 对话 toggles and task switches.
// Backed by an in-memory map + sessionStorage (wrapped safely so storage errors degrade to memory-only).
export interface StreamAttachment {
  kind: 'uploaded' | 'local';
  value: string; // uploaded basename in <stateDir>/attachments OR absolute local path on host disk
  label: string; // human-readable filename displayed on the chip above the composer
  size?: number;
}

export interface StreamDraft {
  text: string;
  attachments: StreamAttachment[];
}

export const MAX_STREAM_ATTACHMENTS = 32;

const STORAGE_PREFIX = 'shoal.stream.draft.';
// Orphaned drafts (sessions that no longer exist) must not pile up in sessionStorage forever.
export const MAX_STORED_DRAFTS = 24;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const drafts = new Map<string, StreamDraft>();
const listeners = new Set<() => void>();

export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storageOverride: DraftStorage | null | undefined; // undefined = use the real sessionStorage
let prunedOnce = false;

function getStorage(): DraftStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

// Test seam: inject an in-memory store (or null for "storage unavailable"); undefined restores the default.
export function setStreamDraftStorage(storage: DraftStorage | null | undefined): void {
  storageOverride = storage;
  prunedOnce = false;
  drafts.clear();
}

export interface StoredDraftMeta {
  key: string;
  updatedAt: number;
}

// Pure eviction policy: expired entries go first, then the oldest beyond `max`. `keep` is never evicted.
export function selectDraftsToEvict(entries: StoredDraftMeta[], now: number, max: number, ttlMs: number, keep?: string): string[] {
  const evict = new Set<string>();
  const alive: StoredDraftMeta[] = [];
  for (const e of entries) {
    if (e.key !== keep && now - e.updatedAt > ttlMs) evict.add(e.key);
    else alive.push(e);
  }
  const overflow = alive.length - max;
  if (overflow > 0) {
    const oldestFirst = alive.filter((e) => e.key !== keep).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const e of oldestFirst.slice(0, overflow)) evict.add(e.key);
  }
  return [...evict];
}

function pruneStoredDrafts(keep?: string, now: number = Date.now()): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const entries: StoredDraftMeta[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      let updatedAt = 0; // legacy / unparsable entries count as the oldest
      try {
        const parsed = JSON.parse(storage.getItem(k) ?? '{}') as { updatedAt?: unknown };
        if (typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)) updatedAt = parsed.updatedAt;
      } catch {
        // keep 0
      }
      entries.push({ key: k, updatedAt });
    }
    const keepKey = keep ? STORAGE_PREFIX + keep : undefined;
    for (const k of selectDraftsToEvict(entries, now, MAX_STORED_DRAFTS, DRAFT_TTL_MS, keepKey)) {
      storage.removeItem(k);
      drafts.delete(k.slice(STORAGE_PREFIX.length));
    }
  } catch {
    // storage failures degrade to memory-only
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

function normalizeAttachment(raw: unknown): StreamAttachment | null {
  if (typeof raw === 'string') {
    const v = raw.trim();
    return v ? { kind: 'uploaded', value: v, label: v } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<StreamAttachment>;
  if ((o.kind !== 'uploaded' && o.kind !== 'local') || typeof o.value !== 'string' || !o.value.trim()) return null;
  const value = o.value.trim();
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : value;
  const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? o.size : undefined;
  return { kind: o.kind, value, label, ...(size !== undefined ? { size } : {}) };
}

function sameAttachment(a: StreamAttachment, b: StreamAttachment): boolean {
  return a.kind === b.kind && a.value === b.value && a.label === b.label && a.size === b.size;
}

export function mergeStreamAttachments(existing: StreamAttachment[], incoming: StreamAttachment[]): StreamAttachment[] {
  const out = [...existing];
  const seen = new Set(out.map((a) => `${a.kind}:${a.value}`));
  for (const item of incoming) {
    if (out.length >= MAX_STREAM_ATTACHMENTS) break;
    const key = `${item.kind}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function readStorage(sessionId: string): StreamDraft | null {
  try {
    const raw = getStorage()?.getItem(STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { text?: unknown; attachments?: unknown };
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.map(normalizeAttachment).filter((a): a is StreamAttachment => a !== null)
      : [];
    if (!text && attachments.length === 0) return null;
    return { text, attachments };
  } catch {
    return null;
  }
}

export function getStreamDraft(sessionId: string | null): StreamDraft {
  if (!sessionId) return { text: '', attachments: [] };
  const cached = drafts.get(sessionId);
  if (cached) return { text: cached.text, attachments: cached.attachments.map((a) => ({ ...a })) };
  const stored = readStorage(sessionId);
  if (stored) {
    drafts.set(sessionId, stored);
    return { text: stored.text, attachments: stored.attachments.map((a) => ({ ...a })) };
  }
  return { text: '', attachments: [] };
}

export function setStreamDraft(sessionId: string | null, draft: StreamDraft): void {
  if (!sessionId) return;
  const empty = !draft.text && draft.attachments.length === 0;
  const prev = drafts.get(sessionId);
  if (empty) {
    if (!prev) {
      try { getStorage()?.removeItem(STORAGE_PREFIX + sessionId); } catch { /* ignore */ }
      return;
    }
    drafts.delete(sessionId);
    try { getStorage()?.removeItem(STORAGE_PREFIX + sessionId); } catch { /* ignore */ }
    notify();
    return;
  }
  if (
    prev &&
    prev.text === draft.text &&
    prev.attachments.length === draft.attachments.length &&
    prev.attachments.every((a, i) => sameAttachment(a, draft.attachments[i]))
  ) {
    return;
  }
  const next: StreamDraft = { text: draft.text, attachments: draft.attachments.map((a) => ({ ...a })) };
  const isNewKey = !prev;
  drafts.set(sessionId, next);
  try { getStorage()?.setItem(STORAGE_PREFIX + sessionId, JSON.stringify({ ...next, updatedAt: Date.now() })); } catch { /* ignore */ }
  // Sweep on the first write and whenever a brand-new session key appears, not on every keystroke.
  if (isNewKey || !prunedOnce) {
    prunedOnce = true;
    pruneStoredDrafts(sessionId);
  }
  notify();
}

export function clearStreamDraft(sessionId: string | null): void {
  setStreamDraft(sessionId, { text: '', attachments: [] });
}

export function hasStreamDraft(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const d = getStreamDraft(sessionId);
  return Boolean(d.text.trim() || d.attachments.length > 0);
}

export function subscribeStreamDrafts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Persistent per-session idempotency key for StreamView retries across Alt+M view unmounts/remounts (5 min TTL).
const SEND_ID_PREFIX = 'shoal.stream.sendid.';
const SEND_ID_TTL_MS = 5 * 60_000;
const sendIds = new Map<string, { key: string; id: string; at: number }>();

export function resolveStreamSendId(sessionId: string | null, fingerprint: string, makeId: () => string): string {
  if (!sessionId) return makeId();
  const now = Date.now();
  let cur = sendIds.get(sessionId);
  if (!cur) {
    try {
      const raw = getStorage()?.getItem(SEND_ID_PREFIX + sessionId);
      if (raw) {
        const parsed = JSON.parse(raw) as { key?: unknown; id?: unknown; at?: unknown };
        if (typeof parsed.key === 'string' && typeof parsed.id === 'string' && typeof parsed.at === 'number') {
          cur = { key: parsed.key, id: parsed.id, at: parsed.at };
        }
      }
    } catch { /* ignore */ }
  }
  if (cur && cur.key === fingerprint && now - cur.at < SEND_ID_TTL_MS) {
    sendIds.set(sessionId, cur);
    return cur.id;
  }
  const fresh = { key: fingerprint, id: makeId(), at: now };
  sendIds.set(sessionId, fresh);
  try { getStorage()?.setItem(SEND_ID_PREFIX + sessionId, JSON.stringify(fresh)); } catch { /* ignore */ }
  return fresh.id;
}

export function clearStreamSendId(sessionId: string | null, id: string): void {
  if (!sessionId) return;
  const cur = sendIds.get(sessionId);
  if (!cur || cur.id === id) sendIds.delete(sessionId);
  try {
    const raw = getStorage()?.getItem(SEND_ID_PREFIX + sessionId);
    if (!raw || JSON.parse(raw)?.id === id) getStorage()?.removeItem(SEND_ID_PREFIX + sessionId);
  } catch { /* ignore */ }
}
