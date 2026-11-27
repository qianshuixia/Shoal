import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AgentKind, CliToolInfo, PermissionMode } from '../shared/protocol.ts';
import { isValidAgyModel } from '../shared/protocol.ts';
import { buildSafeProcessLaunch, findExecutableWin, isCmdBatchPath, unwrapNpmCmdShim } from './cliRegistry.ts';
import { findExecutable } from './platform.ts';

// Hook commands go through shells that quote badly (agy uses `cmd /c`), so a path with spaces falls back to its
// 8.3 short form when the volume has one. Shorten only the directory when the filename has no spaces: `%~sI` on a >8-char
// filename like `statusline.mjs` produces `STATUS~1.MJS`, and Node's ESM loader rejects uppercase `.MJS`.
export function shortPath(p: string): string {
  if (!p.includes(' ') || process.platform !== 'win32') return p;
  // Verbatim: Node would otherwise escape the quotes as \" and cmd reads them literally.
  // execFileSync honours windowsVerbatimArguments (it is a spawnSync option) though its typings leave it out.
  const opts = { encoding: 'utf8' as const, windowsHide: true, windowsVerbatimArguments: true };
  const shorten = (target: string) =>
    execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${target}") do @echo %~sI`], opts).trim();
  try {
    const base = path.basename(p);
    if (!base.includes(' ')) {
      const dir = shorten(path.dirname(p));
      const kept = dir ? path.join(dir, base) : '';
      if (kept && !kept.includes(' ') && fs.existsSync(kept)) return kept;
    }
    const out = shorten(p);
    if (!out || !fs.existsSync(out)) return p;
    const origExt = path.extname(p);
    const outExt = path.extname(out);
    if (origExt && outExt && origExt.toLowerCase() === outExt.toLowerCase() && origExt !== outExt) {
      const fixed = out.slice(0, -outExt.length) + origExt;
      if (fs.existsSync(fixed)) return fixed;
    }
    return out;
  } catch {
    return p;
  }
}

export const ROOT = path.resolve(import.meta.dirname, '..');
export const NOTIFY = shortPath(path.join(ROOT, 'hooks', 'notify.mjs')).replaceAll('\\', '/');
const STATUSLINE = shortPath(path.join(ROOT, 'hooks', 'statusline.mjs')).replaceAll('\\', '/');
// The desktop app's hooks run on its bundled Node: the user's machine may have none on PATH. A checkout keeps `node`.
export const NODE = process.env.WORKBENCH_BUNDLED === '1' ? shortPath(process.execPath).replaceAll('\\', '/') : 'node';
const FAKE_AGENT = path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs');

const appdata = (env: NodeJS.ProcessEnv = process.env) => env.APPDATA ?? '';
const localAppdata = (env: NodeJS.ProcessEnv = process.env) => env.LOCALAPPDATA ?? '';
const claudeExe = (env: NodeJS.ProcessEnv = process.env) => path.join(appdata(env), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const codexJs = (env: NodeJS.ProcessEnv = process.env) => path.join(appdata(env), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const agyExe = (env: NodeJS.ProcessEnv = process.env) => path.join(localAppdata(env), 'agy', 'bin', 'agy.exe');

// CLI lookup: on Windows check the default npm / agy install paths first, then fall back to PATH & common dirs;
// on POSIX check PATH first, then usual install locations (a GUI launch may not have the user's PATH).
export interface CliEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  delimiter?: string; // PATH separator, only overridden by tests that build PATH from Windows temp dirs
}
const firstExisting = (cands: string[]) => cands.find(p => fs.existsSync(p)) ?? null;
const ctx = (c: CliEnv) => ({ platform: c.platform ?? process.platform, env: c.env ?? process.env, home: c.home ?? os.homedir(), delimiter: c.delimiter });

export function resolveClaude(c: CliEnv = {}): string | null {
  const { platform, env, home, delimiter } = ctx(c);
  if (platform === 'win32') {
    const def = claudeExe(env);
    if (fs.existsSync(def)) return def;
    return findExecutableWin('claude', env, home);
  }
  return findExecutable('claude', env, platform, delimiter) ?? firstExisting([
    path.posix.join(home, '.local', 'bin', 'claude'),
    path.posix.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
}

export function resolveAgy(c: CliEnv = {}): string | null {
  const { platform, env, home, delimiter } = ctx(c);
  if (platform === 'win32') {
    const def = agyExe(env);
    if (fs.existsSync(def)) return def;
    return findExecutableWin('agy', env, home);
  }
  return findExecutable('agy', env, platform, delimiter) ?? firstExisting([path.posix.join(home, '.local', 'bin', 'agy')]);
}

// Where the codex entry point is: on win32 the default npm codex.js if present, else PATH / common dirs;
// on POSIX whatever `codex` resolves to.
export function resolveCodex(c: CliEnv = {}): string | null {
  const { platform, env, home, delimiter } = ctx(c);
  if (platform === 'win32') {
    const def = codexJs(env);
    if (fs.existsSync(def)) return def;
    return findExecutableWin('codex', env, home);
  }
  return findExecutable('codex', env, platform, delimiter) ?? firstExisting([
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.posix.join(home, '.local', 'bin', 'codex'),
  ]);
}

// An npm-installed codex is a symlink (POSIX) or .cmd shim (Windows) to @openai/codex/bin/codex.js: run that on the
// bundled Node directly without cmd.exe. Native binaries and version-manager shims (Volta, mise, asdf) run by path.
export function codexLaunchFor(resolved: string): { file: string; prefix: string[] } {
  const lower = resolved.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const unwrapped = unwrapNpmCmdShim(resolved);
    if (unwrapped) {
      const uLower = unwrapped.toLowerCase();
      if (uLower.endsWith('.js') || uLower.endsWith('.mjs') || uLower.endsWith('.cjs')) {
        return { file: process.execPath, prefix: [unwrapped] };
      }
      return { file: unwrapped, prefix: [] };
    }
    return { file: resolved, prefix: [] };
  }
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* keep as is */ }
  const rLower = real.toLowerCase();
  return (rLower.endsWith('.js') || rLower.endsWith('.mjs') || rLower.endsWith('.cjs'))
    ? { file: process.execPath, prefix: [real] }
    : { file: resolved, prefix: [] };
}

export function codexLaunch(c: CliEnv = {}): { file: string; prefix: string[] } {
  const { platform, env } = ctx(c);
  if (platform === 'win32') {
    const found = resolveCodex(c);
    return found ? codexLaunchFor(found) : { file: process.execPath, prefix: [codexJs(env)] };
  }
  const found = resolveCodex(c);
  return found ? codexLaunchFor(found) : { file: 'codex', prefix: [] };
}

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest'];
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const AGY_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'];

const UNSAFE_HOOK_NODE_RE = /[\s'"`$%&|;<>()^!]/;
const UNSAFE_HOOK_SCRIPT_RE = /['"`$%]/;

// When NODE or the hook script path contains spaces or shell/TOML metacharacters (e.g. bundled desktop installed
// under `D:\Program Files\Shoal` on a volume without 8.3 short paths, or a username like `O'Brien`), quoting
// `"node.exe" "notify.mjs"` breaks Windows PowerShell (Codex hooks), TOML single-quoted strings, or `cmd /c`.
// Fall back to the PATH-resolved `<stateDir>/bin/shoal-hook` wrapper which has zero paths, spaces, or quotes.
export function formatHookCommand(agent: string, ev: string, node = NODE, notify = NOTIFY): string {
  if (UNSAFE_HOOK_NODE_RE.test(node) || UNSAFE_HOOK_SCRIPT_RE.test(notify)) return `shoal-hook ${agent} ${ev}`;
  return `${node} "${notify}" ${agent} ${ev}`;
}
export function formatStatusLineCommand(agent: string, node = NODE, statusline = STATUSLINE): string {
  if (UNSAFE_HOOK_NODE_RE.test(node) || UNSAFE_HOOK_SCRIPT_RE.test(statusline)) return `shoal-statusline ${agent}`;
  return `${node} "${statusline}" ${agent}`;
}
const hookCmd = (agent: string, ev: string) => formatHookCommand(agent, ev);
// agy hooks and statusLine always invoke the PATH-resolved `shoal-hook` / `shoal-statusline` wrappers in `<stateDir>/bin`,
// so spaces in the workbench install path or user directory never break `cmd /c` quoting.
export const agyUsable = () => true;

// Claude saves a conversation as <config>/projects/<cwd slug>/<uuid>.jsonl once a prompt is sent; read-only check.
export function claudeConversationExists(id: string): boolean {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  let slugs: string[];
  try {
    slugs = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return slugs.some(d => fs.existsSync(path.join(dir, d, `${id}.jsonl`)));
}

// The status line command claude would run without our --settings: the first of the project's local and shared settings
// and the user's settings that has a command-type statusLine (undefined when none). Never throws.
export function userStatusLine(cwd: string): string | undefined {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json'),
  ];
  for (const f of files) {
    try {
      const sl = JSON.parse(fs.readFileSync(f, 'utf8'))?.statusLine;
      if (sl?.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) return sl.command;
    } catch { /* missing or unreadable */ }
  }
  return undefined;
}

// The status line command agy would run without our --settings (from ~/.gemini/antigravity-cli/settings.json, or
// AGY_CONFIG_DIR in tests). When the user has none, stack_with_default stays true so agy keeps its built-in status line.
export function agyUserStatusLine(): { command?: string; stackWithDefault: boolean; padding: number } {
  const file = path.join(process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'settings.json');
  try {
    const sl = JSON.parse(fs.readFileSync(file, 'utf8'))?.statusLine;
    if (sl && typeof sl === 'object' && !Array.isArray(sl)) {
      const cmd = sl.enabled !== false && (sl.type === undefined || sl.type === 'command') && typeof sl.command === 'string' && sl.command.trim()
        ? sl.command.trim().replace(/^~(?=[/\\])/, os.homedir())
        : undefined;
      if (cmd) {
        return {
          command: cmd,
          stackWithDefault: sl.stack_with_default === true,
          padding: typeof sl.padding === 'number' && Number.isFinite(sl.padding) ? sl.padding : 0,
        };
      }
    }
  } catch { /* missing or unreadable */ }
  return { stackWithDefault: true, padding: 0 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGY_SENDER_RE = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const AGY_USER_EXPLICIT_RE = /"source"\s*:\s*"USER_EXPLICIT"/;
const AGY_BRAIN_PATH_RE = /[/\\]brain[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/\\]|$)/i;

export type AgyConversationState =
  | { kind: 'main' }
  | { kind: 'subagent'; parentIds: string[]; hasUserTurn: boolean }
  | { kind: 'missing' };

function readFirstLine(fd: number, maxBytes = 256 * 1024): string {
  const chunk = Buffer.allocUnsafe(16 * 1024);
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < maxBytes) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    const nl = chunk.subarray(0, n).indexOf(0x0a);
    if (nl >= 0) {
      parts.push(Buffer.from(chunk.subarray(0, nl)));
      break;
    }
    parts.push(Buffer.from(chunk.subarray(0, n)));
    pos += n;
  }
  return parts.length ? Buffer.concat(parts).toString('utf8').trim() : '';
}

// Inspects <AGY_CONFIG_DIR>/brain/<id>/.system_generated/logs/transcript*.jsonl.
// User conversations start with source=USER_EXPLICIT; subagents and non-forked swarm workers start with source=SYSTEM
// carrying `sender=<parent-uuid>` in their leading system messages. Never throws.
export function agyConversationState(id: string): AgyConversationState {
  if (!UUID_RE.test(id)) return { kind: 'missing' };
  const logsDir = path.join(
    process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    'brain', id, '.system_generated', 'logs',
  );
  for (const name of ['transcript.jsonl', 'transcript_full.jsonl']) {
    const file = path.join(logsDir, name);
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      continue;
    }
    try {
      const firstLine = readFirstLine(fd);
      if (!firstLine) continue;
      const first = JSON.parse(firstLine) as Record<string, unknown>;
      if (!first || typeof first !== 'object' || Array.isArray(first)) continue;
      if (first.source !== 'SYSTEM' && first.type !== 'SYSTEM_MESSAGE') return { kind: 'main' };

      const parentIds: string[] = [];
      const seen = new Set<string>();
      const collectSenders = (content: unknown) => {
        if (typeof content !== 'string') return;
        for (const m of content.matchAll(AGY_SENDER_RE)) {
          const key = m[1].toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            parentIds.push(m[1]);
          }
        }
      };
      collectSenders(first.content);

      const size = fs.fstatSync(fd).size;
      const headLen = Math.min(size, 64 * 1024);
      const headBuf = Buffer.allocUnsafe(headLen);
      const got = fs.readSync(fd, headBuf, 0, headLen, 0);
      const headText = headBuf.subarray(0, got).toString('utf8');
      for (const rawLine of headText.split('\n').slice(1)) {
        const l = rawLine.trim();
        if (!l) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(l) as Record<string, unknown>;
        } catch {
          break;
        }
        if (obj.source !== 'SYSTEM' && obj.type !== 'SYSTEM_MESSAGE') break;
        collectSenders(obj.content);
      }

      let hasUserTurn = AGY_USER_EXPLICIT_RE.test(headText);
      if (!hasUserTurn && size > headLen) {
        const scanLen = Math.min(size, 16 * 1024 * 1024);
        const fullBuf = Buffer.allocUnsafe(scanLen);
        const n = fs.readSync(fd, fullBuf, 0, scanLen, 0);
        hasUserTurn = AGY_USER_EXPLICIT_RE.test(fullBuf.subarray(0, n).toString('utf8'));
      }
      return { kind: 'subagent', parentIds, hasUserTurn };
    } catch {
      continue;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { kind: 'missing' };
}

function resolveAgyMain(startId: string | null | undefined): string | undefined {
  if (!startId || !UUID_RE.test(startId)) return undefined;
  const queue = [startId];
  const seen = new Set([startId.toLowerCase()]);
  while (queue.length && seen.size <= 16) {
    const cur = queue.shift()!;
    const st = agyConversationState(cur);
    if (st.kind === 'main') return cur;
    if (st.kind === 'subagent') {
      // Preserve a worker conversation only when the user already explicitly sent turns inside it.
      if (cur === startId && st.hasUserTurn) return cur;
      for (const p of st.parentIds) {
        const key = p.toLowerCase();
        if (!seen.has(key) && seen.size < 16) {
          seen.add(key);
          queue.push(p);
        }
      }
    }
  }
  return undefined;
}

// Conversation id to pass to `agy --conversation`: prefers the last primary transcript's conversation (recovering from
// historical in-CLI /resume switches or nested `agy -p` SessionStart overwrites) and walks `sender=<parent>` out of
// background subagents / swarm workers back to the main coordinator conversation. Undefined if nothing exists on disk.
export function agyResumeId(native: string | null, transcriptPath: string | undefined): string | undefined {
  const tpId = typeof transcriptPath === 'string' ? transcriptPath.match(AGY_BRAIN_PATH_RE)?.[1] : undefined;
  return resolveAgyMain(tpId) ?? resolveAgyMain(native);
}

export function agyTranscriptFile(id: string): string | undefined {
  if (!UUID_RE.test(id)) return undefined;
  const logsDir = path.join(
    process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    'brain', id, '.system_generated', 'logs',
  );
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const f = path.join(logsDir, name);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

// Conversation id to pass to `claude --resume`: the recorded id if its file exists; otherwise the transcript the last
// hook reported (records saved before in-CLI /resume switches were tracked still hold the launch id).
export function claudeResumeId(native: string | null, transcriptPath: string | undefined): string | undefined {
  if (native && claudeConversationExists(native)) return native;
  if (typeof transcriptPath !== 'string' || !transcriptPath) return undefined;
  const file = transcriptPath.replace(/^\\\\\?\\/, '');
  const id = path.basename(file, '.jsonl');
  return UUID_RE.test(id) && fs.existsSync(file) ? id : undefined;
}

export function availableAgents(): AgentKind[] {
  const out: AgentKind[] = [];
  const claude = resolveClaude(), codex = resolveCodex(), agy = resolveAgy();
  if (claude && fs.existsSync(claude)) out.push('claude');
  if (codex && fs.existsSync(codex)) out.push('codex');
  if (agy && fs.existsSync(agy) && agyUsable()) out.push('agy');
  if (process.env.WORKBENCH_FAKE_AGENT === '1') out.push('fake');
  return out;
}

function writeNodeShim(binDir: string, name: string, scriptName: string): void {
  const bundled = process.env.WORKBENCH_BUNDLED === '1';
  const winFallback = bundled ? `"${process.execPath.replaceAll('%', '%%')}"` : 'node';
  const posixFallback = bundled ? `'${process.execPath.replaceAll("'", "'\\''")}'` : 'node';

  const cmd = [
    '@echo off',
    'if defined WORKBENCH_NODE (',
    `  "%WORKBENCH_NODE%" "%~dp0${scriptName}" %*`,
    ') else (',
    `  ${winFallback} "%~dp0${scriptName}" %*`,
    ')',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), cmd, 'utf8');

  // Strict LF line endings so Git Bash / POSIX shells execute without '\r' errors.
  // Convert DIR via cygpath -w under Git Bash / MSYS2 when present so MSYS_NO_PATHCONV=1 still hands Windows Node a valid path.
  const sh = [
    '#!/bin/sh',
    'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'if command -v cygpath >/dev/null 2>&1; then',
    '  DIR=$(cygpath -w "$DIR")',
    'fi',
    'if [ -n "$WORKBENCH_NODE" ]; then',
    `  exec "$WORKBENCH_NODE" "$DIR/${scriptName}" "$@"`,
    'fi',
    `exec ${posixFallback} "$DIR/${scriptName}" "$@"`,
    '',
  ].join('\n');
  const shFile = path.join(binDir, name);
  fs.writeFileSync(shFile, sh, 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(shFile, 0o755); } catch { /* ignore */ }
  }
}

// Writes the per-agent hook config files and shoal CLI/hook shims into the state dir (idempotent).
export function writeHookFiles(stateDir: string): void {
  const binDir = path.join(stateDir, 'bin');
  const collabDir = path.join(stateDir, 'collab');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(collabDir, { recursive: true });

  for (const script of ['shoal-cli.mjs', 'notify.mjs', 'statusline.mjs']) {
    const src = path.join(ROOT, 'hooks', script);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(binDir, script));
  }
  writeNodeShim(binDir, 'shoal', 'shoal-cli.mjs');
  writeNodeShim(binDir, 'shoal-hook', 'notify.mjs');
  writeNodeShim(binDir, 'shoal-statusline', 'statusline.mjs');

  const hooks: Record<string, unknown> = {};
  for (const ev of CLAUDE_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd('claude', ev), timeout: 5 }] }];
  // Claude reports its subscription rate limits only to the status line command. This one replaces the user's own
  // (--settings wins), so it runs that for us: see userStatusLine and hooks/statusline.mjs.
  const statusLine = { type: 'command', command: formatStatusLineCommand('claude') };
  fs.writeFileSync(path.join(stateDir, 'claude-hooks.json'), JSON.stringify({ hooks, statusLine }, null, 2));

  // Earlier versions synced a shoal-collab skill for agy; it now gets its instructions like the other CLIs (see buildLaunch).
  fs.rmSync(path.join(stateDir, 'agy-hooks', '.agents', 'skills', 'shoal-collab'), { recursive: true, force: true });

  // agy executes hook and statusLine commands through `cmd /c` (Windows) or `sh -c` (POSIX), where quoted paths with
  // spaces break `cmd /c` parsing. Running the PATH-resolved `shoal-hook` / `shoal-statusline` wrappers in `<stateDir>/bin`
  // keeps the commands free of paths, spaces, and quotes on every install location.
  const agy: Record<string, unknown> = {};
  for (const ev of AGY_EVENTS) agy[ev] = [{ type: 'command', command: `shoal-hook agy ${ev}`, timeout: 5 }];
  const dir = path.join(stateDir, 'agy-hooks', '.agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ workbench: agy }, null, 2));
  const agySl = agyUserStatusLine();
  const agyStatusLine = {
    type: 'command',
    command: 'shoal-statusline agy',
    enabled: true,
    stack_with_default: agySl.stackWithDefault,
    padding: agySl.padding,
  };
  fs.writeFileSync(path.join(stateDir, 'agy-settings.json'), JSON.stringify({ statusLine: agyStatusLine }, null, 2));
}

export function preparePrompt(prompt: string, sessionId: string, stateDir: string): string {
  let p = prompt;
  if (p.length > 8000) {
    const file = path.join(stateDir, 'prompts', `${sessionId}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, p);
    p = `请先阅读 ${file} 中的任务说明，然后按说明执行。`;
  }
  return p.startsWith('-') ? ` ${p}` : p;
}

export interface Launch {
  file: string;
  args: string[];
  verbatimArgs?: string; // used on Windows for non-npm .cmd/.bat scripts via cmd.exe /d /s /c
  nativeSessionId: string | null; // known at spawn for claude and when resuming
}

// Default full-permission flags for deep-adapted CLIs (omitted when permissionMode === 'normal').
// Flags checked against local --help: claude 2.1.310, codex 0.167.0 (top level and `resume`), agy 1.5.3.
export const FULL_ACCESS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  agy: '--dangerously-skip-permissions',
} as const;

// True when the user's Codex config.toml sets developer_instructions itself.
export function codexHasUserDeveloperInstructions(): boolean {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  try {
    return /^[ 	]*developer_instructions[ 	]*=/m.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export type LaunchCliMeta = Pick<CliToolInfo, 'path' | 'command' | 'normalArgs' | 'fullAccessArgs' | 'promptArg'>;

// resume: native session id of a saved conversation to reopen (resume commands verified in M0); the prompt is ignored then.
export function buildLaunch(opts: {
  agent: AgentKind;
  sessionId: string;
  prompt: string;
  stateDir: string;
  resume?: string;
  model?: string;
  collabDir?: string;
  instructions?: string; // standing instructions for the session (the fake agent ignores them)
  permissionMode?: PermissionMode; // default 'full'; 'normal' omits skip-permission flags
  readOnly?: boolean; // Pi review or plan session
  cliMeta?: LaunchCliMeta; // resolved executable & args for generic/custom CLIs (or fallback path for built-ins)
}): Launch {
  const { agent, sessionId, stateDir, resume, model, collabDir, instructions, cliMeta } = opts;
  const fullAccess = opts.permissionMode !== 'normal';
  const prompt = resume ? '' : preparePrompt(opts.prompt, sessionId, stateDir);
  switch (agent) {
    case 'claude': {
      const native = resume ?? crypto.randomUUID();
      const args = [resume ? '--resume' : '--session-id', native, '--settings', path.join(stateDir, 'claude-hooks.json').replaceAll('\\', '/')];
      if (fullAccess) args.push(FULL_ACCESS.claude);
      if (instructions) args.push('--append-system-prompt', instructions);
      if (prompt) args.push(prompt);
      const resolved = cliMeta?.path ?? resolveClaude() ?? 'claude';
      const safe = buildSafeProcessLaunch(resolved, args);
      return typeof safe.args === 'string'
        ? { file: safe.file, args: [], verbatimArgs: safe.args, nativeSessionId: native }
        : { file: safe.file, args: safe.args, nativeSessionId: native };
    }
    case 'codex': {
      const codexArgs: string[] = [];
      if (resume) codexArgs.push('resume', resume);
      // Byte-identical to spikes/probe.mjs: Codex stores trust hashes of these strings.
      for (const ev of CODEX_EVENTS) codexArgs.push('-c', `hooks.${ev}=[{hooks=[{type="command",command='${hookCmd('codex', ev)}',timeout=5}]}]`);
      // Not injected when the user's own Codex config defines developer_instructions: a -c override would replace it.
      if (instructions && !codexHasUserDeveloperInstructions()) codexArgs.push('-c', `developer_instructions=${JSON.stringify(instructions)}`);
      codexArgs.push('-c', 'check_for_update_on_startup=false');
      if (fullAccess) codexArgs.push(FULL_ACCESS.codex);
      if (prompt) codexArgs.push(prompt);
      const { file, prefix } = cliMeta?.path ? codexLaunchFor(cliMeta.path) : codexLaunch();
      if (process.platform === 'win32' && prefix.length === 0 && (file.toLowerCase().endsWith('.cmd') || file.toLowerCase().endsWith('.bat'))) {
        throw new Error(`Codex 启动路径 ${file} 是无法直接解包的批处理脚本，请使用标准 npm 安装或原生 codex.exe`);
      }
      return { file, args: [...prefix, ...codexArgs], nativeSessionId: resume ?? null };
    }
    case 'agy': {
      const args = resume ? ['--conversation', resume] : [];
      args.push('--settings', path.join(stateDir, 'agy-settings.json').replaceAll('\\', '/'), '--add-dir', path.join(stateDir, 'agy-hooks'));
      if (collabDir) {
        fs.mkdirSync(collabDir, { recursive: true });
        args.push('--add-dir', collabDir);
      }
      // agy has no system-prompt flag. It reads AGENTS.md of every workspace folder as an always-on rule, and a folder
      // added with --add-dir is a workspace folder, so the instructions go into a folder of their own.
      if (instructions) {
        const dir = path.join(stateDir, 'agy-instructions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${instructions}\n`);
        args.push('--add-dir', dir);
      }
      if (fullAccess) args.push(FULL_ACCESS.agy);
      if (model && isValidAgyModel(model)) args.push('--model', model);
      if (prompt) args.push('-i', prompt);
      const resolved = cliMeta?.path ?? resolveAgy() ?? 'agy';
      const safe = buildSafeProcessLaunch(resolved, args);
      return typeof safe.args === 'string'
        ? { file: safe.file, args: [], verbatimArgs: safe.args, nativeSessionId: resume ?? null }
        : { file: safe.file, args: safe.args, nativeSessionId: resume ?? null };
    }
    case 'pi': {
      const args = ['--extension', path.join(ROOT, 'hooks', 'pi.ts')];
      if (resume) args.push('--session', resume);
      if (opts.readOnly) args.push('--no-extensions', '--no-mcp', '--tools', 'read,grep,find,ls');
      if (instructions) args.push('--append-system-prompt', instructions);
      const target = cliMeta?.path ?? 'pi';
      if (isCmdBatchPath(target)) throw new Error('Pi 请使用标准 npm 安装或原生可执行文件');
      if (prompt) args.push(prompt.startsWith('@') ? ` ${prompt}` : prompt);
      const safe = buildSafeProcessLaunch(target, args);
      return typeof safe.args === 'string'
        ? { file: safe.file, args: [], verbatimArgs: safe.args, nativeSessionId: null }
        : { file: safe.file, args: safe.args, nativeSessionId: null };
    }
    case 'fake': {
      const args = [FAKE_AGENT];
      if (resume) args.push('--resume', resume);
      if (prompt) args.push(prompt);
      return { file: process.execPath, args, nativeSessionId: resume ?? null };
    }
    default: {
      const target = cliMeta?.path ?? cliMeta?.command ?? agent;
      const modeArgs = fullAccess ? (cliMeta?.fullAccessArgs ?? []) : (cliMeta?.normalArgs ?? []);
      const args = [...modeArgs];
      const batch = isCmdBatchPath(target);
      if (prompt && !batch && (cliMeta?.promptArg ?? 'positional') === 'positional') {
        args.push(prompt);
      }
      const safe = buildSafeProcessLaunch(target, args);
      return typeof safe.args === 'string'
        ? { file: safe.file, args: [], verbatimArgs: safe.args, nativeSessionId: null }
        : { file: safe.file, args: safe.args, nativeSessionId: null };
    }
  }
}

export interface GeneratorLaunch {
  file: string;
  args: string[];
  stdin: string | null;
  outFile: string | null;
}

// Headless one-shot call that writes a handoff card from a prompt. The result comes from stdout, or from outFile when set.
// No --bare for claude (it skips the OAuth login) and no -m for codex (the user's codex has its own provider and model).
// Headless agy (-p) is intentionally disabled (returns null): automated non-interactive Antigravity CLI calls violate
// account policy and spawn extra language-server sidecars.
export function buildGenerator(agent: AgentKind, prompt: string, outFile: string): GeneratorLaunch | null {
  switch (agent) {
    case 'claude': {
      const baseArgs = ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence'];
      const resolved = resolveClaude() ?? 'claude';
      const safe = buildSafeProcessLaunch(resolved, baseArgs);
      if (typeof safe.args === 'string') return null;
      return { file: safe.file, args: safe.args, stdin: prompt, outFile: null };
    }
    case 'codex': {
      const { file, prefix } = codexLaunch();
      if (process.platform === 'win32' && prefix.length === 0 && (file.toLowerCase().endsWith('.cmd') || file.toLowerCase().endsWith('.bat'))) {
        return null;
      }
      return {
        file,
        args: [...prefix, 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"', '-o', outFile, '-'],
        stdin: prompt, outFile,
      };
    }
    case 'agy':
      return null;
    case 'fake':
      return { file: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'fake-handoff.mjs')], stdin: prompt, outFile: null };
    default:
      return null;
  }
}
