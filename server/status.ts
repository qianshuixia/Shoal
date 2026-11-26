import type { SessionStatus } from '../shared/protocol.ts';

export type StatusEvent =
  | { type: 'hook'; event: string }
  | { type: 'input'; data: string }
  | { type: 'ready' } // generic CLI emitted output or settled without hooks: starting -> idle
  | { type: 'quiet' } // no PTY output for a while while still `starting`
  | { type: 'exit' };

const WORKING = new Set(['UserPromptSubmit', 'PreToolUse', 'PreInvocation', 'PiContinued']);
const NEEDS_YOU = new Set(['Stop', 'StopFailure', 'PermissionRequest', 'Notification']);

// Hooks that settle the status one way or the other (anything but SessionStart/PostInvocation etc.).
export const isWorkingHook = (event: string) => WORKING.has(event);
export const isStatusHook = (event: string) => WORKING.has(event) || NEEDS_YOU.has(event) || event === 'PiIdle';

export function reduceStatus(current: SessionStatus, ev: StatusEvent): SessionStatus {
  if (current === 'exited') return current;
  switch (ev.type) {
    case 'exit':
      return 'exited';
    case 'hook':
      if (WORKING.has(ev.event)) return 'working';
      // A fresh session reached its prompt: ready, but nothing is waiting on the user yet.
      if (ev.event === 'SessionStart') return current === 'starting' ? 'idle' : current;
      if (ev.event === 'PiIdle') return 'idle';
      // Claude's "waiting for your input" reminder fires on an untouched session too; it does not make it need you.
      if (ev.event === 'Notification' && current === 'idle') return current;
      if (NEEDS_YOU.has(ev.event)) return 'needs_you';
      return current;
    case 'input':
      // Ctrl+C interrupts a turn without firing a Stop hook.
      return current === 'working' && ev.data.includes('\x03') ? 'needs_you' : current;
    case 'ready':
      return current === 'starting' ? 'idle' : current;
    case 'quiet':
      return current === 'starting' ? 'needs_you' : current;
  }
}
