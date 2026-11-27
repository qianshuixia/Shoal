import type { InteractiveInputReason, ServerMsg } from '../../../shared/protocol.ts';

// Module-level pub/sub & per-session persistence for interactive question picker replies, Write-in drafts,
// and rejection errors so App.tsx forwards every ack without re-rendering and both drafts & errors survive
// transient QuestionCard or full StreamView unmounts (PermissionRequest banners or Terminal <-> Dialog toggles).
export type InteractiveInputResultMsg = Extract<ServerMsg, { t: 'interactive-input-result' }>;
type Listener = (msg: InteractiveInputResultMsg) => void;

const listeners = new Set<Listener>();
const writeInDrafts = new Map<string, { key: string; text: string }>();
const questionErrors = new Map<string, { key: string; msg: string }>();
const pendingRequests = new Map<string, { sessionId: string; questionKey: string; timer: ReturnType<typeof setTimeout> }>();

export function registerPendingInteractiveRequest(
  reqId: string,
  sessionId: string,
  questionKey: string,
  ttlMs: number,
): void {
  const prev = pendingRequests.get(reqId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pendingRequests.delete(reqId);
  }, ttlMs + 10_000);
  pendingRequests.set(reqId, { sessionId, questionKey, timer });
}

export function clearPendingInteractiveRequest(reqId: string): void {
  const prev = pendingRequests.get(reqId);
  if (!prev) return;
  clearTimeout(prev.timer);
  pendingRequests.delete(reqId);
}

export function clearSessionInteractiveCache(sessionId: string | null): void {
  if (!sessionId) return;
  writeInDrafts.delete(sessionId);
  questionErrors.delete(sessionId);
  for (const [reqId, entry] of pendingRequests) {
    if (entry.sessionId === sessionId) {
      clearTimeout(entry.timer);
      pendingRequests.delete(reqId);
    }
  }
}

export function emitInteractiveInputResult(msg: InteractiveInputResultMsg): void {
  if (msg.reqId) {
    const pending = pendingRequests.get(msg.reqId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.reqId);
      // Persist server-side rejections even if StreamView unmounted while the user peeked at Terminal mode.
      if (!msg.ok && pending.questionKey) {
        setQuestionError(msg.id, pending.questionKey, describeInteractiveRejection(msg.reason));
      }
    }
  }
  for (const fn of [...listeners]) fn(msg);
}

export function subscribeInteractiveInputResult(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export interface InteractiveActionWait {
  promise: Promise<InteractiveInputResultMsg | null>; // null = timed out or canceled
  cancel(): void;
}

// Create BEFORE sending the WS message so a fast synchronous/local reply is never missed.
export function waitInteractiveInputResult(id: string, reqId: string, timeoutMs: number): InteractiveActionWait {
  let done: (r: InteractiveInputResultMsg | null) => void = () => {};
  let settled = false;
  const finish = (r: InteractiveInputResultMsg | null) => {
    if (settled) return;
    settled = true;
    unsub();
    clearTimeout(timer);
    done(r);
  };
  const promise = new Promise<InteractiveInputResultMsg | null>((resolve) => {
    done = resolve;
  });
  const unsub = subscribeInteractiveInputResult((msg) => {
    if (msg.id !== id || msg.reqId !== reqId) return;
    finish(msg);
  });
  const timer = setTimeout(() => finish(null), timeoutMs);
  return {
    promise,
    cancel: () => finish(null),
  };
}

export function getQuestionWriteInDraft(sessionId: string | null, questionKey: string): string {
  if (!sessionId || !questionKey) return '';
  const entry = writeInDrafts.get(sessionId);
  return entry && entry.key === questionKey ? entry.text : '';
}

export function setQuestionWriteInDraft(sessionId: string | null, questionKey: string, text: string): void {
  if (!sessionId || !questionKey) return;
  if (!text) {
    const cur = writeInDrafts.get(sessionId);
    if (cur && cur.key === questionKey) writeInDrafts.delete(sessionId);
    return;
  }
  writeInDrafts.set(sessionId, { key: questionKey, text });
}

export function clearQuestionWriteInDraft(sessionId: string | null, questionKey?: string): void {
  if (!sessionId) return;
  if (!questionKey) {
    writeInDrafts.delete(sessionId);
    return;
  }
  const cur = writeInDrafts.get(sessionId);
  if (cur && cur.key === questionKey) writeInDrafts.delete(sessionId);
}

export function getQuestionError(sessionId: string | null, questionKey: string): string {
  if (!sessionId || !questionKey) return '';
  const entry = questionErrors.get(sessionId);
  return entry && entry.key === questionKey ? entry.msg : '';
}

export function setQuestionError(sessionId: string | null, questionKey: string, msg: string): void {
  if (!sessionId || !questionKey) return;
  if (!msg) {
    clearQuestionError(sessionId, questionKey);
    return;
  }
  questionErrors.set(sessionId, { key: questionKey, msg });
}

export function clearQuestionError(sessionId: string | null, questionKey?: string): void {
  if (!sessionId) return;
  if (!questionKey) {
    questionErrors.delete(sessionId);
    return;
  }
  const cur = questionErrors.get(sessionId);
  if (cur && cur.key === questionKey) questionErrors.delete(sessionId);
}

export function describeInteractiveRejection(reason?: InteractiveInputReason | 'disconnected' | 'timeout'): string {
  switch (reason) {
    case 'disconnected':
      return '连接已断开，操作未发送，请等待重连后重试或切到终端处理';
    case 'blocked':
      return '终端正等待确认，已停止本次操作，请查看终端';
    case 'busy':
      return '上一步操作尚未完成或终端正在发送消息，请稍后再试';
    case 'too-large':
      return '自定义回答超过 32,000 字符上限，请精简后重试';
    case 'exited':
      return '终端会话已结束，操作未发送';
    case 'aborted':
      return '终端状态已变化，操作已中止，请查看终端确认当前状态';
    case 'timeout':
      return '未收到服务端确认，请确认终端状态后再试';
    default:
      return '操作未能发送，请重试或切到终端处理';
  }
}
