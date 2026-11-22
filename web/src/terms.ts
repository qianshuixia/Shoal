import { Terminal, type IDisposable } from '@xterm/xterm';
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
  glDisposables: IDisposable[];
  contentSeq: number;
  glSuspendedSig: string | null;
  suspendedYdisp: number;
  replaying: boolean; // writing the server's replay of earlier output
}

const registry = new Map<string, Entry>();

// Terminals that hold output, sessions whose saved output was asked for, and sessions the server had none for.
const filled = new Set<string>();
const wanted = new Set<string>();
const empty = new Set<string>();
const emptyListeners = new Set<() => void>();
const changedEmpty = () => { for (const fn of emptyListeners) fn(); };

// An exited session's terminal is empty after a page load or a Shoal restart; ask the server for the saved output.
// Requests made while disconnected are sent again by resendWantedReplays() once the socket opens.
export function requestReplay(id: string): void {
  if (filled.has(id) || empty.has(id)) return;
  wanted.add(id);
  send({ t: 'want-replay', id });
}

export function resendWantedReplays(): void {
  for (const id of wanted) send({ t: 'want-replay', id });
}

// True once the server answered that it has no saved output for the session.
export function isReplayEmpty(id: string): boolean {
  return empty.has(id) && !filled.has(id);
}

export function subscribeReplayEmpty(fn: () => void): () => void {
  emptyListeners.add(fn);
  return () => { emptyListeners.delete(fn); };
}

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
// On macOS the browser pastes on Cmd+V by itself, and Ctrl+V is the CLIs' own image-paste key (Claude Code's
// chat:imagePaste is Ctrl+V there, Alt+V on Windows), so Ctrl+V goes to the CLI unchanged.
const MAC_HOST = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);
const isPasteKey = (e: KeyboardEvent) => !MAC_HOST && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyV';

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
// Anything else (a screenshot: Chrome often hands the page no image data at all for a bitmap) becomes the image-paste key
// (Alt+V; Ctrl+V on macOS), and the CLI reads the clipboard image itself. Server and browser share the system clipboard.
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
  send({ t: 'in', id, d: MAC_HOST ? '\x16' : '\x1bv' });
}

const POSIX_HOST = typeof navigator !== 'undefined' && !/Win/.test(navigator.platform || navigator.userAgent);

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
  // Off Windows a bare absolute POSIX path (not //host) is a local file too.
  if (!/^file:/i.test(uri) && !/^[A-Za-z]:[\\/]/.test(uri) && !(POSIX_HOST && /^\/(?!\/)/.test(uri))) return;
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
  entry = {
    id,
    term,
    fit,
    el,
    opened: false,
    sentCols: 0,
    sentRows: 0,
    resizeTimer: 0,
    gl: null,
    glDisposables: [],
    contentSeq: 0,
    glSuspendedSig: null,
    suspendedYdisp: 0,
    replaying: false,
  };
  const self = entry;
  term.onScroll(() => {
    if (
      self.glSuspendedSig !== null &&
      Math.abs(term.buffer.active.viewportY - self.suspendedYdisp) >= Math.max(1, term.rows)
    ) {
      self.glSuspendedSig = null;
      ensureGl(self, false);
      if (self.gl) term.refresh(0, term.rows - 1);
    }
  });
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
  el.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    handleGlContextLost();
  }, true);
  registry.set(id, entry);
  return entry;
}

export function writeOut(id: string, d: string): void {
  const entry = getEntry(id);
  entry.contentSeq++;
  entry.term.write(d);
  if (!filled.has(id)) {
    filled.add(id);
    if (empty.has(id)) changedEmpty();
  }
}

export function replay(id: string, d: string): void {
  wanted.delete(id);
  if (!d) {
    if (!filled.has(id) && !empty.has(id)) {
      empty.add(id);
      changedEmpty();
    }
    return;
  }
  const wasEmpty = empty.delete(id);
  filled.add(id);
  if (wasEmpty) changedEmpty();
  const entry = getEntry(id);
  entry.contentSeq++;
  entry.term.reset();
  entry.replaying = true;
  entry.term.write(d, () => {
    entry.replaying = false;
    entry.glSuspendedSig = null;
    if (entry.opened && entry.el.isConnected && !entry.gl && !glRestoreTimer) {
      ensureGl(entry, false);
      if (entry.gl) entry.term.refresh(0, entry.term.rows - 1);
    }
  });
}

export function dispose(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  clearTimeout(entry.resizeTimer);
  dropGl(entry);
  entry.term.dispose();
  entry.el.remove();
  registry.delete(id);
  filled.delete(id);
  wanted.delete(id);
  if (empty.delete(id)) changedEmpty();
  if (registry.size === 0) {
    clearGlRestoreTimer();
    clearAtlasCooldownTimer();
  }
}

export function disposeExcept(keep: Set<string>): void {
  for (const id of [...registry.keys()]) if (!keep.has(id)) dispose(id);
}

// Sends plain text to a live terminal via xterm's paste channel (uses bracketed paste when supported).
export function pasteToTerminal(id: string | null, text: string): boolean {
  if (!id || !text) return false;
  const entry = registry.get(id);
  if (!entry || !entry.opened) return false;
  entry.term.focus();
  entry.term.paste(text);
  return true;
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
  entry.glSuspendedSig = null;
  glRecent = [...glRecent.filter((e) => e !== entry), entry];
  ensureGl(entry, false);
  trimGl();
  fitEntry(id);
  entry.term.refresh(0, entry.term.rows - 1);
}

export function detach(id: string, host?: HTMLElement): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (!host || entry.el.parentElement === host) {
    entry.el.remove();
    dropGl(entry);
  }
  glRecent = glRecent.filter((e) => e !== entry);
}

// Browsers cap live WebGL contexts (Chrome: 16 per page) and past that silently kill the oldest, which may be a terminal
// on screen (blank, then the DOM renderer). Keep WebGL only for terminals currently mounted in the DOM (up to MAX_GL).
const MAX_GL = 2;
let glRecent: Entry[] = []; // terminals by when they were last shown, oldest first

interface InternalAtlasTexture {
  texture: WebGLTexture | null;
  version: number;
}
interface InternalAtlas {
  pages?: { canvas: HTMLCanvasElement; version: number }[];
  _requestClearModel?: boolean;
}
interface InternalGlyphRenderer {
  setAtlas?: (atlas: InternalAtlas) => void;
  _atlasTextures?: InternalAtlasTexture[];
}
interface InternalWebglRenderer {
  _gl?: WebGL2RenderingContext;
  _charAtlas?: InternalAtlas;
  _glyphRenderer?: { value?: InternalGlyphRenderer };
  clear?: () => void;
}
interface InternalWebglAddon {
  _renderer?: InternalWebglRenderer;
}
interface InternalEmitter {
  _size?: number;
  fire?: (arg: unknown) => void;
}
interface InternalCore {
  optionsService?: Record<string, unknown> & { _onOptionChange?: InternalEmitter };
  _optionsService?: Record<string, unknown> & { _onOptionChange?: InternalEmitter };
  _themeService?: Record<string, unknown> & { _onChangeColors?: InternalEmitter };
  _coreBrowserService?: Record<string, unknown> & { _onWindowChange?: InternalEmitter };
  linkifier?: Record<string, unknown> & { _onShowLinkUnderline?: InternalEmitter; _onHideLinkUnderline?: InternalEmitter };
  _linkifier?: Record<string, unknown> & { _onShowLinkUnderline?: InternalEmitter; _onHideLinkUnderline?: InternalEmitter };
  [key: string]: unknown;
}
interface InternalTerminal {
  _addonManager?: { _addons?: unknown[] };
  _core?: InternalCore;
}

const atlasIds = new WeakMap<object, number>();
let nextAtlasId = 1;
function atlasIdOf(gl: WebglAddon | null): number | null {
  if (!gl) return null;
  const renderer = (gl as unknown as InternalWebglAddon)._renderer;
  const key: object | undefined = renderer?._charAtlas ?? gl.textureAtlas;
  if (!key) return null;
  let id = atlasIds.get(key);
  if (id === undefined) {
    id = nextAtlasId++;
    atlasIds.set(key, id);
  }
  return id;
}

// Cumulative retry points: 150, 500, 1100, 2000, 2900, 4100 ms (covers transient <3s and slow driver TDR restores).
const GL_RESTORE_DELAYS = [150, 350, 600, 900, 900, 1200];
const SAFE_CAP_COOLDOWN_MS = 2000;
let glRestoreTimer = 0;
let glRestoreAttempt = 0;
let atlasCooldownTimer = 0;
let lastAtlasRebuildAt = -Infinity;
let lastSafeRebuildSignature: string | null = null;
let lastHardRebuildSignature: string | null = null;
let atlasSyncQueued = false;
let pendingForceSync = false;
let totalRebuildCount = 0;
let totalSyncCount = 0;
let probeCanvas: HTMLCanvasElement | null = null;

function clearGlRestoreTimer(): void {
  if (glRestoreTimer) {
    clearTimeout(glRestoreTimer);
    glRestoreTimer = 0;
  }
}

function clearAtlasCooldownTimer(): void {
  if (atlasCooldownTimer) {
    clearTimeout(atlasCooldownTimer);
    atlasCooldownTimer = 0;
  }
}

function dropGl(entry: Entry): void {
  for (const d of entry.glDisposables) d.dispose();
  entry.glDisposables = [];
  const gl = entry.gl;
  entry.gl = null;
  glRecent = glRecent.filter((e) => e !== entry);
  gl?.dispose();
}

// Verify WebGL2 context and shader/program/buffer/texture allocation before instantiating WebglAddon so a broken or
// half-restored GPU state never enters WebglRenderer's constructor and leaks DOM canvases / ResizeObservers / timers.
function preflightWebgl2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    if (!probeCanvas) {
      probeCanvas = document.createElement('canvas');
      probeCanvas.width = 1;
      probeCanvas.height = 1;
    }
    const gl = probeCanvas.getContext('webgl2', { antialias: false, depth: false }) as WebGL2RenderingContext | null;
    if (!gl || gl.isContextLost?.()) {
      probeCanvas = null;
      return false;
    }
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const p1 = gl.createProgram();
    const p2 = gl.createProgram();
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    const tex = gl.createTexture();
    const ok = Boolean(vs && fs && p1 && p2 && vao && buf && tex);
    if (tex) gl.deleteTexture(tex);
    if (buf) gl.deleteBuffer(buf);
    if (vao) gl.deleteVertexArray(vao);
    if (p2) gl.deleteProgram(p2);
    if (p1) gl.deleteProgram(p1);
    if (fs) gl.deleteShader(fs);
    if (vs) gl.deleteShader(vs);
    return ok;
  } catch {
    probeCanvas = null;
    return false;
  }
}

function guardInFrameAtlasOverflow(): void {
  for (const e of registry.values()) {
    if (!e.gl) continue;
    const renderer = (e.gl as unknown as InternalWebglAddon)._renderer;
    const atlas = renderer?._charAtlas;
    const pages = atlas?.pages;
    const textures = renderer?._glyphRenderer?.value?._atlasTextures;
    if (!atlas || !pages || !textures || pages.length <= textures.length) continue;
    for (let i = textures.length; i < pages.length; i++) {
      const idx = i;
      Object.defineProperty(textures, idx, {
        configurable: true,
        enumerable: true,
        get: () => ({
          texture: null,
          get version() {
            return atlas.pages?.[idx]?.version ?? -1;
          },
          set version(_v: number) {
            // no-op: overflow guard prevents out-of-bounds _bindAtlasPageTexture until microtask rebuilds
          },
        }),
      });
    }
  }
}

function captureCoreSubscriptions(term: Terminal, bucket: IDisposable[]): () => void {
  const core = (term as unknown as InternalTerminal)._core;
  if (!core) return () => {};
  const targets: [Record<string, unknown> | undefined, string[]][] = [
    [core, ['onWillOpen']],
    [core._themeService, ['onChangeColors']],
    [core.optionsService ?? core._optionsService, ['onOptionChange', 'onSpecificOptionChange', 'onMultipleOptionChange']],
    [core._coreBrowserService, ['onWindowChange', 'onDprChange']],
    [core.linkifier ?? core._linkifier, ['onShowLinkUnderline', 'onHideLinkUnderline']],
  ];
  const cleanups: (() => void)[] = [];
  const seen = new Set<Record<string, unknown>>();
  for (const [target, keys] of targets) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    for (const key of keys) {
      const orig = target[key];
      if (typeof orig !== 'function') continue;
      const ownDesc = Object.getOwnPropertyDescriptor(target, key);
      if (ownDesc && !ownDesc.configurable) continue;
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: ownDesc?.enumerable ?? true,
        value: (...args: unknown[]) => {
          const sub = (orig as (...a: unknown[]) => IDisposable).apply(target, args);
          if (sub && typeof sub.dispose === 'function') bucket.push(sub);
          return sub;
        },
      });
      cleanups.push(() => {
        if (ownDesc) {
          Object.defineProperty(target, key, ownDesc);
        } else {
          delete target[key];
        }
      });
    }
  }
  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
  };
}

function ensureGl(entry: Entry, fromRestoreLoop: boolean): void {
  if (!entry.opened || !entry.el.isConnected || entry.gl || entry.glSuspendedSig !== null) return;
  if (!preflightWebgl2()) {
    if (!fromRestoreLoop) requestGlRestore(true);
    return;
  }
  let gl: WebglAddon | null = null;
  const screenEl = entry.el.querySelector('.xterm-screen');
  const beforeNodes = screenEl ? new Set(screenEl.children) : null;
  const createdSubs: IDisposable[] = [];
  const createdObservers: ResizeObserver[] = [];
  const createdTimers: ReturnType<typeof setTimeout>[] = [];
  const OrigRO = typeof window !== 'undefined' ? window.ResizeObserver : undefined;
  const winTimer = typeof window !== 'undefined' ? (window as unknown as { setTimeout: (...args: unknown[]) => ReturnType<typeof setTimeout> }) : undefined;
  const origSetTimeout = winTimer?.setTimeout;
  try {
    if (OrigRO) {
      window.ResizeObserver = class extends OrigRO {
        constructor(cb: ResizeObserverCallback) {
          super(cb);
          createdObservers.push(this);
        }
      };
    }
    if (winTimer && origSetTimeout) {
      winTimer.setTimeout = (...args: unknown[]) => {
        const id = origSetTimeout.apply(window, args);
        createdTimers.push(id);
        return id;
      };
    }
    const restoreSubs = captureCoreSubscriptions(entry.term, createdSubs);
    try {
      gl = new WebglAddon();
      entry.term.loadAddon(gl);
    } finally {
      restoreSubs();
      if (OrigRO) window.ResizeObserver = OrigRO;
      if (winTimer && origSetTimeout) winTimer.setTimeout = origSetTimeout;
    }
    const glCtx = (gl as unknown as InternalWebglAddon)._renderer?._gl;
    if (glCtx?.isContextLost?.()) {
      gl.dispose();
      gl = null;
      if (!fromRestoreLoop) requestGlRestore(true);
      return;
    }
    entry.gl = gl;
    glRecent = [...glRecent.filter((e) => e !== entry), entry];
    entry.glDisposables = [
      gl.onContextLoss(() => handleGlContextLost()),
      gl.onRemoveTextureAtlasCanvas(() => scheduleAtlasSync(true)),
      gl.onAddTextureAtlasCanvas(() => {
        guardInFrameAtlasOverflow();
        scheduleAtlasSync(false);
      }),
    ];
  } catch {
    // Clean up any partial subscriptions, observers, timers, or canvases created before WebglRenderer's constructor threw.
    for (const sub of createdSubs) {
      try {
        sub.dispose();
      } catch {
        // ignore individual listener disposal error
      }
    }
    for (const ro of createdObservers) ro.disconnect();
    for (const t of createdTimers) clearTimeout(t);
    try {
      gl?.dispose();
    } catch {
      // ignore secondary disposal error
    }
    if (screenEl && beforeNodes) {
      for (const child of [...screenEl.children]) {
        if (!beforeNodes.has(child) && child.tagName === 'CANVAS') child.remove();
      }
    }
    if (!fromRestoreLoop) requestGlRestore(true);
  }
}

function requestGlRestore(resetAttempts: boolean): void {
  if (resetAttempts && !glRestoreTimer) {
    glRestoreAttempt = 0;
  }
  if (glRestoreTimer || glRestoreAttempt >= GL_RESTORE_DELAYS.length) return;
  const delay = GL_RESTORE_DELAYS[glRestoreAttempt++];
  glRestoreTimer = window.setTimeout(() => {
    glRestoreTimer = 0;
    let remaining = false;
    for (const e of registry.values()) {
      if (!e.opened || !e.el.isConnected || e.gl || e.glSuspendedSig !== null) continue;
      ensureGl(e, true);
      if (e.gl) {
        e.term.refresh(0, e.term.rows - 1);
      } else {
        remaining = true;
      }
    }
    if (remaining && glRestoreAttempt < GL_RESTORE_DELAYS.length) {
      requestGlRestore(false);
    } else if (!remaining) {
      glRestoreAttempt = 0;
    }
  }, delay);
}

function handleGlContextLost(): void {
  probeCanvas = null;
  for (const e of registry.values()) {
    if (e.gl) {
      dropGl(e);
      if (e.opened && e.el.isConnected) e.term.refresh(0, e.term.rows - 1);
    }
  }
  requestGlRestore(true);
}

export function rebuildConnectedGl(capSignature: string | null = null, isHardCap = false): void {
  clearGlRestoreTimer();
  clearAtlasCooldownTimer();
  glRestoreAttempt = 0;
  lastSafeRebuildSignature = capSignature;
  lastHardRebuildSignature = isHardCap ? capSignature : null;
  const live = [...registry.values()].filter((e) => e.opened && e.el.isConnected);
  if (capSignature === null) {
    for (const e of live) e.glSuspendedSig = null;
  }
  for (const e of registry.values()) {
    if (e.gl) dropGl(e);
  }
  for (const e of live) {
    ensureGl(e, false);
    e.term.refresh(0, e.term.rows - 1);
  }
  lastAtlasRebuildAt = performance.now();
  totalRebuildCount++;
}

function viewportSignatureOf(active: { entry: Entry }[]): string {
  return active
    .map(({ entry: e }) => `${e.id}:${e.contentSeq}:${e.term.buffer.active.viewportY}:${e.term.cols}x${e.term.rows}:${scale}`)
    .join('|');
}

function collectActiveGl(): {
  active: { entry: Entry; renderer?: InternalWebglRenderer; atlas?: InternalAtlas }[];
  safeCap: number;
  hardCap: number;
} {
  const active: { entry: Entry; renderer?: InternalWebglRenderer; atlas?: InternalAtlas }[] = [];
  for (const e of registry.values()) {
    if (!e.opened || !e.el.isConnected || !e.gl) continue;
    const renderer = (e.gl as unknown as InternalWebglAddon)._renderer;
    active.push({ entry: e, renderer, atlas: renderer?._charAtlas });
  }
  let maxUnits = 16;
  for (const item of active) {
    const glCtx = item.renderer?._gl;
    if (glCtx && !glCtx.isContextLost?.()) {
      const units = glCtx.getParameter(glCtx.MAX_TEXTURE_IMAGE_UNITS) as number;
      if (typeof units === 'number' && units > 0) maxUnits = units;
      break;
    }
  }
  const safeCap = Math.max(4, Math.min(8, maxUnits - 8));
  const hardCap = Math.max(safeCap + 2, Math.min(14, maxUnits - 2));
  return { active, safeCap, hardCap };
}

function scheduleCooldownRecheck(delayMs: number): void {
  if (atlasCooldownTimer) return;
  atlasCooldownTimer = window.setTimeout(() => {
    atlasCooldownTimer = 0;
    const { active, safeCap } = collectActiveGl();
    if (active.length === 0) return;
    const sig = viewportSignatureOf(active);
    if (sig === lastSafeRebuildSignature) return;
    if (active.some((item) => (item.atlas?.pages?.length ?? 0) >= safeCap)) {
      rebuildConnectedGl(sig, false);
    }
  }, Math.max(16, Math.ceil(delayMs)));
}

function scheduleAtlasSync(removedPage: boolean): void {
  pendingForceSync = pendingForceSync || removedPage;
  if (atlasSyncQueued) return;
  atlasSyncQueued = true;
  queueMicrotask(() => {
    atlasSyncQueued = false;
    const forceSync = pendingForceSync;
    pendingForceSync = false;

    const { active, safeCap, hardCap } = collectActiveGl();
    if (active.length === 0) return;

    const maxPages = active.reduce((m, item) => Math.max(m, item.atlas?.pages?.length ?? 0), 0);
    const sig = viewportSignatureOf(active);
    if (maxPages >= hardCap) {
      // If redrawing the exact same static viewport right after a dedicated hardCap rebuild still hit hardCap,
      // suspend WebGL on these panes and stay on the stable DOM renderer instead of looping every frame.
      if (sig === lastHardRebuildSignature) {
        for (const item of active) {
          item.entry.glSuspendedSig = sig;
          item.entry.suspendedYdisp = item.entry.term.buffer.active.viewportY;
          dropGl(item.entry);
          item.entry.term.refresh(0, item.entry.term.rows - 1);
        }
        return;
      }
      rebuildConnectedGl(sig, true);
      return;
    }
    if (maxPages >= safeCap && sig !== lastSafeRebuildSignature) {
      const elapsed = performance.now() - lastAtlasRebuildAt;
      if (elapsed >= SAFE_CAP_COOLDOWN_MS) {
        rebuildConnectedGl(sig, false);
        return;
      }
      scheduleCooldownRecheck(SAFE_CAP_COOLDOWN_MS - elapsed + 10);
    }

    const needsSync = forceSync || active.some((item) => item.atlas?._requestClearModel === true);
    if (!needsSync) return;

    for (const item of active) {
      if (item.atlas && item.atlas._requestClearModel) item.atlas._requestClearModel = false;
    }
    for (const item of active) {
      // After _mergePages + _deletePage, a shifted page can land on a slot whose previous occupant had the exact
      // same `version` number, causing GlyphRenderer.render() to skip texImage2D upload; reset all slot versions to -1.
      if (item.atlas) {
        const glyphRenderer = item.renderer?._glyphRenderer?.value;
        if (glyphRenderer?.setAtlas) {
          glyphRenderer.setAtlas(item.atlas);
        } else if (glyphRenderer?._atlasTextures) {
          for (const tex of glyphRenderer._atlasTextures) tex.version = -1;
        }
      }
      item.renderer?.clear?.();
      item.entry.term.refresh(0, item.entry.term.rows - 1);
    }
    totalSyncCount++;
  });
}

let wasHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      wasHidden = true;
      return;
    }
    if (wasHidden && document.visibilityState === 'visible') {
      wasHidden = false;
      rebuildConnectedGl();
    }
  });
  document.fonts?.addEventListener?.('loadingdone', (ev) => {
    const faces = (ev as FontFaceSetLoadEvent).fontfaces;
    if (faces?.length && !faces.some((f) => /Maple Mono|Cascadia Mono|Consolas|YaHei Mono/i.test(f.family))) return;
    const live = [...registry.values()].filter((e) => e.opened && e.el.isConnected);
    if (live.length === 0) return;
    rebuildConnectedGl();
    for (const e of live) fitEntry(e.id);
  });
}

export interface TermGlDebug {
  hasGl: boolean;
  liveGlCount: number;
  atlasId: number | null;
  atlasPages: number;
  page0Version: number | null;
  slot0TexVersion: number | null;
  requestClearModel: boolean | null;
  contextLost: boolean | null;
  addonCount: number;
  rebuildCount: number;
  syncCount: number;
  pendingCooldownRecheck: boolean;
  pendingRestoreRetry: boolean;
  glSuspended: boolean;
  screenCanvasCount: number;
  themeListeners: number;
  windowListeners: number;
  optionListeners: number;
  linkListeners: number;
}

export function termGlDebug(id: string, opts?: { fireWindowChange?: boolean }): TermGlDebug {
  let liveGlCount = 0;
  for (const e of registry.values()) {
    if (e.gl) liveGlCount++;
  }
  const entry = registry.get(id);
  const core = entry ? (entry.term as unknown as InternalTerminal)._core : undefined;
  if (opts?.fireWindowChange && typeof window !== 'undefined') {
    core?._coreBrowserService?._onWindowChange?.fire?.(window);
  }
  const gl = entry?.gl ?? null;
  const renderer = gl ? (gl as unknown as InternalWebglAddon)._renderer : undefined;
  const atlas = renderer?._charAtlas;
  const addonCount = entry ? ((entry.term as unknown as InternalTerminal)._addonManager?._addons?.length ?? 0) : 0;
  const screenCanvasCount = entry ? entry.el.querySelectorAll('.xterm-screen canvas').length : 0;
  const linkifier = core?.linkifier ?? core?._linkifier;
  const optSvc = core?.optionsService ?? core?._optionsService;
  return {
    hasGl: !!gl,
    liveGlCount,
    atlasId: atlasIdOf(gl),
    atlasPages: atlas?.pages?.length ?? 0,
    page0Version: atlas?.pages?.[0]?.version ?? null,
    slot0TexVersion: renderer?._glyphRenderer?.value?._atlasTextures?.[0]?.version ?? null,
    requestClearModel: atlas?._requestClearModel ?? null,
    contextLost: renderer?._gl?.isContextLost?.() ?? null,
    addonCount,
    rebuildCount: totalRebuildCount,
    syncCount: totalSyncCount,
    pendingCooldownRecheck: atlasCooldownTimer !== 0,
    pendingRestoreRetry: glRestoreTimer !== 0,
    glSuspended: entry?.glSuspendedSig !== null && entry?.glSuspendedSig !== undefined,
    screenCanvasCount,
    themeListeners: core?._themeService?._onChangeColors?._size ?? 0,
    windowListeners: core?._coreBrowserService?._onWindowChange?._size ?? 0,
    optionListeners: optSvc?._onOptionChange?._size ?? 0,
    linkListeners: (linkifier?._onShowLinkUnderline?._size ?? 0) + (linkifier?._onHideLinkUnderline?._size ?? 0),
  };
}

function trimGl(): void {
  for (const e of [...glRecent]) {
    if (e.gl && !e.el.isConnected) dropGl(e);
  }
  let live = glRecent.filter((e) => e.gl).length;
  for (const e of [...glRecent]) {
    if (live <= MAX_GL) break;
    if (!e.gl) continue;
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
    e.glSuspendedSig = null;
    e.term.options.fontSize = fontSize();
    if (e.opened && e.el.isConnected && !e.gl) ensureGl(e, false);
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

// Repaint the visible terminal canvas without resizing the PTY or touching FitAddon.
// Used after a floating HUD over the WebGL2 canvas shrinks or unmounts so WebView2/DirectComposition
// composites a fresh canvas frame over the vacated region instead of leaving stale pixels.
export function refreshTerminalCanvas(id: string | null): void {
  if (!id) return;
  const entry = registry.get(id);
  if (!entry || !entry.opened || !entry.el.isConnected || entry.term.rows <= 0) return;
  // Refreshing row 0 updates minimal model state while making WebglRenderer redraw and swap the full WebGL2 canvas.
  entry.term.refresh(0, 0);
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
