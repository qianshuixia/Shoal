import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  ChangedFile, ChangeStatus, DiffPayload, FileListResult, FilePayload, FsCreateBody, FsCreateResult, FsDeleteBody, FsDeleteResult, FsPasteBody, FsPasteResult, FsRenameBody, FsRenameResult, GitInfo, ProjectChanges, TreeEntry, TreeListing, WriteFileBody, WriteFileResult,
} from '../shared/protocol.ts';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB guard for editor & diff
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB guard for inline image preview
export const MAX_FILE_SEARCH = 20_000;
export const MAX_CHANGED_FILES = 20_000;
export const MAX_UNTRACKED_LINE_STAT = 200;

const PORCELAIN_CACHE_TTL_MS = 250;
const LINE_STAT_CONCURRENCY = 16;
const PATH_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' });
const NAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// Heavy artifact / dependency folders dimmed in the tree and skipped during fallback FS walk.
// Note: dotfiles like .env, .env.local, .gitignore, .github are intentionally NOT here so users can inspect/edit them!
const HEAVY_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', '.parcel-cache', 'coverage', '.worktrees', '__pycache__', '.venv', 'venv',
]);

export class WorkspaceError extends Error {
  status: number;
  code?: string;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const toPosix = (p: string): string => p.replace(/\\/g, '/');

function isInsideRoot(realRoot: string, realTarget: string): boolean {
  const normRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const normTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget === normRoot || normTarget.startsWith(rootWithSep);
}

export interface ResolvedProjectPath {
  realRoot: string;
  absPath: string;
  relPosix: string; // '' when allowRoot && root requested
}

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git');
}

// Resolves a relative path inside projectDir, rejecting '..', drive switches, UNC paths, external symlinks, and '.git' internals.
export function resolveProjectPath(
  projectDir: string,
  rawRelPath: string,
  opts: { allowRoot?: boolean; allowGitRead?: boolean; preserveSpaces?: boolean } = {},
): ResolvedProjectPath {
  if (typeof rawRelPath !== 'string' || rawRelPath.includes('\0')) {
    throw new WorkspaceError(400, '文件路径无效');
  }
  const normalizedInput = opts.preserveSpaces ? rawRelPath : rawRelPath.trim();
  if (/^(?:\\\\|\/\/)/.test(normalizedInput) || /^[A-Za-z]:/.test(normalizedInput)) {
    throw new WorkspaceError(400, '只允许项目内的相对路径');
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(projectDir);
  } catch {
    throw new WorkspaceError(404, `项目目录不存在：${projectDir}`);
  }
  const cleaned = normalizedInput.replace(/^[/\\]+/, '');
  if (!cleaned) {
    if (opts.allowRoot) return { realRoot, absPath: realRoot, relPosix: '' };
    throw new WorkspaceError(400, '缺少文件路径');
  }
  const absPath = path.resolve(realRoot, cleaned);
  const rel = path.relative(realRoot, absPath);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new WorkspaceError(400, '文件路径超出项目目录范围');
  }
  if (!opts.allowGitRead && hasGitSegment(rel)) {
    throw new WorkspaceError(403, '不允许直接访问或修改 .git 内部文件');
  }
  // Verify realpath containment on the deepest existing ancestor (and the leaf itself if it exists).
  let probe = absPath;
  while (true) {
    if (fs.existsSync(probe)) {
      let realProbe: string;
      try {
        realProbe = fs.realpathSync.native(probe);
      } catch {
        throw new WorkspaceError(400, '无法解析真实文件路径');
      }
      if (!isInsideRoot(realRoot, realProbe)) {
        throw new WorkspaceError(403, '拒绝访问指向项目目录之外的符号链接');
      }
      const realRel = path.relative(realRoot, realProbe);
      if (!opts.allowGitRead && realRel && hasGitSegment(realRel)) {
        throw new WorkspaceError(403, '不允许通过符号链接访问 .git 内部文件');
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return { realRoot, absPath, relPosix: toPosix(rel) };
}

interface GitBufResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  code: number | string | null;
}

function runGitBuf(cwd: string, args: string[], timeout = 12_000): Promise<GitBufResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, encoding: 'buffer', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = !!e && (
          e.killed === true
          || e.code === 'ETIMEDOUT'
          || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        );
        resolve({
          ok: !err,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
          timedOut,
          code: e?.code ?? 0,
        });
      },
    );
  });
}

function classifyStatus(xy: string): ChangeStatus {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'R';
  if (y === 'D' || (x === 'D' && y === '.')) return 'D';
  if (x === 'A' && y !== 'D') return 'A';
  return 'M';
}

const STATUS_PRIORITY: Record<ChangeStatus, number> = { U: 6, D: 5, M: 4, A: 3, R: 2, '?': 1 };

export interface ParsedPorcelainItem {
  path: string;
  origPath?: string;
  status: ChangeStatus;
  isSubmodule?: boolean;
  isDirHint?: boolean;
}

interface ParsedPorcelain {
  git: GitInfo | null;
  initial: boolean;
  items: ParsedPorcelainItem[];
}

export function parsePorcelainZ(buf: Buffer): ParsedPorcelain {
  const text = buf.toString('utf8');
  const tokens = text.split('\0');
  let head: string | undefined;
  let oid = '';
  const byPath = new Map<string, ParsedPorcelainItem>();

  const mergeItem = (next: ParsedPorcelainItem) => {
    if (!next.path) return;
    const prev = byPath.get(next.path);
    if (!prev) {
      byPath.set(next.path, next);
      return;
    }
    // Same path deleted in index/worktree and recreated as untracked -> treat as modified without duplicate keys
    if ((prev.status === 'D' && next.status === '?') || (prev.status === '?' && next.status === 'D')) {
      const origPath = prev.origPath ?? next.origPath;
      byPath.set(next.path, {
        path: next.path,
        status: 'M',
        ...(origPath ? { origPath } : {}),
        ...((prev.isSubmodule || next.isSubmodule) ? { isSubmodule: true } : {}),
        ...((prev.isDirHint || next.isDirHint) ? { isDirHint: true } : {}),
      });
      return;
    }
    const keepNext = STATUS_PRIORITY[next.status] >= STATUS_PRIORITY[prev.status];
    const origPath = keepNext ? (next.origPath ?? prev.origPath) : (prev.origPath ?? next.origPath);
    byPath.set(next.path, {
      path: next.path,
      status: keepNext ? next.status : prev.status,
      ...(origPath ? { origPath } : {}),
      ...((prev.isSubmodule || next.isSubmodule) ? { isSubmodule: true } : {}),
      ...((prev.isDirHint || next.isDirHint) ? { isDirHint: true } : {}),
    });
  };

  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      if (rec.startsWith('# branch.head ')) head = rec.slice('# branch.head '.length).trim();
      else if (rec.startsWith('# branch.oid ')) oid = rec.slice('# branch.oid '.length).trim();
      continue;
    }
    const kind = rec[0];
    if (kind === '?' && rec[1] === ' ') {
      const rawPath = rec.slice(2);
      const isDirHint = rawPath.endsWith('/');
      const cleanPath = isDirHint ? rawPath.slice(0, -1) : rawPath;
      mergeItem({ path: cleanPath, status: '?', ...(isDirHint ? { isDirHint: true } : {}) });
    } else if (kind === '1' && rec[1] === ' ') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const m = rec.match(/^1 (\S+) (\S+) (\S+) (\S+) (\S+) \S+ \S+ ([\s\S]+)$/);
      if (m) {
        const isSubmodule = m[2].startsWith('S') || m[3] === '160000' || m[4] === '160000' || m[5] === '160000';
        mergeItem({ path: m[6], status: classifyStatus(m[1]), ...(isSubmodule ? { isSubmodule: true } : {}) });
      }
    } else if (kind === '2' && rec[1] === ' ') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const m = rec.match(/^2 (\S+) (\S+) (\S+) (\S+) (\S+) \S+ \S+ \S+ ([\s\S]+)$/);
      const origPath = tokens[++i] ?? undefined;
      if (m) {
        const isSubmodule = m[2].startsWith('S') || m[3] === '160000' || m[4] === '160000' || m[5] === '160000';
        mergeItem({ path: m[6], origPath, status: classifyStatus(m[1]), ...(isSubmodule ? { isSubmodule: true } : {}) });
      }
    } else if (kind === 'u' && rec[1] === ' ') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const m = rec.match(/^u (\S+) (\S+) \S+ \S+ \S+ (\S+) \S+ \S+ \S+ ([\s\S]+)$/);
      if (m) {
        const isSubmodule = m[2].startsWith('S') || m[3] === '160000';
        mergeItem({ path: m[4], status: 'U', ...(isSubmodule ? { isSubmodule: true } : {}) });
      }
    }
  }

  if (!head) return { git: null, initial: false, items: [] };
  const items = [...byPath.values()];
  const initial = oid === '(initial)';
  const git: GitInfo = head === '(detached)'
    ? { branch: oid && !initial ? oid.slice(0, 7) : 'HEAD', detached: true, dirty: items.length }
    : { branch: head, detached: false, dirty: items.length };
  return { git, initial, items };
}

export function parseNumstatZ(buf: Buffer): Map<string, { added: number | null; deleted: number | null }> {
  const out = new Map<string, { added: number | null; deleted: number | null }>();
  const tokens = buf.toString('utf8').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    const firstTab = rec.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : rec.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const aRaw = rec.slice(0, firstTab);
    const dRaw = rec.slice(firstTab + 1, secondTab);
    let filePath = rec.slice(secondTab + 1);
    if (filePath === '') {
      // Rename in -z mode: next two NUL tokens are origPath and newPath
      const _orig = tokens[++i];
      filePath = tokens[++i] ?? '';
    }
    if (!filePath) continue;
    const added = aRaw === '-' ? null : Number(aRaw);
    const deleted = dRaw === '-' ? null : Number(dRaw);
    const prev = out.get(filePath);
    if (!prev) {
      out.set(filePath, {
        added: Number.isFinite(added) ? added : null,
        deleted: Number.isFinite(deleted) ? deleted : null,
      });
    } else {
      out.set(filePath, {
        added: prev.added === null || added === null || !Number.isFinite(added) ? null : prev.added + added,
        deleted: prev.deleted === null || deleted === null || !Number.isFinite(deleted) ? null : prev.deleted + deleted,
      });
    }
  }
  return out;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function countLinesAsync(absPath: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(absPath);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    if (st.size === 0) return 0;
    const buf = await fs.promises.readFile(absPath);
    if (isBinaryBuffer(buf)) return null;
    let lines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
    if (buf[buf.length - 1] !== 10) lines++;
    return lines;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

interface PorcelainSnapshot {
  git: GitInfo | null;
  initial: boolean;
  items: ParsedPorcelainItem[];
  fileStatus: Map<string, ChangeStatus>;
  dirStatus: Map<string, ChangeStatus>;
  timedOut: boolean;
  errorCode: number | string | null;
}

const inFlightPorcelain = new Map<string, Promise<PorcelainSnapshot>>();
const recentPorcelain = new Map<string, { at: number; data: PorcelainSnapshot }>();
const inFlightChanges = new Map<string, Promise<ProjectChanges>>();

export function invalidateProjectGitCache(projectDir: string): void {
  try {
    const realRoot = fs.realpathSync.native(projectDir);
    recentPorcelain.delete(realRoot);
  } catch {
    // ignore missing dir
  }
}

function buildPorcelainSnapshot(st: GitBufResult): PorcelainSnapshot {
  if (!st.ok) {
    return {
      git: null,
      initial: false,
      items: [],
      fileStatus: new Map(),
      dirStatus: new Map(),
      timedOut: st.timedOut,
      errorCode: st.code,
    };
  }
  const parsed = parsePorcelainZ(st.stdout);
  const fileStatus = new Map<string, ChangeStatus>();
  const dirStatus = new Map<string, ChangeStatus>();
  if (parsed.git) {
    for (const item of parsed.items) {
      fileStatus.set(item.path, item.status);
      if (item.isDirHint || item.isSubmodule) {
        const curSelf = dirStatus.get(item.path);
        if (!curSelf || STATUS_PRIORITY[item.status] > STATUS_PRIORITY[curSelf]) {
          dirStatus.set(item.path, item.status);
        }
      }
      let pos = item.path.indexOf('/');
      while (pos !== -1) {
        const dirPath = item.path.slice(0, pos);
        const cur = dirStatus.get(dirPath);
        if (!cur || STATUS_PRIORITY[item.status] > STATUS_PRIORITY[cur]) {
          dirStatus.set(dirPath, item.status);
        }
        pos = item.path.indexOf('/', pos + 1);
      }
    }
  }
  return {
    git: parsed.git,
    initial: parsed.initial,
    items: parsed.items,
    fileStatus,
    dirStatus,
    timedOut: false,
    errorCode: 0,
  };
}

async function getPorcelainSnapshot(realRoot: string, opts: { bypassCache?: boolean } = {}): Promise<PorcelainSnapshot> {
  if (!opts.bypassCache) {
    const cached = recentPorcelain.get(realRoot);
    if (cached && Date.now() - cached.at < PORCELAIN_CACHE_TTL_MS) {
      return cached.data;
    }
  }
  const existing = inFlightPorcelain.get(realRoot);
  if (existing) return existing;

  const p = (async () => {
    const st = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
    const snap = buildPorcelainSnapshot(st);
    if (!snap.timedOut && snap.errorCode !== 'ENOENT') {
      recentPorcelain.set(realRoot, { at: Date.now(), data: snap });
    }
    return snap;
  })().finally(() => {
    inFlightPorcelain.delete(realRoot);
  });

  inFlightPorcelain.set(realRoot, p);
  return p;
}

export async function readGitInfo(projectDir: string): Promise<{ git: GitInfo | null; enoent: boolean }> {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(projectDir);
  } catch {
    return { git: null, enoent: false };
  }
  const snap = await getPorcelainSnapshot(realRoot);
  return {
    git: snap.timedOut ? null : snap.git,
    enoent: snap.errorCode === 'ENOENT',
  };
}

async function computeChanges(realRoot: string): Promise<ProjectChanges> {
  const snap = await getPorcelainSnapshot(realRoot);
  if (snap.timedOut) {
    throw new WorkspaceError(504, 'Git 状态扫描超时，项目内未忽略文件过多');
  }
  if (!snap.git) return { git: null, files: [] };

  const sortedItems = [...snap.items].sort((a, b) => PATH_COLLATOR.compare(a.path, b.path));
  const truncated = sortedItems.length > MAX_CHANGED_FILES;
  const targetItems = truncated ? sortedItems.slice(0, MAX_CHANGED_FILES) : sortedItems;

  const stats = new Map<string, { added: number | null; deleted: number | null }>();
  if (targetItems.length > 0) {
    if (!snap.initial) {
      const ns = await runGitBuf(realRoot, ['diff', 'HEAD', '--numstat', '-z']);
      if (ns.ok) for (const [k, v] of parseNumstatZ(ns.stdout)) stats.set(k, v);
    } else {
      const [cached, wt] = await Promise.all([
        runGitBuf(realRoot, ['diff', '--cached', '--numstat', '-z']),
        runGitBuf(realRoot, ['diff', '--numstat', '-z']),
      ]);
      for (const r of [cached, wt]) {
        if (!r.ok) continue;
        for (const [k, v] of parseNumstatZ(r.stdout)) {
          const prev = stats.get(k);
          if (!prev) stats.set(k, v);
          else stats.set(k, {
            added: prev.added === null || v.added === null ? null : prev.added + v.added,
            deleted: prev.deleted === null || v.deleted === null ? null : prev.deleted + v.deleted,
          });
        }
      }
    }
  }

  const statNeededIndices: number[] = [];
  for (let i = 0; i < targetItems.length; i++) {
    const it = targetItems[i];
    if (!stats.has(it.path) && (it.status === '?' || it.status === 'A') && !it.isDirHint && !it.isSubmodule) {
      statNeededIndices.push(i);
    }
  }
  const statsSkipped = statNeededIndices.length > MAX_UNTRACKED_LINE_STAT;

  const extraLines = new Map<number, number | null>();
  if (!statsSkipped && statNeededIndices.length > 0) {
    const counts = await mapWithConcurrency(
      statNeededIndices,
      LINE_STAT_CONCURRENCY,
      (idx) => countLinesAsync(path.join(realRoot, targetItems[idx].path)),
    );
    for (let i = 0; i < statNeededIndices.length; i++) {
      extraLines.set(statNeededIndices[i], counts[i]);
    }
  }

  const files: ChangedFile[] = targetItems.map((it, idx) => {
    const baseItem = it.origPath
      ? { path: it.path, origPath: it.origPath, status: it.status }
      : { path: it.path, status: it.status };
    const num = stats.get(it.path);
    if (num) return { ...baseItem, added: num.added, deleted: num.deleted };
    if (extraLines.has(idx)) {
      const lines = extraLines.get(idx) ?? null;
      return { ...baseItem, added: lines, deleted: lines === null ? null : 0 };
    }
    return { ...baseItem, added: null, deleted: null };
  });

  return {
    git: snap.git,
    files,
    ...(truncated ? { truncated: true } : {}),
    ...(statsSkipped ? { statsSkipped: true } : {}),
  };
}

export async function listChanges(projectDir: string): Promise<ProjectChanges> {
  const { realRoot } = resolveProjectPath(projectDir, '', { allowRoot: true });
  const existing = inFlightChanges.get(realRoot);
  if (existing) return existing;

  const p = computeChanges(realRoot).finally(() => {
    inFlightChanges.delete(realRoot);
  });
  inFlightChanges.set(realRoot, p);
  return p;
}

export async function readDiff(projectDir: string, rawRelPath: string): Promise<DiffPayload> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath, { preserveSpaces: true });
  const stRes = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', relPosix]);
  let status: ChangeStatus | null = null;
  let origPosix: string | undefined;
  let initial = false;
  let isSubmoduleOrDir = false;
  if (stRes.ok) {
    const parsed = parsePorcelainZ(stRes.stdout);
    initial = parsed.initial;
    const hit = parsed.items.find((x) => x.path === relPosix) ?? parsed.items[0];
    if (hit) {
      status = hit.status;
      origPosix = hit.origPath;
      isSubmoduleOrDir = !!(hit.isSubmodule || hit.isDirHint);
    }
  }

  let diskBuf: Buffer | null = null;
  let size = 0;
  let mtimeMs: number | null = null;
  try {
    const fst = await fs.promises.stat(absPath);
    if (fst.isDirectory()) {
      isSubmoduleOrDir = true;
    } else if (fst.isFile()) {
      size = fst.size;
      mtimeMs = fst.mtimeMs;
      if (!isSubmoduleOrDir && size <= MAX_TEXT_BYTES) {
        diskBuf = await fs.promises.readFile(absPath);
      }
    }
  } catch {
    // Missing in worktree (e.g. status === 'D')
  }

  if (isSubmoduleOrDir) {
    return { path: relPosix, status, base: '', head: '', binary: false, tooLarge: false, isDirectory: true, size: 0, mtimeMs: null };
  }

  if (size > MAX_TEXT_BYTES) {
    return { path: relPosix, status, base: '', head: '', binary: false, tooLarge: true, size, mtimeMs };
  }

  let baseBuf: Buffer = Buffer.alloc(0);
  if (!initial && status !== '?') {
    const baseRefPath = origPosix ?? relPosix;
    const show = await runGitBuf(realRoot, ['show', `HEAD:${baseRefPath}`]);
    if (show.ok) baseBuf = show.stdout;
  }

  if (baseBuf.length > MAX_TEXT_BYTES) {
    return { path: relPosix, status, base: '', head: '', binary: false, tooLarge: true, size: Math.max(size, baseBuf.length), mtimeMs };
  }

  const binary = isBinaryBuffer(baseBuf) || (diskBuf !== null && isBinaryBuffer(diskBuf));
  if (binary) {
    return { path: relPosix, status, base: '', head: '', binary: true, tooLarge: false, size, mtimeMs };
  }

  return {
    path: relPosix,
    status,
    base: baseBuf.toString('utf8').replace(/\r\n/g, '\n'),
    head: diskBuf ? diskBuf.toString('utf8').replace(/\r\n/g, '\n') : '',
    binary: false,
    tooLarge: false,
    size,
    mtimeMs,
  };
}

export function readFileEntry(projectDir: string, rawRelPath: string, statOnly = false): FilePayload {
  const { absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath, { preserveSpaces: true });
  let fst: fs.Stats;
  try {
    fst = fs.statSync(absPath);
  } catch {
    return { path: relPosix, kind: 'missing', size: 0, mtimeMs: null };
  }
  if (!fst.isFile()) {
    throw new WorkspaceError(400, '目标不是普通文件');
  }
  const ext = path.extname(absPath).toLowerCase();
  const imgMime = IMAGE_MIME[ext];
  // SVG is both XML text and image: in FilePayload we return text if editable, OR let's return image?
  // Returning 'image' for raster images (.png/.jpg/.gif/.webp/.bmp/.ico) and for .svg returning 'image' with content?
  // Even better: for .svg, users may want image preview AND source editing, or image preview! Wait: if .svg is 'image' with content populated when <= MAX_TEXT_BYTES, or keep raster + svg as 'image' and allow raw preview! Let's check spec: ".png, .jpg, .jpeg, .gif, .webp, .bmp, .svg 直接渲染缩放预览与文件大小信息". Let's also include content for .svg if !statOnly and <= MAX_TEXT_BYTES so even editing svg is possible if needed, while kind='image' renders preview!
  if (imgMime) {
    return {
      path: relPosix,
      kind: fst.size > MAX_IMAGE_BYTES ? 'too_large' : 'image',
      size: fst.size,
      mtimeMs: fst.mtimeMs,
      mime: imgMime,
    };
  }
  if (fst.size > MAX_TEXT_BYTES) {
    return { path: relPosix, kind: 'too_large', size: fst.size, mtimeMs: fst.mtimeMs };
  }
  if (statOnly) {
    return { path: relPosix, kind: 'text', size: fst.size, mtimeMs: fst.mtimeMs };
  }
  const buf = fs.readFileSync(absPath);
  if (isBinaryBuffer(buf)) {
    return { path: relPosix, kind: 'binary', size: fst.size, mtimeMs: fst.mtimeMs };
  }
  return {
    path: relPosix,
    kind: 'text',
    content: buf.toString('utf8'),
    size: fst.size,
    mtimeMs: fst.mtimeMs,
  };
}

export function resolveRawImage(projectDir: string, rawRelPath: string): { absPath: string; mime: string; size: number } {
  const { absPath } = resolveProjectPath(projectDir, rawRelPath, { preserveSpaces: true });
  const ext = path.extname(absPath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new WorkspaceError(415, '只支持预览图片文件');
  let fst: fs.Stats;
  try {
    fst = fs.statSync(absPath);
  } catch {
    throw new WorkspaceError(404, '图片文件不存在');
  }
  if (!fst.isFile()) throw new WorkspaceError(400, '目标不是文件');
  if (fst.size > MAX_IMAGE_BYTES) throw new WorkspaceError(413, '图片体积过大');
  return { absPath, mime, size: fst.size };
}

export function writeFileEntry(projectDir: string, body: Partial<WriteFileBody>): WriteFileResult {
  if (typeof body.path !== 'string') throw new WorkspaceError(400, '缺少文件路径');
  if (typeof body.content !== 'string') throw new WorkspaceError(400, '文件内容必须是字符串');
  if (Buffer.byteLength(body.content, 'utf8') > MAX_TEXT_BYTES) throw new WorkspaceError(413, '文件内容超过 2 MB 上限');

  const { absPath, relPosix } = resolveProjectPath(projectDir, body.path, { preserveSpaces: true });
  let existingStat: fs.Stats | null = null;
  let existingRaw: Buffer | null = null;
  try {
    existingStat = fs.statSync(absPath);
    if (existingStat.isDirectory()) throw new WorkspaceError(400, '不能覆盖同名目录');
    if (existingStat.isFile() && existingStat.size <= MAX_TEXT_BYTES) {
      existingRaw = fs.readFileSync(absPath);
    }
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    existingStat = null;
  }

  // Preserve CRLF line endings when editing an existing CRLF file from the browser editor (which normalizes to LF).
  let outText = body.content;
  if (existingRaw && !isBinaryBuffer(existingRaw) && !outText.includes('\r\n') && outText.includes('\n')) {
    const prevStr = existingRaw.toString('utf8');
    if (prevStr.includes('\r\n') && !/(?<!\r)\n/.test(prevStr)) {
      outText = outText.replace(/\n/g, '\r\n');
    }
  }
  const buf = Buffer.from(outText, 'utf8');

  if (!body.force && body.expectedMtimeMs !== undefined) {
    if (body.expectedMtimeMs === null && existingStat !== null) {
      const sameText = existingRaw && !isBinaryBuffer(existingRaw)
        && existingRaw.toString('utf8').replace(/\r\n/g, '\n') === body.content.replace(/\r\n/g, '\n');
      if (!sameText) {
        throw new WorkspaceError(409, '磁盘上已出现同名文件', 'conflict', { mtimeMs: existingStat.mtimeMs });
      }
    } else if (typeof body.expectedMtimeMs === 'number') {
      if (!existingStat) {
        throw new WorkspaceError(409, '磁盘上的文件已被外部删除', 'conflict', { mtimeMs: null });
      }
      // 2ms tolerance for filesystem float rounding
      if (Math.abs(existingStat.mtimeMs - body.expectedMtimeMs) > 2) {
        const sameText = existingRaw && !isBinaryBuffer(existingRaw)
          && existingRaw.toString('utf8').replace(/\r\n/g, '\n') === body.content.replace(/\r\n/g, '\n');
        if (!sameText) {
          throw new WorkspaceError(409, '磁盘上的文件已被外部修改', 'conflict', { mtimeMs: existingStat.mtimeMs });
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buf);
  const after = fs.statSync(absPath);
  invalidateProjectGitCache(projectDir);
  return { path: relPosix, size: after.size, mtimeMs: after.mtimeMs };
}

export async function discardFile(projectDir: string, rawRelPath: string): Promise<void> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath, { preserveSpaces: true });
  const stRes = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', relPosix]);
  if (!stRes.ok) throw new WorkspaceError(400, '当前项目不是有效的 Git 仓库');
  const parsed = parsePorcelainZ(stRes.stdout);
  if (!parsed.git) throw new WorkspaceError(400, '当前项目不是有效的 Git 仓库');
  const hit = parsed.items.find((x) => x.path === relPosix) ?? parsed.items[0];
  if (!hit) return; // already clean

  try {
    if (hit.status === '?') {
      let fst: fs.Stats | null = null;
      try { fst = fs.lstatSync(absPath); } catch { fst = null; }
      if (fst && fst.isDirectory() && !fst.isSymbolicLink()) {
        throw new WorkspaceError(400, '不支持整目录删除');
      }
      fs.rmSync(absPath, { force: true });
      return;
    }

    if (parsed.initial) {
      // Unborn HEAD: remove from index and remove working copy if it was staged-added
      await runGitBuf(realRoot, ['rm', '-f', '--', relPosix]);
      fs.rmSync(absPath, { force: true });
      return;
    }

    // Check if the path existed in HEAD
    const inHead = await runGitBuf(realRoot, ['cat-file', '-e', `HEAD:${relPosix}`]);
    if (!inHead.ok) {
      // Added to index (and maybe renamed from origPath)
      await runGitBuf(realRoot, ['rm', '-f', '--', relPosix]);
      fs.rmSync(absPath, { force: true });
      if (hit.origPath) {
        // Guard origPath containment too
        resolveProjectPath(projectDir, hit.origPath);
        await runGitBuf(realRoot, ['checkout', 'HEAD', '--', hit.origPath]);
      }
      return;
    }

    const co = await runGitBuf(realRoot, ['checkout', 'HEAD', '--', relPosix]);
    if (!co.ok) {
      throw new WorkspaceError(500, `放弃改动失败：${co.stderr.trim() || 'git checkout 失败'}`);
    }
  } finally {
    recentPorcelain.delete(realRoot);
  }
}

export async function listTree(projectDir: string, rawRelDir = ''): Promise<TreeListing> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelDir, { allowRoot: true, preserveSpaces: true });
  let fst: fs.Stats;
  try {
    fst = await fs.promises.stat(absPath);
  } catch {
    throw new WorkspaceError(404, `目录不存在：${relPosix || '.'}`);
  }
  if (!fst.isDirectory()) throw new WorkspaceError(400, '目标不是目录');

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(absPath, { withFileTypes: true });
  } catch {
    throw new WorkspaceError(400, `无法读取目录：${relPosix || '.'}`);
  }

  // Reuse project-level porcelain cache (O(1) lookup, 0 extra git spawns on expand)
  const snap = await getPorcelainSnapshot(realRoot);
  const prefix = relPosix ? relPosix + '/' : '';

  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.git') continue; // hide internal git object store
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const full = path.join(absPath, d.name);
        const real = await fs.promises.realpath(full);
        if (!isInsideRoot(realRoot, real)) continue; // hide external symlinks
        const lst = await fs.promises.stat(real);
        isDir = lst.isDirectory();
        isFile = lst.isFile();
      } catch {
        continue; // broken symlink
      }
    }
    if (!isDir && !isFile) continue;
    const entryPath = prefix + d.name;
    if (isDir) {
      const st = snap.dirStatus.get(entryPath);
      entries.push({
        name: d.name,
        path: entryPath,
        kind: 'dir',
        ...(HEAVY_DIRS.has(d.name) && { ignored: true }),
        ...(st && { gitStatus: st }),
      });
    } else {
      const st = snap.fileStatus.get(entryPath);
      entries.push({
        name: d.name,
        path: entryPath,
        kind: 'file',
        ...(st && { gitStatus: st }),
      });
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    // Put non-ignored dirs ahead of heavy ignored dirs (like node_modules) so source dirs sit at the top
    if (a.kind === 'dir' && !!a.ignored !== !!b.ignored) return a.ignored ? 1 : -1;
    return NAME_COLLATOR.compare(a.name, b.name);
  });

  return { path: relPosix, entries };
}

export async function listAllFiles(projectDir: string): Promise<FileListResult> {
  const { realRoot } = resolveProjectPath(projectDir, '', { allowRoot: true });
  const [ls, del] = await Promise.all([
    runGitBuf(realRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    runGitBuf(realRoot, ['ls-files', '--deleted', '-z']),
  ]);
  if (ls.ok) {
    const deletedSet = new Set(del.ok ? del.stdout.toString('utf8').split('\0').filter(Boolean) : []);
    const raw = ls.stdout.toString('utf8').split('\0').filter((p) => p && !deletedSet.has(p));
    // Also surface root .env* files that are commonly gitignored so Ctrl+P can find .env!
    const seen = new Set(raw);
    try {
      for (const d of await fs.promises.readdir(realRoot, { withFileTypes: true })) {
        if (d.isFile() && d.name.startsWith('.env') && !seen.has(d.name)) {
          raw.push(d.name);
          seen.add(d.name);
        }
      }
    } catch { /* ignore */ }
    const truncated = raw.length > MAX_FILE_SEARCH;
    const existing = truncated ? raw.slice(0, MAX_FILE_SEARCH) : raw;
    existing.sort((a, b) => NAME_COLLATOR.compare(a, b));
    return { files: existing, truncated };
  }

  // Fallback walk for non-Git project folders
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, prefix: string) => {
    if (truncated) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name === '.git' || HEAVY_DIRS.has(d.name)) continue;
      if (d.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(full, rel);
      } else if (d.isFile()) {
        files.push(rel);
        if (files.length >= MAX_FILE_SEARCH) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(realRoot, '');
  files.sort((a, b) => NAME_COLLATOR.compare(a, b));
  return { files, truncated };
}

const MAX_EXTERNAL_PASTE = 50;
const MAX_PASTE_ENTRIES = 2000;
const MAX_PASTE_BYTES = 200 * 1024 * 1024;
const WIN_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const INVALID_NAME_CHAR = /[\x00-\x1f<>:"/\\|?*]/;

function validateEntryName(raw: unknown): string {
  if (typeof raw !== 'string') throw new WorkspaceError(400, '缺少名称');
  const name = raw.trim();
  if (!name) throw new WorkspaceError(400, '名称不能为空');
  if (name === '.' || name === '..') throw new WorkspaceError(400, '名称无效');
  if (name.toLowerCase() === '.git') throw new WorkspaceError(403, '不允许操作 .git 目录');
  if (INVALID_NAME_CHAR.test(name)) throw new WorkspaceError(400, '名称包含非法字符');
  if (/[. ]$/.test(name)) throw new WorkspaceError(400, '名称不能以点或空格结尾');
  if (WIN_RESERVED_NAME.test(name)) throw new WorkspaceError(400, '名称不能使用系统保留名');
  return name;
}

// Preserves leading spaces on already-existing filenames (e.g. " notes.txt") while still rejecting illegal names.
function validateExistingBasename(name: string): string {
  if (!name || !name.trim()) throw new WorkspaceError(400, '名称无效');
  if (name === '.' || name === '..') throw new WorkspaceError(400, '名称无效');
  if (name.toLowerCase() === '.git') throw new WorkspaceError(403, '不允许操作 .git 目录');
  if (INVALID_NAME_CHAR.test(name)) throw new WorkspaceError(400, '名称包含非法字符');
  if (/[. ]$/.test(name)) throw new WorkspaceError(400, '名称不能以点或空格结尾');
  if (WIN_RESERVED_NAME.test(name)) throw new WorkspaceError(400, '名称不能使用系统保留名');
  return name;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isCaseOnlySameEntry(srcAbs: string, destAbs: string): boolean {
  if (process.platform !== 'win32') return false;
  if (srcAbs.toLowerCase() !== destAbs.toLowerCase()) return false;
  try {
    const sa = fs.lstatSync(srcAbs, { bigint: true });
    const sb = fs.lstatSync(destAbs, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
  } catch {
    return false;
  }
}

// Resolves an existing leaf entry while preserving exact whitespace in filenames and validating parent containment
// separately from the leaf (so a symlink leaf can still be safely unlinked without following its target).
function resolveExistingLeaf(
  projectDir: string,
  rawRelPath: string,
  opts: { allowExternalSymlinkLeaf?: boolean } = {},
): ResolvedProjectPath & { stat: fs.Stats } {
  if (typeof rawRelPath !== 'string' || rawRelPath.includes('\0')) {
    throw new WorkspaceError(400, '文件路径无效');
  }
  if (/^(?:\\\\|\/\/)/.test(rawRelPath) || /^[A-Za-z]:/.test(rawRelPath)) {
    throw new WorkspaceError(400, '只允许项目内的相对路径');
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(projectDir);
  } catch {
    throw new WorkspaceError(404, `项目目录不存在：${projectDir}`);
  }
  const cleaned = rawRelPath.replace(/^[/\\]+/, '');
  if (!cleaned) throw new WorkspaceError(400, '缺少文件路径');
  const absPath = path.resolve(realRoot, cleaned);
  const rel = path.relative(realRoot, absPath);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new WorkspaceError(400, '文件路径超出项目目录范围');
  }
  if (hasGitSegment(rel)) {
    throw new WorkspaceError(403, '不允许直接访问或修改 .git 内部文件');
  }
  const parentAbs = path.dirname(absPath);
  let realParent: string;
  try {
    realParent = fs.realpathSync.native(parentAbs);
  } catch {
    throw new WorkspaceError(404, `文件或目录不存在：${toPosix(rel)}`);
  }
  if (!isInsideRoot(realRoot, realParent)) {
    throw new WorkspaceError(403, '拒绝访问指向项目目录之外的符号链接');
  }
  const parentRel = path.relative(realRoot, realParent);
  if (parentRel && hasGitSegment(parentRel)) {
    throw new WorkspaceError(403, '不允许通过符号链接访问 .git 内部文件');
  }
  const stat = lstatOrNull(absPath);
  if (!stat) throw new WorkspaceError(404, `文件或目录不存在：${toPosix(rel)}`);
  if (stat.isSymbolicLink() && !opts.allowExternalSymlinkLeaf) {
    let realLeaf: string;
    try {
      realLeaf = fs.realpathSync.native(absPath);
    } catch {
      throw new WorkspaceError(403, '拒绝操作损坏或指向外部的符号链接');
    }
    if (!isInsideRoot(realRoot, realLeaf)) {
      throw new WorkspaceError(403, '拒绝操作指向项目目录之外的符号链接');
    }
    const leafRel = path.relative(realRoot, realLeaf);
    if (leafRel && hasGitSegment(leafRel)) {
      throw new WorkspaceError(403, '不允许通过符号链接访问 .git 内部文件');
    }
  }
  return { realRoot, absPath, relPosix: toPosix(rel), stat };
}

function splitCopyStem(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: '' };
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, idx), ext: name.slice(idx) };
}

function uniqueCopyName(targetAbsDir: string, baseName: string, isDir: boolean): string {
  if (!lstatOrNull(path.join(targetAbsDir, baseName))) return baseName;
  const { stem, ext } = splitCopyStem(baseName, isDir);
  const first = `${stem} copy${ext}`;
  if (!lstatOrNull(path.join(targetAbsDir, first))) return first;
  for (let i = 2; i <= 999; i++) {
    const cand = `${stem} copy ${i}${ext}`;
    if (!lstatOrNull(path.join(targetAbsDir, cand))) return cand;
  }
  throw new WorkspaceError(409, `目标目录同名副本过多：${baseName}`);
}

export function createFsEntry(projectDir: string, body: Partial<FsCreateBody>): FsCreateResult {
  const kind = body.kind;
  if (kind !== 'file' && kind !== 'dir') throw new WorkspaceError(400, '创建类型必须是 file 或 dir');
  const name = validateEntryName(body.name);
  const parent = resolveProjectPath(
    projectDir,
    typeof body.parentDir === 'string' ? body.parentDir : '',
    { allowRoot: true, preserveSpaces: true },
  );
  const parentStat = lstatOrNull(parent.absPath);
  if (!parentStat || !parentStat.isDirectory()) throw new WorkspaceError(400, '目标父目录不存在');

  const rel = parent.relPosix ? `${parent.relPosix}/${name}` : name;
  const target = resolveProjectPath(projectDir, rel, { preserveSpaces: true });
  if (lstatOrNull(target.absPath)) throw new WorkspaceError(409, `已存在同名项：${name}`);

  try {
    if (kind === 'dir') fs.mkdirSync(target.absPath);
    else fs.writeFileSync(target.absPath, '', { flag: 'wx' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new WorkspaceError(409, `已存在同名项：${name}`);
    throw new WorkspaceError(500, `创建失败：${(e as Error).message}`);
  }
  invalidateProjectGitCache(projectDir);
  return { path: target.relPosix, kind };
}

function moveFileNoOverwriteSync(srcAbs: string, destAbs: string): void {
  try {
    // Hard link atomically fails with EEXIST if destAbs already exists (no TOCTOU overwrite).
    fs.linkSync(srcAbs, destAbs);
    try {
      fs.unlinkSync(srcAbs);
    } catch (unlinkErr) {
      try { fs.unlinkSync(destAbs); } catch { /* best-effort rollback */ }
      throw unlinkErr;
    }
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new WorkspaceError(409, `目标位置已存在同名项：${path.basename(destAbs)}`);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL' && code !== 'EXDEV') throw e;
  }
  // Fallback when filesystem does not support hard links: atomic O_EXCL copy + unlink.
  try {
    fs.copyFileSync(srcAbs, destAbs, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `目标位置已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  try {
    fs.unlinkSync(srcAbs);
  } catch (unlinkErr) {
    try { fs.unlinkSync(destAbs); } catch { /* best-effort rollback */ }
    throw unlinkErr;
  }
}

function moveSymlinkNoOverwriteSync(srcAbs: string, destAbs: string): void {
  const linkTarget = fs.readlinkSync(srcAbs);
  try {
    fs.symlinkSync(linkTarget, destAbs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  try {
    fs.unlinkSync(srcAbs);
  } catch (unlinkErr) {
    try { fs.unlinkSync(destAbs); } catch { /* best-effort rollback */ }
    throw unlinkErr;
  }
}

function moveDirNoOverwriteSync(srcAbs: string, destAbs: string): void {
  const srcStat = fs.lstatSync(srcAbs);
  const targetMode = srcStat.mode & 0o777;
  // Atomically claim destAbs with mkdir (0o700 during move so permissions are never widened before restore).
  try {
    fs.mkdirSync(destAbs, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  const moved: Array<{ name: string; kind: 'file' | 'symlink' | 'dir' }> = [];
  try {
    for (const d of fs.readdirSync(srcAbs, { withFileTypes: true })) {
      const fromChild = path.join(srcAbs, d.name);
      const toChild = path.join(destAbs, d.name);
      if (d.isSymbolicLink()) {
        moveSymlinkNoOverwriteSync(fromChild, toChild);
        moved.push({ name: d.name, kind: 'symlink' });
      } else if (d.isDirectory()) {
        moveDirNoOverwriteSync(fromChild, toChild);
        moved.push({ name: d.name, kind: 'dir' });
      } else {
        moveFileNoOverwriteSync(fromChild, toChild);
        moved.push({ name: d.name, kind: 'file' });
      }
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(destAbs, targetMode);
    }
    fs.rmdirSync(srcAbs);
  } catch (e) {
    const stuck: string[] = [];
    for (const item of moved.reverse()) {
      const fromBack = path.join(destAbs, item.name);
      const toBack = path.join(srcAbs, item.name);
      try {
        if (item.kind === 'symlink') moveSymlinkNoOverwriteSync(fromBack, toBack);
        else if (item.kind === 'dir') moveDirNoOverwriteSync(fromBack, toBack);
        else moveFileNoOverwriteSync(fromBack, toBack);
      } catch {
        stuck.push(item.name);
      }
    }
    try { fs.rmdirSync(destAbs); } catch { /* leave non-empty destAbs untouched */ }
    if (stuck.length > 0) {
      throw new WorkspaceError(500, `目录移动失败且以下条目留在目标目录未能自动回滚：${stuck.join(', ')}`);
    }
    throw e;
  }
}

export function renameFsEntry(projectDir: string, body: Partial<FsRenameBody>): FsRenameResult {
  if (typeof body.path !== 'string') throw new WorkspaceError(400, '缺少原路径');
  const newName = validateEntryName(body.newName);
  const src = resolveExistingLeaf(projectDir, body.path);
  const kind: 'file' | 'dir' = src.stat.isDirectory() && !src.stat.isSymbolicLink() ? 'dir' : 'file';

  const slash = src.relPosix.lastIndexOf('/');
  const parentRel = slash === -1 ? '' : src.relPosix.slice(0, slash);
  const destRel = parentRel ? `${parentRel}/${newName}` : newName;
  const dest = resolveProjectPath(projectDir, destRel, { preserveSpaces: true });

  if (src.absPath === dest.absPath) {
    return { oldPath: src.relPosix, newPath: dest.relPosix, kind };
  }
  const caseOnlySame = isCaseOnlySameEntry(src.absPath, dest.absPath);
  if (!caseOnlySame && lstatOrNull(dest.absPath)) {
    throw new WorkspaceError(409, `已存在同名项：${newName}`);
  }
  try {
    if (caseOnlySame) {
      fs.renameSync(src.absPath, dest.absPath);
    } else if (kind === 'dir') {
      moveDirNoOverwriteSync(src.absPath, dest.absPath);
    } else if (src.stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(src.absPath);
      fs.symlinkSync(linkTarget, dest.absPath);
      try {
        fs.unlinkSync(src.absPath);
      } catch (unlinkErr) {
        try { fs.unlinkSync(dest.absPath); } catch { /* rollback */ }
        throw unlinkErr;
      }
    } else {
      moveFileNoOverwriteSync(src.absPath, dest.absPath);
    }
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new WorkspaceError(409, `已存在同名项：${newName}`);
    throw new WorkspaceError(500, `重命名失败：${(e as Error).message}`);
  }
  invalidateProjectGitCache(projectDir);
  return { oldPath: src.relPosix, newPath: dest.relPosix, kind };
}

function assertDirDeletable(dirAbs: string): void {
  const stack = [dirAbs];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.name.toLowerCase() === '.git') {
        throw new WorkspaceError(403, '目录内包含 .git 仓库元数据，拒绝直接删除');
      }
      if (!d.isSymbolicLink() && d.isDirectory()) {
        stack.push(path.join(cur, d.name));
      }
    }
  }
}

export function deleteFsEntry(projectDir: string, body: Partial<FsDeleteBody>): FsDeleteResult {
  if (typeof body.path !== 'string') throw new WorkspaceError(400, '缺少文件路径');
  const target = resolveExistingLeaf(projectDir, body.path, { allowExternalSymlinkLeaf: true });
  const isRealDir = target.stat.isDirectory() && !target.stat.isSymbolicLink();
  const kind: 'file' | 'dir' = isRealDir ? 'dir' : 'file';

  if (isRealDir) assertDirDeletable(target.absPath);

  try {
    if (target.stat.isSymbolicLink()) fs.unlinkSync(target.absPath);
    else if (isRealDir) fs.rmSync(target.absPath, { recursive: true });
    else fs.rmSync(target.absPath);
  } catch (e) {
    throw new WorkspaceError(500, `删除失败：${(e as Error).message}`);
  }
  invalidateProjectGitCache(projectDir);
  return { path: target.relPosix, kind };
}

interface PasteBudget {
  entries: number;
  bytes: number;
}

async function resolveDeepestReal(absPath: string): Promise<string> {
  let probe = absPath;
  const tail: string[] = [];
  while (true) {
    try {
      const real = await fs.promises.realpath(probe);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return absPath;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function inspectPasteTree(
  srcAbs: string,
  destAbs: string,
  targetRealRoot: string,
  budget: PasteBudget,
  opts: { rejectAllSymlinks: boolean; allowSrcRoot?: string },
): Promise<void> {
  const st = await fs.promises.lstat(srcAbs);
  budget.entries += 1;
  if (budget.entries > MAX_PASTE_ENTRIES) {
    throw new WorkspaceError(400, `单次粘贴文件总数超过上限（${MAX_PASTE_ENTRIES} 个）`);
  }
  if (st.isSymbolicLink()) {
    if (opts.rejectAllSymlinks) {
      throw new WorkspaceError(403, '拒绝从外部剪贴板粘贴符号链接');
    }
    const linkTarget = await fs.promises.readlink(srcAbs);
    const literalAtDest = path.resolve(path.dirname(destAbs), linkTarget);
    const realAtDest = await resolveDeepestReal(literalAtDest);
    if (!isInsideRoot(targetRealRoot, literalAtDest) || !isInsideRoot(targetRealRoot, realAtDest)) {
      throw new WorkspaceError(403, '符号链接在目标目录中会指向项目外部，拒绝粘贴');
    }
    for (const candidate of [literalAtDest, realAtDest]) {
      const destRel = path.relative(targetRealRoot, candidate);
      if (destRel && hasGitSegment(destRel)) {
        throw new WorkspaceError(403, '符号链接指向 .git 元数据，拒绝粘贴');
      }
    }
    if (opts.allowSrcRoot) {
      let realTarget: string;
      try {
        realTarget = await fs.promises.realpath(srcAbs);
      } catch {
        throw new WorkspaceError(403, '包含损坏的符号链接，拒绝粘贴');
      }
      if (!isInsideRoot(opts.allowSrcRoot, realTarget) || !isInsideRoot(targetRealRoot, realTarget)) {
        throw new WorkspaceError(403, '符号链接指向目标项目外部，拒绝粘贴');
      }
      const realRel = path.relative(targetRealRoot, realTarget);
      if (realRel && hasGitSegment(realRel)) {
        throw new WorkspaceError(403, '符号链接指向 .git 元数据，拒绝粘贴');
      }
    }
    return;
  }
  if (st.isFile()) {
    budget.bytes += st.size;
    if (budget.bytes > MAX_PASTE_BYTES) {
      throw new WorkspaceError(400, `单次粘贴总大小超过上限（${Math.round(MAX_PASTE_BYTES / (1024 * 1024))} MB）`);
    }
    return;
  }
  if (!st.isDirectory()) return;

  const dirents = await fs.promises.readdir(srcAbs, { withFileTypes: true });
  for (const d of dirents) {
    if (d.name.toLowerCase() === '.git') {
      throw new WorkspaceError(403, '目录内包含 .git 元数据，拒绝复制或移动');
    }
    await inspectPasteTree(
      path.join(srcAbs, d.name),
      path.join(destAbs, d.name),
      targetRealRoot,
      budget,
      opts,
    );
  }
}

interface CreatedManifest {
  files: string[];
  dirs: string[];
}

// Safely rolls back ONLY files/symlinks created by this operation (unlink) and directories only if still empty (rmdir),
// guaranteeing we never delete concurrent entries written by other processes.
async function rollbackCreatedManifest(manifest: CreatedManifest): Promise<void> {
  for (let i = manifest.files.length - 1; i >= 0; i--) {
    try { await fs.promises.unlink(manifest.files[i]); } catch { /* best-effort */ }
  }
  for (let i = manifest.dirs.length - 1; i >= 0; i--) {
    try { await fs.promises.rmdir(manifest.dirs[i]); } catch { /* non-empty or already gone -> leave intact */ }
  }
}

// Copies a file, symlink, or directory into a brand-new destAbs that MUST NOT already exist.
// Exclusively claims every target (COPYFILE_EXCL / symlink / mkdir 0o700), restores directory mode on POSIX,
// and records created paths in `manifest` so rollback only ever removes entries created by this call.
async function copyIntoNewTarget(srcAbs: string, destAbs: string, manifest: CreatedManifest): Promise<'file' | 'dir'> {
  const st = await fs.promises.lstat(srcAbs);
  if (st.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(srcAbs);
    try {
      await fs.promises.symlink(linkTarget, destAbs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkspaceError(409, `目标位置已存在同名项：${path.basename(destAbs)}`);
      }
      throw e;
    }
    manifest.files.push(destAbs);
    return 'file';
  }
  if (!st.isDirectory()) {
    try {
      await fs.promises.copyFile(srcAbs, destAbs, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkspaceError(409, `目标位置已存在同名项：${path.basename(destAbs)}`);
      }
      throw e;
    }
    manifest.files.push(destAbs);
    return 'file';
  }

  const targetMode = st.mode & 0o777;
  try {
    await fs.promises.mkdir(destAbs, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `目标位置已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  manifest.dirs.push(destAbs);

  const dirents = await fs.promises.readdir(srcAbs, { withFileTypes: true });
  for (const d of dirents) {
    await copyIntoNewTarget(path.join(srcAbs, d.name), path.join(destAbs, d.name), manifest);
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(destAbs, targetMode);
  }
  return 'dir';
}

async function moveSymlinkNoOverwriteAsync(srcAbs: string, destAbs: string): Promise<void> {
  const linkTarget = await fs.promises.readlink(srcAbs);
  try {
    await fs.promises.symlink(linkTarget, destAbs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `目标目录已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  try {
    await fs.promises.unlink(srcAbs);
  } catch (unlinkErr) {
    try { await fs.promises.unlink(destAbs); } catch { /* rollback */ }
    throw unlinkErr;
  }
}

async function moveFileNoOverwriteAsync(srcAbs: string, destAbs: string): Promise<void> {
  try {
    await fs.promises.link(srcAbs, destAbs);
    try {
      await fs.promises.unlink(srcAbs);
    } catch (unlinkErr) {
      try { await fs.promises.unlink(destAbs); } catch { /* rollback */ }
      throw unlinkErr;
    }
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new WorkspaceError(409, `目标目录已存在同名项：${path.basename(destAbs)}`);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL' && code !== 'EXDEV') throw e;
  }
  // Atomic O_EXCL copy + unlink fallback (handles EXDEV and filesystems without hard links without overwriting destAbs).
  try {
    await fs.promises.copyFile(srcAbs, destAbs, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `目标目录已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }
  try {
    await fs.promises.unlink(srcAbs);
  } catch (unlinkErr) {
    try { await fs.promises.unlink(destAbs); } catch { /* rollback */ }
    throw unlinkErr;
  }
}

async function moveDirNoOverwriteAsync(
  srcAbs: string,
  destAbs: string,
  targetRealRoot: string,
  srcRealRoot: string,
): Promise<void> {
  const srcStat = await fs.promises.lstat(srcAbs);
  const targetMode = srcStat.mode & 0o777;
  // Atomically claim destAbs with mkdir (0o700 during move to avoid ever widening permissions).
  try {
    await fs.promises.mkdir(destAbs, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError(409, `目标目录已存在同名项：${path.basename(destAbs)}`);
    }
    throw e;
  }

  const moved: Array<{ name: string; kind: 'file' | 'symlink' | 'dir' }> = [];
  let exdev = false;
  try {
    const entries = await fs.promises.readdir(srcAbs, { withFileTypes: true });
    for (const d of entries) {
      const fromChild = path.join(srcAbs, d.name);
      const toChild = path.join(destAbs, d.name);
      if (d.isSymbolicLink()) {
        await moveSymlinkNoOverwriteAsync(fromChild, toChild);
        moved.push({ name: d.name, kind: 'symlink' });
      } else if (d.isDirectory()) {
        await moveDirNoOverwriteAsync(fromChild, toChild, targetRealRoot, srcRealRoot);
        moved.push({ name: d.name, kind: 'dir' });
      } else {
        await moveFileNoOverwriteAsync(fromChild, toChild);
        moved.push({ name: d.name, kind: 'file' });
      }
    }
    if (process.platform !== 'win32') {
      await fs.promises.chmod(destAbs, targetMode);
    }
    await fs.promises.rmdir(srcAbs);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const stuck: string[] = [];
    for (const item of moved.reverse()) {
      const fromBack = path.join(destAbs, item.name);
      const toBack = path.join(srcAbs, item.name);
      try {
        if (item.kind === 'symlink') await moveSymlinkNoOverwriteAsync(fromBack, toBack);
        else if (item.kind === 'dir') await moveDirNoOverwriteAsync(fromBack, toBack, srcRealRoot, targetRealRoot);
        else await moveFileNoOverwriteAsync(fromBack, toBack);
      } catch {
        stuck.push(item.name);
      }
    }
    try { await fs.promises.rmdir(destAbs); } catch { /* leave non-empty destAbs intact */ }
    if (stuck.length > 0) {
      throw new WorkspaceError(500, `目录移动失败且以下条目留在目标目录未能自动回滚：${stuck.join(', ')}`);
    }
    if (code === 'EXDEV') exdev = true;
    else throw e;
  }

  if (exdev) {
    const budget: PasteBudget = { entries: 0, bytes: 0 };
    await inspectPasteTree(srcAbs, destAbs, targetRealRoot, budget, { rejectAllSymlinks: false, allowSrcRoot: srcRealRoot });
    const manifest: CreatedManifest = { files: [], dirs: [] };
    try {
      await copyIntoNewTarget(srcAbs, destAbs, manifest);
    } catch (cpErr) {
      await rollbackCreatedManifest(manifest);
      throw cpErr;
    }
    // Copy succeeded completely; if cleaning up the source fails, keep the complete destination intact to prevent data loss.
    try {
      await fs.promises.rm(srcAbs, { recursive: true });
    } catch (rmErr) {
      throw new WorkspaceError(500, `已完整复制到目标目录，但清理原目录失败（未删除目标副本）：${(rmErr as Error).message}`);
    }
  }
}

async function moveEntryNoOverwrite(
  srcAbs: string,
  destAbs: string,
  isDir: boolean,
  isSymlink: boolean,
  targetRealRoot: string,
  srcRealRoot: string,
): Promise<void> {
  if (isSymlink) return moveSymlinkNoOverwriteAsync(srcAbs, destAbs);
  if (!isDir) return moveFileNoOverwriteAsync(srcAbs, destAbs);
  return moveDirNoOverwriteAsync(srcAbs, destAbs, targetRealRoot, srcRealRoot);
}

export async function pasteFsEntries(
  targetProjectDir: string,
  body: Partial<FsPasteBody>,
  resolveSourceProjectDir?: (sourceProjectId: string) => string | null,
): Promise<FsPasteResult> {
  const mode = body.mode;
  if (mode !== 'copy' && mode !== 'cut') throw new WorkspaceError(400, '粘贴模式无效');

  const targetDir = resolveProjectPath(
    targetProjectDir,
    typeof body.targetDir === 'string' ? body.targetDir : '',
    { allowRoot: true, preserveSpaces: true },
  );
  const targetDirStat = lstatOrNull(targetDir.absPath);
  if (!targetDirStat || !targetDirStat.isDirectory()) throw new WorkspaceError(400, '目标目录不存在');
  const realTargetDir = fs.realpathSync.native(targetDir.absPath);

  if (Array.isArray(body.externalPaths) && body.externalPaths.length > 0) {
    if (mode !== 'copy') throw new WorkspaceError(400, '外部剪贴板文件只支持复制粘贴');
    if (body.externalPaths.length > MAX_EXTERNAL_PASTE) {
      throw new WorkspaceError(400, `单次最多粘贴 ${MAX_EXTERNAL_PASTE} 个文件`);
    }
    const budget: PasteBudget = { entries: 0, bytes: 0 };
    const plan: Array<{ srcAbs: string; destAbs: string; destRel: string; isDir: boolean }> = [];
    const reservedNames = new Set<string>();

    for (const raw of body.externalPaths) {
      if (typeof raw !== 'string') continue;
      if (!raw || raw.includes('\0')) continue;
      if (/^(?:\\\\|\/\/)/.test(raw) || !path.isAbsolute(raw)) {
        throw new WorkspaceError(400, `不支持的路径：${raw}`);
      }
      const norm = path.normalize(raw);
      if (path.dirname(norm) === norm) throw new WorkspaceError(400, `不支持粘贴磁盘根目录：${norm}`);
      if (hasGitSegment(norm)) throw new WorkspaceError(403, '拒绝从 .git 目录粘贴文件');
      const st = lstatOrNull(norm);
      if (!st) throw new WorkspaceError(404, `剪贴板文件不存在：${norm}`);
      if (st.isSymbolicLink()) throw new WorkspaceError(403, '拒绝从外部剪贴板粘贴符号链接');
      const realSrc = fs.realpathSync.native(norm);
      if (hasGitSegment(realSrc)) throw new WorkspaceError(403, '拒绝从 .git 目录粘贴文件');
      const isDir = st.isDirectory();
      const baseName = validateExistingBasename(path.basename(norm));
      if (isDir && isInsideRoot(realSrc, realTargetDir)) {
        throw new WorkspaceError(400, '不能将文件夹粘贴到自身或子目录内');
      }
      let finalName = uniqueCopyName(targetDir.absPath, baseName, isDir);
      while (reservedNames.has(process.platform === 'win32' ? finalName.toLowerCase() : finalName)) {
        const { stem, ext } = splitCopyStem(finalName, isDir);
        finalName = `${stem} copy${ext}`;
      }
      reservedNames.add(process.platform === 'win32' ? finalName.toLowerCase() : finalName);
      const destRel = targetDir.relPosix ? `${targetDir.relPosix}/${finalName}` : finalName;
      const dest = resolveProjectPath(targetProjectDir, destRel, { preserveSpaces: true });
      await inspectPasteTree(realSrc, dest.absPath, targetDir.realRoot, budget, { rejectAllSymlinks: true });
      plan.push({ srcAbs: realSrc, destAbs: dest.absPath, destRel: dest.relPosix, isDir });
    }
    if (plan.length === 0) throw new WorkspaceError(400, '剪贴板中没有可粘贴的文件');

    const manifest: CreatedManifest = { files: [], dirs: [] };
    try {
      for (const item of plan) {
        // Records only entries actually created by this call; rollback unlinks files and rmdirs only empty dirs.
        await copyIntoNewTarget(item.srcAbs, item.destAbs, manifest);
      }
    } catch (e) {
      await rollbackCreatedManifest(manifest);
      if (e instanceof WorkspaceError) throw e;
      throw new WorkspaceError(500, `粘贴失败：${(e as Error).message}`);
    }
    invalidateProjectGitCache(targetProjectDir);
    return { paths: plan.map((p) => p.destRel), targetDir: targetDir.relPosix };
  }

  if (typeof body.sourcePath !== 'string' || !body.sourcePath) {
    throw new WorkspaceError(400, '缺少要粘贴的源路径');
  }
  const srcProjectDir = body.sourceProjectId
    ? (resolveSourceProjectDir?.(body.sourceProjectId) ?? null)
    : targetProjectDir;
  if (!srcProjectDir) throw new WorkspaceError(404, '源项目不存在');

  const src = resolveExistingLeaf(srcProjectDir, body.sourcePath);
  const isSymlink = src.stat.isSymbolicLink();
  const isDir = src.stat.isDirectory() && !isSymlink;
  const realSrc = isSymlink ? src.absPath : fs.realpathSync.native(src.absPath);

  if (isDir && isInsideRoot(realSrc, realTargetDir)) {
    throw new WorkspaceError(400, '不能将文件夹复制或移动到自身或子目录内');
  }

  const baseName = validateExistingBasename(path.basename(src.absPath));
  if (mode === 'cut') {
    const srcParentReal = fs.realpathSync.native(path.dirname(src.absPath));
    const sameParent = process.platform === 'win32'
      ? srcParentReal.toLowerCase() === realTargetDir.toLowerCase()
      : srcParentReal === realTargetDir;
    if (sameParent) {
      return { paths: [src.relPosix], targetDir: targetDir.relPosix, skipped: true };
    }
    const destRel = targetDir.relPosix ? `${targetDir.relPosix}/${baseName}` : baseName;
    const dest = resolveProjectPath(targetProjectDir, destRel, { preserveSpaces: true });
    const budget: PasteBudget = { entries: 0, bytes: 0 };
    await inspectPasteTree(src.absPath, dest.absPath, targetDir.realRoot, budget, {
      rejectAllSymlinks: false,
      allowSrcRoot: src.realRoot,
    });
    try {
      await moveEntryNoOverwrite(src.absPath, dest.absPath, isDir, isSymlink, targetDir.realRoot, src.realRoot);
    } catch (e) {
      if (e instanceof WorkspaceError) throw e;
      throw new WorkspaceError(500, `移动失败：${(e as Error).message}`);
    }
    invalidateProjectGitCache(targetProjectDir);
    if (srcProjectDir !== targetProjectDir) invalidateProjectGitCache(srcProjectDir);
    return { paths: [dest.relPosix], targetDir: targetDir.relPosix };
  }

  const finalName = uniqueCopyName(targetDir.absPath, baseName, isDir);
  const destRel = targetDir.relPosix ? `${targetDir.relPosix}/${finalName}` : finalName;
  const dest = resolveProjectPath(targetProjectDir, destRel, { preserveSpaces: true });
  const budget: PasteBudget = { entries: 0, bytes: 0 };
  await inspectPasteTree(src.absPath, dest.absPath, targetDir.realRoot, budget, {
    rejectAllSymlinks: false,
    allowSrcRoot: src.realRoot,
  });
  const manifest: CreatedManifest = { files: [], dirs: [] };
  try {
    await copyIntoNewTarget(src.absPath, dest.absPath, manifest);
  } catch (e) {
    await rollbackCreatedManifest(manifest);
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError(500, `复制失败：${(e as Error).message}`);
  }
  invalidateProjectGitCache(targetProjectDir);
  return { paths: [dest.relPosix], targetDir: targetDir.relPosix };
}
