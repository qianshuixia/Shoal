import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pty from 'node-pty';
import type { AgentKind, HookBody, ServerMsg, SessionInfo } from '../shared/protocol.ts';
import { agyUserStatusLine, buildLaunch, userStatusLine } from './agents.ts';
import { detectLimit, readResetsAt } from './quota.ts';
import { isStatusHook, isWorkingHook, reduceStatus } from './status.ts';
import type { StatusEvent } from './status.ts';

const BUF_KEEP = 1024 * 1024;
const BUF_MAX = BUF_KEEP + 256 * 1024; // trim in batches so we do not re-slice on every chunk
const QUIET_MS = 4000;
const QUEUE_TICK_MS = 250;
const TYPING_QUIET_MS = 5000; // no user keystrokes this long before a queued message is pasted
const DELIVERY_GAP_MS = 2000; // between two deliveries to the same session
// Margin after the Stop hook: it fires as the turn ends, while the TUI may still be redrawing its prompt.
const SETTLE_MS = 1500;
const ENTER_DELAY_MS = 300; // pasted text first, Enter separately
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// Claude Code notes its PID when a fullscreen launch starts and clears it 10 s after the first frame. A process killed
// before that counts as a crash, and two of them turn fullscreen (and with it mouse clicks on its menus) off for that version.
const CLAUDE_HEALTHY_MS = 11_000;
export const ENV_STRIP = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|CODEX_SANDBOX|CODEX_THREAD|AGY_SESSION)/;

interface Live {
  info: SessionInfo;
  proc: pty.IPty;
  buf: string;
  quiet: NodeJS.Timeout | null;
  removed: boolean;
  queue: string[]; // texts waiting to be pasted (FIFO)
  permBlocked: boolean; // a permission prompt is open, so typed text would answer it
  lastInputAt: number; // last keystroke from the user (injected writes do not count)
  lastDeliveryAt: number;
  modes: Map<number, boolean>; // last state of each REPLAY_MODES mode the CLI set
  tail: string; // end of the previous PTY chunk, so a mode switch split across chunks is still seen
  trimmed: boolean; // buf has lost its start
  firstOutAt: number; // 0 until the PTY first writes
}

// DEC private modes that change how the page's terminal behaves: alternate screen, mouse reporting (Claude Code's
// fullscreen mode, whose menus take clicks), focus events and bracketed paste. The replay buffer loses its start once
// it is trimmed, so their last state is sent ahead of it.
const REPLAY_MODES = new Set([47, 1047, 1049, 1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004]);
const MODE_TAIL = 32; // longer than any mode sequence the CLIs send
export function trackModes(modes: Map<number, boolean>, text: string): void {
  for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const n of m[1].split(';').map(Number)) if (REPLAY_MODES.has(n)) modes.set(n, m[2] === 'h');
  }
}
export function modePrefix(modes: Map<number, boolean>): string {
  return [...modes].filter(([, on]) => on).map(([n]) => `\x1b[?${n}h`).join('');
}

export interface SessionManagerConfig {
  port: number;
  token: string;
  stateDir: string;
}

export interface SpawnOptions {
  taskId: string;
  agent: AgentKind;
  cwd: string;
  prompt: string;
  cols?: number;
  rows?: number;
  resume?: string; // native session id to reopen
}

// Hook events that mean a prompt was submitted, i.e. the CLI now has a saved conversation.
const PROMPT_EVENTS = new Set(['UserPromptSubmit', 'PreInvocation']);

// Native conversation id after a hook: the first id is taken from any event; later only SessionStart may change it
// (the CLI switched conversations in-process, e.g. claude /resume). Switching to a resumed conversation makes it
// resumable at once; any other source waits for the next prompt event.
export function nativeIdUpdate(
  current: string | null, event: string, incoming: unknown, source: unknown,
): { id: string; resumable?: boolean } | undefined {
  if (typeof incoming !== 'string' || !incoming || incoming === current) return undefined;
  if (current === null) return { id: incoming };
  if (event !== 'SessionStart') return undefined;
  return { id: incoming, resumable: source === 'resume' };
}

// Text safe to paste: no paste markers or control characters other than newline and tab.
export function sanitizePaste(text: string): string {
  return text
    .replaceAll(PASTE_START, '')
    .replaceAll(PASTE_END, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Ctrl+J as a win32-input-mode key record (Vk;Sc;Uc;Kd;Cs;Rc_, down then up; ConPTY enables ?9001h itself).
// Codex on Windows reads key events, not the paste: a \n is kept only inside its ASCII paste-burst heuristic,
// so after Chinese text it was dropped. Ctrl+J is Codex's insert-newline key and works after any text.
export const CODEX_NEWLINE = '\x1b[74;36;10;1;8;1_\x1b[74;36;10;0;8;1_';

// Bytes to write for a paste: one bracketed-paste block, or a single line when the CLI has no bracketed paste.
// Newlines are \n by default, never \r (Codex submits on a \r even inside a paste); claude and agy keep \n in the input.
export function pasteFrame(text: string, bracketed: boolean, newline = '\n'): string {
  const clean = sanitizePaste(text);
  return bracketed ? PASTE_START + clean.replaceAll('\n', newline) + PASTE_END : clean.replace(/\n+/g, ' ');
}

export interface DeliveryState {
  status: SessionInfo['status'];
  statusSince: number;
  permBlocked: boolean;
  lastInputAt: number;
  lastDeliveryAt: number;
}

// Whether the head of a session's queue may be pasted now.
export function deliverable(s: DeliveryState, now: number): boolean {
  return (s.status === 'needs_you' || s.status === 'idle') && now - s.statusSince >= SETTLE_MS && !s.permBlocked
    && now - s.lastInputAt >= TYPING_QUIET_MS && now - s.lastDeliveryAt >= DELIVERY_GAP_MS;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export class SessionManager {
  private live = new Map<string, Live>();
  private dead = new Map<string, SessionInfo>(); // restored from disk, no process
  private listeners = new Set<(m: ServerMsg) => void>();
  private cfg: SessionManagerConfig;
  private queueTimer: NodeJS.Timeout | null = null;

  constructor(cfg: SessionManagerConfig) {
    this.cfg = cfg;
  }

  subscribe(fn: (m: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: ServerMsg) {
    for (const fn of this.listeners) fn(m);
  }

  // Registers exited sessions loaded from the persisted state so they show up in snapshots.
  restore(infos: SessionInfo[]) {
    for (const i of infos) this.dead.set(i.id, i);
  }

  list(): SessionInfo[] {
    return [...this.dead.values(), ...[...this.live.values()].map(s => s.info)];
  }

  replays(): { id: string; d: string }[] {
    return [...this.live.values()].filter(s => s.buf).map(s => ({ id: s.info.id, d: (s.trimmed ? modePrefix(s.modes) : '') + s.buf }));
  }

  private log(obj: unknown) {
    try {
      fs.appendFileSync(path.join(this.cfg.stateDir, 'events.jsonl'), JSON.stringify(obj) + '\n');
    } catch (e) {
      console.error('[events.jsonl]', (e as Error).message);
    }
  }

  spawn(o: SpawnOptions): SessionInfo {
    const id = crypto.randomUUID();
    const launch = buildLaunch({ agent: o.agent, sessionId: id, prompt: o.prompt, stateDir: this.cfg.stateDir, resume: o.resume });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_STRIP.test(k))) as Record<string, string>;
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Claude Code only turns on synchronized output (DEC 2026) for terminals it recognizes; xterm.js supports it, and
      // without it half-drawn frames show the cursor jumping around the spinner and status lines.
      CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
      WORKBENCH_SESSION_ID: id,
      WORKBENCH_PORT: String(this.cfg.port),
      WORKBENCH_HOOK_TOKEN: this.cfg.token,
    });
    // Our status line (for the rate limits) replaces the user's own; the relay script runs theirs.
    const userSl = o.agent === 'claude' ? userStatusLine(o.cwd) : o.agent === 'agy' ? agyUserStatusLine().command : undefined;
    if (userSl) env.WORKBENCH_USER_STATUSLINE = userSl;
    const cols = clamp(o.cols ?? 120, 20, 500);
    const rows = clamp(o.rows ?? 36, 5, 200);
    const proc = pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env });
    const now = Date.now();
    const s: Live = {
      info: {
        id, taskId: o.taskId, agent: o.agent, nativeSessionId: launch.nativeSessionId, resumable: Boolean(o.resume || o.prompt),
        status: 'starting', statusSince: now, startedAt: now, exitCode: null, cols, rows,
      },
      proc, buf: '', quiet: null, removed: false,
      queue: [], permBlocked: false, lastInputAt: 0, lastDeliveryAt: 0, modes: new Map(), tail: '', trimmed: false, firstOutAt: 0,
    };
    this.live.set(id, s);
    this.armQuiet(s);
    proc.onData(d => {
      if (!s.firstOutAt) s.firstOutAt = Date.now();
      trackModes(s.modes, s.tail + d);
      s.tail = (s.tail + d).slice(-MODE_TAIL);
      s.buf += d;
      if (s.buf.length > BUF_MAX) {
        let tail = s.buf.slice(-BUF_KEEP);
        const nl = tail.indexOf('\n');
        if (nl >= 0 && nl < 4096) tail = tail.slice(nl + 1);
        s.buf = tail;
        s.trimmed = true;
      }
      if (s.info.status === 'starting') this.armQuiet(s);
      if (!s.removed) this.emit({ t: 'out', id, d });
    });
    proc.onExit(e => {
      if (s.quiet) clearTimeout(s.quiet);
      s.info.exitCode = e.exitCode;
      this.log({ kind: 'exit', sessionId: id, agent: o.agent, exitCode: e.exitCode, at: Date.now() });
      this.dropQueue(s);
      this.apply(s, { type: 'exit' });
    });
    return s.info;
  }

  // (Re)starts the "no output while still starting" timer.
  private armQuiet(s: Live) {
    if (s.quiet) clearTimeout(s.quiet);
    s.quiet = setTimeout(() => this.apply(s, { type: 'quiet' }), QUIET_MS);
  }

  private apply(s: Live, ev: StatusEvent) {
    if (s.removed) return;
    const next = reduceStatus(s.info.status, ev);
    if (next === s.info.status && ev.type !== 'exit') return;
    if (next !== s.info.status) {
      s.info.status = next;
      s.info.statusSince = Date.now();
    }
    if (next !== 'starting' && s.quiet) {
      clearTimeout(s.quiet);
      s.quiet = null;
    }
    this.emit({ t: 'session', session: s.info });
  }

  hook(body: HookBody): boolean {
    this.log({ kind: 'hook', ...body });
    const s = this.live.get(body.sessionId);
    if (!s) {
      console.warn(`[hook] unknown session ${body.sessionId} (${body.event})`);
      return false;
    }
    const p = (body.payload ?? {}) as Record<string, unknown>;
    const native = s.info.agent === 'agy' ? p.conversationId : p.session_id;
    let changed = false;
    const nativeUpdate = nativeIdUpdate(s.info.nativeSessionId, body.event, native, p.source);
    if (nativeUpdate) {
      s.info.nativeSessionId = nativeUpdate.id;
      if (nativeUpdate.resumable !== undefined) s.info.resumable = nativeUpdate.resumable;
      changed = true;
    }
    if (!s.info.resumable && PROMPT_EVENTS.has(body.event)) {
      s.info.resumable = true;
      changed = true;
    }
    const tp = p.transcript_path ?? p.transcriptPath;
    if (typeof tp === 'string' && tp && tp !== s.info.transcriptPath) {
      s.info.transcriptPath = tp;
      changed = true;
    }
    const lim = detectLimit(s.info.agent, body.event, p);
    if (lim) {
      if (s.info.agent === 'claude' && lim.resetsAt === null && s.info.transcriptPath) lim.resetsAt = readResetsAt(s.info.transcriptPath);
      s.info.limit = { ...lim, at: Date.now() };
      changed = true;
    } else if (s.info.limit && isWorkingHook(body.event)) {
      delete s.info.limit;
      changed = true;
    }
    if (body.event === 'PermissionRequest') s.permBlocked = true;
    else if (isStatusHook(body.event)) s.permBlocked = false;
    const before = s.info.status;
    this.apply(s, { type: 'hook', event: body.event });
    if (changed && s.info.status === before) this.emit({ t: 'session', session: s.info });
    return true;
  }

  input(id: string, d: string) {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited') return;
    s.lastInputAt = Date.now();
    s.permBlocked = false;
    s.proc.write(d);
    this.apply(s, { type: 'input', data: d });
  }

  // Queues text to be pasted into the session once it is idle (see deliverable). False if the session is not running.
  enqueue(id: string, text: string): boolean {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited') return false;
    s.queue.push(text);
    s.info.queued = s.queue.length;
    this.emit({ t: 'session', session: s.info });
    this.queueTimer ??= setInterval(() => this.drain(), QUEUE_TICK_MS);
    return true;
  }

  private drain() {
    const now = Date.now();
    let pending = false;
    for (const s of this.live.values()) {
      if (!s.queue.length) continue;
      if (deliverable({ ...s, status: s.info.status, statusSince: s.info.statusSince }, now)) this.deliver(s, now);
      if (s.queue.length) pending = true;
    }
    if (!pending && this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
  }

  private deliver(s: Live, now: number) {
    const text = s.queue.shift()!;
    s.lastDeliveryAt = now;
    s.permBlocked = false;
    const frame = pasteFrame(text, s.modes.get(2004) === true, s.info.agent === 'codex' ? CODEX_NEWLINE : '\n');
    try {
      s.proc.write(frame);
    } catch (e) {
      console.warn('[inject]', (e as Error).message);
    }
    setTimeout(() => {
      if (s.removed || s.info.status === 'exited') return;
      try { s.proc.write('\r'); } catch (e) { console.warn('[inject]', (e as Error).message); }
    }, ENTER_DELAY_MS);
    s.info.queued = s.queue.length;
    this.emit({ t: 'session', session: s.info });
    this.log({ kind: 'inject', sessionId: s.info.id, chars: text.length, at: now });
  }

  private dropQueue(s: Live) {
    if (s.queue.length) this.log({ kind: 'inject-dropped', sessionId: s.info.id, count: s.queue.length, at: Date.now() });
    s.queue = [];
    if (s.info.queued) s.info.queued = 0;
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited' || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    cols = clamp(cols, 20, 500);
    rows = clamp(rows, 5, 200);
    try {
      s.proc.resize(cols, rows);
    } catch (e) {
      console.warn('[resize]', (e as Error).message);
      return;
    }
    s.info.cols = cols;
    s.info.rows = rows;
    this.emit({ t: 'session', session: s.info });
  }

  // Ends the PTY but keeps the session, so it can still be resumed; onExit marks it exited.
  kill(id: string) {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited') return;
    void this.endProc(s);
  }

  // Kills the PTY, but leaves a young claude running until it is past its fullscreen health check (CLAUDE_HEALTHY_MS).
  private endProc(s: Live): Promise<void> {
    const kill = () => {
      if (s.info.exitCode !== null) return;
      try {
        s.proc.kill();
      } catch (e) {
        console.warn('[kill]', (e as Error).message);
      }
    };
    const wait = s.info.agent === 'claude' ? (s.firstOutAt || Date.now()) + CLAUDE_HEALTHY_MS - Date.now() : 0;
    if (wait <= 0) {
      kill();
      return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(() => { kill(); resolve(); }, wait));
  }

  // Kills the PTY and forgets the session (no further broadcasts for it).
  remove(id: string): Promise<void> {
    this.dead.delete(id);
    const s = this.live.get(id);
    if (!s) return Promise.resolve();
    s.removed = true;
    this.dropQueue(s);
    if (s.quiet) clearTimeout(s.quiet);
    this.live.delete(id);
    // Killing an already-exited ConPTY makes node-pty's console-list helper print an AttachConsole stack.
    if (s.info.status === 'exited') return Promise.resolve();
    return this.endProc(s);
  }

  // Resolves once every PTY is killed (young claude sessions take up to CLAUDE_HEALTHY_MS).
  async killAll(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    await Promise.all([...this.live.keys()].map(id => this.remove(id)));
  }
}
