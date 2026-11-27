import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pty from 'node-pty';
import type { AgentKind, HookBody, PermissionMode, ServerMsg, SessionInfo } from '../shared/protocol.ts';
import { isDeepAgent } from '../shared/protocol.ts';
import { agyConversationState, agyUserStatusLine, buildLaunch, userStatusLine } from './agents.ts';
import type { LaunchCliMeta } from './agents.ts';
import { detectLimit, readResetsAt } from './quota.ts';
import { isStatusHook, isWorkingHook, reduceStatus } from './status.ts';
import type { StatusEvent } from './status.ts';

const BUF_KEEP = 1024 * 1024;
const BUF_MAX = BUF_KEEP + 256 * 1024; // trim in batches so we do not re-slice on every chunk
const QUIET_MS = 4000;
const SCROLL_SAVE_MS = 30_000; // how often changed terminal output is written to `<stateDir>/scrollback`
const QUEUE_TICK_MS = 250;
const TYPING_QUIET_MS = 5000; // no user keystrokes this long before a queued message is pasted
const DELIVERY_GAP_MS = 2000; // between two deliveries to the same session
// Margin after the Stop hook: it fires as the turn ends, while the TUI may still be redrawing its prompt.
const SETTLE_MS = 1500;
const ENTER_DELAY_MS = 300; // pasted text first, Enter separately
const ENTER_POLL_MS = 50;
// Codex on Windows drains pastes as per-key console events (~2,000 chars/s) and suppresses Enter for ~120 ms after a
// paste burst so trailing newlines in clipboard pastes do not auto-submit. Wait for both a size-based floor and PTY
// echo silence before sending `\r`, capped so continuous status output cannot starve submission.
const CODEX_ENTER_MS_PER_CHAR = 0.5;
const CODEX_ENTER_FLOOR_CAP_MS = 6000;
const CODEX_ECHO_QUIET_MS = 250;
const ECHO_QUIET_MS = 150;
const ENTER_MAX_WAIT_MS = 12_000;
const CODEX_SANDBOX_WAIT_MS = 15_000;
const CODEX_SANDBOX_SETTLE_MS = 400;
const DELIVERY_INFLIGHT_MS = 8000; // lock queue until UserPromptSubmit/PreInvocation arrives (or lock expires)
const SYSTEM_INJECT_TTL_MS = 15_000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// Claude Code notes its PID when a fullscreen launch starts and clears it 10 s after the first frame. A process killed
// before that counts as a crash, and two of them turn fullscreen (and with it mouse clicks on its menus) off for that version.
const CLAUDE_HEALTHY_MS = 11_000;
export const ENV_STRIP = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|CODEX_SANDBOX|CODEX_THREAD|AGY_SESSION)/;
export const STARTUP_BLOCK_RE = /Hooks need review|Trust all and continue|Do you trust the files in this folder|trust this folder|No,\s*exit/i;

const TERM_REPORT_RE = /^(?:\x1b\[(?:[IO]|<\d+(?:;\d+)*[Mm]|\d+(?:;\d+)*R|[?>=]?[\d;]*c|\?[\d;]+\$y)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

// Auto-generated terminal reports (focus events, SGR mouse, CPR, DA, OSC replies) are NOT user typing.
export function isTerminalReportSequence(d: string): boolean {
  return d === '' || TERM_REPORT_RE.test(d);
}

// Removes ANSI control sequences (expanding CSI cursor-forward into spaces) so TUI trust prompts remain matchable.
export function stripAnsiForMatch(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.max(1, Number(n) || 1)))
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// Prepends `dir` to Path/PATH while deduplicating case-variant keys (`Path` vs `PATH` on Windows).
export function prependEnvPath(env: Record<string, string>, dir: string): void {
  if (!dir) return;
  let existing = '';
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path') {
      if (!existing && env[k]) existing = env[k];
      delete env[k];
    }
  }
  const first = existing.split(path.delimiter)[0];
  const alreadyFirst = first && (process.platform === 'win32' ? first.toLowerCase() === dir.toLowerCase() : first === dir);
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  env[key] = alreadyFirst ? existing : existing ? `${dir}${path.delimiter}${existing}` : dir;
}

export interface EnqueueOptions {
  system?: boolean;
  onDelivered?: () => void;
}

interface QueuedMessage {
  text: string;
  system: boolean;
  onDelivered?: () => void;
}

interface Live {
  info: SessionInfo;
  cwd: string;
  collabDir?: string; // `<stateDir>/collab/<projectId>`, passed to the CLI as an extra workspace folder
  peerToken: string;
  proc: pty.IPty;
  buf: string;
  quiet: NodeJS.Timeout | null;
  removed: boolean;
  exitWaiters: (() => void)[];
  queue: QueuedMessage[]; // messages waiting to be pasted (FIFO)
  permBlocked: boolean; // a permission prompt is open, so typed text would answer it
  startupBlocked: boolean; // a trust / hooks-review startup prompt was detected before first turn
  firstTurnSeen: boolean;
  startupTail: string;
  codexTail: string;
  inputDisabledUntil: number; // Codex composer disabled while `Setting up sandbox...` runs
  hasDraft: boolean; // user typed/pasted uncommitted characters at the prompt
  interruptedByUser: boolean; // user pressed Ctrl+C while messages were queued
  lastInputAt: number; // last keystroke from the user (injected writes & terminal reports do not count)
  lastDeliveryAt: number;
  deliveringUntil: number;
  inputSeq: number;
  // Bumped by anything that can answer or replace an on-screen prompt (input, delivery, a new permission request,
  // a detected startup prompt). A phone answer carries the value it saw, so it only lands on that same wait.
  waitSeq: number;
  // Bumped by every PTY output chunk: a prompt answer also needs the screen it was read from to still be the screen.
  outSeq: number;
  enterTimer: NodeJS.Timeout | null;
  enterWasSystem: boolean;
  systemInjectedPending: number;
  systemInjectedUntil: number;
  subagentWait: boolean; // true while agy main conversation waits for async subagents (intermediate-stop)
  modes: Map<number, boolean>; // last state of each REPLAY_MODES mode the CLI set
  tail: string; // end of the previous PTY chunk, so a mode switch split across chunks is still seen
  trimmed: boolean; // buf has lost its start
  scrollDirty: boolean; // buf changed since it was last written to disk
  firstOutAt: number; // 0 until the PTY first writes
  lastOutAt: number; // 0 until the PTY writes non-empty output
  initialPromptPending: boolean; // true until the launch prompt's first hook arrives, so spawn jitter cannot reorder tasks
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
  projectId?: string;
  agent: AgentKind;
  cwd: string;
  prompt: string;
  model?: string; // optional CLI model slug (for agy)
  cols?: number;
  rows?: number;
  resume?: string; // native session id to reopen
  instructions?: string; // standing instructions appended to the CLI's system prompt (see buildLaunch)
  permissionMode?: PermissionMode; // default 'full'; 'normal' omits skip-permission flags
  readOnly?: boolean;
  cliMeta?: LaunchCliMeta; // resolved executable & flags for generic/custom CLIs
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

const normPath = (p: string) => {
  const clean = path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
};

// Interactive agy sessions launched by Shoal carry both the project cwd and `<stateDir>/agy-hooks` in workspacePaths.
// A nested `agy -p` run inside a shell tool (or a branched worker workspace) lacks the project cwd.
// agy leaves a folder it does not trust yet out of workspacePaths, so a session started in a new folder lists only the
// folders Shoal added (agy-hooks, the project's collab folder, agy-instructions). It counts as primary only when it
// lists our collab folder and nothing else: a branched worker lists its copy of the project.
export function agyPrimaryWorkspaces(cwd: string, stateDir: string, workspacePaths: unknown, collabDir?: string): boolean {
  if (!Array.isArray(workspacePaths)) return true;
  const have = new Set(workspacePaths.filter((x): x is string => typeof x === 'string' && x.length > 0).map(normPath));
  const hooks = normPath(path.join(stateDir, 'agy-hooks'));
  if (!have.has(hooks)) return false;
  if (have.has(normPath(cwd))) return true;
  if (!collabDir || !have.has(normPath(collabDir))) return false;
  const ours = new Set([hooks, normPath(collabDir), normPath(path.join(stateDir, 'agy-instructions'))]);
  return [...have].every(p => ours.has(p));
}

// agy emits Stop with `fullyIdle: false` (or `continuationActive: true`) when the main agent pauses its turn solely to
// wait on async subagents or background commands and will auto-resume without user input.
export function isAgyIntermediateStop(p: Record<string, unknown>): boolean {
  if (typeof p.error === 'string' && p.error.trim() !== '') return false;
  if (detectLimit('agy', 'Stop', p)) return false;
  return p.fullyIdle === false || p.continuationActive === true;
}

export type AgyHookAction =
  | { kind: 'ignore' } // subagent, swarm worker, or nested CLI: logged for token usage, ignored for session/task state
  | { kind: 'intermediate-stop'; nativeId?: string; resumable?: boolean }
  | { kind: 'primary'; nativeId?: string; resumable?: boolean };

// Classifies an agy hook so background subagents (`invoke_subagent`), swarm workers, and nested `agy -p` calls never
// hijack `nativeSessionId` / `transcriptPath` or trigger premature `待验收` cards, while genuine in-TUI `/resume` or
// `/new` conversation switches (which enter via SessionStart or PreInvocation with a non-empty lastUserInput) still track.
export function agyHookDisposition(opts: {
  currentId: string | null;
  event: string;
  payload: Record<string, unknown>;
  cwd: string;
  stateDir: string;
  collabDir?: string;
}): AgyHookAction {
  const { currentId, event, payload: p, cwd, stateDir, collabDir } = opts;
  if (event === 'RateLimits') return { kind: 'primary' };
  const conv = typeof p.conversationId === 'string' ? p.conversationId : '';
  if (!conv) return { kind: 'ignore' };
  if (currentId === null) {
    if (!agyPrimaryWorkspaces(cwd, stateDir, p.workspacePaths, collabDir)) return { kind: 'ignore' };
    if (agyConversationState(conv).kind === 'subagent') return { kind: 'ignore' };
    if (event === 'Stop' && isAgyIntermediateStop(p)) return { kind: 'intermediate-stop', nativeId: conv };
    return { kind: 'primary', nativeId: conv };
  }
  if (conv !== currentId) {
    if (event !== 'SessionStart' && event !== 'PreInvocation') return { kind: 'ignore' };
    if (!agyPrimaryWorkspaces(cwd, stateDir, p.workspacePaths, collabDir)) return { kind: 'ignore' };
    if (typeof p.lastUserInput !== 'string' || p.lastUserInput.trim() === '') return { kind: 'ignore' };
    const st = agyConversationState(conv);
    if (st.kind === 'subagent' && !st.hasUserTurn) return { kind: 'ignore' };
    return { kind: 'primary', nativeId: conv, resumable: true };
  }
  if (event === 'Stop' && isAgyIntermediateStop(p)) return { kind: 'intermediate-stop' };
  return { kind: 'primary' };
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
// Only used on Windows: on POSIX Codex gets the whole text through bracketed paste, so a plain \n is kept.
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
  initialPromptPending?: boolean;
  startupBlocked?: boolean;
  deliveringUntil?: number;
  inputDisabledUntil?: number;
  enterPending?: boolean;
  hasDraft?: boolean;
  interruptedByUser?: boolean;
}

export function enterReady(opts: {
  agent: AgentKind;
  chars: number;
  injectAt: number;
  lastOutAt: number;
  now: number;
}): { ready: boolean; nextDelayMs: number } {
  const floor = opts.agent === 'codex'
    ? Math.min(CODEX_ENTER_FLOOR_CAP_MS, ENTER_DELAY_MS + Math.ceil(Math.max(0, opts.chars) * CODEX_ENTER_MS_PER_CHAR))
    : ENTER_DELAY_MS;
  const elapsed = Math.max(0, opts.now - opts.injectAt);
  if (elapsed >= ENTER_MAX_WAIT_MS) return { ready: true, nextDelayMs: 0 };
  const floorRem = Math.max(0, floor - elapsed);
  const quietTarget = opts.agent === 'codex' ? CODEX_ECHO_QUIET_MS : ECHO_QUIET_MS;
  const quietRem = opts.lastOutAt > opts.injectAt
    ? Math.max(0, quietTarget - Math.max(0, opts.now - opts.lastOutAt))
    : 0;
  const wait = Math.max(floorRem, quietRem);
  if (wait <= 0) return { ready: true, nextDelayMs: 0 };
  return { ready: false, nextDelayMs: Math.min(ENTER_MAX_WAIT_MS - elapsed, Math.max(ENTER_POLL_MS, wait)) };
}

// Whether the head of a session's queue may be pasted now.
export function deliverable(s: DeliveryState, now: number): boolean {
  return (s.status === 'needs_you' || s.status === 'idle')
    && now - s.statusSince >= SETTLE_MS
    && !s.permBlocked
    && !s.initialPromptPending
    && !s.startupBlocked
    && !s.enterPending
    && !s.hasDraft
    && !s.interruptedByUser
    && now >= (s.deliveringUntil ?? 0)
    && now >= (s.inputDisabledUntil ?? 0)
    && now - s.lastInputAt >= TYPING_QUIET_MS
    && now - s.lastDeliveryAt >= DELIVERY_GAP_MS;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export class SessionManager {
  private live = new Map<string, Live>();
  private dead = new Map<string, SessionInfo>(); // restored from disk, no process
  private peerTokens = new Map<string, string>(); // peerToken -> sessionId
  private listeners = new Set<(m: ServerMsg) => void>();
  private cfg: SessionManagerConfig;
  private queueTimer: NodeJS.Timeout | null = null;
  private lastDesktopActive = 0;
  private scrollTimer: NodeJS.Timeout | null = null;

  constructor(cfg: SessionManagerConfig) {
    this.cfg = cfg;
  }

  // Terminal output is kept on disk so an exited session can still be shown after Shoal restarts.
  private scrollFile(id: string): string {
    return path.join(this.cfg.stateDir, 'scrollback', `${id}.log`);
  }

  private saveScrollback(s: Live) {
    s.scrollDirty = false;
    if (!s.buf) return;
    const file = this.scrollFile(s.info.id);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, (s.trimmed ? modePrefix(s.modes) : '') + s.buf);
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn('[scrollback]', (e as Error).message);
    }
  }

  private deleteScrollback(id: string) {
    fs.rm(this.scrollFile(id), { force: true }, e => { if (e) console.warn('[scrollback]', e.message); });
  }

  private armScrollSave() {
    if (this.scrollTimer) return;
    this.scrollTimer = setInterval(() => {
      for (const s of this.live.values()) if (s.scrollDirty && !s.removed) this.saveScrollback(s);
    }, SCROLL_SAVE_MS);
    this.scrollTimer.unref?.();
  }

  markDesktopActive(now = Date.now()): void {
    this.lastDesktopActive = now;
  }

  lastDesktopActiveAt(): number {
    return this.lastDesktopActive;
  }

  private syncBlocked(s: Live): boolean {
    const next = s.permBlocked ? 'permission' : s.startupBlocked ? 'startup' : undefined;
    if (s.info.blocked === next) return false;
    if (next) s.info.blocked = next;
    else delete s.info.blocked;
    return true;
  }

  subscribe(fn: (m: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: ServerMsg) {
    for (const fn of this.listeners) fn(m);
  }

  // Registers exited sessions loaded from the persisted state so they show up in snapshots.
  // Scrollback files of sessions that are no longer in the state are deleted.
  restore(infos: SessionInfo[]) {
    for (const i of infos) this.dead.set(i.id, i);
    const dir = path.join(this.cfg.stateDir, 'scrollback');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const id = n.replace(/.log(.tmp)?$/, '');
      if (n.endsWith('.tmp') || (!this.dead.has(id) && !this.live.has(id))) fs.rmSync(path.join(dir, n), { force: true });
    }
  }

  // Clears the `interrupted` flag on restored sessions (e.g. when the user dismisses the recovery banner or batch-resumes).
  clearInterrupted(onlyIds?: ReadonlySet<string>): SessionInfo[] {
    const cleared: SessionInfo[] = [];
    for (const [id, info] of this.dead) {
      if (!info.interrupted || (onlyIds && !onlyIds.has(id))) continue;
      const next = { ...info };
      delete next.interrupted;
      this.dead.set(id, next);
      cleared.push(next);
    }
    return cleared;
  }

  list(): SessionInfo[] {
    return [...this.dead.values(), ...[...this.live.values()].map(s => s.info)];
  }

  replays(): { id: string; d: string }[] {
    return [...this.live.values()].filter(s => s.buf).map(s => ({ id: s.info.id, d: (s.trimmed ? modePrefix(s.modes) : '') + s.buf }));
  }

  // The wait a phone prompt answer is bound to: a live, blocked session's current waitSeq plus its replay at the same
  // instant (info is a copy, so a later change cannot leak into a screen read from this instant). Null when nothing waits.
  promptWait(id: string): { info: SessionInfo; waitSeq: number; outSeq: number; replay: string | null } | null {
    const s = this.live.get(id);
    if (!s || s.removed || s.info.status === 'exited' || !s.info.blocked) return null;
    return { info: { ...s.info }, waitSeq: s.waitSeq, outSeq: s.outSeq, replay: this.replayOf(id) };
  }

  // Writes a phone's prompt answer only if the same wait is still open (nothing typed, delivered or re-prompted since
  // `waitSeq` was read) and the screen it was read from is still the screen (no output since `outSeq`). 'redrawn'
  // means only the output moved on: the caller may read the screen again. Synchronous, so nothing can slip between the
  // check and the write.
  answerPrompt(id: string, waitSeq: number, outSeq: number, data: string): 'ok' | 'stale' | 'redrawn' {
    const s = this.live.get(id);
    if (!s || s.removed || s.info.status === 'exited' || !s.info.blocked || s.waitSeq !== waitSeq) return 'stale';
    if (s.outSeq !== outSeq) return 'redrawn';
    this.input(id, data, { fromMobile: true });
    return 'ok';
  }

  // A live session's buffer, or the saved output of a session restored from disk.
  replayOf(id: string): string | null {
    const s = this.live.get(id);
    if (s) return s.buf ? (s.trimmed ? modePrefix(s.modes) : '') + s.buf : null;
    if (!this.dead.has(id)) return null;
    try {
      return fs.readFileSync(this.scrollFile(id), 'utf8') || null;
    } catch {
      return null;
    }
  }

  // True for sessions whose output `replays()` already sends on connect.
  hasLiveBuffer(id: string): boolean {
    return !!this.live.get(id)?.buf;
  }

  private log(obj: unknown) {
    try {
      fs.appendFileSync(path.join(this.cfg.stateDir, 'events.jsonl'), JSON.stringify(obj) + '\n');
    } catch (e) {
      console.error('[events.jsonl]', (e as Error).message);
    }
  }

  resolvePeerToken(token: string): { session: SessionInfo; subagentWait: boolean } | undefined {
    if (!token) return undefined;
    const got = Buffer.from(token);
    for (const [candidate, sid] of this.peerTokens) {
      const want = Buffer.from(candidate);
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
        const s = this.live.get(sid);
        if (!s || s.removed || s.info.status === 'exited') return undefined;
        return { session: s.info, subagentWait: s.subagentWait };
      }
    }
    return undefined;
  }

  spawn(o: SpawnOptions): SessionInfo {
    const id = crypto.randomUUID();
    const deep = isDeepAgent(o.agent);
    const permissionMode: PermissionMode = o.permissionMode === 'normal' ? 'normal' : 'full';
    const peerToken = deep ? crypto.randomBytes(32).toString('hex') : '';
    const collabDir = deep && o.projectId ? path.join(this.cfg.stateDir, 'collab', o.projectId) : undefined;
    const launch = buildLaunch({
      agent: o.agent, sessionId: id, prompt: o.prompt, stateDir: this.cfg.stateDir,
      resume: o.resume, model: o.model, collabDir, instructions: deep ? o.instructions : undefined,
      permissionMode, readOnly: o.readOnly, cliMeta: o.cliMeta,
    });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_STRIP.test(k))) as Record<string, string>;
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    if (deep) {
      prependEnvPath(env, path.join(this.cfg.stateDir, 'bin'));
      Object.assign(env, {
        // Claude Code only turns on synchronized output (DEC 2026) for terminals it recognizes; xterm.js supports it, and
        // without it half-drawn frames show the cursor jumping around the spinner and status lines.
        ...(o.agent === 'claude' ? { CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1' } : {}),
        WORKBENCH_SESSION_ID: id,
        WORKBENCH_PORT: String(this.cfg.port),
        WORKBENCH_HOOK_TOKEN: this.cfg.token,
        WORKBENCH_PEER_TOKEN: peerToken,
        WORKBENCH_NODE: process.execPath,
        ...(o.agent === 'pi' ? { WORKBENCH_PI_CWD: o.cwd, WORKBENCH_PI_PERMISSION: permissionMode } : {}),
        ...(collabDir ? { WORKBENCH_COLLAB_DIR: collabDir, WORKBENCH_PEERS_FILE: path.join(collabDir, 'PEERS.md') } : {}),
      });
    }
    // Our status line (for the rate limits) replaces the user's own; the relay script runs theirs.
    const userSl = o.agent === 'claude' ? userStatusLine(o.cwd) : o.agent === 'agy' ? agyUserStatusLine().command : undefined;
    if (userSl) env.WORKBENCH_USER_STATUSLINE = userSl;
    const cols = clamp(o.cols ?? 120, 20, 500);
    const rows = clamp(o.rows ?? 36, 5, 200);
    const proc = pty.spawn(launch.file, launch.verbatimArgs ?? launch.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env });
    const now = Date.now();
    const s: Live = {
      info: {
        id, taskId: o.taskId, agent: o.agent, nativeSessionId: launch.nativeSessionId,
        resumable: deep && Boolean(o.resume || o.prompt),
        permissionMode,
        status: 'starting', statusSince: now, startedAt: now, exitCode: null, cols, rows,
      },
      cwd: o.cwd, collabDir, peerToken, proc, buf: '', quiet: null, removed: false, exitWaiters: [],
      queue: [], permBlocked: false, startupBlocked: false, firstTurnSeen: false, startupTail: '', codexTail: '', inputDisabledUntil: 0,
      hasDraft: false, interruptedByUser: false, lastInputAt: 0, lastDeliveryAt: 0, deliveringUntil: 0,
      inputSeq: 0, waitSeq: 0, outSeq: 0, enterTimer: null, enterWasSystem: false, systemInjectedPending: 0, systemInjectedUntil: 0, subagentWait: false,
      modes: new Map(), tail: '', trimmed: false, scrollDirty: false, firstOutAt: 0, lastOutAt: 0,
      initialPromptPending: deep && Boolean(o.prompt && !o.resume),
    };
    this.live.set(id, s);
    if (peerToken) this.peerTokens.set(peerToken, id);
    this.armQuiet(s);
    this.armScrollSave();
    proc.onData(d => {
      const outNow = Date.now();
      if (!s.firstOutAt) s.firstOutAt = outNow;
      if (d) {
        s.lastOutAt = outNow;
        s.outSeq++;
      }
      const prevTail = s.tail;
      trackModes(s.modes, prevTail + d);
      s.tail = (prevTail + d).slice(-MODE_TAIL);
      if (deep && !s.firstTurnSeen) {
        s.startupTail = (s.startupTail + stripAnsiForMatch(prevTail + d)).slice(-1024);
        if (!s.startupBlocked && STARTUP_BLOCK_RE.test(s.startupTail)) {
          s.startupBlocked = true;
          s.waitSeq++;
          if (this.syncBlocked(s) && !s.removed) this.emit({ t: 'session', session: s.info });
        }
      }
      if (s.info.agent === 'codex') {
        s.codexTail = (s.codexTail + stripAnsiForMatch(prevTail + d)).slice(-1024);
        const disIdx = s.codexTail.lastIndexOf('Input disabled until setup completes');
        const rdyIdx = s.codexTail.lastIndexOf('Sandbox ready');
        if (disIdx >= 0 && rdyIdx < disIdx && s.codexTail.slice(Math.max(0, disIdx - 240), disIdx).includes('Setting up sandbox')) {
          if (s.inputDisabledUntil <= outNow) s.inputDisabledUntil = outNow + CODEX_SANDBOX_WAIT_MS;
        } else if (rdyIdx >= 0 && s.inputDisabledUntil > outNow + CODEX_SANDBOX_SETTLE_MS) {
          s.inputDisabledUntil = outNow + CODEX_SANDBOX_SETTLE_MS;
        }
      }
      s.buf += d;
      s.scrollDirty = true;
      if (s.buf.length > BUF_MAX) {
        let tail = s.buf.slice(-BUF_KEEP);
        const nl = tail.indexOf('\n');
        if (nl >= 0 && nl < 4096) tail = tail.slice(nl + 1);
        s.buf = tail;
        s.trimmed = true;
      }
      if (s.info.status === 'starting') {
        if (!deep && d) this.apply(s, { type: 'ready' });
        else this.armQuiet(s);
      }
      if (!s.removed) this.emit({ t: 'out', id, d });
    });
    proc.onExit(e => {
      if (s.peerToken) this.peerTokens.delete(s.peerToken);
      if (s.quiet) clearTimeout(s.quiet);
      if (s.enterTimer) {
        clearTimeout(s.enterTimer);
        s.enterTimer = null;
      }
      s.deliveringUntil = 0;
      s.info.exitCode = e.exitCode;
      this.log({ kind: 'exit', sessionId: id, agent: o.agent, exitCode: e.exitCode, at: Date.now() });
      if (!s.removed) this.saveScrollback(s);
      this.dropQueue(s);
      this.apply(s, { type: 'exit' });
      const waiters = s.exitWaiters.splice(0);
      for (const w of waiters) w();
    });
    return s.info;
  }

  // (Re)starts the "no output while still starting" timer.
  private armQuiet(s: Live) {
    if (s.quiet) clearTimeout(s.quiet);
    s.quiet = setTimeout(() => {
      // Fallback for CLIs that start quietly without emitting UserPromptSubmit: never leave initialPromptPending wedged.
      if (s.info.status === 'starting') s.initialPromptPending = false;
      this.apply(s, isDeepAgent(s.info.agent) ? { type: 'quiet' } : { type: 'ready' });
    }, QUIET_MS);
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

  hook(body: HookBody): false | { userTurn: boolean; intermediateStop?: boolean; systemInjected?: boolean } {
    const s = this.live.get(body.sessionId);
    const p = (body.payload ?? {}) as Record<string, unknown>;
    if (s?.info.agent === 'pi' && (p.cwd !== s.cwd || typeof p.session_id !== 'string'
      || (body.event !== 'SessionStart' && s.info.nativeSessionId && p.session_id !== s.info.nativeSessionId))) return false;
    this.log({ kind: 'hook', ...body });
    if (!s) {
      console.warn(`[hook] unknown session ${body.sessionId} (${body.event})`);
      return false;
    }
    const beforeStatus = s.info.status;
    const beforeNative = s.info.nativeSessionId;
    let changed = false;
    if (s.info.agent === 'agy') {
      const act = agyHookDisposition({
        currentId: s.info.nativeSessionId,
        event: body.event,
        payload: p,
        cwd: s.cwd,
        stateDir: this.cfg.stateDir,
        collabDir: s.collabDir,
      });
      if (act.kind === 'ignore') return false;
      if (act.nativeId && act.nativeId !== s.info.nativeSessionId) {
        s.info.nativeSessionId = act.nativeId;
        if (act.resumable !== undefined) s.info.resumable = act.resumable;
        changed = true;
      }
      const tp = p.transcript_path ?? p.transcriptPath;
      if (typeof tp === 'string' && tp && tp !== s.info.transcriptPath) {
        s.info.transcriptPath = tp;
        changed = true;
      }
      if (act.kind === 'intermediate-stop') {
        s.subagentWait = true;
        const prevStatus = s.info.status;
        this.apply(s, { type: 'hook', event: 'PreInvocation' });
        if (changed && s.info.status === prevStatus) this.emit({ t: 'session', session: s.info });
        return { userTurn: false, intermediateStop: true };
      }
      if (body.event !== 'RateLimits') s.subagentWait = false;
    } else if (s.info.agent === 'pi') {
      const id = typeof p.session_id === 'string' ? p.session_id : null;
      const file = typeof p.transcript_path === 'string' ? p.transcript_path : undefined;
      const leaf = typeof p.leaf_id === 'string' || p.leaf_id === null ? p.leaf_id : undefined;
      const resumable = !!file && p.resumable === true;
      changed = s.info.nativeSessionId !== id || s.info.transcriptPath !== file
        || s.info.transcriptLeafId !== leaf || s.info.resumable !== resumable;
      s.info.nativeSessionId = id;
      s.info.transcriptPath = file;
      s.info.transcriptLeafId = leaf;
      s.info.resumable = resumable;
      if (body.event === 'SessionStart') {
        s.startupBlocked = false;
        if (this.syncBlocked(s)) changed = true;
      }
    } else {
      const nativeUpdate = nativeIdUpdate(s.info.nativeSessionId, body.event, p.session_id, p.source);
      if (nativeUpdate) {
        s.info.nativeSessionId = nativeUpdate.id;
        if (nativeUpdate.resumable !== undefined) s.info.resumable = nativeUpdate.resumable;
        changed = true;
      }
      const tp = p.transcript_path ?? p.transcriptPath;
      if (typeof tp === 'string' && tp && tp !== s.info.transcriptPath) {
        s.info.transcriptPath = tp;
        changed = true;
      }
    }
    if (s.info.agent !== 'pi' && !s.info.resumable && PROMPT_EVENTS.has(body.event)) {
      s.info.resumable = true;
      changed = true;
    }
    let userTurn = false;
    let systemInjected = false;
    if (PROMPT_EVENTS.has(body.event)) {
      s.firstTurnSeen = true;
      s.startupBlocked = false;
      if (this.syncBlocked(s)) changed = true;
      s.deliveringUntil = 0;
      s.inputDisabledUntil = 0;
      s.hasDraft = false;
      s.interruptedByUser = false;
      const now = Date.now();
      if (s.systemInjectedPending > 0 && now <= s.systemInjectedUntil) {
        s.systemInjectedPending--;
        systemInjected = true;
      } else if (s.systemInjectedPending > 0) {
        s.systemInjectedPending = 0;
      }
      if (s.initialPromptPending) {
        s.initialPromptPending = false;
      } else if (!systemInjected && (body.event === 'UserPromptSubmit' || beforeStatus !== 'working' || s.info.nativeSessionId !== beforeNative)) {
        userTurn = true;
      }
    } else if (body.event === 'SessionStart' && beforeNative !== null && s.info.nativeSessionId !== beforeNative) {
      userTurn = true;
    } else if (body.event === 'Stop' || body.event === 'StopFailure') {
      s.firstTurnSeen = true;
      s.startupBlocked = false;
      if (this.syncBlocked(s)) changed = true;
      s.deliveringUntil = 0;
      s.initialPromptPending = false;
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
    if (body.event === 'PermissionRequest') {
      s.permBlocked = true;
      s.waitSeq++;
    }
    else if (isStatusHook(body.event)) s.permBlocked = false;
    if (this.syncBlocked(s)) changed = true;
    const before = s.info.status;
    this.apply(s, { type: 'hook', event: body.event });
    if (changed && s.info.status === before) this.emit({ t: 'session', session: s.info });
    return { userTurn, ...(systemInjected && { systemInjected: true }) };
  }

  input(id: string, d: string, opts?: { fromMobile?: boolean }) {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited') return;
    if (isTerminalReportSequence(d)) {
      s.proc.write(d);
      return;
    }
    if (!opts?.fromMobile) this.lastDesktopActive = Date.now();
    const wasPermBlocked = s.permBlocked;
    s.lastInputAt = Date.now();
    s.inputSeq++;
    s.waitSeq++;
    s.permBlocked = false;
    if (s.enterTimer) {
      clearTimeout(s.enterTimer);
      s.enterTimer = null;
      s.deliveringUntil = 0;
      if (s.enterWasSystem && s.systemInjectedPending > 0) s.systemInjectedPending--;
      s.enterWasSystem = false;
    }
    if (d.includes('\x03')) {
      s.hasDraft = false;
      s.deliveringUntil = 0;
      if (s.queue.length > 0) s.interruptedByUser = true;
    } else if (d.includes('\r') || d.includes('\n')) {
      s.hasDraft = false;
      s.interruptedByUser = false;
      s.startupBlocked = false;
      s.initialPromptPending = false;
    } else if (d.includes('\x15') || d === '\x1b') {
      s.hasDraft = false;
    } else if (!wasPermBlocked && (s.info.status === 'needs_you' || s.info.status === 'idle')) {
      const cleaned = d.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
      if (/[^\x00-\x1f\x7f]/.test(cleaned) && !cleaned.startsWith('\x1b')) {
        s.hasDraft = true;
      }
    }
    const blockedChanged = this.syncBlocked(s);
    const prevStatus = s.info.status;
    s.proc.write(d);
    this.apply(s, { type: 'input', data: d });
    if (blockedChanged && s.info.status === prevStatus) this.emit({ t: 'session', session: s.info });
  }

  // Queues text to be pasted into the session once it is idle (see deliverable). False if the session is not running.
  enqueue(id: string, text: string, opts?: EnqueueOptions): boolean {
    const s = this.live.get(id);
    if (!s || s.info.status === 'exited') return false;
    const system = opts?.system === true;
    if (!system) {
      // Explicit human action from UI unfreezes prior Ctrl+C / draft blocks on this session.
      s.interruptedByUser = false;
      s.hasDraft = false;
    }
    s.queue.push({ text, system, onDelivered: opts?.onDelivered });
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
      if (deliverable({ ...s, status: s.info.status, statusSince: s.info.statusSince, enterPending: s.enterTimer !== null }, now)) {
        this.deliver(s, now);
      }
      if (s.queue.length) pending = true;
    }
    if (!pending && this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
  }

  private deliver(s: Live, now: number) {
    const item = s.queue.shift()!;
    const { text, system, onDelivered } = item;
    const cleanChars = sanitizePaste(text).length;
    const initial = enterReady({ agent: s.info.agent, chars: cleanChars, injectAt: now, lastOutAt: s.lastOutAt, now });
    s.lastDeliveryAt = now;
    s.deliveringUntil = now + initial.nextDelayMs + DELIVERY_INFLIGHT_MS;
    s.permBlocked = false;
    s.waitSeq++;
    this.syncBlocked(s);
    if (system) {
      s.systemInjectedPending++;
      s.systemInjectedUntil = now + initial.nextDelayMs + SYSTEM_INJECT_TTL_MS;
    }
    const seq = s.inputSeq;
    const frame = pasteFrame(text, s.modes.get(2004) === true, s.info.agent === 'codex' && process.platform === 'win32' ? CODEX_NEWLINE : '\n');
    try {
      s.proc.write(frame);
    } catch (e) {
      console.warn('[inject]', (e as Error).message);
    }
    if (s.enterTimer) clearTimeout(s.enterTimer);
    s.enterWasSystem = system;
    const injectAt = now;
    const scheduleEnter = (delayMs: number) => {
      s.enterTimer = setTimeout(() => {
        s.enterTimer = null;
        if (s.removed || s.info.status === 'exited' || s.inputSeq !== seq) {
          s.enterWasSystem = false;
          s.deliveringUntil = 0;
          if (system && s.systemInjectedPending > 0) s.systemInjectedPending--;
          return;
        }
        const pollNow = Date.now();
        const r = enterReady({
          agent: s.info.agent,
          chars: cleanChars,
          injectAt,
          lastOutAt: s.lastOutAt,
          now: pollNow,
        });
        if (!r.ready) {
          s.deliveringUntil = pollNow + r.nextDelayMs + DELIVERY_INFLIGHT_MS;
          if (system) s.systemInjectedUntil = pollNow + r.nextDelayMs + SYSTEM_INJECT_TTL_MS;
          scheduleEnter(r.nextDelayMs);
          return;
        }
        s.enterWasSystem = false;
        s.lastDeliveryAt = pollNow;
        s.deliveringUntil = pollNow + DELIVERY_INFLIGHT_MS;
        if (system) s.systemInjectedUntil = pollNow + SYSTEM_INJECT_TTL_MS;
        try {
          s.proc.write('\r');
          onDelivered?.();
        } catch (e) {
          console.warn('[inject]', (e as Error).message);
        }
      }, delayMs);
    };
    scheduleEnter(initial.nextDelayMs);
    s.info.queued = s.queue.length;
    this.emit({ t: 'session', session: s.info });
    this.log({ kind: 'inject', sessionId: s.info.id, chars: text.length, system, at: now });
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
  // On Windows ConPTY, `node-pty`'s `kill()` uses an async `conpty_console_list_agent` fork and does not wait for the
  // shell process to exit; calling `process.exit(0)` right away then deadlocks inside `conpty.node`'s ThreadSafeFunction
  // finalizer (`th->join()`). Killing the process tree first with `taskkill.exe` and awaiting `onExit` avoids both
  // leaked `CREATE_NO_WINDOW` descendants and the exit deadlock.
  private endProc(s: Live): Promise<void> {
    const kill = (): Promise<void> => {
      if (s.info.exitCode !== null) return Promise.resolve();
      const realWinPty = process.platform === 'win32' && '_agent' in s.proc && Number.isInteger(s.proc.pid) && s.proc.pid > 0;
      if (!realWinPty) {
        try {
          s.proc.kill();
        } catch (e) {
          console.warn('[kill]', (e as Error).message);
        }
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        let settled = false;
        let ptyExited = false;
        let treeKilled = false;
        const done = () => {
          if (settled || !ptyExited || !treeKilled) return;
          settled = true;
          clearTimeout(timer);
          const idx = s.exitWaiters.indexOf(onPtyExit);
          if (idx >= 0) s.exitWaiters.splice(idx, 1);
          // Yield one event-loop turn so `conpty.node` finishes `ThreadSafeFunction.Release()` after `onExit`.
          setImmediate(resolve);
        };
        const onPtyExit = () => {
          ptyExited = true;
          done();
        };
        const timer = setTimeout(() => {
          ptyExited = true;
          treeKilled = true;
          done();
        }, 3000);
        timer.unref?.();
        s.exitWaiters.push(onPtyExit);
        // Kill the whole ConPTY process tree BEFORE calling `s.proc.kill()` (`ClosePseudoConsole`),
        // otherwise `ClosePseudoConsole` kills the root shell first and `taskkill /T` misses `CREATE_NO_WINDOW` children.
        execFile('taskkill.exe', ['/PID', String(s.proc.pid), '/T', '/F'], { windowsHide: true, timeout: 2500 }, () => {
          try {
            s.proc.kill();
          } catch (e) {
            console.warn('[kill]', (e as Error).message);
          }
          treeKilled = true;
          done();
        });
      });
    };
    const wait = s.info.agent === 'claude' ? (s.firstOutAt || Date.now()) + CLAUDE_HEALTHY_MS - Date.now() : 0;
    if (wait <= 0) return kill();
    return new Promise(resolve => setTimeout(() => { void kill().then(resolve); }, wait));
  }

  // Kills the PTY and forgets the session (no further broadcasts for it), including its saved output.
  remove(id: string): Promise<void> {
    this.deleteScrollback(id);
    return this.drop(id);
  }

  private drop(id: string): Promise<void> {
    this.dead.delete(id);
    const s = this.live.get(id);
    if (!s) return Promise.resolve();
    this.peerTokens.delete(s.peerToken);
    s.removed = true;
    this.dropQueue(s);
    if (s.quiet) clearTimeout(s.quiet);
    if (s.enterTimer) {
      clearTimeout(s.enterTimer);
      s.enterTimer = null;
    }
    this.live.delete(id);
    // Killing an already-exited ConPTY makes node-pty's console-list helper print an AttachConsole stack.
    if (s.info.status === 'exited') return Promise.resolve();
    return this.endProc(s);
  }

  // Resolves once every PTY is killed (young claude sessions take up to CLAUDE_HEALTHY_MS).
  async killAll(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    if (this.scrollTimer) clearInterval(this.scrollTimer);
    this.scrollTimer = null;
    // Saved before the kill, so the output survives a restart (onExit skips removed sessions).
    for (const s of this.live.values()) if (s.scrollDirty) this.saveScrollback(s);
    await Promise.all([...this.live.keys()].map(id => this.drop(id)));
  }
}
