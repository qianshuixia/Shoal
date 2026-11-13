import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AgentKind } from '../shared/protocol.ts';

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
const nodeCmd = NODE.includes(' ') ? `"${NODE}"` : NODE;
const FAKE_AGENT = path.join(ROOT, 'test', 'fixtures', 'fake-agent.mjs');

const appdata = () => process.env.APPDATA ?? '';
const localAppdata = () => process.env.LOCALAPPDATA ?? '';
const claudeExe = () => path.join(appdata(), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const codexJs = () => path.join(appdata(), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const agyExe = () => path.join(localAppdata(), 'agy', 'bin', 'agy.exe');

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest'];
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const AGY_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'];

const hookCmd = (agent: string, ev: string) => `${nodeCmd} "${NOTIFY}" ${agent} ${ev}`;
// agy runs hook and statusLine commands through `cmd /c`, which breaks quoted paths.
const agyUsable = () => !NOTIFY.includes(' ') && !STATUSLINE.includes(' ') && !NODE.includes(' ');

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
  if (fs.existsSync(claudeExe())) out.push('claude');
  if (fs.existsSync(codexJs())) out.push('codex');
  if (fs.existsSync(agyExe()) && agyUsable()) out.push('agy');
  if (process.env.WORKBENCH_FAKE_AGENT === '1') out.push('fake');
  return out;
}

// Writes the per-agent hook config files into the state dir (idempotent).
export function writeHookFiles(stateDir: string): void {
  const hooks: Record<string, unknown> = {};
  for (const ev of CLAUDE_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd('claude', ev), timeout: 5 }] }];
  // Claude reports its subscription rate limits only to the status line command. This one replaces the user's own
  // (--settings wins), so it runs that for us: see userStatusLine and hooks/statusline.mjs.
  const statusLine = { type: 'command', command: `${nodeCmd} "${STATUSLINE}" claude` };
  fs.writeFileSync(path.join(stateDir, 'claude-hooks.json'), JSON.stringify({ hooks, statusLine }, null, 2));

  if (!agyUsable()) {
    console.warn(`[agents] WARNING: hook command path contains a space (${NODE} ${NOTIFY} ${STATUSLINE}); agy hooks cannot be quoted, agy is disabled`);
    return;
  }
  const agy: Record<string, unknown> = {};
  for (const ev of AGY_EVENTS) agy[ev] = [{ type: 'command', command: `${NODE} ${NOTIFY} agy ${ev}`, timeout: 5 }];
  const dir = path.join(stateDir, 'agy-hooks', '.agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ workbench: agy }, null, 2));
  const agySl = agyUserStatusLine();
  const agyStatusLine = {
    type: 'command',
    command: `${NODE} ${STATUSLINE} agy`,
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
  nativeSessionId: string | null; // known at spawn for claude and when resuming
}

// Every real CLI runs with full permissions (the author's choice): no approval prompts, no codex sandbox.
// Flags checked against local --help: claude 2.1.310, codex 0.167.0 (top level and `resume`), agy 1.5.3.
export const FULL_ACCESS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  agy: '--dangerously-skip-permissions',
} as const;

// resume: native session id of a saved conversation to reopen (resume commands verified in M0); the prompt is ignored then.
export function buildLaunch(opts: { agent: AgentKind; sessionId: string; prompt: string; stateDir: string; resume?: string }): Launch {
  const { agent, sessionId, stateDir, resume } = opts;
  const prompt = resume ? '' : preparePrompt(opts.prompt, sessionId, stateDir);
  switch (agent) {
    case 'claude': {
      const native = resume ?? crypto.randomUUID();
      const args = [resume ? '--resume' : '--session-id', native, '--settings', path.join(stateDir, 'claude-hooks.json').replaceAll('\\', '/'), FULL_ACCESS.claude];
      if (prompt) args.push(prompt);
      return { file: claudeExe(), args, nativeSessionId: native };
    }
    case 'codex': {
      const args = [codexJs()];
      if (resume) args.push('resume', resume);
      // Byte-identical to spikes/probe.mjs: Codex stores trust hashes of these strings.
      for (const ev of CODEX_EVENTS) args.push('-c', `hooks.${ev}=[{hooks=[{type="command",command='${hookCmd('codex', ev)}',timeout=5}]}]`);
      args.push('-c', 'check_for_update_on_startup=false', FULL_ACCESS.codex);
      if (prompt) args.push(prompt);
      return { file: process.execPath, args, nativeSessionId: resume ?? null };
    }
    case 'agy': {
      const args = resume ? ['--conversation', resume] : [];
      args.push('--settings', path.join(stateDir, 'agy-settings.json').replaceAll('\\', '/'), '--add-dir', path.join(stateDir, 'agy-hooks'), FULL_ACCESS.agy);
      if (prompt) args.push('-i', prompt);
      return { file: agyExe(), args, nativeSessionId: resume ?? null };
    }
    case 'fake': {
      const args = [FAKE_AGENT];
      if (resume) args.push('--resume', resume);
      if (prompt) args.push(prompt);
      return { file: process.execPath, args, nativeSessionId: resume ?? null };
    }
  }
}

// Headless one-shot call that writes a handoff card from a prompt. The result comes from stdout, or from outFile when set.
// No --bare for claude (it skips the OAuth login) and no -m for codex (the user's codex has its own provider and model).
export function buildGenerator(agent: AgentKind, prompt: string, outFile: string): { file: string; args: string[]; stdin: string | null; outFile: string | null } {
  switch (agent) {
    case 'claude':
      return { file: claudeExe(), args: ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence'], stdin: prompt, outFile: null };
    case 'codex':
      return {
        file: process.execPath,
        args: [codexJs(), 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"', '-o', outFile, '-'],
        stdin: prompt, outFile,
      };
    case 'agy': // agy does not read stdin
      return { file: agyExe(), args: ['-p', prompt.startsWith('-') ? ` ${prompt}` : prompt, '--effort', 'low', '--print-timeout', '2m', '--disable-slash-commands'], stdin: null, outFile: null };
    case 'fake':
      return { file: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'fake-handoff.mjs')], stdin: prompt, outFile: null };
  }
}
