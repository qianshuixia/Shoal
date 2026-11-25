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
import { agyUsable, codexLaunchFor, resolveAgy, resolveClaude, resolveCodex } from './agents.ts';
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
const GENERIC_CODEX_CAPS = [...GENERIC_CAPS, 'Codex 订阅额度'];
const GENERIC_LIMITS = '未深度适配：不支持自动状态感知（工作中/待验收卡片）、自动对话续接、Token 统计与跨 CLI 自动委派';
const GENERIC_CODEX_LIMITS = '未深度适配：不支持自动状态感知（工作中/待验收卡片）、自动对话续接、Token 统计与跨 CLI 自动委派；已识别为 Codex，支持显示订阅额度';

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
  const npmPrefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix ?? '';
  const pnpmHome = env.PNPM_HOME ?? '';
  const voltaHome = env.VOLTA_HOME ?? '';
  const nvmSymlink = env.NVM_SYMLINK ?? '';
  const pathDirs = getEnvPath(env).split(';');
  const common = [
    appdata ? path.win32.join(appdata, 'npm') : '',
    npmPrefix,
    pnpmHome,
    voltaHome ? path.win32.join(voltaHome, 'bin') : '',
    nvmSymlink,
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
      const cand = /^[A-Za-z]:/.test(dir) ? path.win32.join(dir, name) : path.join(dir, name);
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

const SHIM_RUNNER_BASENAMES = new Set(['node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe']);
const SHIM_NODE_CALL_RE = /^@?(?:call\s+)?(?:"%_prog%"|node(?:\.exe)?|"(?:%dp0%|%~dp0)[\\/]?node\.exe"|"[A-Za-z]:[\\/][^"\r\n]*[\\/]node\.exe")\s+"([^"\r\n]+\.(?:[mc]?js))"\s+%\*\s*$/i;
const SHIM_EXE_CALL_RE = /^@?(?:call\s+)?"([^"\r\n]+\.exe)"\s+%\*\s*$/i;
const SHIM_ALLOWED_SET_VARS = new Set(['_prog', 'dp0', 'pathext', 'node_path', '_bin', '_basedir', 'local_node_path']);
const SHIM_SET_VAR_RE = /^@?set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=|([A-Za-z_][A-Za-z0-9_]*)=)/i;
const SHIM_IF_EXIST_RE = /^@?if\s+(?:not\s+)?exist\s+(?:"[^"\r\n()]+"|[^\s()]+)(?:\s*\(|\s+set\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=|([A-Za-z_][A-Za-z0-9_]*)=)[^\r\n()]+)?$/i;
const SHIM_BOILERPLATE_SEG_RE = /^@?(?:echo\s+off|setlocal|endlocal|goto\b|else\b|exit\s+\/b\b|call\s+:[A-Za-z0-9_.-]+|title\b|set\b|:[A-Za-z0-9_.-]+)(?:\s|$)/i;

// Unwraps Windows .cmd/.bat shims (npm, pnpm, yarn, scoop, etc.) to their underlying JS entrypoint or native .exe
// ONLY when every statement in the batch script matches pure pass-through shim boilerplate (no custom env vars like
// CODEX_HOME, no `cd`/`pushd`/arbitrary `if` branches, and no extra fixed arguments).
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

  const baseDir = path.dirname(cmdPath);
  const resolveTarget = (rawTarget: string): string | null => {
    let target: string;
    const relMatch = rawTarget.match(/^(?:%dp0%|%~dp0)[\\/]*(.+)$/i);
    if (relMatch) {
      const normalized = relMatch[1].replaceAll('\\', path.sep);
      target = path.resolve(baseDir, normalized);
    } else if (/^[A-Za-z]:[\\/]/.test(rawTarget)) {
      target = rawTarget;
    } else {
      return null;
    }
    if (SHIM_RUNNER_BASENAMES.has(path.win32.basename(target).toLowerCase())) return null;
    return isRegularFile(target) ? target : null;
  };

  let matchedTarget: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(@?rem\b|::)/i.test(line)) continue;
    const segments = line.split(/(?:\|\||&&|&)/);
    for (const rawSeg of segments) {
      const seg = rawSeg.trim().replace(/^[()]+|[()]+$/g, '').trim();
      if (!seg) continue;
      // Reject any custom `set VAR=...` (such as CODEX_HOME, OPENAI_API_KEY, etc.) so wrapper env setup is never bypassed.
      const setMatch = seg.match(SHIM_SET_VAR_RE);
      if (setMatch) {
        const varName = (setMatch[1] ?? setMatch[2] ?? '').toLowerCase();
        if (!SHIM_ALLOWED_SET_VARS.has(varName)) return null;
        continue;
      }
      if (seg.includes('%*')) {
        const jsMatch = seg.match(SHIM_NODE_CALL_RE);
        if (jsMatch) {
          const hit = resolveTarget(jsMatch[1]);
          if (hit) {
            if (matchedTarget && matchedTarget !== hit) return null;
            matchedTarget = hit;
            continue;
          }
        }
        const exeMatch = seg.match(SHIM_EXE_CALL_RE);
        if (exeMatch) {
          const hit = resolveTarget(exeMatch[1]);
          if (hit) {
            if (matchedTarget && matchedTarget !== hit) return null;
            matchedTarget = hit;
            continue;
          }
        }
        return null;
      }
      // Allow only npm/pnpm-style `IF EXIST <path> (` or `IF EXIST <path> SET <allowed>=...` guards; reject arbitrary `if` commands.
      if (/^@?if\b/i.test(seg)) {
        const ifMatch = seg.match(SHIM_IF_EXIST_RE);
        if (!ifMatch) return null;
        const varName = (ifMatch[1] ?? ifMatch[2] ?? '').toLowerCase();
        if (varName && !SHIM_ALLOWED_SET_VARS.has(varName)) return null;
        continue;
      }
      // Reject non-boilerplate commands (e.g. `cd`, `pushd`, `call other.cmd`, `echo ...`) so wrapper behavior is preserved.
      if (!SHIM_BOILERPLATE_SEG_RE.test(seg)) return null;
    }
  }

  return matchedTarget;
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
    const unwrapped = unwrapNpmCmdShim(resolvedPath);
    if (unwrapped) {
      const unwrappedLower = unwrapped.toLowerCase();
      if (unwrappedLower.endsWith('.js') || unwrappedLower.endsWith('.mjs') || unwrappedLower.endsWith('.cjs')) {
        return { file: process.execPath, args: [unwrapped, ...args] };
      }
      return { file: unwrapped, args };
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

  // Deep built-ins preserve legacy default resolution first, with Windows PATH/common-dir fallback inside resolve*().
  if (spec.id === 'claude') {
    const primary = resolveClaude(c);
    return primary && isRegularFile(primary) ? primary : null;
  }
  if (spec.id === 'codex') {
    const primary = resolveCodex(c);
    return primary && isRegularFile(primary) ? primary : null;
  }
  if (spec.id === 'agy') {
    const primary = resolveAgy(c);
    return primary && isRegularFile(primary) ? primary : null;
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
function probeCliVersion(resolvedPath: string, _id: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform === 'win32' && isCmdBatchPath(resolvedPath, platform)) {
    return Promise.resolve(null);
  }
  let file = resolvedPath;
  let args = ['--version'];
  const lower = resolvedPath.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    file = process.execPath;
    args = [resolvedPath, '--version'];
  } else if (platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    const unwrapped = unwrapNpmCmdShim(resolvedPath);
    if (!unwrapped) return Promise.resolve(null);
    const unwrappedLower = unwrapped.toLowerCase();
    if (unwrappedLower.endsWith('.js') || unwrappedLower.endsWith('.mjs') || unwrappedLower.endsWith('.cjs')) {
      file = process.execPath;
      args = [unwrapped, '--version'];
    } else {
      file = unwrapped;
      args = ['--version'];
    }
  } else if (platform !== 'win32') {
    const launch = codexLaunchFor(resolvedPath);
    file = launch.file;
    args = [...launch.prefix, '--version'];
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

const CODEX_NAME_TOKEN_RE = /(?:^|[-_.])codex(?:[-_.]|$)/i;
const CODEX_PKG_RE = /@openai[\\/]codex(?:@[^\s"']+)?(?:[\\/]|$)/i;
const CODEX_EXEC_TOKEN_RE = /^(?:(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/]|(?:%dp0%|%~dp0)[\\/]*)?[^"\r\n]*[\\/])?codex(?:\.(?:exe|cmd|bat|js|mjs|cjs))?$/i;
const CODEX_RUNNER_COMMANDS = new Set([
  'node', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'corepack',
  'wsl', 'env', 'cmd', 'bash', 'sh', 'zsh', 'pwsh', 'powershell',
  'volta', 'mise', 'asdf', 'fnm', 'nvm',
]);
const CODEX_WRAPPER_EXT_RE = /\.(?:cmd|bat|sh)$/i;
const STRIP_EXEC_EXT_RE = /\.(?:exe|cmd|bat|com|js|mjs|cjs|sh)$/i;
const BATCH_SET_CODEX_HOME_RE = /^@?set\s+(?:"CODEX_HOME=([^"\r\n]*)"|CODEX_HOME=([^&\r\n]*))$/i;
const SHELL_VAR_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function pathBaseNoExt(raw: string): string {
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return base.replace(STRIP_EXEC_EXT_RE, '');
}

function isCodexPathOrName(raw: string): boolean {
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return false;
  if (CODEX_PKG_RE.test(cleaned)) return true;
  return CODEX_NAME_TOKEN_RE.test(pathBaseNoExt(cleaned));
}

function isCodexRunnerCommand(command: string): boolean {
  return CODEX_RUNNER_COMMANDS.has(pathBaseNoExt(command).toLowerCase());
}

function isCodexExecutableToken(token: string): boolean {
  const cleaned = token.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return false;
  return CODEX_PKG_RE.test(cleaned) || CODEX_EXEC_TOKEN_RE.test(cleaned);
}

const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists',
  '--conditions', '-C', '--diagnostic-dir', '--heapsnapshot-signal', '--inspect-port', '--max-old-space-size',
  '--redirect-warnings', '--title', '-c', '--eval', '-e', '-p', '--print',
]);
const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--userconfig', '--cache', '--registry']);
const WSL_VALUE_FLAGS = new Set(['-d', '--distribution', '-u', '--user', '--cd', '--shell-type']);

function isCodexArgs(command: string, args?: readonly string[], depth = 0): boolean {
  if (!args?.length || depth > 3) return false;
  const runner = pathBaseNoExt(command).toLowerCase();
  if (!CODEX_RUNNER_COMMANDS.has(runner)) return false;

  if (runner === 'node' || runner === 'bun' || runner === 'deno') {
    let i = 0;
    if (runner === 'bun' && args[0] === 'run') i = 1;
    if (runner === 'deno' && args[0] === 'run') i = 1;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a.startsWith('-')) {
        if (!a.includes('=') && NODE_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      return isCodexExecutableToken(a);
    }
    return i < args.length ? isCodexExecutableToken(args[i]) : false;
  }

  if (runner === 'npx' || runner === 'bunx' || runner === 'pnpx') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        const next = args[i + 1];
        return next ? isCodexExecutableToken(next) : false;
      }
      if (a === '-p' || a === '--package') {
        const pkg = args[i + 1];
        if (pkg && isCodexExecutableToken(pkg)) return true;
        i++;
        continue;
      }
      if (a.startsWith('--package=')) {
        if (isCodexExecutableToken(a.slice('--package='.length))) return true;
        continue;
      }
      if (a.startsWith('-')) {
        if (!a.includes('=') && NPX_VALUE_FLAGS.has(a)) i++;
        continue;
      }
      return isCodexExecutableToken(a);
    }
    return false;
  }

  if (runner === 'pnpm' || runner === 'yarn') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i++;
    const sub = args[i]?.toLowerCase();
    if (sub !== 'dlx' && sub !== 'exec' && sub !== 'x') return false;
    i++;
    while (i < args.length && args[i].startsWith('-')) {
      if ((args[i] === '--package' || args[i] === '-p') && args[i + 1]) {
        if (isCodexExecutableToken(args[i + 1])) return true;
        i += 2;
        continue;
      }
      i++;
    }
    const target = args[i];
    return target ? (isCodexExecutableToken(target) || isCodexArgs(target, args.slice(i + 1), depth + 1)) : false;
  }

  if (runner === 'volta' || runner === 'mise' || runner === 'asdf' || runner === 'fnm' || runner === 'nvm' || runner === 'corepack') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i++;
    const sub = args[i]?.toLowerCase();
    if (sub === 'run' || sub === 'exec' || sub === 'x') i++;
    while (i < args.length && args[i].startsWith('-')) {
      if (!args[i].includes('=') && (args[i] === '--node' || args[i] === '--npm' || args[i] === '--yarn')) i++;
      i++;
    }
    if (args[i] === '--') i++;
    const target = args[i];
    return target ? (isCodexExecutableToken(target) || isCodexArgs(target, args.slice(i + 1), depth + 1)) : false;
  }

  if (runner === 'wsl') {
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '--' || a === '-e' || a === '--exec') { i++; break; }
      if (a.startsWith('-')) {
        if (!a.includes('=') && WSL_VALUE_FLAGS.has(a)) i++;
        i++;
        continue;
      }
      break;
    }
    const target = args[i];
    return target ? (isCodexExecutableToken(target) || isCodexArgs(target, args.slice(i + 1), depth + 1)) : false;
  }

  if (runner === 'env') {
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-u' || a === '--unset') { i += 2; continue; }
      if (a.startsWith('-') || SHELL_VAR_ASSIGN_RE.test(a)) { i++; continue; }
      break;
    }
    const target = args[i];
    return target ? (isCodexExecutableToken(target) || isCodexArgs(target, args.slice(i + 1), depth + 1)) : false;
  }

  // Shells (`cmd`, `bash`, `sh`, `zsh`, `pwsh`, `powershell`): inspect command argument only when `-c` / `/c` / `/k` / `-Command` or direct script path is given.
  if (runner === 'cmd' || runner === 'bash' || runner === 'sh' || runner === 'zsh' || runner === 'pwsh' || runner === 'powershell') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const al = a.toLowerCase();
      if (al === '/c' || al === '/k' || al === '-c' || al === '-lc' || al === '-command') {
        const inline = args.slice(i + 1).join(' ');
        for (const seg of splitCommandSegments(inline)) {
          const toks = tokenizeCommandSegment(seg);
          const first = toks[0]?.text ?? '';
          if (first && (isCodexExecutableToken(first) || isCodexArgs(first, toks.slice(1).map(t => t.text), depth + 1))) {
            return true;
          }
        }
        return false;
      }
      if (a.startsWith('-') || a.startsWith('/')) continue;
      return isCodexExecutableToken(a);
    }
    return false;
  }

  return false;
}

interface ShellToken {
  text: string;
  raw: string;
}

function tokenizeCommandSegment(seg: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let cur = '';
  let raw = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      raw += ch;
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < seg.length && (seg[i + 1] === '"' || seg[i + 1] === '\\' || seg[i + 1] === '$')) {
        const next = seg[++i];
        raw += next;
        cur += next;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push({ text: cur, raw });
        cur = '';
        raw = '';
        hasToken = false;
      }
    } else {
      cur += ch;
      raw += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push({ text: cur, raw });
  return tokens;
}

function splitCommandSegments(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ((ch === '&' || ch === '|') && line[i + 1] === ch) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    if (ch === '&' || ch === ';' || ch === '|') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function isAbsoluteAny(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
}

function expandBatchCodexHome(raw: string, scriptDir: string, env: NodeJS.ProcessEnv, home: string): string | null {
  let out = raw.trim().replace(/^"|"$/g, '');
  if (!out) return null;
  const dp0 = scriptDir.endsWith('\\') || scriptDir.endsWith('/') ? scriptDir : `${scriptDir}${path.sep}`;
  out = out.replace(/%~dp0|%dp0%/gi, dp0);
  out = out.replace(/%(USERPROFILE|HOME|APPDATA|LOCALAPPDATA)%/gi, (_, key: string) => {
    const upper = key.toUpperCase();
    if (upper === 'USERPROFILE' || upper === 'HOME') return env[upper] ?? env.USERPROFILE ?? env.HOME ?? home;
    return env[upper] ?? `%${key}%`;
  });
  if (/%[^%]+%/.test(out)) return null;
  if (!isAbsoluteAny(out)) return null;
  return path.normalize(out);
}

function expandShellCodexHomeRaw(rawRhs: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const trimmed = rawRhs.trim();
  if (!trimmed) return null;
  const homeVal = env.HOME ?? home;
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < trimmed.length && (trimmed[i + 1] === '"' || trimmed[i + 1] === '\\' || trimmed[i + 1] === '$')) {
        out += trimmed[++i];
        continue;
      }
      if (ch === '$') {
        if (trimmed.startsWith('${HOME}', i)) { out += homeVal; i += 6; continue; }
        if (/^\$HOME(?![A-Za-z0-9_])/.test(trimmed.slice(i))) { out += homeVal; i += 4; continue; }
        return null; // unexpanded $VAR inside double quotes
      }
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\' && i + 1 < trimmed.length) { out += trimmed[++i]; continue; }
    if (i === 0 && ch === '~' && (trimmed.length === 1 || trimmed[1] === '/' || trimmed[1] === '\\')) {
      out += homeVal;
      continue;
    }
    if (ch === '$') {
      if (trimmed.startsWith('${HOME}', i)) { out += homeVal; i += 6; continue; }
      if (/^\$HOME(?![A-Za-z0-9_])/.test(trimmed.slice(i))) { out += homeVal; i += 4; continue; }
      return null; // unexpanded $VAR
    }
    out += ch;
  }
  if (!out || !isAbsoluteAny(out)) return null;
  return path.normalize(out);
}

const WRAPPER_CACHE_MAX = 64;
const wrapperCodexCache = new Map<string, { isCodex: boolean; codexHome?: string }>();

function inspectWrapperForCodex(resolvedPath: string, env: NodeJS.ProcessEnv, home: string): { isCodex: boolean; codexHome?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 16 * 1024) return { isCodex: false };
  } catch {
    return { isCodex: false };
  }
  const inheritedExported = typeof env.CODEX_HOME === 'string';
  const cacheKey = `${resolvedPath}|${stat.ino}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}|${home}|${env.USERPROFILE ?? ''}|${env.HOME ?? ''}|${env.APPDATA ?? ''}|${env.LOCALAPPDATA ?? ''}|${inheritedExported ? '1' : '0'}`;
  const cached = wrapperCodexCache.get(cacheKey);
  if (cached) return cached;

  let text: string;
  try {
    const buf = fs.readFileSync(resolvedPath);
    if (buf.includes(0)) return { isCodex: false };
    text = buf.toString('utf8');
  } catch {
    return { isCodex: false };
  }
  const isScript = CODEX_WRAPPER_EXT_RE.test(resolvedPath) || text.startsWith('#!');
  if (!isScript) return { isCodex: false };

  const scriptDir = path.dirname(resolvedPath);
  const isBatch = /\.(?:cmd|bat)$/i.test(resolvedPath);
  let isCodex = false;
  let activeCodexHome: string | undefined; // batch: set CODEX_HOME; shell: exported CODEX_HOME
  let shellLocalCodexHome: string | undefined; // shell: assigned but not yet exported CODEX_HOME
  let shellCodexHomeExported = inheritedExported;
  let effectiveCodexHome: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isBatch ? /^(@?rem\b|::)/i.test(line) : line.startsWith('#')) continue;

    for (const seg of splitCommandSegments(line)) {
      if (isBatch) {
        const setMatch = seg.match(BATCH_SET_CODEX_HOME_RE);
        if (setMatch) {
          const val = setMatch[1] ?? setMatch[2] ?? '';
          activeCodexHome = val.trim() ? (expandBatchCodexHome(val, scriptDir, env, home) ?? undefined) : undefined;
          continue;
        }
        const tokens = tokenizeCommandSegment(seg);
        let idx = 0;
        if (tokens[idx]?.text.startsWith('@')) tokens[idx] = { ...tokens[idx], text: tokens[idx].text.slice(1) };
        if (tokens[idx] && tokens[idx].text.toLowerCase() === 'call') idx++;
        const cmd = tokens[idx]?.text ?? '';
        const rest = tokens.slice(idx + 1).map(t => t.text);
        if (cmd && (isCodexExecutableToken(cmd) || isCodexArgs(cmd, rest))) {
          isCodex = true;
          effectiveCodexHome = activeCodexHome;
        }
      } else {
        const tokens = tokenizeCommandSegment(seg);
        if (!tokens.length) continue;
        // Handle `export CODEX_HOME=...`, `export CODEX_HOME`, and `unset CODEX_HOME`
        if (tokens[0].text === 'export') {
          for (const t of tokens.slice(1)) {
            if (t.text === 'CODEX_HOME') {
              shellCodexHomeExported = true;
              activeCodexHome = shellLocalCodexHome;
              continue;
            }
            const m = t.raw.match(SHELL_VAR_ASSIGN_RE);
            if (m && m[1] === 'CODEX_HOME') {
              const val = expandShellCodexHomeRaw(m[2], env, home) ?? undefined;
              shellCodexHomeExported = true;
              shellLocalCodexHome = val;
              activeCodexHome = val;
            }
          }
          continue;
        }
        if (tokens[0].text === 'unset') {
          if (tokens.slice(1).some(t => t.text === 'CODEX_HOME')) {
            shellCodexHomeExported = false;
            shellLocalCodexHome = undefined;
            activeCodexHome = undefined;
          }
          continue;
        }

        // Parse optional leading `VAR=VAL` assignments, `exec`/`command`/`nohup`, and `env [VAR=VAL | -u VAR]...`
        let idx = 0;
        let inlineCodexHome: string | undefined;
        let inlineSet = false;
        let inlineUnset = false;
        while (idx < tokens.length) {
          const t = tokens[idx];
          const m = t.raw.match(SHELL_VAR_ASSIGN_RE);
          if (m) {
            if (m[1] === 'CODEX_HOME') {
              inlineCodexHome = expandShellCodexHomeRaw(m[2], env, home) ?? undefined;
              inlineSet = true;
              inlineUnset = false;
            }
            idx++;
            continue;
          }
          break;
        }
        if (idx >= tokens.length) {
          // Pure `CODEX_HOME=...` without a command: exported if already exported (including inherited env) or later `export CODEX_HOME`.
          if (inlineSet) {
            shellLocalCodexHome = inlineCodexHome;
            if (shellCodexHomeExported) activeCodexHome = inlineCodexHome;
          }
          continue;
        }

        while (idx < tokens.length) {
          const word = tokens[idx].text;
          if (word === 'exec' || word === 'command' || word === 'nohup') {
            idx++;
            continue;
          }
          if (word === 'env') {
            idx++;
            while (idx < tokens.length) {
              const et = tokens[idx];
              if (et.text === '-i' || et.text === '--ignore-environment') {
                inlineCodexHome = undefined;
                inlineUnset = true;
                idx++;
                continue;
              }
              if ((et.text === '-u' || et.text === '--unset') && idx + 1 < tokens.length) {
                if (tokens[idx + 1].text === 'CODEX_HOME') {
                  inlineCodexHome = undefined;
                  inlineUnset = true;
                }
                idx += 2;
                continue;
              }
              if (et.text === '--') {
                idx++;
                break;
              }
              const em = et.raw.match(SHELL_VAR_ASSIGN_RE);
              if (em) {
                if (em[1] === 'CODEX_HOME') {
                  inlineCodexHome = expandShellCodexHomeRaw(em[2], env, home) ?? undefined;
                  inlineUnset = false;
                }
                idx++;
                continue;
              }
              break;
            }
            continue;
          }
          break;
        }

        const cmd = tokens[idx]?.text ?? '';
        const rest = tokens.slice(idx + 1).map(t => t.text);
        if (cmd && (isCodexExecutableToken(cmd) || isCodexArgs(cmd, rest))) {
          isCodex = true;
          effectiveCodexHome = inlineCodexHome ?? (inlineUnset ? undefined : activeCodexHome);
        }
      }
    }
  }
  const res = { isCodex, ...(isCodex && effectiveCodexHome ? { codexHome: effectiveCodexHome } : {}) };
  if (wrapperCodexCache.size >= WRAPPER_CACHE_MAX) {
    const oldest = wrapperCodexCache.keys().next().value;
    if (oldest !== undefined) wrapperCodexCache.delete(oldest);
  }
  wrapperCodexCache.set(cacheKey, res);
  return res;
}

export interface CustomCodexDetection {
  isCodex: boolean;
  codexHome?: string;
}

// Recognizes whether a user-defined custom CLI wraps or launches OpenAI Codex CLI (and extracts an explicit CODEX_HOME
// from .cmd/.bat/.sh wrapper scripts when present). Pure read-only inspection; never executes untrusted files.
export function detectCustomCodex(
  custom: CustomCliConfig,
  resolvedPath: string | null,
  c: CliEnv = {},
): CustomCodexDetection {
  const env = c.env ?? process.env;
  const home = c.home ?? os.homedir();
  const wrapper = resolvedPath ? inspectWrapperForCodex(resolvedPath, env, home) : { isCodex: false };

  let isCodex = wrapper.isCodex;
  if (!isCodex && resolvedPath) {
    const unwrapped = unwrapNpmCmdShim(resolvedPath);
    if (unwrapped && isCodexPathOrName(unwrapped)) isCodex = true;
  }
  if (!isCodex && resolvedPath) {
    try {
      const real = fs.realpathSync(resolvedPath);
      if (isCodexPathOrName(real)) isCodex = true;
    } catch { /* ignore */ }
  }
  if (!isCodex && (isCodexPathOrName(custom.command) || (resolvedPath ? isCodexPathOrName(resolvedPath) : false))) {
    isCodex = true;
  }
  if (!isCodex && (isCodexArgs(custom.command, custom.fullAccessArgs) || isCodexArgs(custom.command, custom.normalArgs))) {
    isCodex = true;
  }
  if (!isCodex && CODEX_NAME_TOKEN_RE.test(custom.id)) {
    isCodex = true;
  }
  return { isCodex, ...(isCodex && wrapper.codexHome ? { codexHome: wrapper.codexHome } : {}) };
}

function normHomeKey(dir: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(dir).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isDistinctCodexHome(codexHome: string | undefined, c: CliEnv): boolean {
  if (!codexHome) return false;
  const platform = c.platform ?? process.platform;
  const env = c.env ?? process.env;
  const home = c.home ?? os.homedir();
  const defaultHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  return normHomeKey(codexHome, platform) !== normHomeKey(defaultHome, platform);
}

// Resolves which CODEX_HOME directories should be scanned for subscription quota:
// - hasDefaultCodex: true when built-in `codex` or any enabled custom Codex CLI uses the default CODEX_HOME.
// - customHomes: enabled custom Codex CLIs whose wrapper script explicitly sets a distinct CODEX_HOME.
export function resolveCustomCodexHomes(
  settings: Settings,
  c: CliEnv = {},
): { hasDefaultCodex: boolean; customHomes: { id: string; codexHome: string }[] } {
  const tools = buildCliTools(settings, c);
  const customById = new Map((settings.customClis ?? []).map((x) => [x.id, x]));

  let hasDefaultCodex = tools.some((t) => t.id === 'codex' && t.enabled && t.usable);
  const customHomes: { id: string; codexHome: string }[] = [];

  for (const t of tools) {
    if (t.source !== 'custom' || t.quotaAgent !== 'codex' || !t.enabled || !t.usable) continue;
    const cfg = customById.get(t.id);
    const det = cfg ? detectCustomCodex(cfg, t.path, c) : { isCodex: true };
    if (det.codexHome && isDistinctCodexHome(det.codexHome, c)) {
      customHomes.push({ id: t.id, codexHome: det.codexHome });
    } else {
      hasDefaultCodex = true;
    }
  }
  return { hasDefaultCodex, customHomes };
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
    const codexDet = detectCustomCodex(custom, resolved, c);
    const quotaKey = codexDet.isCodex
      ? (isDistinctCodexHome(codexDet.codexHome, c) ? custom.id : 'codex')
      : undefined;
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
      capabilities: codexDet.isCodex ? [...GENERIC_CODEX_CAPS] : [...GENERIC_CAPS],
      limitations: codexDet.isCodex ? GENERIC_CODEX_LIMITS : GENERIC_LIMITS,
      promptArg: isBatch ? 'none' : (custom.promptArg ?? 'positional'),
      ...(codexDet.isCodex ? { quotaAgent: 'codex' as const, quotaKey } : {}),
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
