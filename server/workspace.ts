import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  ChangedFile, ChangeStatus, DiffPayload, FileListResult, FilePayload, GitInfo, ProjectChanges, TreeEntry, TreeListing, WriteFileBody, WriteFileResult,
} from '../shared/protocol.ts';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB guard for editor & diff
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB guard for inline image preview
export const MAX_FILE_SEARCH = 20_000;

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

// Resolves a relative path inside projectDir, rejecting '..', drive switches, UNC paths, external symlinks, and '.git' internals.
export function resolveProjectPath(
  projectDir: string,
  rawRelPath: string,
  opts: { allowRoot?: boolean; allowGitRead?: boolean } = {},
): ResolvedProjectPath {
  if (typeof rawRelPath !== 'string' || rawRelPath.includes('\0')) {
    throw new WorkspaceError(400, '文件路径无效');
  }
  const trimmed = rawRelPath.trim();
  if (/^(?:\\\\|\/\/)/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new WorkspaceError(400, '只允许项目内的相对路径');
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(projectDir);
  } catch {
    throw new WorkspaceError(404, `项目目录不存在：${projectDir}`);
  }
  const cleaned = trimmed.replace(/^[/\\]+/, '');
  if (!cleaned) {
    if (opts.allowRoot) return { realRoot, absPath: realRoot, relPosix: '' };
    throw new WorkspaceError(400, '缺少文件路径');
  }
  const absPath = path.resolve(realRoot, cleaned);
  const rel = path.relative(realRoot, absPath);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new WorkspaceError(400, '文件路径超出项目目录范围');
  }
  const parts = rel.split(path.sep);
  if (!opts.allowGitRead && parts[0]?.toLowerCase() === '.git') {
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
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return { realRoot, absPath, relPosix: toPosix(rel) };
}

function runGitBuf(cwd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, encoding: 'buffer', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
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

interface ParsedPorcelain {
  git: GitInfo | null;
  initial: boolean;
  items: { path: string; origPath?: string; status: ChangeStatus }[];
}

export function parsePorcelainZ(buf: Buffer): ParsedPorcelain {
  const text = buf.toString('utf8');
  const tokens = text.split('\0');
  let head: string | undefined;
  let oid = '';
  const items: ParsedPorcelain['items'] = [];

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
      items.push({ path: rec.slice(2), status: '?' });
    } else if (kind === '1' && rec[1] === ' ') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const m = rec.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      if (m) items.push({ path: m[2], status: classifyStatus(m[1]) });
    } else if (kind === '2' && rec[1] === ' ') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const m = rec.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      const origPath = tokens[++i] ?? undefined;
      if (m) items.push({ path: m[2], origPath, status: classifyStatus(m[1]) });
    } else if (kind === 'u' && rec[1] === ' ') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const m = rec.match(/^u (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/);
      if (m) items.push({ path: m[2], status: 'U' });
    }
  }

  if (!head) return { git: null, initial: false, items: [] };
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

function countLinesQuick(absPath: string): number | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    if (st.size === 0) return 0;
    const buf = fs.readFileSync(absPath);
    if (isBinaryBuffer(buf)) return null;
    let lines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
    if (buf[buf.length - 1] !== 10) lines++;
    return lines;
  } catch {
    return null;
  }
}

export async function listChanges(projectDir: string): Promise<ProjectChanges> {
  const { realRoot } = resolveProjectPath(projectDir, '', { allowRoot: true });
  const st = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  if (!st.ok) return { git: null, files: [] };
  const parsed = parsePorcelainZ(st.stdout);
  if (!parsed.git) return { git: null, files: [] };

  const stats = new Map<string, { added: number | null; deleted: number | null }>();
  if (parsed.items.length > 0) {
    if (!parsed.initial) {
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

  const files: ChangedFile[] = parsed.items.map((it) => {
    const num = stats.get(it.path);
    if (num) return { ...it, added: num.added, deleted: num.deleted };
    if (it.status === '?' || it.status === 'A') {
      const lines = countLinesQuick(path.join(realRoot, it.path));
      return { ...it, added: lines, deleted: lines === null ? null : 0 };
    }
    return { ...it, added: null, deleted: null };
  });

  files.sort((a, b) => a.path.localeCompare(b.path, 'en', { sensitivity: 'base' }));
  return { git: parsed.git, files };
}

export async function readDiff(projectDir: string, rawRelPath: string): Promise<DiffPayload> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath);
  const stRes = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', relPosix]);
  let status: ChangeStatus | null = null;
  let origPosix: string | undefined;
  let initial = false;
  if (stRes.ok) {
    const parsed = parsePorcelainZ(stRes.stdout);
    initial = parsed.initial;
    const hit = parsed.items.find((x) => x.path === relPosix) ?? parsed.items[0];
    if (hit) {
      status = hit.status;
      origPosix = hit.origPath;
    }
  }

  let diskBuf: Buffer | null = null;
  let size = 0;
  let mtimeMs: number | null = null;
  try {
    const fst = fs.statSync(absPath);
    if (fst.isFile()) {
      size = fst.size;
      mtimeMs = fst.mtimeMs;
      if (size <= MAX_TEXT_BYTES) diskBuf = fs.readFileSync(absPath);
    }
  } catch {
    // Missing in worktree (e.g. status === 'D')
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
  const { absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath);
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
  const { absPath } = resolveProjectPath(projectDir, rawRelPath);
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

  const { absPath, relPosix } = resolveProjectPath(projectDir, body.path);
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
  return { path: relPosix, size: after.size, mtimeMs: after.mtimeMs };
}

export async function discardFile(projectDir: string, rawRelPath: string): Promise<void> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelPath);
  const stRes = await runGitBuf(realRoot, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', relPosix]);
  if (!stRes.ok) throw new WorkspaceError(400, '当前项目不是有效的 Git 仓库');
  const parsed = parsePorcelainZ(stRes.stdout);
  if (!parsed.git) throw new WorkspaceError(400, '当前项目不是有效的 Git 仓库');
  const hit = parsed.items.find((x) => x.path === relPosix) ?? parsed.items[0];
  if (!hit) return; // already clean

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
}

const STATUS_PRIORITY: Record<ChangeStatus, number> = { U: 6, D: 5, M: 4, A: 3, R: 2, '?': 1 };

export async function listTree(projectDir: string, rawRelDir = ''): Promise<TreeListing> {
  const { realRoot, absPath, relPosix } = resolveProjectPath(projectDir, rawRelDir, { allowRoot: true });
  let fst: fs.Stats;
  try {
    fst = fs.statSync(absPath);
  } catch {
    throw new WorkspaceError(404, `目录不存在：${relPosix || '.'}`);
  }
  if (!fst.isDirectory()) throw new WorkspaceError(400, '目标不是目录');

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    throw new WorkspaceError(400, `无法读取目录：${relPosix || '.'}`);
  }

  // Collect dirty markers under this directory (fast even on medium repos; non-blocking if not a git repo)
  const fileStatus = new Map<string, ChangeStatus>();
  const dirStatus = new Map<string, ChangeStatus>();
  const prefix = relPosix ? relPosix + '/' : '';
  const stRes = await runGitBuf(
    realRoot,
    relPosix ? ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', relPosix] : ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
  );
  if (stRes.ok) {
    const parsed = parsePorcelainZ(stRes.stdout);
    for (const item of parsed.items) {
      if (prefix && !item.path.startsWith(prefix)) continue;
      const rest = prefix ? item.path.slice(prefix.length) : item.path;
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        fileStatus.set(rest, item.status);
      } else {
        const childDir = rest.slice(0, slash);
        const cur = dirStatus.get(childDir);
        if (!cur || STATUS_PRIORITY[item.status] > STATUS_PRIORITY[cur]) {
          dirStatus.set(childDir, item.status);
        }
      }
    }
  }

  const entries: TreeEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.git') continue; // hide internal git object store
    const full = path.join(absPath, d.name);
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    let size: number | undefined;
    if (d.isSymbolicLink()) {
      try {
        const real = fs.realpathSync.native(full);
        if (!isInsideRoot(realRoot, real)) continue; // hide external symlinks
        const lst = fs.statSync(real);
        isDir = lst.isDirectory();
        isFile = lst.isFile();
        if (isFile) size = lst.size;
      } catch {
        continue; // broken symlink
      }
    } else if (isFile) {
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
    }
    if (!isDir && !isFile) continue;
    const entryPath = prefix + d.name;
    if (isDir) {
      entries.push({
        name: d.name,
        path: entryPath,
        kind: 'dir',
        ...(HEAVY_DIRS.has(d.name) && { ignored: true }),
        ...(dirStatus.get(d.name) && { gitStatus: dirStatus.get(d.name) }),
      });
    } else {
      entries.push({
        name: d.name,
        path: entryPath,
        kind: 'file',
        ...(fileStatus.get(d.name) && { gitStatus: fileStatus.get(d.name) }),
        ...(size !== undefined && { size }),
      });
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    // Put non-ignored dirs ahead of heavy ignored dirs (like node_modules) so source dirs sit at the top
    if (a.kind === 'dir' && !!a.ignored !== !!b.ignored) return a.ignored ? 1 : -1;
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
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
      for (const d of fs.readdirSync(realRoot, { withFileTypes: true })) {
        if (d.isFile() && d.name.startsWith('.env') && !seen.has(d.name)) {
          raw.push(d.name);
          seen.add(d.name);
        }
      }
    } catch { /* ignore */ }
    const truncated = raw.length > MAX_FILE_SEARCH;
    const existing = truncated ? raw.slice(0, MAX_FILE_SEARCH) : raw;
    existing.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
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
  files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  return { files, truncated };
}
