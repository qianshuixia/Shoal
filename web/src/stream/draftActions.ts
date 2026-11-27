import type { ServerMsg } from '../../../shared/protocol.ts';

// Tiny module-level pub/sub for the server's `draft-action-result` replies, so App.tsx can forward every reply
// without re-rendering and StreamView can await exactly the one it sent.
export type DraftActionResult = Extract<ServerMsg, { t: 'draft-action-result' }>;
type Listener = (msg: DraftActionResult) => void;

const listeners = new Set<Listener>();

export function emitDraftActionResult(msg: DraftActionResult): void {
  for (const fn of [...listeners]) fn(msg);
}

export function subscribeDraftActionResult(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export interface DraftActionWait {
  promise: Promise<DraftActionResult | null>; // null = no reply before the timeout
  cancel(): void;
}

// Create BEFORE sending the request so a fast reply is never missed.
export function waitDraftActionResult(id: string, action: DraftActionResult['action'], timeoutMs: number): DraftActionWait {
  let done: (r: DraftActionResult | null) => void = () => {};
  const promise = new Promise<DraftActionResult | null>((resolve) => {
    done = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = subscribeDraftActionResult((msg) => {
    if (msg.id !== id || msg.action !== action) return;
    cleanup();
    done(msg);
  });
  function cleanup() {
    unsub();
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    cleanup();
    done(null);
  }, timeoutMs);
  return {
    promise,
    cancel: () => {
      cleanup();
      done(null);
    },
  };
}

export function describeDraftRejection(reason: DraftActionResult['reason']): string {
  switch (reason) {
    case 'stale':
      return '终端刚刚有新输入，未执行操作，请查看终端';
    case 'blocked':
      return '终端正在等待确认，未执行操作，请查看终端';
    case 'busy':
      return '当前回合仍在运行，未执行操作，请稍后重试或到终端处理';
    default:
      return '终端操作失败，请查看终端';
  }
}
