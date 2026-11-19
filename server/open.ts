import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExecutable } from './platform.ts';

// Opens a link clicked in a terminal (file: URI or bare absolute path) in VS Code / Explorer. Nothing here ever executes the target.

export class OpenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Resolved {
  path: string;
  line?: number;
  col?: number;
}

export interface OpenCommand {
  kind: 'dir' | 'default' | 'select' | 'editor';
  cmd: string;
  args: string[];
  // Pass args as written: Explorer only understands `/select,"C:\a b\c.exe"`, not Node's quoting of the whole arg.
  verbatim?: true;
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const FRAGMENT_POS = /^#L(\d+)(?:C(\d+))?$/;
const HASH_POS = /#L(\d+)(?:C(\d+))?$/;
const COLON_POS = /:(\d+)(?::(\d+))?$/;

const isUnc = (p: string) => p.startsWith('\\\\') || p.startsWith('//');
const exists = (p: string) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const pos = (m: RegExpExecArray): { line: number; col?: number } => ({ line: Number(m[1]), ...(m[2] && { col: Number(m[2]) }) });

// Turns a clicked link into an existing absolute local path (plus optional line/column). Throws OpenError otherwise.
export function resolveOpenTarget(target: string, platform: NodeJS.Platform = process.platform): Resolved {
  const raw = target.trim();
  const posix = platform !== 'win32';
  if (!raw) throw new OpenError(400, '链接为空');
  if (isUnc(raw)) throw new OpenError(400, `不支持网络路径：${raw}`);
  let p: string;
  let fragmentPos: { line: number; col?: number } | undefined;
  if (/^file:/i.test(raw)) {
    const hash = raw.indexOf('#');
    const base = hash === -1 ? raw : raw.slice(0, hash);
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new OpenError(400, `链接无效：${raw}`);
    }
    if (url.host !== '' && url.host.toLowerCase() !== 'localhost') throw new OpenError(400, `不支持远程文件链接：${raw}`);
    try {
      // fileURLToPath only understands the host platform's paths, so POSIX decoding is done by hand.
      p = posix ? decodeURIComponent(url.pathname) : fileURLToPath(url);
    } catch {
      throw new OpenError(400, `链接无效：${raw}`);
    }
    if (p.includes('\0')) throw new OpenError(400, `链接无效：${raw}`);
    const m = hash === -1 ? null : FRAGMENT_POS.exec(raw.slice(hash));
    if (m) fragmentPos = pos(m);
  } else if (posix ? raw.startsWith('/') : DRIVE_PATH.test(raw)) {
    p = raw;
  } else {
    throw new OpenError(400, `只支持 file: 链接和${posix ? '' : ' Windows '}绝对路径：${raw}`);
  }
  // normalize would collapse a leading // into /, so a //host/share path (e.g. from file:////host/share) is refused first.
  if (posix && p.startsWith('//')) throw new OpenError(400, `不支持网络路径：${p}`);
  p = posix ? path.posix.normalize(p) : path.win32.normalize(p);
  if (posix ? !p.startsWith('/') : isUnc(p) || !DRIVE_PATH.test(p)) {
    throw new OpenError(400, `只支持本机${posix ? '' : '磁盘上'}的绝对路径：${p}`);
  }
  if (exists(p)) return { path: p, ...fragmentPos };
  for (const re of [HASH_POS, COLON_POS]) {
    const m = re.exec(p);
    if (!m) continue;
    const stripped = p.slice(0, m.index);
    if (exists(stripped)) return { path: stripped, ...pos(m) };
  }
  throw new OpenError(404, `文件不存在：${p}`);
}

const DEFAULT_OPEN = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'html', 'htm']);
const SELECT_ONLY = new Set(['exe', 'com', 'msi', 'msp', 'lnk', 'url', 'scr', 'cpl', 'dll', 'sys', 'appref-ms', 'pif', 'msc', 'hta']);

// macOS: .command / .app / installers run or launch when opened, so they are only revealed in Finder.
const MAC_SELECT_ONLY = new Set([...SELECT_ONLY, 'app', 'command', 'tool', 'terminal', 'pkg', 'mpkg', 'dmg', 'scpt', 'applescript', 'workflow', 'jar']);
// Directories Finder treats as a program or package: `open Foo.app` would launch it.
const MAC_BUNDLE_DIRS = new Set(['app', 'bundle', 'framework', 'pkg', 'mpkg', 'prefpane', 'workflow']);

// What to run for a resolved path. Never a shell, never `start`; programs and shortcuts are only selected in Explorer.
export function openAction(resolved: Resolved, isDir: boolean, editor: string | null, platform: NodeJS.Platform = process.platform): OpenCommand {
  const file = resolved.path;
  if (platform !== 'win32') return posixOpenAction(resolved, isDir, editor, platform === 'darwin');
  const explorer = 'explorer.exe';
  if (isDir) return { kind: 'dir', cmd: explorer, args: [file] };
  const ext = path.extname(file).slice(1).toLowerCase();
  if (DEFAULT_OPEN.has(ext)) return { kind: 'default', cmd: explorer, args: [file] };
  if (SELECT_ONLY.has(ext) || !editor) return { kind: 'select', cmd: explorer, args: [`/select,"${file}"`], verbatim: true };
  if (resolved.line === undefined) return { kind: 'editor', cmd: editor, args: [file] };
  const at = resolved.col === undefined ? `${resolved.line}` : `${resolved.line}:${resolved.col}`;
  return { kind: 'editor', cmd: editor, args: ['--goto', `${file}:${at}`] };
}

// macOS: open / open -R (reveal in Finder); elsewhere xdg-open, and a file is revealed by opening its folder.
function posixOpenAction(resolved: Resolved, isDir: boolean, editor: string | null, mac: boolean): OpenCommand {
  const file = resolved.path;
  const ext = path.extname(file).slice(1).toLowerCase();
  const opener = mac ? 'open' : 'xdg-open';
  const select = (): OpenCommand => mac
    ? { kind: 'select', cmd: opener, args: ['-R', file] }
    : { kind: 'select', cmd: opener, args: [path.posix.dirname(file)] };
  if (isDir) return mac && MAC_BUNDLE_DIRS.has(ext) ? select() : { kind: 'dir', cmd: opener, args: [file] };
  if (DEFAULT_OPEN.has(ext)) return { kind: 'default', cmd: opener, args: [file] };
  if ((mac ? MAC_SELECT_ONLY : SELECT_ONLY).has(ext) || !editor) return select();
  if (resolved.line === undefined) return { kind: 'editor', cmd: editor, args: [file] };
  const at = resolved.col === undefined ? `${resolved.line}` : `${resolved.line}:${resolved.col}`;
  return { kind: 'editor', cmd: editor, args: ['--goto', `${file}:${at}`] };
}

// WORKBENCH_EDITOR (an exe) first; otherwise Code.exe next to the `code.cmd` found on PATH (the .cmd itself is never spawned).
export function findEditor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const set = env.WORKBENCH_EDITOR?.trim();
  if (set) return set;
  if (platform !== 'win32') {
    // POSIX: an executable `code` on PATH; on macOS the VS Code app bundle's CLI when it was never added to PATH.
    const onPath = findExecutable('code', env, platform, path.delimiter);
    if (onPath) return onPath;
    const bundled = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    return platform === 'darwin' && exists(bundled) ? bundled : null;
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !exists(path.join(dir, 'code.cmd'))) continue;
    const exe = path.resolve(dir, '..', 'Code.exe');
    if (exists(exe)) return exe;
  }
  return null;
}

// Starts the command detached, or appends it to WORKBENCH_OPEN_LOG (one JSON line) instead when that is set, so tests never open anything.
export function runOpen(c: OpenCommand, env: NodeJS.ProcessEnv = process.env): void {
  const log = env.WORKBENCH_OPEN_LOG;
  if (log) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify({ cmd: c.cmd, args: c.args }) + '\n');
    return;
  }
  const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: c.verbatim });
  child.on('error', (e) => console.error('[open]', c.cmd, e.message));
  child.unref();
}
