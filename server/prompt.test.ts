import { describe, expect, it } from 'vitest';
import { classifyPrompt, promptFingerprint, readPrompt, renderScreen, screenText } from './prompt.ts';

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
    const lines = screenText(screen);
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
    // A question above a numbered list is still a reply, not a dialog, without a selection cursor.
    expect(classifyPrompt(['Which approach should we take?', '1. Rewrite it', '2. Patch it'], 'permission').kind).toBe('unknown');
  });

  it('offers nothing on a startup screen that is half drawn or never says which key answers it', () => {
    const trust = 'Do you trust the files in this folder?';
    expect(classifyPrompt([trust, '❯ 1. Yes, proceed', '  2. No, exit'], 'startup').keys.map(k => k.data)).toEqual(['1', '2']);
    // Only one option drawn so far, or only the "No, exit" line: no Enter, no digit.
    expect(classifyPrompt([trust, '❯ 1. Yes, proceed'], 'startup')).toEqual({ kind: 'unknown', keys: [] });
    expect(classifyPrompt(['  2. No, exit'], 'startup')).toEqual({ kind: 'unknown', keys: [] });
    expect(classifyPrompt(['Hooks need review'], 'startup')).toEqual({ kind: 'unknown', keys: [] });
    // "Press Enter" inside another sentence is not an instruction to go on, and Enter never skips a menu we could
    // not read whole.
    expect(classifyPrompt(['Hooks need review', 'Do not press Enter. Use Esc to exit.'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt([trust, '❯ 1. Yes, proceed', 'Use arrows to select, then press Enter.'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt([trust, '❯ 1. Yes, proceed', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt(['Hooks need review', '', 'Press Enter to continue…'], 'startup').kind).toBe('confirm');
  });

  it('gives Enter only to the startup dialog the Enter line belongs to', () => {
    const trust = 'Do you trust the files in this folder?';
    // An earlier dialog's "Press Enter" left above, a new trust dialog still drawing its options under it.
    expect(classifyPrompt(['Hooks need review', 'Press Enter to continue', '', trust], 'startup').kind).toBe('unknown');
    // A half-drawn option with no label yet, or a lone selection cursor, is still a menu.
    expect(classifyPrompt([trust, '❯ 1.', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt([trust, '❯', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    // Startup text far above the Enter line belongs to something else.
    const filler = Array.from({ length: 7 }, (_, i) => `note ${i}`);
    expect(classifyPrompt(['Hooks need review', ...filler, 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    // An Enter line of another dialog in between cuts the startup text off.
    expect(classifyPrompt(['Hooks need review', 'Press Enter to continue', 'Update ready', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    // In a frame, the dialog is the frame: startup text inside it counts, text outside it does not.
    const box = (...rows: string[]) => ['╭────────────────────────────╮', ...rows.map(r => `│ ${r.padEnd(26)} │`), '╰────────────────────────────╯'];
    expect(classifyPrompt(box('Hooks need review', '', 'Press Enter to continue'), 'startup').kind).toBe('confirm');
    expect(classifyPrompt([trust, ...box('Update ready', 'Press Enter to continue')], 'startup').kind).toBe('unknown');
    // Frame borders separate dialogs: an old framed hooks dialog with a new frame only just started under it, a closed
    // hooks frame with another dialog's Enter line under it, a frame still drawing (no bottom border yet).
    const hooks = box('Hooks need review', 'Press Enter to continue');
    expect(classifyPrompt([...hooks, '╭────────────────────────────╮'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt([...hooks, 'Update ready', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt([...box('Hooks need review'), 'Update ready', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt(hooks.slice(0, -1), 'startup').kind).toBe('unknown');
    // Any cursor the menu reader knows, ">" included, marks a half-drawn menu.
    expect(classifyPrompt(['Hooks need review', '>', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt(['Hooks need review', '> 1.', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
    expect(classifyPrompt(['Hooks need review', '❯ Review now', 'Press Enter to continue'], 'startup').kind).toBe('unknown');
  });

  it('offers Enter only when all visible borders belong to the same closed frame', async () => {
    const top = '╭────────────────────────────╮';
    const bottom = '╰────────────────────────────╯';
    const row = (text: string) => `│ ${text.padEnd(26)} │`;
    const title = row('Hooks need review');
    const enter = row('Press Enter to continue');
    const replay = (lines: string[]) => readPrompt(
      { id: 's1', blocked: 'startup', cols: 80, rows: 12 }, 1, lines.join('\r\n'), text => text,
    );
    for (const lines of [
      [top, title, `  ${row('Update ready')}`, `  ${enter}`, `  ${bottom}`],
      [top, title, '│ Update ready', enter, bottom],
      [top, title, '│ Update ready │', enter, bottom],
      [top, title, enter.replaceAll('│', '┃'), bottom],
      [top, title, enter, '╰──────────────────────────╯'],
      // The top border scrolled off or not drawn, two Enter lines in one frame, a cursor or option inside it.
      [title, enter, bottom],
      [top, title, enter, row('Update ready'), enter, bottom],
      [top, row('❯ Review now'), title, enter, bottom],
      [top, row('2. No, exit'), title, enter, bottom],
    ]) {
      expect(await replay(lines), lines.join('\n')).toMatchObject({ kind: 'unknown', keys: [] });
    }
    expect(await replay([top, title, `│ ${'中文'.padEnd(24)} │`, enter, bottom])).toMatchObject({ kind: 'confirm' });
  });

  it('does not borrow an unframed startup title or mistake an unnumbered > option for input', () => {
    const enter = 'Press Enter to continue';
    const hooks = 'Hooks need review';
    const trust = 'Do you trust the files in this folder?';
    for (const lines of [
      [hooks, 'Update ready', enter],
      [hooks, '', 'Update ready', enter],
      [trust, 'Update ready', enter],
      [hooks, '> Review now', enter],
      [hooks, '❯Review now', enter],
      // A cursor or a numbered option anywhere on the screen, not only between the title and the Enter line.
      ['❯ Review now', hooks, enter],
      ['2. No, exit', '', hooks, enter],
    ]) {
      expect(classifyPrompt(lines, 'startup'), lines.join('\n')).toEqual({ kind: 'unknown', keys: [] });
    }
    expect(classifyPrompt([trust, enter], 'startup').kind).toBe('confirm');
  });

  it('fingerprints and shows the whole screen, so what the dialog asks about is part of the wait', async () => {
    const screen = (target: string) => [
      `Edit file ${target}.md`,
      ...Array.from({ length: 12 }, (_, i) => `  line ${i}`),
      'Apply this edit? (y/n)',
    ].join('\r\n');
    const draft = await readPrompt({ id: 's1', blocked: 'permission', cols: 80, rows: 20 }, 1, screen('draft'), t => t);
    const published = await readPrompt({ id: 's1', blocked: 'permission', cols: 80, rows: 20 }, 1, screen('published'), t => t);
    expect(draft?.kind).toBe('yn');
    expect(draft?.lines[0]).toBe('Edit file draft.md');
    expect(published?.fingerprint).not.toBe(draft?.fingerprint);
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

  it('shows and fingerprints a long line in full, so what it asks about is never cut off', async () => {
    const long = (end: string) => `Run ${'x'.repeat(200)} ${end}? (y/n)`;
    const a = await readPrompt({ id: 's1', blocked: 'permission', cols: 240, rows: 5 }, 1, long('rm -rf build'), t => t);
    const b = await readPrompt({ id: 's1', blocked: 'permission', cols: 240, rows: 5 }, 1, long('rm -rf src'), t => t);
    expect(a?.lines[0]).toBe(long('rm -rf build'));
    expect(b?.lines[0]).toBe(long('rm -rf src'));
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
    expect(a?.waitSeq).toBe(1);
  });

  it('returns null when the session is not blocked', async () => {
    expect(await readPrompt({ id: 's1', blocked: undefined, cols: 80, rows: 10 }, 0, 'Allow? (y/n)', t => t)).toBeNull();
  });
});
