import crypto from 'node:crypto';
import xtermHeadless from '@xterm/headless';
import type { SessionInfo } from '../shared/protocol.ts';
import { STARTUP_BLOCK_RE } from './sessions.ts';

const { Terminal } = xtermHeadless;

// A blocked session's prompt as the phone sees it: the last screen lines, the keys that answer it, and a fingerprint
// the answer must echo so a key is only written while that same prompt is still waiting.
export type PromptKind = 'yn' | 'menu' | 'confirm' | 'unknown';
export interface PromptKey { label: string; data: string }
export interface PromptView {
  kind: PromptKind;
  lines: string[];
  keys: PromptKey[];
  fingerprint: string;
}

const TAIL_BYTES = 128 * 1024;
const MAX_LINES = 8;
const MAX_LINE_CHARS = 160;

// Replays the end of a session's raw output into a headless terminal of the session's size and returns its screen.
export async function renderScreen(raw: string, cols: number, rows: number): Promise<string[]> {
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
    for (let y = 0; y < rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    return lines;
  } finally {
    term.dispose();
  }
}

// The last non-empty screen lines, trimmed to what a phone banner can show.
export function promptLines(screen: string[]): string[] {
  const out: string[] = [];
  for (let i = screen.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const line = screen[i].replace(/\s+$/, '');
    if (!line.trim()) {
      if (out.length > 0 && out[0] !== '') out.unshift('');
      continue;
    }
    out.unshift(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line);
  }
  while (out[0] === '') out.shift();
  return out;
}

const MENU_RE = /^\s*(?:[❯›>▸▶*]\s*)?(\d)[.)]\s+(.+?)\s*$/;
const YN_RE = /[([]\s*y\s*\/\s*n\s*[)\]]/i;
// TUI dialogs draw a frame; its side borders are not part of the text.
const unbox = (line: string) => line.replace(/^\s*[│┃║|]/, '').replace(/[│┃║|]\s*$/, '');
const isFrame = (line: string) => /^[\s─━═╭╮╰╯┌┐└┘│┃║|]*$/.test(line);
// Lines a dialog may draw under its options (hints like "Esc to cancel", a closing frame).
const MAX_FOOTER_LINES = 2;
const CURSOR_RE = /^\s*[❯›>▸▶]/;

// The numbered options of the dialog at the bottom of the screen: a run of 1, 2, 3… on consecutive lines (a long
// option may wrap onto unnumbered lines), followed by at most a short footer. Numbered lines higher up (logs, lists
// in the agent's reply) are not a dialog.
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
  let first = -1;
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
    first = i;
    if (m[1] === '1') break;
  }
  if (items.length < 2 || items[0].data !== '1') return null;
  // A dialog shows a selection cursor or asks a question right above its options; a numbered list in a reply does not.
  const above = text.slice(0, first).reverse().find(l => l.trim() && !isFrame(l)) ?? '';
  return cursor || /[?？]\s*$/.test(above) ? items : null;
}

// Picks the keys that answer what is on screen, and only when the screen shows a dialog we recognise: `(y/n)` on
// the last lines answers with y / n; a numbered dialog at the bottom with its digit; a recognised startup trust /
// hooks prompt with Enter (its default choice). Anything else gets no keys: open the terminal.
export function classifyPrompt(lines: string[], blocked: NonNullable<SessionInfo['blocked']>): { kind: PromptKind; keys: PromptKey[] } {
  const tail = lines.filter(l => l.trim() && !isFrame(l)).slice(-2).join('\n');
  if (YN_RE.test(tail)) return { kind: 'yn', keys: [{ label: '是 (y)', data: 'y' }, { label: '否 (n)', data: 'n' }] };
  const menu = bottomMenu(lines);
  if (menu) return { kind: 'menu', keys: menu };
  if (blocked === 'startup' && STARTUP_BLOCK_RE.test(lines.map(unbox).join('\n'))) {
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
  const screen = raw ? await renderScreen(raw, session.cols || 120, session.rows || 36) : [];
  const rawLines = promptLines(screen);
  const { kind, keys } = classifyPrompt(rawLines, session.blocked);
  return {
    kind,
    lines: rawLines.map(scrub),
    keys: keys.map(k => ({ ...k, label: scrub(k.label) })),
    fingerprint: promptFingerprint(session.id, waitSeq, session.blocked, rawLines),
  };
}
