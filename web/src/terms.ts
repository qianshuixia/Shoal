import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { send } from './ws.ts';
import { pinIme } from './ime.ts';

// One xterm per session, kept outside React state and alive while the session exists.
interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  sentCols: number;
  sentRows: number;
  resizeTimer: number; // pending resize to the server (0 = none)
  gl: WebglAddon | null; // see MAX_GL
  replaying: boolean; // writing the server's replay of earlier output
}

const registry = new Map<string, Entry>();

const BASE_FONT = 14;
let scale = 1;
const fontSize = () => Math.round(BASE_FONT * scale);

const altOnly = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
export const isJumpKey = (e: KeyboardEvent) => altOnly(e) && e.code === 'Backquote';
export const isNewTaskKey = (e: KeyboardEvent) => altOnly(e) && e.code === 'KeyN';
// Alt+1 / Alt+2 focus the left / right pane: 0 / 1; null for any other key.
export const isPaneKey = (e: KeyboardEvent): 0 | 1 | null => (altOnly(e) ? (e.code === 'Digit1' ? 0 : e.code === 'Digit2' ? 1 : null) : null);
export const isSearchKey = (e: KeyboardEvent) => altOnly(e) && e.code === 'KeyK';
export const isInspectKey = (e: KeyboardEvent) => altOnly(e) && e.code === 'KeyE';
const ctrlOnly = (e: KeyboardEvent) => e.ctrlKey && !e.altKey && !e.metaKey;
// Ctrl+= / Ctrl++ (numpad too) zoom in, Ctrl+- out, Ctrl+0 back to 100%: 1 / -1 / 0; null for any other key.
// Shift is allowed because + is Shift+= on most layouts.
export function zoomKey(e: KeyboardEvent): 1 | -1 | 0 | null {
  if (!ctrlOnly(e)) return null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return 1;
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return -1;
  if ((e.code === 'Digit0' || e.code === 'Numpad0') && !e.shiftKey) return 0;
  return null;
}
// Ctrl+- stays with the CLI inside a terminal: it is ^_, Claude Code's undo.
const isPageKey = (e: KeyboardEvent) =>
  isJumpKey(e) || isNewTaskKey(e) || isPaneKey(e) !== null || isSearchKey(e) || isInspectKey(e) || zoomKey(e) === 1 || zoomKey(e) === 0;
const isPasteKey = (e: KeyboardEvent) => e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyV';

let notice: (msg: string) => void = () => {};
export function setTermNotice(fn: (msg: string) => void): void {
  notice = fn;
}

// Saves each dropped image on the server and pastes its path, in drop order; other files are skipped with a notice.
async function dropFiles(term: Terminal, files: File[]): Promise<void> {
  const images = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
  const skipped = files.length - images.length;
  term.focus();
  for (const f of images) {
    try {
      const res = await fetch('/api/attachments', { method: 'POST', headers: { 'content-type': f.type }, body: f });
      const json = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || !json.path) throw new Error(json.error ?? `HTTP ${res.status}`);
      term.paste(json.path);
    } catch (e) {
      notice(`图片上传失败：${f.name}（${(e as Error).message}）`);
    }
  }
  if (skipped > 0) notice(`已跳过 ${skipped} 个非图片文件（只支持拖入图片）`);
  term.focus();
}

// Files copied in Explorer are pasted as their paths, like Windows Terminal does (quoted when they contain spaces).
// Anything else (a screenshot: Chrome often hands the page no image data at all for a bitmap) becomes Alt+V, and the CLI
// reads the clipboard image itself. Server and browser share the system clipboard.
async function pasteNonText(term: Terminal, id: string): Promise<void> {
  try {
    const res = await fetch('/api/clipboard/files');
    const json = await res.json().catch(() => ({})) as { paths?: string[]; error?: string };
    if (!res.ok || !json.paths) throw new Error(json.error ?? `HTTP ${res.status}`);
    if (json.paths.length > 0) {
      term.paste(json.paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' '));
      return;
    }
  } catch (e) {
    notice(`读取剪贴板文件失败：${(e as Error).message}`);
  }
  send({ t: 'in', id, d: '\x1bv' });
}

let fileLinkHandler: ((uri: string) => Promise<boolean> | boolean) | null = null;
export function setTermFileLinkHandler(fn: ((uri: string) => Promise<boolean> | boolean) | null): void {
  fileLinkHandler = fn;
}

// Clicked terminal link: web links open in a new tab, in-project viewable files open in the right Inspector,
// and other file links (outside project, directories, executables) are opened by the server.
function openLink(uri: string): void {
  if (/^https?:/i.test(uri)) {
    window.open(uri, '_blank', 'noopener');
    return;
  }
  if (!/^file:/i.test(uri) && !/^[A-Za-z]:[\\/]/.test(uri)) return;
  void (async () => {
    try {
      if (fileLinkHandler && (await fileLinkHandler(uri))) return;
      const res = await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: uri }) });
      if (res.ok) return;
      const json = await res.json().catch(() => ({})) as { error?: string };
      notice(json.error ?? `打开失败（HTTP ${res.status}）`);
    } catch (e) {
      notice(`打开失败：${(e as Error).message}`);
    }
  })();
}

// Softer ANSI palette so CLI colors sit calmly on the dark UI (24-bit colors are unaffected).
const THEME = {
  background: '#0f1012', foreground: '#e6e8ec', cursor: '#dcdfe4', cursorAccent: '#0f1012',
  selectionBackground: '#34445e',
  black: '#26282d', red: '#e07a73', green: '#9cc28a', yellow: '#e3c17a',
  blue: '#84a9dd', magenta: '#c39ad6', cyan: '#74bdc4', white: '#d6d9de',
  brightBlack: '#6b6f78', brightRed: '#eb958f', brightGreen: '#b3d3a3', brightYellow: '#ecd193',
  brightBlue: '#a1bfe8', brightMagenta: '#d3b2e2', brightCyan: '#93cfd5', brightWhite: '#f6f7f9',
};

// Copy on select, like Windows Terminal: whatever is selected when the left button is released goes to the clipboard.
// xterm selects words and lines on the mousedown of a double/triple click, so those land here too; a plain click leaves no selection.
let selectingIn: Terminal | null = null;
window.addEventListener('mouseup', (e) => {
  const term = selectingIn;
  selectingIn = null;
  if (e.button !== 0 || !term?.hasSelection()) return;
  navigator.clipboard.writeText(term.getSelection()).catch((err: Error) => notice(`复制失败：${err.message}`));
}, true);

// Full-screen CLIs (Claude Code's fullscreen mode) take mouse drags themselves and hand the selected text over as OSC 52
// (`c;<base64>`); xterm leaves that to the embedder. Only writes count: a query (`?`) would let the CLI read the clipboard.
function osc52(data: string): void {
  const payload = data.slice(data.indexOf(';') + 1);
  if (!data.includes(';') || !payload || payload === '?') return;
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  } catch {
    return;
  }
  navigator.clipboard.writeText(text).catch((err: Error) => notice(`复制失败：${err.message}`));
}

function getEntry(id: string): Entry {
  let entry = registry.get(id);
  if (entry) return entry;
  const term = new Terminal({
    // Same face as the author's Windows Terminal (Maple Mono NF CN has matching CJK glyphs); the rest are fallbacks.
    fontFamily: '"Maple Mono NF CN", "Cascadia Mono", Consolas, "Microsoft YaHei Mono", monospace',
    fontSize: fontSize(),
    cursorBlink: true,
    scrollback: 5000,
    lineHeight: 1.2,
    // Grayscale glyph antialiasing: on an opaque atlas Chrome uses subpixel AA, which leaves colored fringes on some CJK glyphs (e.g. 测).
    allowTransparency: true,
    theme: THEME,
    // xterm also activates a link when a drag ends on it; a drag leaves a selection, a click does not.
    linkHandler: { allowNonHttpProtocols: true, activate: (_event, uri) => { if (!term.hasSelection()) openLink(uri); } },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'term-host';
  entry = { id, term, fit, el, opened: false, sentCols: 0, sentRows: 0, resizeTimer: 0, gl: null, replaying: false };
  const self = entry;
  // Replayed output repeats copies made long ago (e.g. on a page reload); those must not overwrite the clipboard.
  term.parser.registerOscHandler(52, (data) => {
    if (!self.replaying) osc52(data);
    return true;
  });
  // Bound to this session id at creation, so input can never be routed elsewhere.
  term.onData((d) => send({ t: 'in', id, d }));
  // Let page-level shortcuts through instead of typing them into the terminal.
  // Ctrl+V goes to the browser's native paste (images become Alt+V below, text goes through xterm) instead of being sent as ^V.
  term.attachCustomKeyEventHandler((e) => !isPageKey(e) && !isPasteKey(e));
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0) selectingIn = term;
  }, true);
  // Capture phase on the host runs before xterm's own paste listeners on its textarea and element.
  // A paste without text would reach the CLI as an empty bracketed paste. See pasteNonText for what it becomes instead.
  el.addEventListener('paste', (e) => {
    if (e.clipboardData?.getData('text/plain')) return;
    e.preventDefault();
    e.stopPropagation();
    void pasteNonText(term, id);
  }, true);
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, true);
  el.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void dropFiles(term, files);
  }, true);
  registry.set(id, entry);
  return entry;
}

export function writeOut(id: string, d: string): void {
  getEntry(id).term.write(d);
}

export function replay(id: string, d: string): void {
  const entry = getEntry(id);
  entry.term.reset();
  entry.replaying = true;
  entry.term.write(d, () => { entry.replaying = false; });
}

export function dispose(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  clearTimeout(entry.resizeTimer);
  glRecent = glRecent.filter((e) => e !== entry);
  entry.term.dispose();
  entry.el.remove();
  registry.delete(id);
}

export function disposeExcept(keep: Set<string>): void {
  for (const id of [...registry.keys()]) if (!keep.has(id)) dispose(id);
}

// Move the terminal's element into `host`; term.open() runs only once per terminal.
export function attach(id: string, host: HTMLElement): void {
  const entry = getEntry(id);
  host.replaceChildren(entry.el);
  if (!entry.opened) {
    entry.term.open(entry.el);
    entry.opened = true;
    pinIme(entry.term, entry.el);
  }
  glRecent = [...glRecent.filter((e) => e !== entry), entry];
  if (!entry.gl) {
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => dropGl(entry));
      entry.term.loadAddon(gl);
      entry.gl = gl;
    } catch {
      // fall back to the default renderer
    }
  }
  trimGl();
  fitEntry(id);
  entry.term.refresh(0, entry.term.rows - 1);
}

// Browsers cap live WebGL contexts (Chrome: 16 per page) and past that silently kill the oldest, which may be a terminal
// on screen (blank, then the DOM renderer). Keep a context only for the terminals shown most recently; hidden ones
// beyond that fall back to the DOM renderer and get a new context when shown again.
const MAX_GL = 8;
let glRecent: Entry[] = []; // terminals by when they were last shown, oldest first

function dropGl(entry: Entry): void {
  const gl = entry.gl;
  entry.gl = null;
  gl?.dispose();
}

function trimGl(): void {
  let live = glRecent.filter((e) => e.gl).length;
  for (const e of glRecent) {
    if (live <= MAX_GL) break;
    if (!e.gl || e.el.isConnected) continue;
    dropGl(e);
    live--;
  }
  glRecent = glRecent.filter((e) => e.gl);
}

const RESIZE_SEND_MS = 100;

export function fitEntry(id: string): void {
  const entry = registry.get(id);
  if (!entry || !entry.opened || !entry.el.isConnected || entry.el.clientWidth === 0) return;
  entry.fit.fit();
  if (entry.term.cols === entry.sentCols && entry.term.rows === entry.sentRows) return;
  // Dragging a divider or the window refits on every frame; the CLI redraws on each PTY resize, so send the size it settles on.
  clearTimeout(entry.resizeTimer);
  entry.resizeTimer = window.setTimeout(() => {
    entry.resizeTimer = 0;
    if (!registry.has(id)) return;
    const { cols, rows } = entry.term;
    if (cols === entry.sentCols && rows === entry.sentRows) return;
    entry.sentCols = cols;
    entry.sentRows = rows;
    send({ t: 'resize', id, cols, rows });
  }, RESIZE_SEND_MS);
}

// UI zoom: terminals follow the page scale, then refit (hidden ones refit when they are shown again).
export function setTermScale(next: number): void {
  if (next === scale) return;
  scale = next;
  for (const e of registry.values()) {
    e.term.options.fontSize = fontSize();
    fitEntry(e.id);
  }
}

export function termFontSize(id: string): number | null {
  return registry.get(id)?.term.options.fontSize ?? null;
}

// After a reconnect the server may have lost our sizes; make the next fit resend them.
export function forgetSentSizes(): void {
  for (const e of registry.values()) e.sentCols = e.sentRows = 0;
}

export function sizeOf(id: string | null): { cols: number; rows: number } | null {
  const entry = id ? registry.get(id) : undefined;
  return entry?.opened ? { cols: entry.term.cols, rows: entry.term.rows } : null;
}

// Only the terminal in the focused pane may hold DOM focus.
export function focusOnly(id: string | null): void {
  for (const e of registry.values()) if (e.id !== id) e.term.blur();
  if (id) registry.get(id)?.term.focus();
}

export function termText(id: string): string {
  const entry = registry.get(id);
  if (!entry) return '';
  const buf = entry.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}
