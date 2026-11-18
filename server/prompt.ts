import crypto from 'node:crypto';
import xtermHeadless from '@xterm/headless';
import type { SessionInfo } from '../shared/protocol.ts';

const { Terminal } = xtermHeadless;

// A blocked session's prompt as the phone sees it: the screen lines in full, the keys that answer it, and a
// fingerprint the answer must echo so a key is only written while that same prompt is still waiting. `waitSeq` (the
// wait it was read in) lets a refused answer tell "the screen changed under the same wait" from "already answered".
export type PromptKind = 'yn' | 'menu' | 'confirm' | 'unknown';
export interface PromptKey { label: string; data: string }
export interface PromptView {
  kind: PromptKind;
  lines: string[];
  keys: PromptKey[];
  fingerprint: string;
  waitSeq: number;
}

const TAIL_BYTES = 128 * 1024;
const MAX_LABEL_CHARS = 160; // a key label only; the full option line is in `lines`

// Replays the end of a session's raw output into a headless terminal of the session's size and returns its screen.
export async function renderScreen(raw: string, cols: number, rows: number): Promise<string[]> {
  return (await replayScreen(raw, cols, rows)).lines;
}

async function replayScreen(raw: string, cols: number, rows: number) {
  let data = raw.length > TAIL_BYTES ? raw.slice(-TAIL_BYTES) : raw;
  if (data !== raw) {
    const nl = data.indexOf('\n');
    if (nl >= 0 && nl < 4096) data = data.slice(nl + 1);
  }
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => term.write(data, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    const rightBorders = new Map<string, number>();
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      const row = buf.getLine(buf.viewportY + rowIndex);
      const text = row?.translateToString(true) ?? '';
      lines.push(text);
      if (!row || !FRAME_ROW_RE.test(text)) continue;
      for (let column = row.length - 1; column >= 0; column--) {
        if (!row.getCell(column)?.getChars().trim()) continue;
        rightBorders.set(text.trimEnd(), column);
        break;
      }
    }
    return { lines, rightBorders };
  } finally {
    term.dispose();
  }
}

// The whole visible screen in full (right-trimmed, no leading / trailing blank rows, blank runs folded to one):
// what the prompt is classified and fingerprinted from, so whatever the dialog asks about (a command, a file) is part
// of the wait it identifies, however far above the options it is drawn.
export function screenText(screen: string[]): string[] {
  const out: string[] = [];
  for (const row of screen) {
    const line = row.replace(/\s+$/, '');
    if (line.trim()) out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

const clipLabel = (label: string) => (label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label);

// The selection cursors a TUI menu draws; one set for reading a menu and for refusing Enter over a half-drawn one.
const CURSOR = '[❯›>▸▶]';
const MENU_RE = new RegExp(`^\\s*(?:(?:${CURSOR}|\\*)\\s*)?(\\d)[.)]\\s+(.+?)\\s*$`);
const YN_RE = /[([]\s*y\s*\/\s*n\s*[)\]]/i;
// TUI dialogs draw a frame; its side borders are not part of the text.
const unbox = (line: string) => line.replace(/^\s*[│┃║|]/, '').replace(/[│┃║|]\s*$/, '');
const isFrame = (line: string) => /^[\s─━═╭╮╰╯┌┐└┘│┃║|]*$/.test(line);
// Lines a dialog may draw under its options (hints like "Esc to cancel", a closing frame).
const MAX_FOOTER_LINES = 2;
const CURSOR_RE = new RegExp(`^\\s*${CURSOR}`);
// A line that is nothing but an instruction to press Enter to go on: the only evidence that Enter answers a startup
// screen ("Do not press Enter", "select, then press Enter" are not).
const ENTER_LINE_RE = /^\s*(?:press|hit)\s+enter\s+to\s+(?:continue|confirm|proceed|accept)[\s.…!]*$/i;
const MENU_LIKE_RE = /^\s*(?:\*\s*)?\d+[.)](?:\s|$)/;
const STARTUP_ENTER_TITLE_RE = /^\s*(?:Hooks need review|Do you trust the files in this folder|(?:Do you )?trust this folder)[\s?.…!]*$/i;
const FRAME_ROW_RE = /^( *)([│┃║|])(.*)\2\s*$/;
const FRAME_BOTTOM_RE = /^ *(?:╰[─━═]+╯|└[─━═]+┘)\s*$/;

// The numbered options of the dialog at the bottom of the screen: a run of 1, 2, 3… on consecutive lines (a long
// option may wrap onto unnumbered lines) with a selection cursor on one of them, followed by at most a short footer.
// Numbered lines higher up, or without a cursor (logs, lists in the agent's reply, even under a question), are not
// a dialog.
function bottomMenu(lines: string[]): PromptKey[] | null {
  const text = lines.map(unbox);
  let end = text.length - 1;
  let footer = 0;
  while (end >= 0 && !MENU_RE.test(text[end])) {
    if (text[end].trim() && !isFrame(text[end]) && ++footer > MAX_FOOTER_LINES) return null;
    end--;
  }
  if (end < 0) return null;
  const items: PromptKey[] = [];
  let cursor = false;
  for (let i = end; i >= 0; i--) {
    const m = MENU_RE.exec(text[i]);
    if (!m) {
      if (!text[i].trim() || isFrame(text[i]) || items.length === 0) break;
      continue; // wrapped continuation of the option below
    }
    const want = items.length === 0 ? null : Number(items[0].data) - 1;
    if (want !== null && Number(m[1]) !== want) break;
    items.unshift({ label: `${m[1]}. ${m[2].replace(/\s+\((?:esc|[a-z])\)$/i, '')}`, data: m[1] });
    if (CURSOR_RE.test(text[i])) cursor = true;
    if (m[1] === '1') break;
  }
  return cursor && items.length >= 2 && items[0].data === '1' ? items : null;
}

function closedStartupFrame(lines: string[], last: number, rightBorders?: ReadonlyMap<string, number>): boolean {
  const bottom = lines[last].trimEnd();
  const top = bottom.replace('╰', '╭').replace('╯', '╮').replace('└', '┌').replace('┘', '┐');
  const left = bottom.length - bottom.trimStart().length;
  const right = bottom.length - 1;
  let side: string | undefined;
  let seenEnter = false;
  let seenTitle = false;
  for (let index = last - 1; index >= 0; index--) {
    const line = lines[index].trimEnd();
    if (line === top) return seenEnter && seenTitle;
    const row = FRAME_ROW_RE.exec(line);
    if (!row || row[1].length !== left || (rightBorders?.get(line) ?? line.length - 1) !== right) return false;
    if (side !== undefined && row[2] !== side) return false;
    side = row[2];
    const content = row[3];
    if (!content.trim()) continue;
    if (!seenEnter) {
      if (!ENTER_LINE_RE.test(content)) return false;
      seenEnter = true;
    } else {
      if (ENTER_LINE_RE.test(content)) return false;
      if (STARTUP_ENTER_TITLE_RE.test(content)) seenTitle = true;
    }
  }
  return false;
}

// Only a complete closed frame or an adjacent unframed title and Enter line identify a startup confirmation.
function startupEnter(lines: string[], rightBorders?: ReadonlyMap<string, number>): boolean {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last < 0) return false;
  if (FRAME_BOTTOM_RE.test(lines[last])) {
    if (!closedStartupFrame(lines, last, rightBorders)) return false;
  } else {
    if (!ENTER_LINE_RE.test(lines[last])) return false;
    let title = last - 1;
    while (title >= 0 && !lines[title].trim()) title--;
    if (title < 0) return false;
    if (!STARTUP_ENTER_TITLE_RE.test(lines[title])) return false;
  }
  return !lines.some(line => CURSOR_RE.test(unbox(line)) || MENU_LIKE_RE.test(unbox(line)));
}

// Picks the keys that answer what is on screen, and only when the screen shows a dialog we recognise: `(y/n)` on
// the last lines answers with y / n; a complete numbered dialog at the bottom with its digit; a recognised startup
// trust / hooks dialog with Enter (see startupEnter). Anything else (a half-drawn menu, a lone "No, exit") gets no
// keys: open the terminal.
export function classifyPrompt(
  lines: string[], blocked: NonNullable<SessionInfo['blocked']>, rightBorders?: ReadonlyMap<string, number>,
): { kind: PromptKind; keys: PromptKey[] } {
  const tail = lines.filter(l => l.trim() && !isFrame(l)).slice(-2).join('\n');
  if (YN_RE.test(tail)) return { kind: 'yn', keys: [{ label: '是 (y)', data: 'y' }, { label: '否 (n)', data: 'n' }] };
  const menu = bottomMenu(lines);
  if (menu) return { kind: 'menu', keys: menu };
  if (blocked === 'startup' && startupEnter(lines, rightBorders)) {
    return { kind: 'confirm', keys: [{ label: '确认 (Enter)', data: '\r' }] };
  }
  return { kind: 'unknown', keys: [] };
}

// Identifies one wait, not one picture: the session's waitSeq changes with every input, delivery and new prompt, so
// a redrawn identical prompt is a different wait. The raw (unscrubbed) lines keep two prompts that scrub to the same
// text apart.
export function promptFingerprint(sessionId: string, waitSeq: number, blocked: string, rawLines: string[]): string {
  return crypto.createHash('sha256').update(`${sessionId}\u0000${waitSeq}\u0000${blocked}\u0000${rawLines.join('\n')}`).digest('hex').slice(0, 24);
}

// Classifies and fingerprints the raw screen; `scrub` (local paths and other private text) only shapes what the
// phone is shown.
export async function readPrompt(
  session: Pick<SessionInfo, 'id' | 'blocked' | 'cols' | 'rows'>,
  waitSeq: number,
  raw: string | null,
  scrub: (text: string) => string,
): Promise<PromptView | null> {
  if (!session.blocked) return null;
  const screen = raw ? await replayScreen(raw, session.cols || 120, session.rows || 36) : null;
  const rawLines = screenText(screen?.lines ?? []);
  const { kind, keys } = classifyPrompt(rawLines, session.blocked, screen?.rightBorders);
  return {
    kind,
    lines: rawLines.map(l => scrub(l)),
    keys: keys.map(k => ({ ...k, label: scrub(clipLabel(k.label)) })),
    fingerprint: promptFingerprint(session.id, waitSeq, session.blocked, rawLines),
    waitSeq,
  };
}
