import { expect, it } from 'vitest';
import type { StreamBlock } from '../shared/protocol.ts';
import { dedupeLiveAnswer, extractPtyPromptState } from '../shared/ptyLive.ts';

it('keeps identical live answers across committed turns and ignores still-pending input', () => {
  const blocks: StreamBlock[] = [
    { id: 'first', kind: 'user', text: '第一轮' },
    { id: 'answer', kind: 'assistant', text: '好的。' },
  ];
  expect(dedupeLiveAnswer('好的。', [...blocks, { id: 'queued', kind: 'user', text: '第二轮', pending: 'queued' }])).toBeUndefined();
  expect(dedupeLiveAnswer('好的。', [...blocks, { id: 'second', kind: 'user', text: '第二轮' }])).toBe('好的。');
});

it('does not misclassify an unframed multi-line draft ending with a bare glyph as empty', () => {
  const threeLines = [
    { startRow: 0, text: '> first line of draft', wrapped: false },
    { startRow: 1, text: '  second indented line', wrapped: false },
    { startRow: 2, text: '> ', wrapped: false },
  ];
  const st3 = extractPtyPromptState('fake', threeLines, false);
  expect(st3.found).toBe(true);
  expect(st3.draft?.text).toContain('first line of draft');
  expect(st3.draft?.multiline).toBe(true);

  const twoLines = [
    { startRow: 0, text: '› first line', wrapped: false },
    { startRow: 1, text: '› ', wrapped: false },
  ];
  const st2 = extractPtyPromptState('codex', twoLines, false);
  expect(st2.found).toBe(false);
  expect(st2.draft).toBeNull();
});
