import { describe, expect, it } from 'vitest';
import { classifyPrompt, promptFingerprint, promptLines, readPrompt, renderScreen } from './prompt.ts';

const CLAUDE_PERMISSION = [
  '╭──────────────────────────────╮',
  '│ Bash command                 │',
  '│   npm test                   │',
  '│ Do you want to proceed?      │',
  '│ ❯ 1. Yes                     │',
  "│   2. Yes, and don't ask again │",
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────╯',
].join('\r\n');

describe('prompt reading', () => {
  it('renders cursor-positioned TUI output as screen text', async () => {
    const screen = await renderScreen('\x1b[2J\x1b[3;5H\x1b[1mDo you trust the files in this folder?\x1b[0m\x1b[5;5H❯ 1. Yes, proceed\x1b[6;5H  2. No, exit', 60, 10);
    const lines = promptLines(screen);
    expect(lines).toEqual(['    Do you trust the files in this folder?', '', '    ❯ 1. Yes, proceed', '      2. No, exit']);
  });

  it('reads a boxed numbered menu as digit keys and drops shortcut hints from labels', async () => {
    const view = await readPrompt({ id: 's1', blocked: 'permission', cols: 80, rows: 20 }, 0, CLAUDE_PERMISSION, t => t);
    expect(view?.kind).toBe('menu');
    expect(view?.keys.map(k => k.data)).toEqual(['1', '2', '3']);
    expect(view?.keys[2].label).toBe('3. No, and tell Claude what to do differently');
  });

  it('answers (y/n) with y and n, a recognised startup prompt with Enter, and anything else with no keys', () => {
    expect(classifyPrompt(['Allow? (y/n)'], 'permission').keys.map(k => k.data)).toEqual(['y', 'n']);
    expect(classifyPrompt(['Hooks need review', 'Press Enter to continue'], 'startup')).toEqual({ kind: 'confirm', keys: [{ label: '确认 (Enter)', data: '\r' }] });
    expect(classifyPrompt(['Something unexpected'], 'permission')).toEqual({ kind: 'unknown', keys: [] });
    // Numbered output above the question is not the dialog: the (y/n) on the last line is.
    expect(classifyPrompt(['1. step one done', '2. step two done', 'Allow? (y/n)'], 'permission').keys.map(k => k.data)).toEqual(['y', 'n']);
    // A startup block with an empty or unrecognised screen offers no Enter.
    expect(classifyPrompt([], 'startup').kind).toBe('unknown');
    expect(classifyPrompt(['Loading…'], 'startup').kind).toBe('unknown');
  });

  it('only takes a numbered dialog at the bottom of the screen', () => {
    // A numbered list in the agent's reply (no cursor, no question above) is not a dialog.
    expect(classifyPrompt(['Plan:', '1. read the code', '2. fix it'], 'permission').kind).toBe('unknown');
    // A numbered list far above the bottom is not a dialog either.
    expect(classifyPrompt(['Do you want?', '❯ 1. Yes', '  2. No', 'later output', 'more output', 'and more'], 'permission').kind).toBe('unknown');
    // Footer hints and a wrapped option are fine.
    const wrapped = classifyPrompt([
      'Do you want to proceed?',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again for this command in",
      '     G:/work',
      '  3. No',
      '',
      'Esc to cancel · Tab to add additional instructions',
    ], 'permission');
    expect(wrapped.kind).toBe('menu');
    expect(wrapped.keys.map(k => k.data)).toEqual(['1', '2', '3']);
    // Numbers must run 1, 2, 3 without gaps.
    expect(classifyPrompt(['Pick?', '❯ 1. a', '  3. c'], 'permission').kind).toBe('unknown');
  });

  it('fingerprints the wait, not the picture, and shows scrubbed text', async () => {
    const raw = 'Do you trust C:\\Users\\me\\secret-proj?\r\n❯ 1. Yes, proceed\r\n  2. No, exit';
    const scrub = (t: string) => t.replace(/C:\\\S+/g, '[本机路径]');
    const view = await readPrompt({ id: 's1', blocked: 'startup', cols: 80, rows: 10 }, 3, raw, scrub);
    expect(view?.lines[0]).toBe('Do you trust [本机路径]');
    const rawLines = ['Do you trust C:\\Users\\me\\secret-proj?', '❯ 1. Yes, proceed', '  2. No, exit'];
    expect(view?.fingerprint).toBe(promptFingerprint('s1', 3, 'startup', rawLines));
    // The same prompt drawn again after any input is another wait.
    expect(promptFingerprint('s1', 4, 'startup', rawLines)).not.toBe(view?.fingerprint);
    // Two different paths that scrub to the same text stay apart.
    const other = await readPrompt({ id: 's1', blocked: 'startup', cols: 80, rows: 10 }, 3, raw.replace('secret-proj', 'other-proj'), scrub);
    expect(other?.lines).toEqual(view?.lines);
    expect(other?.fingerprint).not.toBe(view?.fingerprint);
    expect(promptFingerprint('s2', 3, 'startup', rawLines)).not.toBe(view?.fingerprint);
  });

  it('returns null when the session is not blocked', async () => {
    expect(await readPrompt({ id: 's1', blocked: undefined, cols: 80, rows: 10 }, 0, 'Allow? (y/n)', t => t)).toBeNull();
  });
});
