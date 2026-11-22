import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  AgentKind,
  CliScanResult,
  CliTier,
  CliToolInfo,
  CliToolPreference,
  CustomCliConfig,
  PermissionMode,
  Settings,
} from '../shared/protocol.ts';
import { isDeepAgent, isValidCustomCliId } from '../shared/protocol.ts';
import { agyUsable, codexLaunch, resolveAgy, resolveClaude, resolveCodex } from './agents.ts';
import type { CliEnv } from './agents.ts';
import { findExecutable } from './platform.ts';

export interface BuiltinCliSpec {
  id: string;
  label: string;
  tier: CliTier;
  commands: string[]; // executable names to search in priority order
  fullAccessArgs: string[];
  normalArgs: string[];
  promptArg: 'positional' | 'none';
  fullAccessNote?: string;
  capabilities: string[];
  limitations?: string;
  extraWinPaths?: (env: NodeJS.ProcessEnv, home: string) => string[];
  extraPosixPaths?: (home: string) => string[];
}

const DEEP_CAPS = ['Hooks 状态感知', '待验收卡片', '自动续接', 'Token 与额度统计', '跨 CLI 委派'];
const GENERIC_CAPS = ['原生终端交互', '任务管理', '权限模式切换'];
const GENERIC_LIMITS = '未深度适配：不支持自动状态感知（工作中/待验收卡片）、自动对话续接、Token 统计与跨 CLI 自动委派';

// Curated built-in AI coding CLI catalog. Every fullAccessArgs entry is verified against official CLI --help or docs;
// CLIs without a verified interactive skip-permission flag keep fullAccessArgs: [] with an explicit fullAccessNote.
export const BUILTIN_CLI_CATALOG: readonly BuiltinCliSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    tier: 'deep',
    commands: ['claude'],
    fullAccessArgs: ['--dangerously-skip-permissions'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: DEEP_CAPS,
  },
  {
    id: 'codex',
    label: 'Codex',
    tier: 'deep',
    commands: ['codex'],
    fullAccessArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: DEEP_CAPS,
  },
  {
    id: 'agy',
    label: 'Antigravity',
    tier: 'deep',
    commands: ['agy'],
    fullAccessArgs: ['--dangerously-skip-permissions'],
    normalArgs: [],
    promptArg: 'positional',
    fullAccessNote: '正常模式下 Antigravity CLI 暂未暴露独立审批 Hook，授权弹窗在终端中确认',
    capabilities: DEEP_CAPS,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    tier: 'generic',
    commands: ['gemini'],
    fullAccessArgs: ['--yolo'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    tier: 'generic',
    commands: ['kimi'],
    fullAccessArgs: ['--auto'],
    normalArgs: [],
    promptArg: 'none',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
    extraWinPaths: (_env, home) => [path.win32.join(home, '.kimi-code', 'bin', 'kimi.exe')],
    extraPosixPaths: (home) => [path.posix.join(home, '.kimi-code', 'bin', 'kimi')],
  },
  {
    id: 'droid',
    label: 'Factory Droid',
    tier: 'generic',
    commands: ['droid'],
    fullAccessArgs: [],
    normalArgs: [],
    promptArg: 'positional',
    fullAccessNote: '交互模式无命令行免确认参数，请在 Droid 终端内调整自主等级',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
    extraWinPaths: (_env, home) => [path.win32.join(home, 'bin', 'droid.exe')],
    extraPosixPaths: (home) => [path.posix.join(home, 'bin', 'droid')],
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    tier: 'generic',
    commands: ['qwen'],
    fullAccessArgs: ['--yolo'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 'generic',
    commands: ['opencode'],
    fullAccessArgs: [],
    normalArgs: [],
    promptArg: 'none',
    fullAccessNote: 'OpenCode 无命令行免确认参数，自动放行需在 opencode.json 中配置',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    tier: 'generic',
    commands: ['copilot'],
    fullAccessArgs: ['--yolo'],
    normalArgs: [],
    promptArg: 'none',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    tier: 'generic',
    commands: ['cursor-agent'],
    fullAccessArgs: ['--force'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'aider',
    label: 'Aider',
    tier: 'generic',
    commands: ['aider'],
    fullAccessArgs: ['--yes-always'],
    normalArgs: [],
    promptArg: 'none',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'amp',
    label: 'Amp',
    tier: 'generic',
    commands: ['amp'],
    fullAccessArgs: ['--dangerously-allow-all'],
    normalArgs: [],
    promptArg: 'none',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'cline',
    label: 'Cline CLI',
    tier: 'generic',
    commands: ['cline'],
    fullAccessArgs: ['--yolo'],
    normalArgs: [],
    promptArg: 'positional',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 'generic',
    commands: ['goose'],
    fullAccessArgs: [],
    normalArgs: [],
    promptArg: 'none',
    fullAccessNote: 'Goose 无独立命令行免确认参数，权限由本地 Goose 配置控制',
    capabilities: GENERIC_CAPS,
    limitations: GENERIC_LIMITS,
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_CLI_CATALOG.map((c) => [c.id, c]));

// Never resolve .ps1: CreateProcessW / node-pty cannot execute PowerShell scripts directly.
const WIN_EXEC_EXTS = ['.exe', '.com', '.cmd', '.bat'] as const;
const WIN_EXT_SET = new Set<string>(WIN_EXEC_EXTS);
const CMD_METACHAR_RE = /[&|<>^%!\r\n"]/;
const ENV_STRIP_SCAN = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT|CODEX_SANDBOX|CODEX_THREAD|AGY_SESSION)/;
const VERSION_RE = /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/;

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function getEnvPath(env: NodeJS.ProcessEnv): string {
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'path' && typeof v === 'string') return v;
  }
  return '';
}

function uniqueDirs(dirs: string[], platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of dirs) {
    const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function windowsSearchDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const appdata = env.APPDATA ?? '';
  const localAppdata = env.LOCALAPPDATA ?? '';
  const pathDirs = getEnvPath(env).split(';');
  const common = [
    appdata ? path.win32.join(appdata, 'npm') : '',
    localAppdata ? path.win32.join(localAppdata, 'agy', 'bin') : '',
    path.win32.join(home, '.local', 'bin'),
    path.win32.join(home, 'bin'),
    path.win32.join(home, '.kimi-code', 'bin'),
    path.win32.join(home, '.cargo', 'bin'),
    path.win32.join(home, 'scoop', 'shims'),
    localAppdata ? path.win32.join(localAppdata, 'Microsoft', 'WinGet', 'Links') : '',
    path.win32.join(home, '.claude', 'local'),
  ];
  return uniqueDirs([...pathDirs, ...common], 'win32');
}

function posixSearchDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const pathDirs = (env.PATH ?? '').split(':');
  const common = [
    path.posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, 'bin'),
    path.posix.join(home, '.kimi-code', 'bin'),
  ];
  return uniqueDirs([...pathDirs, ...common], 'linux');
}

// Resolves a command name or explicit path on Windows without ever picking a .ps1 file.
export function findExecutableWin(cmd: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const clean = cmd.trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (lower.endsWith('.ps1')) return null;

  const hasSep = clean.includes('\\') || clean.includes('/') || /^[A-Za-z]:/.test(clean);
  const ext = path.win32.extname(lower);
  if (hasSep) {
    if (ext) {
      if (!WIN_EXT_SET.has(ext) && ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') return null;
      return isRegularFile(clean) ? clean : null;
    }
    for (const e of WIN_EXEC_EXTS) {
      const cand = `${clean}${e}`;
      if (isRegularFile(cand)) return cand;
    }
    return null;
  }

  const dirs = windowsSearchDirs(env, home);
  const names = ext && WIN_EXT_SET.has(ext) ? [clean] : WIN_EXEC_EXTS.map((e) => `${clean}${e}`);
  for (const dir of dirs) {
    for (const name of names) {
      const cand = path.win32.join(dir, name);
      if (isRegularFile(cand)) return cand;
    }
  }
  return null;
}

// Resolves a command name or explicit path on POSIX.
export function findExecutablePosix(cmd: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), delimiter = ':'): string | null {
  const clean = cmd.trim();
  if (!clean) return null;
  if (clean.includes('/')) {
    try {
      if (!fs.statSync(clean).isFile()) return null;
      fs.accessSync(clean, fs.constants.X_OK);
      return clean;
    } catch {
      return null;
    }
  }
  const merged = { ...env, PATH: posixSearchDirs(env, home).join(delimiter) };
  return findExecutable(clean, merged, 'linux', delimiter);
}

export function resolveCommandPath(cmd: string, c: CliEnv = {}): string | null {
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const home = c.home ?? os.homedir();
  if (platform === 'win32') return findExecutableWin(cmd, env, home);
  return findExecutablePosix(cmd, env, home, c.delimiter ?? ':');
}

// Unwraps standard npm-generated Windows .cmd shims (e.g. `"%dp0%\node_modules\@google\gemini-cli\dist\index.js"`)
// directly to the underlying JS entrypoint so node-pty launches Node directly without cmd.exe shell injection risks.
export function unwrapNpmCmdShim(cmdPath: string): string | null {
  const lower = cmdPath.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return null;
  let text: string;
  try {
    const stat = fs.statSync(cmdPath);
    if (!stat.isFile() || stat.size > 16 * 1024) return null;
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/%dp0%\\([^"\r\n]+\.(?:[mc]?js))"/i)
    ?? text.match(/%~dp0\\([^"\r\n]+\.(?:[mc]?js))"/i);
  if (!m) return null;
  const target = path.resolve(path.dirname(cmdPath), m[1]);
  return isRegularFile(target) ? target : null;
}

// Prepares safe file + args (or verbatim Windows command line for non-npm .cmd/.bat) for node-pty.
export function buildSafeProcessLaunch(resolvedPath: string, args: string[], platform: NodeJS.Platform = process.platform): {
  file: string;
  args: string[] | string;
} {
  const lower = resolvedPath.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { file: process.execPath, args: [resolvedPath, ...args] };
  }
  if (platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    const unwrappedJs = unwrapNpmCmdShim(resolvedPath);
    if (unwrappedJs) {
      return { file: process.execPath, args: [unwrappedJs, ...args] };
    }
    // Non-npm batch script: forbid shell metacharacters so cmd.exe cannot interpret injected commands,
    // and use node-pty's verbatim command-line string branch (`cmd.exe /d /s /c ""path" args"`).
    if (CMD_METACHAR_RE.test(resolvedPath)) {
      throw new Error(`批处理路径包含不安全字符：${resolvedPath}`);
    }
    const safeArgs = args.map((a) => {
      if (CMD_METACHAR_RE.test(a)) throw new Error(`批处理参数包含不安全字符：${a}`);
      return /\s/.test(a) ? `"${a}"` : a;
    });
    const inner = [`"${resolvedPath}"`, ...safeArgs].join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: `/d /s /c "${inner}"`,
    };
  }
  return { file: resolvedPath, args };
}

export function isCmdBatchPath(resolvedPath: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!resolvedPath || platform !== 'win32') return false;
  const lower = resolvedPath.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return false;
  return unwrapNpmCmdShim(resolvedPath) === null;
}

export function resolveBuiltinPath(spec: BuiltinCliSpec, c: CliEnv = {}): string | null {
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const home = c.home ?? os.homedir();

  // Deep built-ins preserve legacy resolution first so existing setups & tests stay identical.
  if (spec.id === 'claude') {
    const primary = resolveClaude(c);
    if (primary && isRegularFile(primary)) return primary;
    if (platform === 'win32') return findExecutableWin('claude', env, home);
    return null;
  }
  if (spec.id === 'codex') {
    const primary = resolveCodex(c);
    if (primary && isRegularFile(primary)) return primary;
    if (platform === 'win32') return findExecutableWin('codex', env, home);
    return null;
  }
  if (spec.id === 'agy') {
    const primary = resolveAgy(c);
    if (primary && isRegularFile(primary)) return primary;
    if (platform === 'win32') return findExecutableWin('agy', env, home);
    return null;
  }

  for (const cmd of spec.commands) {
    const found = resolveCommandPath(cmd, c);
    if (found) return found;
  }
  const extras = platform === 'win32'
    ? (spec.extraWinPaths?.(env, home) ?? [])
    : (spec.extraPosixPaths?.(home) ?? []);
  for (const p of extras) {
    if (isRegularFile(p)) return p;
  }
  return null;
}

export function effectivePermissionMode(id: string, prefs?: Record<string, CliToolPreference>): PermissionMode {
  return prefs?.[id]?.permissionMode === 'normal' ? 'normal' : 'full';
}

export function effectiveToolEnabled(
  opts: { id: string; tier: CliTier; source: 'builtin' | 'custom'; usable: boolean },
  prefs?: Record<string, CliToolPreference>,
): boolean {
  if (!opts.usable) return false;
  const explicit = prefs?.[opts.id]?.enabled;
  if (typeof explicit === 'boolean') return explicit;
  if (opts.source === 'custom') return true;
  return opts.tier === 'deep';
}

export function sanitizeCliPrefs(raw: unknown): Record<string, CliToolPreference> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, CliToolPreference> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || k.length > 40 || !/^[a-z][a-z0-9_-]*$/.test(k)) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const obj = v as Record<string, unknown>;
    const pref: CliToolPreference = {};
    if (typeof obj.enabled === 'boolean') pref.enabled = obj.enabled;
    if (obj.permissionMode === 'full' || obj.permissionMode === 'normal') pref.permissionMode = obj.permissionMode;
    if (Object.keys(pref).length > 0) out[k] = pref;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateArgsList(raw: unknown, fieldName: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${fieldName} 必须是字符串数组`);
  if (raw.length > 20) throw new Error(`${fieldName} 最多支持 20 个参数`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${fieldName} 包含无效参数`);
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) {
      throw new Error(`${fieldName} 包含非法控制字符或过长参数`);
    }
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export function validateCustomClis(raw: unknown): CustomCliConfig[] {
  if (!Array.isArray(raw)) throw new Error('customClis 必须是数组');
  if (raw.length > 50) throw new Error('自定义 CLI 数量上限为 50 个');
  const out: CustomCliConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('自定义 CLI 配置格式无效');
    }
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim().toLowerCase() : '';
    if (!isValidCustomCliId(id)) {
      throw new Error(`自定义 CLI 标识无效或与内置冲突：${id || '(空)'}`);
    }
    if (seen.has(id)) throw new Error(`自定义 CLI 标识重复：${id}`);
    seen.add(id);

    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    if (!label || [...label].length > 40) {
      throw new Error(`自定义 CLI「${id}」名称不能为空且不超过 40 字`);
    }
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (!command || command.length > 300 || /[\x00-\x1f\x7f]/.test(command)) {
      throw new Error(`自定义 CLI「${label}」命令或路径无效`);
    }
    if (command.toLowerCase().endsWith('.ps1')) {
      throw new Error(`自定义 CLI「${label}」不支持直接执行 .ps1 脚本，请填写 .exe / .cmd 或命令名`);
    }
    const normalArgs = validateArgsList(obj.normalArgs, '正常模式参数');
    const fullAccessArgs = validateArgsList(obj.fullAccessArgs, '全权模式参数');
    const promptArg = obj.promptArg === 'none' ? 'none' : 'positional';
    out.push({
      id,
      label,
      command,
      ...(normalArgs ? { normalArgs } : {}),
      ...(fullAccessArgs ? { fullAccessArgs } : {}),
      promptArg,
    });
  }
  return out;
}

export function sanitizeStoredCustomClis(raw: unknown): CustomCliConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  try {
    const valid = validateCustomClis(raw);
    return valid.length > 0 ? valid : undefined;
  } catch {
    const out: CustomCliConfig[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      try {
        const [one] = validateCustomClis([item]);
        if (one && !seen.has(one.id)) {
          seen.add(one.id);
          out.push(one);
        }
      } catch { /* drop corrupt entry */ }
    }
    return out.length > 0 ? out : undefined;
  }
}

export function validateCliPrefsPatch(raw: unknown): Record<string, CliToolPreference> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('cliPrefs 格式无效');
  }
  const out: Record<string, CliToolPreference> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || k.length > 40 || !/^[a-z][a-z0-9_-]*$/.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new Error(`CLI 标识无效：${k}`);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`CLI「${k}」偏好格式无效`);
    }
    const obj = v as Record<string, unknown>;
    const pref: CliToolPreference = {};
    if (obj.enabled !== undefined) {
      if (typeof obj.enabled !== 'boolean') throw new Error(`CLI「${k}」启用开关无效`);
      pref.enabled = obj.enabled;
    }
    if (obj.permissionMode !== undefined) {
      if (obj.permissionMode !== 'full' && obj.permissionMode !== 'normal') {
        throw new Error(`CLI「${k}」权限模式无效`);
      }
      pref.permissionMode = obj.permissionMode;
    }
    out[k] = pref;
  }
  return out;
}

// Safe async --version probe for built-in CLIs only (never executes raw .cmd/.bat or untrusted custom scripts).
function probeCliVersion(resolvedPath: string, id: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32' && isCmdBatchPath(resolvedPath, platform)) {
    return Promise.resolve(null);
  }
  let file = resolvedPath;
  let args = ['--version'];
  if (id === 'codex') {
    const launch = codexLaunch();
    file = launch.file;
    args = [...launch.prefix, '--version'];
  } else {
    const lower = resolvedPath.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
      file = process.execPath;
      args = [resolvedPath, '--version'];
    } else if (platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
      const unwrapped = unwrapNpmCmdShim(resolvedPath);
      if (!unwrapped) return Promise.resolve(null);
      file = process.execPath;
      args = [unwrapped, '--version'];
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_STRIP_SCAN.test(k)));
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2500, maxBuffer: 64 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err && !stdout) {
        resolve(null);
        return;
      }
      const line = `${stdout ?? ''}\n${stderr ?? ''}`.trim().split(/\r?\n/)[0]?.trim() ?? '';
      const m = line.match(VERSION_RE);
      resolve(m ? m[0] : (line.length > 0 && line.length <= 32 ? line : null));
    });
  });
}

// In-memory cache of detected paths/versions updated lazily or on explicit POST /api/clis/scan.
// Bypassed whenever a caller passes synthetic CliEnv overrides (e.g. unit tests).
const builtinPathCache = new Map<string, string | null>();
const customPathCache = new Map<string, string | null>();
const versionCache = new Map<string, string | null>();
let lastScannedAt = 0;
let scanInFlight: Promise<CliScanResult> | null = null;

const isDefaultEnv = (c: CliEnv): boolean =>
  c.platform === undefined && c.env === undefined && c.home === undefined && c.delimiter === undefined;

function cachedBuiltinPath(spec: BuiltinCliSpec, c: CliEnv): string | null {
  if (!isDefaultEnv(c)) return resolveBuiltinPath(spec, c);
  if (builtinPathCache.has(spec.id)) return builtinPathCache.get(spec.id)!;
  const resolved = resolveBuiltinPath(spec, c);
  builtinPathCache.set(spec.id, resolved);
  return resolved;
}

function cachedCustomPath(command: string, c: CliEnv): string | null {
  if (!isDefaultEnv(c)) return resolveCommandPath(command, c);
  if (customPathCache.has(command)) return customPathCache.get(command)!;
  const resolved = resolveCommandPath(command, c);
  customPathCache.set(command, resolved);
  return resolved;
}

export function buildCliTools(settings: Settings, c: CliEnv = {}): CliToolInfo[] {
  const prefs = settings.cliPrefs;
  const platform = c.platform ?? process.platform;
  const tools: CliToolInfo[] = [];

  for (const spec of BUILTIN_CLI_CATALOG) {
    const resolved = cachedBuiltinPath(spec, c);
    const installed = Boolean(resolved);
    let usable = installed;
    let unusableReason: string | undefined;
    if (spec.id === 'agy' && installed && !agyUsable()) {
      usable = false;
      unusableReason = '工作台路径包含空格，Antigravity hooks 无法启用';
    }
    const enabled = effectiveToolEnabled({ id: spec.id, tier: spec.tier, source: 'builtin', usable }, prefs);
    const permissionMode = effectivePermissionMode(spec.id, prefs);
    const version = resolved ? (versionCache.get(`${spec.id}:${resolved}`) ?? null) : null;
    const isBatch = isCmdBatchPath(resolved, platform);
    tools.push({
      id: spec.id,
      label: spec.label,
      tier: spec.tier,
      source: 'builtin',
      installed,
      usable,
      ...(unusableReason ? { unusableReason } : {}),
      path: resolved,
      ...(version ? { version } : {}),
      command: spec.commands[0],
      enabled,
      permissionMode,
      fullAccessArgs: [...spec.fullAccessArgs],
      normalArgs: [...spec.normalArgs],
      supportsFullAccessFlag: spec.fullAccessArgs.length > 0,
      ...(spec.fullAccessNote ? { fullAccessNote: spec.fullAccessNote } : {}),
      capabilities: [...spec.capabilities],
      ...(spec.limitations ? { limitations: spec.limitations } : {}),
      promptArg: isBatch ? 'none' : spec.promptArg,
    });
  }

  for (const custom of settings.customClis ?? []) {
    const resolved = cachedCustomPath(custom.command, c);
    const installed = Boolean(resolved);
    const usable = installed;
    const enabled = effectiveToolEnabled({ id: custom.id, tier: 'generic', source: 'custom', usable }, prefs);
    const permissionMode = effectivePermissionMode(custom.id, prefs);
    const fullAccessArgs = [...(custom.fullAccessArgs ?? [])];
    const normalArgs = [...(custom.normalArgs ?? [])];
    const isBatch = isCmdBatchPath(resolved, platform);
    tools.push({
      id: custom.id,
      label: custom.label,
      tier: 'generic',
      source: 'custom',
      installed,
      usable,
      ...(!installed ? { unusableReason: `未在 PATH 或指定路径找到可执行文件：${custom.command}` } : {}),
      path: resolved,
      command: custom.command,
      enabled,
      permissionMode,
      fullAccessArgs,
      normalArgs,
      supportsFullAccessFlag: fullAccessArgs.length > 0,
      ...(fullAccessArgs.length === 0 ? { fullAccessNote: '未配置全权启动参数，全放开与正常模式启动参数相同' } : {}),
      capabilities: GENERIC_CAPS,
      limitations: GENERIC_LIMITS,
      promptArg: isBatch ? 'none' : (custom.promptArg ?? 'positional'),
    });
  }

  return tools;
}

export function enabledAgentsFrom(settings: Settings, tools?: CliToolInfo[], c: CliEnv = {}): AgentKind[] {
  const list = tools ?? buildCliTools(settings, c);
  const out: AgentKind[] = list.filter((t) => t.enabled && t.usable).map((t) => t.id);
  if (process.env.WORKBENCH_FAKE_AGENT === '1') {
    const fakePref = settings.cliPrefs?.fake?.enabled;
    if (fakePref !== false) out.push('fake');
  }
  return out;
}

export function delegatableAgentsFrom(settings: Settings, tools?: CliToolInfo[], c: CliEnv = {}): AgentKind[] {
  return enabledAgentsFrom(settings, tools, c).filter((id) => isDeepAgent(id));
}

export function getCliTool(id: string, settings: Settings, c: CliEnv = {}): CliToolInfo | undefined {
  return buildCliTools(settings, c).find((t) => t.id === id);
}

export function getBuiltinCliSpec(id: string): BuiltinCliSpec | undefined {
  return BUILTIN_BY_ID.get(id);
}

export function getCachedCliScan(settings: Settings, c: CliEnv = {}): CliScanResult {
  const cliTools = buildCliTools(settings, c);
  const agents = enabledAgentsFrom(settings, cliTools, c);
  if (!lastScannedAt) lastScannedAt = Date.now();
  return { agents, cliTools, scannedAt: lastScannedAt };
}

export function scanCliTools(settings: Settings, c: CliEnv = {}): Promise<CliScanResult> {
  if (scanInFlight) return scanInFlight;
  const run = (async (): Promise<CliScanResult> => {
    if (isDefaultEnv(c)) {
      builtinPathCache.clear();
      customPathCache.clear();
    }
    const platform = c.platform ?? process.platform;
    const pre = buildCliTools(settings, c);
    await Promise.all(
      pre
        .filter((t) => t.source === 'builtin' && t.installed && t.path)
        .map(async (t) => {
          const ver = await probeCliVersion(t.path!, t.id, platform);
          versionCache.set(`${t.id}:${t.path!}`, ver);
        }),
    );
    lastScannedAt = Date.now();
    const cliTools = buildCliTools(settings, c);
    const agents = enabledAgentsFrom(settings, cliTools, c);
    return { agents, cliTools, scannedAt: lastScannedAt };
  })();
  scanInFlight = run.finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}
