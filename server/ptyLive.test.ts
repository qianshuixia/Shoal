import { expect, it } from 'vitest';
import type { StreamBlock } from '../shared/protocol.ts';
import {
  dedupeLiveAnswer, extractPtyInteractivePrompt, extractPtyLiveFromLines, extractPtyPromptState,
  type TermLineSample,
} from '../shared/ptyLive.ts';

const mkLines = (rows: Array<string | { text: string; muted?: boolean }>): TermLineSample[] =>
  rows.map((r, i) => (typeof r === 'string' ? { startRow: i, text: r } : { startRow: i, text: r.text, muted: r.muted }));

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

it('extracts agy ask_question single-select picker cleanly and prevents LiveTail Markdown leak', () => {
  const lines = mkLines([
    '────────────────────────────────────────────────────────────────────────────────',
    '',
    'Question 1/6: Q1 (2 级 · 昇龙破空重做) ：采纳 3 段飞龙冲霄浮空 + 腾蛟 0.6s 原地影龙重放 + 火化昇龍烈火，默认龙色选哪套？',
    '',
    '> 1. (Recommended) 1A 原作青碧白炽龙（忠实群英传 Magic_127，黄土战场高辨识，插火化书变赤焰昇龍烈火反',
    '     差大）',
    '  2. 1B 鎏金苍白龙（延续主角骑将暖金主色调）',
    '  3. Write-in...',
    '',
    '  ↑/↓ Navigate · → Next · enter Select · esc Skip · ctrl+r Review',
    'esc to cancel                                                                                auto · Gemi',
  ]);

  const parsed = extractPtyInteractivePrompt('agy', lines, false);
  expect(parsed).not.toBeNull();
  expect(parsed?.mode).toBe('select');
  expect(parsed?.progress).toEqual({ current: 1, total: 6 });
  expect(parsed?.title).toBe('Q1 (2 级 · 昇龙破空重做) ：采纳 3 段飞龙冲霄浮空 + 腾蛟 0.6s 原地影龙重放 + 火化昇龍烈火，默认龙色选哪套？');
  expect(parsed?.selectedIndex).toBe(0);
  expect(parsed?.options).toHaveLength(3);
  expect(parsed?.options[0]).toMatchObject({
    index: 0,
    number: '1',
    recommended: true,
    selected: true,
    label: '1A 原作青碧白炽龙（忠实群英传 Magic_127，黄土战场高辨识，插火化书变赤焰昇龍烈火反差大）',
  });
  expect(parsed?.options[2]).toMatchObject({ index: 2, number: '3', label: 'Write-in...', isWriteIn: true });
  expect(parsed?.actions.map(a => a.id)).toEqual(['next', 'review', 'skip']);

  // LiveTail MUST NOT leak the interactive picker lines into Markdown answerText!
  const live = extractPtyLiveFromLines('agy', lines, undefined, false);
  expect(live.answerText).toBeUndefined();
});

it('extracts multi-select, write-in, and review screens accurately', () => {
  const multi = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    'Question 2/4: 需要启用哪些检查？',
    '',
    '> 1. [x] 类型检查',
    '  2. [ ] 单元测试',
    '  3. [ ] Write-in...',
    '',
    '  ↑/↓ Navigate · space Toggle · ← Prev · → Next · enter Confirm · esc Skip · ctrl+r Review',
  ]), false);
  expect(multi?.mode).toBe('multi');
  expect(multi?.options.map(o => o.checked)).toEqual([true, false, false]);
  expect(multi?.actions.map(a => a.id)).toEqual(['prev', 'next', 'confirm', 'review', 'skip']);

  const writeInEmpty = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    'Question 3/4: 补充其他意见？',
    '',
    '  1. 保持默认',
    '> 2. Write-in...',
    '  >',
    '',
    '  enter Confirm · esc Back',
  ]), false);
  expect(writeInEmpty?.mode).toBe('write-in');
  expect(writeInEmpty?.writeInText).toBe('');

  const writeIn = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    'Question 3/4: 补充其他意见？',
    '',
    '  1. 保持默认',
    '> 2. Write-in...',
    '  > 改用暗金色龙焰',
    '',
    '  enter Confirm · esc Back',
  ]), false);
  expect(writeIn?.mode).toBe('write-in');
  expect(writeIn?.progress).toEqual({ current: 3, total: 4 });
  expect(writeIn?.writeInText).toBe('改用暗金色龙焰');

  const review = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    'Review Answers',
    '',
    '1. Q1: 1A 原作青碧白炽龙',
    '2. Q2: 类型检查',
    '',
    '> Submit All',
    '  Back',
    '',
    '  ↑/↓ Navigate · enter Select · esc Back',
  ]), false);
  expect(review?.mode).toBe('review');
  expect(review?.subtitle).toContain('1. Q1: 1A 原作青碧白炽龙');
  expect(review?.options).toMatchObject([
    { label: 'Submit All', selected: true, isSubmit: true },
    { label: 'Back', selected: false, isBack: true },
  ]);
});

it('extracts Claude AskUserQuestion and Codex request_user_input while rejecting normal prose and idle prompts', () => {
  const claude = extractPtyInteractivePrompt('claude', mkLines([
    '← ☐ Auth  ☐ Cache  ✓ Submit →',
    'Which authentication method should we use?',
    '❯ 1. OAuth 2.0',
    { text: '     Recommended for multi-tenant apps', muted: true },
    '  2. API Key',
    '  3. Type something.',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]), false);
  expect(claude?.mode).toBe('select');
  expect(claude?.options[0]).toMatchObject({
    label: 'OAuth 2.0',
    description: 'Recommended for multi-tenant apps',
    selected: true,
  });
  expect(claude?.options[2].isWriteIn).toBe(true);

  const codex = extractPtyInteractivePrompt('codex', mkLines([
    'Question 1/2',
    'Target runtime environment?',
    '› 1. Node 22 (Recommended)',
    '  2. Bun',
    'tab to add notes | enter to submit answer | esc to interrupt',
  ]), false);
  expect(codex?.mode).toBe('select');
  expect(codex?.progress).toEqual({ current: 1, total: 2 });
  expect(codex?.options[0]).toMatchObject({ label: 'Node 22', recommended: true, selected: true });

  // Anti-false-positive guards: normal Markdown prose, idle prompt, or alternate screen must return null.
  expect(extractPtyInteractivePrompt('agy', mkLines([
    'Question 1/2: Here is my summary:',
    '1. First item',
    '2. Second item',
  ]), false)).toBeNull();

  expect(extractPtyInteractivePrompt('agy', mkLines([
    'Question 1/2: Previous screen',
    '> 1. Option A',
    '  2. Option B',
    '────────────────────────────────────────────',
    '> ',
    '────────────────────────────────────────────',
    '  auto · Gemini 4',
  ]), false)).toBeNull();

  expect(extractPtyInteractivePrompt('agy', mkLines([
    'Question 1/2: Pick one',
    '> 1. A',
    '  2. B',
    '  ↑/↓ Navigate · enter Select · esc Skip',
  ]), true)).toBeNull();
});

it('never swallows ordinary Markdown blockquotes without a live shortcut hint bar or with prose instructions', () => {
  const bareMarkdown = mkLines([
    'Question 1/2: Which format?',
    '> 1. JSON',
    '  2. YAML',
  ]);
  expect(extractPtyInteractivePrompt('agy', bareMarkdown, false)).toBeNull();

  const markdownLines = mkLines([
    '> compare formats',
    'Question 1/2: Which format?',
    '> 1. JSON',
    '  2. YAML',
  ]);
  expect(extractPtyInteractivePrompt('agy', markdownLines, false)).toBeNull();
  const live = extractPtyLiveFromLines('agy', markdownLines, 'compare formats', false);
  expect(live.answerText).toContain('Question 1/2: Which format?');
  expect(live.answerText).toContain('> 1. JSON');
  expect(live.answerText).toContain('2. YAML');

  // Prose sentences mentioning arrow/Enter instructions MUST NOT masquerade as a TUI shortcut hint bar.
  const proseInstructionLines = mkLines([
    '> compare formats',
    'Question 1/2: Which format?',
    '> 1. JSON',
    '  2. YAML',
    'Use ↑/↓ to navigate and Enter to select.',
  ]);
  expect(extractPtyInteractivePrompt('agy', proseInstructionLines, false)).toBeNull();
  const proseLive = extractPtyLiveFromLines('agy', proseInstructionLines, 'compare formats', false);
  expect(proseLive.answerText).toContain('Use ↑/↓ to navigate and Enter to select.');
});

it('handles narrow-screen unindented wrapped option lines and wrapped hint bars without leaking to LiveTail', () => {
  const narrowLines = mkLines([
    '────────────────────────────────────────',
    'Question 1/2: Which format should we ship?',
    '',
    '> 1. JSON format with strict schema validation',
    'that hard-wraps onto column 0 without indent',
    '  2. YAML format',
    '',
    '  ↑/↓ Navigate ·',
    '  enter Select',
  ]);
  const parsed = extractPtyInteractivePrompt('agy', narrowLines, false);
  expect(parsed).not.toBeNull();
  expect(parsed?.mode).toBe('select');
  expect(parsed?.options).toHaveLength(2);
  expect(parsed?.options[0].label).toBe('JSON format with strict schema validation that hard-wraps onto column 0 without indent');
  expect(parsed?.options[1].label).toBe('YAML format');
  const live = extractPtyLiveFromLines('agy', narrowLines, undefined, false);
  expect(live.answerText).toBeUndefined();

  // Also handle a hint token broken right across two narrow rows (`↑/↓ Navigate · enter` / `Select · esc Skip`).
  const splitTokenHint = mkLines([
    '────────────────────────────────────────',
    'Question 1/2: Pick one',
    '> 1. Alpha',
    '  2. Beta',
    '↑/↓ Navigate · enter',
    'Select · esc Skip',
  ]);
  const parsedSplit = extractPtyInteractivePrompt('agy', splitTokenHint, false);
  expect(parsedSplit?.mode).toBe('select');
  expect(parsedSplit?.options).toHaveLength(2);
  expect(extractPtyLiveFromLines('agy', splitTokenHint, undefined, false).answerText).toBeUndefined();

  // 3-line narrow-screen wrapped hint bars (both mid-token break across 3 lines AND unindented continuation starting with `other`/`no`).
  const threeLineWrapped = mkLines([
    '───────────────────────────────────',
    'Question 2/4: Pool strategy?',
    '> 1. [x] Share pool with',
    'other services in cluster',
    '  2. [ ] Isolate with',
    'no shared connections',
    '↑/↓ Navigate · space Toggle · ←',
    'Prev · → Next · enter Confirm · esc',
    'Skip · ctrl+r Review',
  ]);
  const parsed3 = extractPtyInteractivePrompt('agy', threeLineWrapped, false);
  expect(parsed3?.mode).toBe('multi');
  expect(parsed3?.options).toHaveLength(2);
  expect(parsed3?.options[0].label).toBe('Share pool with other services in cluster');
  expect(parsed3?.options[1].label).toBe('Isolate with no shared connections');
  expect(parsed3?.actions.map(a => a.id)).toEqual(['prev', 'next', 'confirm', 'review', 'skip']);
  expect(extractPtyLiveFromLines('agy', threeLineWrapped, undefined, false).answerText).toBeUndefined();

  // 3-line wrapped hint where line 1 is standalone and lines 2+3 break mid-token must consume ALL 3 lines (never polluting option 2).
  const threeLineMixed = mkLines([
    '───────────────────────────────────',
    'Question 1/2: Confirm choice?',
    '> 1. Keep',
    '  2. Replace',
    '↑/↓ Navigate · → Next ·',
    'enter Confirm · esc',
    'Back',
  ]);
  const parsed3Mixed = extractPtyInteractivePrompt('agy', threeLineMixed, false);
  expect(parsed3Mixed?.mode).toBe('select');
  expect(parsed3Mixed?.options[1].label).toBe('Replace');
  expect(parsed3Mixed?.actions.map(a => a.id)).toEqual(['next', 'back']);
});

it('classifies optionless Review Answers as review even when user answers mention write-in/自定义回答 or use Chinese headings, and maps Tab/Shift+Tab accurately', () => {
  const reviewNoOpts = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    'Review Answers',
    '',
    '1. Q1: 加上自定义回答',
    '2. Q2: write-in strict mode',
    '',
    '  enter Submit · esc Back',
  ]), false);
  expect(reviewNoOpts?.mode).toBe('review');
  expect(reviewNoOpts?.subtitle).toContain('加上自定义回答');
  expect(reviewNoOpts?.actions.map(a => [a.id, a.key])).toEqual([
    ['submit', 'enter'],
    ['back', 'esc'],
  ]);

  const chineseReview = extractPtyInteractivePrompt('agy', mkLines([
    '────────────────────────────────────────────',
    '核对回答',
    '',
    '1. Q1: 保持默认',
    '',
    '  enter Confirm · esc Back',
  ]), false);
  expect(chineseReview?.mode).toBe('review');
  expect(chineseReview?.actions.map(a => [a.id, a.key])).toEqual([
    ['submit', 'enter'],
    ['back', 'esc'],
  ]);

  const tabNav = extractPtyInteractivePrompt('claude', mkLines([
    'Question 1/2: Pick database?',
    '❯ 1. SQLite',
    '  2. Postgres',
    '  ↑/↓ Navigate · shift+tab Prev · tab Next · enter Select · esc Cancel',
  ]), false);
  expect(tabNav?.mode).toBe('select');
  expect(tabNav?.actions.find(a => a.id === 'prev')).toMatchObject({ key: 'shift+tab', keyHint: 'Shift+Tab' });
  expect(tabNav?.actions.find(a => a.id === 'next')).toMatchObject({ key: 'tab', keyHint: 'Tab' });
});
