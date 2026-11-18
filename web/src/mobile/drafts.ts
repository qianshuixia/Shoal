// Per-task reply drafts in localStorage. Every access is wrapped: private mode / quota errors degrade to memory-only.
const PREFIX = 'shoal.mobile.draft.';

export interface Draft {
  text: string;
  attachments: string[];
}

export const NEW_TASK_DRAFT_KEY = 'new';

export function draftStorageKey(key: string): string {
  return PREFIX + key;
}

export function loadDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(key));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Draft>;
    return {
      text: typeof v.text === 'string' ? v.text : '',
      attachments: Array.isArray(v.attachments) ? v.attachments.filter((a): a is string => typeof a === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Draft): void {
  try {
    if (!draft.text && draft.attachments.length === 0) localStorage.removeItem(draftStorageKey(key));
    else localStorage.setItem(draftStorageKey(key), JSON.stringify(draft));
  } catch { /* memory-only */ }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(draftStorageKey(key));
  } catch { /* memory-only */ }
}

// Idempotent-send ids, persisted per task so a retry after a lost response (even after leaving the task and coming
// back) reuses the same clientMsgId and the server dedupes it. Memory fallback when storage is unavailable.
const SEND_PREFIX = 'shoal.mobile.send.';
export const SEND_ID_TTL_MS = 10 * 60_000;

interface SendRecord {
  clientMsgId: string;
  payload: string;
  at: number;
}

const memorySends = new Map<string, SendRecord>();

function readSend(taskId: string): SendRecord | null {
  try {
    const raw = localStorage.getItem(SEND_PREFIX + taskId);
    if (raw) {
      const v = JSON.parse(raw) as Partial<SendRecord>;
      if (typeof v.clientMsgId === 'string' && typeof v.payload === 'string' && typeof v.at === 'number') {
        return { clientMsgId: v.clientMsgId, payload: v.payload, at: v.at };
      }
    }
  } catch { /* fall through to memory */ }
  return memorySends.get(taskId) ?? null;
}

/** Same payload within the TTL keeps the stored id; anything else gets `makeId()` and overwrites the record. */
export function resolveSendId(taskId: string, payload: string, makeId: () => string): string {
  const prev = readSend(taskId);
  if (prev && prev.payload === payload && Date.now() - prev.at <= SEND_ID_TTL_MS) return prev.clientMsgId;
  const rec: SendRecord = { clientMsgId: makeId(), payload, at: Date.now() };
  memorySends.set(taskId, rec);
  try {
    localStorage.setItem(SEND_PREFIX + taskId, JSON.stringify(rec));
  } catch { /* memory-only */ }
  return rec.clientMsgId;
}

export function clearSendId(taskId: string): void {
  memorySends.delete(taskId);
  try {
    localStorage.removeItem(SEND_PREFIX + taskId);
  } catch { /* memory-only */ }
}
