import { expect, it } from 'vitest';
import {
  clearSessionInteractiveCache, emitInteractiveInputResult, getQuestionError,
  getQuestionWriteInDraft, registerPendingInteractiveRequest, setQuestionWriteInDraft,
} from './interactiveActions.ts';

it('persists Write-in drafts and late blocked/aborted server errors across StreamView unmount/remount', () => {
  const sid = 'sess-persist-1';
  const qKey = JSON.stringify([3, 3, 'Q3（补充要求）']);
  clearSessionInteractiveCache(sid);

  setQuestionWriteInDraft(sid, qKey, '用户在终端切换前写好的自定义回答');
  registerPendingInteractiveRequest('req-1', sid, qKey, 5000);

  // Even with ZERO mounted StreamView listeners (e.g. user switched to Terminal mode),
  // a late server rejection is persisted for this exact question alongside the intact draft.
  emitInteractiveInputResult({
    t: 'interactive-input-result',
    id: sid,
    reqId: 'req-1',
    ok: false,
    reason: 'blocked',
  });

  expect(getQuestionWriteInDraft(sid, qKey)).toBe('用户在终端切换前写好的自定义回答');
  expect(getQuestionError(sid, qKey)).toContain('等待确认');

  // Different question key does not see Q3's draft or error.
  const otherKey = JSON.stringify([4, 4, 'Q4']);
  expect(getQuestionWriteInDraft(sid, otherKey)).toBe('');
  expect(getQuestionError(sid, otherKey)).toBe('');

  clearSessionInteractiveCache(sid);
  expect(getQuestionWriteInDraft(sid, qKey)).toBe('');
  expect(getQuestionError(sid, qKey)).toBe('');
});
