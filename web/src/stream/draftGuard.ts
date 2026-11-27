import type { AgentKind } from '../../../shared/protocol.ts';
import { extractPtyPromptState, type PtyPromptDraft } from '../../../shared/ptyLive.ts';
import { getTermContentSeq, readTermLiveSnapshot, subscribeTermOutput } from '../terms.ts';
import { send } from '../ws.ts';
import { clipPreview } from './format.ts';
import { describeDraftRejection, subscribeDraftActionResult, waitDraftActionResult, type DraftActionResult } from './draftActions.ts';

export const CLEAR_VERIFY_TIMEOUT_MS = 500;
export const DRAFT_ACTION_TIMEOUT_MS = 1800;

// Single-line drafts only need Ctrl+E Ctrl+U. For multi-line drafts we walk down at most (lines - 1) rows: that is
// exactly enough to reach the last row from the first, and one fewer Down than before so a cursor that already sits
// on the last row is less likely to be pushed into the CLI's input history.
export function buildClearSequence(draft: PtyPromptDraft | null): string {
  if (!draft || !draft.multiline) return '\x05\x15';
  const lineCount = Math.min(24, Math.max(2, draft.text.split('\n').length));
  return '\x1b[B'.repeat(lineCount - 1) + '\x05\x15\x7f'.repeat(lineCount - 1) + '\x05\x15';
}

export type ClearOutcome =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'unverified'; message: string; residual?: string };

function residualOf(sessionId: string, agent: AgentKind): string {
  const snap = readTermLiveSnapshot(sessionId);
  if (!snap) return '';
  return extractPtyPromptState(agent, snap.lines, snap.isAlternate).draft?.text ?? '';
}

// Sends `clear-input` (bound to the observed draftSeq), verifies with fresh PTY echo, and only then releases the
// server-side draft lock via `confirm-clear-input`. A server rejection (`ok:false`) aborts immediately.
export function clearTerminalInputAndVerify(
  sessionId: string,
  agent: AgentKind,
  draft: PtyPromptDraft | null,
  draftSeq?: number,
  requireSeq = false,
): Promise<ClearOutcome> {
  if (requireSeq && draftSeq === undefined) {
    return Promise.resolve({ ok: false, reason: 'rejected', message: '终端草稿版本仍在同步，请稍候再试或查看终端' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let unsubResult: (() => void) | null = null;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const seqBefore = getTermContentSeq(sessionId);
    const finish = (outcome: ClearOutcome) => {
      if (settled) return;
      settled = true;
      unsub?.();
      unsubResult?.();
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      // Release the server hasDraft lock ONLY after fresh PTY echo proves the prompt is empty and draftSeq is bound.
      if (outcome.ok && draftSeq !== undefined) send({ t: 'confirm-clear-input', id: sessionId, draftSeq });
      resolve(outcome);
    };
    const check = () => {
      // Require new PTY output after sending `clear-input` so stale buffers never falsely confirm a failed write.
      if (getTermContentSeq(sessionId) <= seqBefore) return;
      const snap = readTermLiveSnapshot(sessionId);
      if (!snap) return;
      const st = extractPtyPromptState(agent, snap.lines, snap.isAlternate);
      if (st.found && !st.draft) finish({ ok: true });
    };
    unsub = subscribeTermOutput(sessionId, check);
    unsubResult = subscribeDraftActionResult((msg: DraftActionResult) => {
      if (msg.id !== sessionId || msg.action !== 'clear' || msg.ok) return;
      finish({ ok: false, reason: 'rejected', message: `${describeDraftRejection(msg.reason)}（未执行清空）` });
    });
    send({ t: 'clear-input', id: sessionId, d: buildClearSequence(draft), ...(draftSeq !== undefined ? { draftSeq } : {}) });
    pollTimer = window.setInterval(check, 60);
    timeoutTimer = window.setTimeout(() => {
      check();
      if (settled) return;
      const residual = residualOf(sessionId, agent);
      const detail = residual ? `，仍残留「${clipPreview(residual, 24)}」（${[...residual].length} 个字符）` : '';
      finish({ ok: false, reason: 'unverified', message: `未能确认终端已清空${detail}，请查看终端`, residual });
    }, CLEAR_VERIFY_TIMEOUT_MS);
  });
}

export type SendDraftOutcome = { ok: true } | { ok: false; message: string };

// `send-draft` is an atomic server action (draftSeq + not-blocked check). No reply in time means unconfirmed:
// we never fall back to writing a raw Enter into the PTY.
export async function sendTerminalDraft(sessionId: string, draftSeq?: number): Promise<SendDraftOutcome> {
  if (draftSeq === undefined) {
    return { ok: false, message: '终端草稿版本仍在同步，请稍候再试或查看终端' };
  }
  const wait = waitDraftActionResult(sessionId, 'send', DRAFT_ACTION_TIMEOUT_MS);
  send({ t: 'send-draft', id: sessionId, draftSeq });
  const res = await wait.promise;
  if (!res) return { ok: false, message: '终端未确认发送，请查看终端确认内容是否已提交' };
  if (!res.ok) return { ok: false, message: describeDraftRejection(res.reason) };
  return { ok: true };
}
