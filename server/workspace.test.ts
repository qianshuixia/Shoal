import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_TEXT_BYTES, MAX_UNTRACKED_LINE_STAT, WorkspaceError, createFsEntry, deleteFsEntry, discardFile, listAllFiles, listChanges, refreshIgnoredIndex, searchIgnoredFiles, listTree, pasteFsEntries, readDiff, readFileEntry, renameFsEntry, openRawPreview, resolveProjectPath, writeFileEntry,
} from './workspace.ts';
import { gitInfo } from './git.ts';
import { scoreFinderPath } from '../shared/protocol.ts';
import { matchProjectFileLink, parseLocalFileLink } from '../web/src/linkParse.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wb-ws-${prefix}-`));
  tempDirs.push(d);
  return d;
}

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(prefix: string): string {
  const d = makeTempDir(prefix);
  git(d, ['init', '-q', '-b', 'main']);
  git(d, ['config', 'user.email', 'test@example.com']);
  git(d, ['config', 'user.name', 'Tester']);
  return d;
}

// openRawPreview hands back an open descriptor; tests only need the metadata, so close it straight away.
function openRaw(root: string, rel: string) {
  const { fd, ...meta } = openRawPreview(root, rel);
  fs.closeSync(fd);
  return meta;
}

function rawStatus(root: string, rel: string): number | undefined {
  try {
    openRaw(root, rel);
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(WorkspaceError);
    return (e as WorkspaceError).status;
  }
}

afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

it('rechecks the workspace target after opening its file handle', () => {
  const root = makeTempDir('handle-check');
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  fs.writeFileSync(first, 'first original');
  fs.writeFileSync(second, 'second original');
  const open = fs.openSync.bind(fs);
  const realFirst = fs.realpathSync.native(first);
  const spy = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    return open(file === realFirst && flags === (process.platform === 'win32' ? fs.constants.O_WRONLY : fs.constants.O_WRONLY | fs.constants.O_NONBLOCK) ? second : file, flags, mode);
  });
  try {
    expect(() => writeFileEntry(root, { path: 'first.txt', content: 'new content' })).toThrow(WorkspaceError);
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(first, 'utf8')).toBe('first original');
  expect(fs.readFileSync(second, 'utf8')).toBe('second original');
});

describe('resolveProjectPath security boundaries', () => {
  it('resolves valid relative paths and blocks traversal, UNC, absolute paths, .git, and external junctions', () => {
    const root = makeTempDir('sec');
    const outside = makeTempDir('outside');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');

    // A backslash only separates path parts on Windows; on POSIX it is part of a file name.
    const bs = (p: string) => (path.sep === '\\' ? p : p.replaceAll('\\', '/'));
    const ok = resolveProjectPath(root, bs('src\\index.ts'));
    expect(ok.relPosix).toBe('src/index.ts');

    expect(() => resolveProjectPath(root, '../outside/secret.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, 'src/../../outside/secret.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, '\\\\evil\\share\\a.txt')).toThrow(WorkspaceError);
    if (process.platform === 'win32') {
      expect(() => resolveProjectPath(root, path.join(outside, 'secret.txt'))).toThrow(WorkspaceError);
    } else {
      // A drive path is refused on Windows; on POSIX a leading / is dropped, so it can only land inside the project.
      const inside = resolveProjectPath(root, path.join(outside, 'secret.txt'));
      expect(inside.absPath.startsWith(inside.realRoot + path.sep)).toBe(true);
    }
    expect(() => resolveProjectPath(root, '.git/config')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, bs('.GIT\\HEAD'))).toThrow(WorkspaceError);

    // Directory junction pointing outside project root (works on Windows without admin rights)
    const linkDir = path.join(root, 'linked-out');
    fs.symlinkSync(outside, linkDir, 'junction');
    fs.writeFileSync(path.join(outside, 'leak.mp4'), 'x');
    expect(() => resolveProjectPath(root, 'linked-out/secret.txt')).toThrow(WorkspaceError);
    expect(rawStatus(root, 'linked-out/leak.mp4')).toBe(403);
    expect(() => resolveProjectPath(root, 'linked-out/new-file.txt')).toThrow(WorkspaceError);
  });

  it.skipIf(process.platform !== 'win32')('treats a case-only sibling in a case-sensitive directory as outside the project', async (ctx) => {
    const parent = makeTempDir('case');
    try {
      execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', parent, 'enable'], { stdio: 'ignore' });
    } catch {
      ctx.skip(); // needs a recent Windows build and an NTFS volume
    }
    const root = path.join(parent, 'Proj');
    const sibling = path.join(parent, 'proj');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.mp4'), 'outside');
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'outside');
    fs.writeFileSync(path.join(root, 'own.mp4'), 'inside');
    fs.symlinkSync(sibling, path.join(root, 'link'), 'junction');

    expect(openRaw(root, 'own.mp4').size).toBe(6);
    expect(rawStatus(root, 'link/secret.mp4')).toBe(403);
    expect(() => readFileEntry(root, 'link/secret.txt')).toThrow(WorkspaceError);
    expect(() => writeFileEntry(root, { path: 'link/planted.txt', content: 'x' })).toThrow(WorkspaceError);
    expect(() => createFsEntry(root, { parentDir: 'link', name: 'made.txt', kind: 'file' })).toThrow(WorkspaceError);
    expect(fs.readdirSync(sibling).sort()).toEqual(['secret.mp4', 'secret.txt']);
    expect((await listTree(root)).entries.map((e) => e.name)).toEqual(['own.mp4']);

    // New directories inherit case sensitivity, so `Box` and `box` are different folders and a cut between them must move.
    fs.mkdirSync(path.join(root, 'Box'));
    fs.mkdirSync(path.join(root, 'box'));
    fs.writeFileSync(path.join(root, 'Box', 'm.txt'), 'm');
    const moved = await pasteFsEntries(root, { mode: 'cut', targetDir: 'box', sourcePath: 'Box/m.txt' });
    expect(moved.skipped).toBeUndefined();
    expect(moved.paths).toEqual(['box/m.txt']);
    expect(fs.readdirSync(path.join(root, 'Box'))).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'box', 'm.txt'), 'utf8')).toBe('m');
    // Cutting into the same folder is still a no-op.
    expect((await pasteFsEntries(root, { mode: 'cut', targetDir: 'box', sourcePath: 'box/m.txt' })).skipped).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('still accepts an in-project link whose stored target differs only in case', async () => {
    const root = makeTempDir('ci');
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'dst'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {};\n');
    const realRoot = fs.realpathSync.native(root);
    const caseVariant = path.join(path.dirname(realRoot), path.basename(realRoot).toUpperCase(), 'SRC');
    fs.symlinkSync(caseVariant, path.join(root, 'inner'), 'junction');
    expect(fs.readlinkSync(path.join(root, 'inner'))).toContain(path.basename(realRoot).toUpperCase());

    expect(readFileEntry(root, 'inner/a.ts').kind).toBe('text');
    await pasteFsEntries(root, { mode: 'copy', targetDir: 'dst', sourcePath: 'inner' });
    expect(fs.readFileSync(path.join(root, 'dst', 'inner', 'a.ts'), 'utf8')).toBe('export {};\n');
  });
});

describe('git changes, diff, and discard', () => {
  it('handles unborn HEAD repos (0 commits) with untracked and staged files', async () => {
    const repo = initRepo('unborn');
    fs.writeFileSync(path.join(repo, 'hello.txt'), 'line1\nline2\n');
    fs.writeFileSync(path.join(repo, 'staged.ts'), 'const a = 1;\n');
    git(repo, ['add', 'staged.ts']);

    const changes = await listChanges(repo);
    expect(changes.git).toEqual({ branch: 'main', detached: false, dirty: 2 });
    expect(changes.files).toEqual([
      { path: 'hello.txt', status: '?', added: 2, deleted: 0 },
      { path: 'staged.ts', status: 'A', added: 1, deleted: 0 },
    ]);

    const diff = await readDiff(repo, 'staged.ts');
    expect(diff.base).toBe('');
    expect(diff.head).toBe('const a = 1;\n');

    await discardFile(repo, 'staged.ts');
    expect(fs.existsSync(path.join(repo, 'staged.ts'))).toBe(false);
  });

  it('tracks M / A / D / R / ? including Chinese filenames, computes diffs, and discards safely', async () => {
    const repo = initRepo('full');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'keep.ts'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'src', 'remove.ts'), 'gone\n');
    fs.writeFileSync(path.join(repo, 'src', 'old-name.ts'), 'same1\nsame2\nsame3\nsame4\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    // Modify keep.ts (+2 -1)
    fs.writeFileSync(path.join(repo, 'src', 'keep.ts'), 'a\nB1\nB2\nc\n');
    // Delete remove.ts
    fs.rmSync(path.join(repo, 'src', 'remove.ts'));
    // Rename old-name.ts -> 说明 文档.ts
    git(repo, ['mv', 'src/old-name.ts', 'src/说明 文档.ts']);
    // Untracked file
    fs.writeFileSync(path.join(repo, 'notes.md'), '# Title\n');

    const changes = await listChanges(repo);
    expect(changes.git).toEqual({ branch: 'main', detached: false, dirty: 4 });
    const byPath = new Map(changes.files.map((f) => [f.path, f]));
    expect(byPath.get('src/keep.ts')).toEqual({ path: 'src/keep.ts', status: 'M', added: 2, deleted: 1 });
    expect(byPath.get('src/remove.ts')).toEqual({ path: 'src/remove.ts', status: 'D', added: 0, deleted: 1 });
    expect(byPath.get('src/说明 文档.ts')?.status).toBe('R');
    expect(byPath.get('src/说明 文档.ts')?.origPath).toBe('src/old-name.ts');
    expect(byPath.get('notes.md')).toEqual({ path: 'notes.md', status: '?', added: 1, deleted: 0 });

    const modDiff = await readDiff(repo, 'src/keep.ts');
    expect(modDiff.base).toBe('a\nb\nc\n');
    expect(modDiff.head).toBe('a\nB1\nB2\nc\n');
    expect(modDiff.status).toBe('M');

    const delDiff = await readDiff(repo, 'src/remove.ts');
    expect(delDiff.base).toBe('gone\n');
    expect(delDiff.head).toBe('');
    expect(delDiff.status).toBe('D');

    // Discard tracked modification and deletion, and untracked file
    await discardFile(repo, 'src/keep.ts');
    expect(fs.readFileSync(path.join(repo, 'src', 'keep.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('a\nb\nc\n');
    // Even after autocrlf checkout, readDiff normalizes CRLF so base === head cleanly
    const cleanDiff = await readDiff(repo, 'src/keep.ts');
    expect(cleanDiff.base).toBe(cleanDiff.head);
    await discardFile(repo, 'src/remove.ts');
    expect(fs.readFileSync(path.join(repo, 'src', 'remove.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('gone\n');
    await discardFile(repo, 'notes.md');
    expect(fs.existsSync(path.join(repo, 'notes.md'))).toBe(false);
  });
});

describe('file read/write, optimistic lock, tree visibility, and guards', () => {
  it('enforces optimistic mtimeMs locking (409 conflict) and supports force override', () => {
    const dir = makeTempDir('rw');
    const file = path.join(dir, 'app.ts');
    fs.writeFileSync(file, 'v1\n');
    const initial = readFileEntry(dir, 'app.ts');
    expect(initial.kind).toBe('text');
    expect(initial.content).toBe('v1\n');
    expect(typeof initial.mtimeMs).toBe('number');

    // Stat-only check omits content
    const statOnly = readFileEntry(dir, 'app.ts', true);
    expect(statOnly.content).toBeUndefined();
    expect(statOnly.mtimeMs).toBe(initial.mtimeMs);

    // Normal save with matching expectedMtimeMs succeeds
    const saved = writeFileEntry(dir, { path: 'app.ts', content: 'v2\n', expectedMtimeMs: initial.mtimeMs });
    expect(fs.readFileSync(file, 'utf8')).toBe('v2\n');

    // Simulate external Agent modifying disk timestamp & content
    const bumped = new Date(saved.mtimeMs + 5000);
    fs.writeFileSync(file, 'agent-v3\n');
    fs.utimesSync(file, bumped, bumped);

    // Saving stale user draft without force throws 409 conflict and preserves agent's disk version
    expect(() =>
      writeFileEntry(dir, { path: 'app.ts', content: 'user-stale\n', expectedMtimeMs: saved.mtimeMs }),
    ).toThrowError(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(fs.readFileSync(file, 'utf8')).toBe('agent-v3\n');

    // Force overwrite succeeds when user explicitly chooses to keep their draft
    writeFileEntry(dir, { path: 'app.ts', content: 'user-forced\n', expectedMtimeMs: saved.mtimeMs, force: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('user-forced\n');
  });

  it('Ctrl+P searches gitignored files on the server, skipping caches, nested repos, worktrees and links out of the project', async () => {
    const repo = initRepo('finder');
    const put = (rel: string, body = '') => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    };
    put('.gitignore', '.tmp/\ndist/\nnode_modules/\n*.log\n');
    put('src/app.ts');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    put('notes.md'); // untracked, not ignored
    put('debug.log'); // ignored file outside any ignored folder
    put('.tmp/promo/out/flow/demo-short.mp4'); // the reported case: deep inside an ignored folder, under an `out/` dir
    put('dist/app.js');
    put('node_modules/pkg/index.js');
    put('.tmp/promo/node_modules/dep/index.js');
    put('.tmp/clone/.git/HEAD', 'ref: refs/heads/main\n'); // nested repo
    put('.tmp/clone/readme.md');
    put('.tmp/wt/.git', 'gitdir: elsewhere\n'); // worktree
    put('.tmp/wt/src/app.ts');
    for (let i = 0; i < 70; i++) put(`.tmp/frames/frame-${String(i).padStart(2, '0')}.png`);
    const outside = makeTempDir('finder-outside');
    fs.writeFileSync(path.join(outside, 'outside-secret.txt'), '');
    fs.symlinkSync(outside, path.join(repo, '.tmp', 'linked'), 'junction');

    // The list the browser ranks locally holds only files git does not ignore.
    const all = await listAllFiles(repo);
    expect(all).toEqual({ files: ['.gitignore', 'notes.md', 'src/app.ts'], truncated: false });

    const hit = await searchIgnoredFiles(repo, 'demo-short.mp4');
    expect(hit.files).toEqual(['.tmp/promo/out/flow/demo-short.mp4']);
    expect(hit.truncated).toBe(false);
    expect(hit.indexed).toBe(73); // 70 frames, the mp4, debug.log, dist/app.js
    expect((await searchIgnoredFiles(repo, 'app')).files).toEqual(['dist/app.js']); // worktree and node_modules copies skipped
    expect((await searchIgnoredFiles(repo, 'readme')).files).toEqual([]); // nested repo skipped
    expect((await searchIgnoredFiles(repo, 'outside-secret')).files).toEqual([]); // junction skipped
    // At most 60 matches come back, best first: the exact basename outranks the other 69 frames.
    const frames = await searchIgnoredFiles(repo, 'frame-07.png');
    expect(frames.files[0]).toBe('.tmp/frames/frame-07.png');
    expect((await searchIgnoredFiles(repo, 'frame')).files).toHaveLength(60);
    expect((await searchIgnoredFiles(repo, '  ')).files).toEqual([]);

    // A file written after the last index is found once the finder reopens (GET /files calls refreshIgnoredIndex).
    put('.tmp/promo/out/flow/demo-long.mp4');
    expect((await searchIgnoredFiles(repo, 'demo-long')).files).toEqual([]);
    refreshIgnoredIndex(repo);
    expect((await searchIgnoredFiles(repo, 'demo-long')).files).toEqual(['.tmp/promo/out/flow/demo-long.mp4']);

    // Without git there is nothing to mark as ignored: the walk returns every file but the same skipped folders.
    const plain = makeTempDir('finder-plain');
    fs.mkdirSync(path.join(plain, 'out'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'out', 'a.txt'), '');
    fs.mkdirSync(path.join(plain, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'node_modules', 'x', 'i.js'), '');
    expect(await listAllFiles(plain)).toEqual({ files: ['out/a.txt'], truncated: false });
    expect(await searchIgnoredFiles(plain, 'a.txt')).toEqual({ files: [], indexed: 0, truncated: false, unreadable: 0 });
  });

  it('Ctrl+P keeps a pasted full path first among more than 60 matches, and reports gitignored folders it could not read', async () => {
    const repo = initRepo('finder-edge');
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), '');
    };
    fs.writeFileSync(path.join(repo, '.gitignore'), '.tmp/\n');
    // 61 longer names start with the pasted path in another case; by name alone they all sort before it.
    const exact = '.tmp/out/clip.mp4';
    put(exact);
    for (let i = 0; i < 61; i++) put(`.tmp/out/CLIP.mp4.${i}`);
    expect((await searchIgnoredFiles(repo, exact)).files[0]).toBe(exact);
    expect(scoreFinderPath(exact, exact)).toBeGreaterThan(scoreFinderPath('.tmp/OUT/clip.mp4', exact)); // case-sensitive disks

    // A folder that fails to read (EIO, no permission) is reported, not passed off as empty; one deleted meanwhile is not.
    put('.tmp/scratch/render.mp4');
    put('.tmp/gone/old.txt');
    const readdir = fs.promises.readdir;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const name = path.basename(String(p));
      if (name === 'scratch' || name === 'gone') {
        return Promise.reject(Object.assign(new Error(name), { code: name === 'scratch' ? 'EIO' : 'ENOENT' }));
      }
      return (readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof readdir);
    try {
      refreshIgnoredIndex(repo);
      const res = await searchIgnoredFiles(repo, 'render');
      expect(res).toMatchObject({ files: [], truncated: false, unreadable: 1 });
    } finally {
      spy.mockRestore();
    }
    refreshIgnoredIndex(repo);
    expect(await searchIgnoredFiles(repo, 'render')).toMatchObject({ files: ['.tmp/scratch/render.mp4'], unreadable: 0 });
  });

  it('guards binary and >2MB files, serves image metadata, and exposes .env while dimming node_modules', async () => {
    const repo = initRepo('tree');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=demo\n');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), '');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'main.ts'), 'console.log(1);\n');
    fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    fs.writeFileSync(path.join(repo, 'huge.log'), Buffer.alloc(MAX_TEXT_BYTES + 16, 0x61));
    fs.writeFileSync(path.join(repo, 'clip.mp4'), Buffer.alloc(MAX_TEXT_BYTES + 16, 0x01));
    fs.writeFileSync(path.join(repo, 'Tune.MP3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    fs.writeFileSync(path.join(repo, 'doc.pdf'), '%PDF-1.4\n');
    fs.writeFileSync(path.join(repo, 'mod.mts'), 'export {};\n');
    fs.writeFileSync(path.join(repo, 'x.constructor'), 'plain\n');

    const tree = await listTree(repo, '');
    const names = tree.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).toContain('.env');
    expect(names).toContain('src');
    expect(names).toContain('node_modules');
    // src comes before ignored node_modules
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('node_modules'));
    expect(tree.entries.find((e) => e.name === 'node_modules')?.ignored).toBe(true);
    expect(tree.entries.find((e) => e.name === 'src')?.gitStatus).toBe('?');

    // Ctrl+P lists src/main.ts, finds the gitignored .env through the ignored-file search, and never offers node_modules
    const all = await listAllFiles(repo);
    expect(all.files).not.toContain('.env');
    expect(all.files).toContain('src/main.ts');
    expect((await searchIgnoredFiles(repo, '.env')).files).toEqual(['.env']);
    expect([...all.files, ...(await searchIgnoredFiles(repo, 'index.js')).files].some((f) => f.startsWith('node_modules/'))).toBe(false);

    expect(readFileEntry(repo, 'logo.png').kind).toBe('image');
    expect(openRaw(repo, 'logo.png').mime).toBe('image/png');
    expect(rawStatus(repo, 'src/main.ts')).toBe(415);
    // Video, audio and PDF preview at any size (streamed with Range); TypeScript .ts/.mts and prototype keys stay non-media.
    expect(readFileEntry(repo, 'clip.mp4')).toMatchObject({ kind: 'video', mime: 'video/mp4', size: MAX_TEXT_BYTES + 16 });
    expect(readFileEntry(repo, 'Tune.MP3')).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });
    expect(readFileEntry(repo, 'doc.pdf')).toMatchObject({ kind: 'pdf', mime: 'application/pdf' });
    expect(openRaw(repo, 'clip.mp4')).toMatchObject({ kind: 'video', size: MAX_TEXT_BYTES + 16 });
    // A small PDF has no NUL byte; the Changes tab must still treat it as a preview, never as editable text.
    expect(await readDiff(repo, 'doc.pdf')).toMatchObject({ binary: true, tooLarge: false, base: '', head: '' });
    fs.mkdirSync(path.join(repo, 'folder.mp4'));
    expect(rawStatus(repo, 'folder.mp4')).toBe(400);
    expect(rawStatus(repo, 'missing.mp4')).toBe(404);
    // NTFS alternate data stream: the suffix looks like video but the bytes come from a text file's hidden stream.
    if (process.platform === 'win32') expect(rawStatus(repo, 'src/main.ts:clip.mp4')).toBe(400);
    expect(readFileEntry(repo, 'src/main.ts').kind).toBe('text');
    expect(readFileEntry(repo, 'mod.mts').kind).toBe('text');
    expect(readFileEntry(repo, 'x.constructor').kind).toBe('text');
    expect(rawStatus(repo, 'x.constructor')).toBe(415);
    expect(rawStatus(repo, '../outside.mp4')).toBeDefined();
    expect(readFileEntry(repo, 'bin.dat').kind).toBe('binary');
    expect(readFileEntry(repo, 'huge.log').kind).toBe('too_large');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO named like media without blocking on open', () => {
    const dir = makeTempDir('fifo');
    execFileSync('mkfifo', [path.join(dir, 'pipe.mp4')]);
    // A blocking open would freeze the event loop for good, so run it in a child process the test can time out.
    const script = [
      `import { openRawPreview } from ${JSON.stringify(new URL('./workspace.ts', import.meta.url).href)};`,
      `try { openRawPreview(${JSON.stringify(dir)}, 'pipe.mp4'); console.log('opened'); }`,
      'catch (e) { console.log(String(e.status)); }',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
    expect(out.trim()).toBe('400');
  });

  it('parses terminal file links and matches deepest in-project files while leaving external/exe links untouched', () => {
    expect(parseLocalFileLink('file:///G:/Workspace/app/src/%E4%B8%AD%E6%96%87.ts#L12C3')).toEqual({
      localPath: 'G:\\Workspace\\app\\src\\中文.ts',
      line: 12,
      col: 3,
    });
    expect(parseLocalFileLink('G:\\Workspace\\app\\src\\auth.ts:42:5')).toEqual({
      localPath: 'G:\\Workspace\\app\\src\\auth.ts',
      line: 42,
      col: 5,
    });
    expect(parseLocalFileLink('\\\\evil-host\\share\\a.ts')).toBeNull();

    // POSIX links: file URL with fragment, bare path with colon suffix, lexical .. folding, //-rooted and remote rejected
    expect(parseLocalFileLink('file:///Users/a/b%20c.ts#L3C1')).toEqual({ localPath: '/Users/a/b c.ts', line: 3, col: 1 });
    expect(parseLocalFileLink('/Users/a/./x/../b.ts:12:3')).toEqual({ localPath: '/Users/a/b.ts', line: 12, col: 3 });
    expect(parseLocalFileLink('/Users/a/b.ts#L7')).toEqual({ localPath: '/Users/a/b.ts', line: 7 });
    expect(parseLocalFileLink('//host/a.ts')).toBeNull();
    expect(parseLocalFileLink('file://host/Users/a.ts')).toBeNull();
    expect(parseLocalFileLink('relative/a.ts')).toBeNull();

    const projects = [
      { id: 'p-outer', name: 'outer', path: 'G:\\Workspace', createdAt: 1 },
      { id: 'p-inner', name: 'inner', path: 'G:\\Workspace\\app', createdAt: 2 },
    ];
    const hit = matchProjectFileLink('G:\\Workspace\\app\\src\\auth.ts:42:5', projects);
    expect(hit?.project.id).toBe('p-inner');
    expect(hit?.relPosix).toBe('src/auth.ts');
    expect(hit?.line).toBe(42);
    expect(hit?.col).toBe(5);
    // PDFs preview in the Inspector now, so they match like any other project file
    expect(matchProjectFileLink('G:\\Workspace\\app\\docs\\spec.pdf', projects)?.relPosix).toBe('docs/spec.pdf');

    // Executables, .git internals, and outside paths return null so /api/open handles them
    expect(matchProjectFileLink('G:\\Workspace\\app\\tool.exe', projects)).toBeNull();
    expect(matchProjectFileLink('G:\\Workspace\\app\\.git\\config', projects)).toBeNull();
    expect(matchProjectFileLink('C:\\Temp\\random.ts#L3', projects)).toBeNull();

    // POSIX projects: deepest wins, case-sensitive, .git and app bundles / installers stay external, Windows links never match
    const posixProjects = [
      { id: 'q-outer', name: 'outer', path: '/Users/a/work/', createdAt: 1 },
      { id: 'q-inner', name: 'inner', path: '/Users/a/work/app', createdAt: 2 },
    ];
    const posixHit = matchProjectFileLink('/Users/a/work/app/src/Auth.ts:42:5', posixProjects);
    expect(posixHit?.project.id).toBe('q-inner');
    expect(posixHit?.relPosix).toBe('src/Auth.ts');
    expect(posixHit?.line).toBe(42);
    expect(matchProjectFileLink('file:///Users/a/work/readme.md#L2', posixProjects)?.project.id).toBe('q-outer');
    expect(matchProjectFileLink('/users/a/work/app/src/a.ts', posixProjects)).toBeNull();
    expect(matchProjectFileLink('/Users/a/work/app/.git/config', posixProjects)).toBeNull();
    for (const f of ['Foo.app', 'run.command', 'x.dmg', 'x.pkg', 'x.exe']) {
      expect(matchProjectFileLink('/Users/a/work/' + f, posixProjects)).toBeNull();
    }
    expect(matchProjectFileLink('G:\\Workspace\\app\\src\\auth.ts', posixProjects)).toBeNull();
    expect(matchProjectFileLink('/Users/a/work/app/src/a.ts', projects)).toBeNull();
  });
});

describe('workspace large changes & git consistency', () => {
  it('skips untracked line stats above threshold while matching gitInfo dirty count', async () => {
    const repo = initRepo('many-untracked');
    fs.writeFileSync(path.join(repo, 'tracked.ts'), 'const a = 1;\n', 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    fs.writeFileSync(path.join(repo, 'tracked.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    const untrackedTotal = MAX_UNTRACKED_LINE_STAT + 120;
    const bulkDir = path.join(repo, 'bulk');
    fs.mkdirSync(bulkDir);
    for (let i = 0; i < untrackedTotal; i++) {
      fs.writeFileSync(path.join(bulkDir, `f-${String(i).padStart(4, '0')}.txt`), 'line1\nline2\n', 'utf8');
    }

    const t0 = Date.now();
    const [changes, info] = await Promise.all([listChanges(repo), gitInfo(repo)]);
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(5000);
    expect(changes.statsSkipped).toBe(true);
    expect(changes.files.length).toBe(untrackedTotal + 1);
    expect(changes.git?.dirty).toBe(untrackedTotal + 1);
    expect(info?.dirty).toBe(changes.git?.dirty);

    const tracked = changes.files.find((f) => f.path === 'tracked.ts');
    expect(tracked).toEqual({ path: 'tracked.ts', status: 'M', added: 1, deleted: 0 });

    const sampleUntracked = changes.files.find((f) => f.path === 'bulk/f-0000.txt');
    expect(sampleUntracked).toEqual({ path: 'bulk/f-0000.txt', status: '?', added: null, deleted: null });
  });

  it('deduplicates git rm --cached + untracked same path and guards nested git directory diff', async () => {
    const repo = initRepo('dedup-dir');
    fs.writeFileSync(path.join(repo, 'cached.ts'), 'export const x = 1;\n', 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    // Staged delete (`D `) + untracked file (`??`) on the same path
    git(repo, ['rm', '--cached', '-q', 'cached.ts']);
    fs.writeFileSync(path.join(repo, 'cached.ts'), 'export const x = 2;\n', 'utf8');

    // Nested git repository appears in parent git status as `sub/`
    const subDir = path.join(repo, 'nested-repo');
    fs.mkdirSync(subDir);
    git(subDir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(subDir, 'inner.txt'), 'hi\n', 'utf8');

    const changes = await listChanges(repo);
    const cachedMatches = changes.files.filter((f) => f.path === 'cached.ts');
    expect(cachedMatches).toHaveLength(1);
    expect(cachedMatches[0].status).toBe('M');

    const nested = changes.files.find((f) => f.path === 'nested-repo');
    expect(nested).toEqual({ path: 'nested-repo', status: '?', added: null, deleted: null });

    const dirDiff = await readDiff(repo, 'nested-repo');
    expect(dirDiff.isDirectory).toBe(true);
    expect(dirDiff.binary).toBe(false);
    expect(dirDiff.head).toBe('');
  });

  it('handles concurrent listChanges/listTree and invalidates porcelain cache on writeFileEntry', async () => {
    const repo = initRepo('cache-invalidate');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'ok\n', 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const [c1, tree1, c2, info1] = await Promise.all([
      listChanges(repo),
      listTree(repo, ''),
      listChanges(repo),
      gitInfo(repo),
    ]);
    expect(c1.files).toEqual([]);
    expect(c2.files).toEqual([]);
    expect(info1?.dirty).toBe(0);
    expect(tree1.entries.map((e) => e.name)).toContain('base.txt');

    // Write immediately within the 250ms porcelain cache window -> cache must be invalidated
    const initial = readFileEntry(repo, 'base.txt', true);
    writeFileEntry(repo, { path: 'base.txt', content: 'updated\n', expectedMtimeMs: initial.mtimeMs });
    const [c3, info2] = await Promise.all([listChanges(repo), gitInfo(repo)]);
    expect(c3.files.map((f) => f.path)).toContain('base.txt');
    expect(c3.git?.dirty).toBe(1);
    expect(info2?.dirty).toBe(1);
  });

  it('creates, renames, copies, moves, pastes external files, and deletes safely with strict guards', async () => {
    const projA = makeTempDir('fs-a');
    const projB = makeTempDir('fs-b');
    const externalDir = makeTempDir('fs-ext');
    fs.writeFileSync(path.join(externalDir, 'clip.txt'), 'from-clipboard\n', 'utf8');

    // Create dir & file
    expect(createFsEntry(projA, { parentDir: '', name: 'src', kind: 'dir' })).toEqual({ path: 'src', kind: 'dir' });
    expect(createFsEntry(projA, { parentDir: 'src', name: 'a.ts', kind: 'file' })).toEqual({ path: 'src/a.ts', kind: 'file' });
    fs.writeFileSync(path.join(projA, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

    // Conflict & invalid name rejection
    expect(() => createFsEntry(projA, { parentDir: 'src', name: 'a.ts', kind: 'file' })).toThrow(WorkspaceError);
    expect(() => createFsEntry(projA, { parentDir: '', name: '.git', kind: 'dir' })).toThrow(WorkspaceError);
    expect(() => createFsEntry(projA, { parentDir: '', name: 'CON.txt', kind: 'file' })).toThrow(WorkspaceError);
    expect(() => createFsEntry(projA, { parentDir: '', name: 'bad/name', kind: 'file' })).toThrow(WorkspaceError);

    // Leading-space existing filename must stay isolated from trimmed neighbor across read, write, paste, and delete
    fs.writeFileSync(path.join(projA, ' notes.txt'), 'leading-space\n', 'utf8');
    fs.writeFileSync(path.join(projA, 'notes.txt'), 'plain\n', 'utf8');
    expect(readFileEntry(projA, ' notes.txt').content).toBe('leading-space\n');
    expect(readFileEntry(projA, 'notes.txt').content).toBe('plain\n');
    writeFileEntry(projA, { path: ' notes.txt', content: 'leading-updated\n' });
    expect(fs.readFileSync(path.join(projA, ' notes.txt'), 'utf8')).toBe('leading-updated\n');
    expect(fs.readFileSync(path.join(projA, 'notes.txt'), 'utf8')).toBe('plain\n');
    const spacedPaste = await pasteFsEntries(projA, { mode: 'copy', targetDir: 'src', sourcePath: ' notes.txt' });
    expect(spacedPaste).toEqual({ paths: ['src/ notes.txt'], targetDir: 'src' });
    expect(fs.readFileSync(path.join(projA, 'src', ' notes.txt'), 'utf8')).toBe('leading-updated\n');
    expect(deleteFsEntry(projA, { path: ' notes.txt' })).toEqual({ path: ' notes.txt', kind: 'file' });
    expect(deleteFsEntry(projA, { path: 'src/ notes.txt' })).toEqual({ path: 'src/ notes.txt', kind: 'file' });
    expect(fs.existsSync(path.join(projA, ' notes.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(projA, 'notes.txt'), 'utf8')).toBe('plain\n');

    // Distinct hard-linked filenames sharing an inode must still reject rename conflict with 409 (keeping both entries)
    fs.writeFileSync(path.join(projA, 'hl-one.txt'), 'shared\n', 'utf8');
    let hardLinkCreated = false;
    try {
      fs.linkSync(path.join(projA, 'hl-one.txt'), path.join(projA, 'hl-two.txt'));
      hardLinkCreated = true;
    } catch { /* skip on filesystems without hard link support */ }
    if (hardLinkCreated) {
      let err: unknown;
      try {
        renameFsEntry(projA, { path: 'hl-one.txt', newName: 'hl-two.txt' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).status).toBe(409);
      expect(fs.existsSync(path.join(projA, 'hl-one.txt'))).toBe(true);
      expect(fs.existsSync(path.join(projA, 'hl-two.txt'))).toBe(true);
      fs.unlinkSync(path.join(projA, 'hl-two.txt'));
    }
    fs.unlinkSync(path.join(projA, 'hl-one.txt'));

    // Directory rename onto an existing empty directory must reject with 409 and preserve both directories
    expect(createFsEntry(projA, { parentDir: '', name: 'dir-src', kind: 'dir' })).toEqual({ path: 'dir-src', kind: 'dir' });
    fs.writeFileSync(path.join(projA, 'dir-src', 'keep.txt'), 'keep\n', 'utf8');
    expect(createFsEntry(projA, { parentDir: '', name: 'dir-empty', kind: 'dir' })).toEqual({ path: 'dir-empty', kind: 'dir' });
    let dirConflictErr: unknown;
    try {
      renameFsEntry(projA, { path: 'dir-src', newName: 'dir-empty' });
    } catch (e) {
      dirConflictErr = e;
    }
    expect(dirConflictErr).toBeInstanceOf(WorkspaceError);
    expect((dirConflictErr as WorkspaceError).status).toBe(409);
    expect(fs.readFileSync(path.join(projA, 'dir-src', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(projA, 'dir-empty'))).toBe(true);
    expect(deleteFsEntry(projA, { path: 'dir-src' })).toEqual({ path: 'dir-src', kind: 'dir' });
    expect(deleteFsEntry(projA, { path: 'dir-empty' })).toEqual({ path: 'dir-empty', kind: 'dir' });

    // Nested .git metadata is protected against delete and copy
    fs.mkdirSync(path.join(projA, 'nested-git', '.git'), { recursive: true });
    fs.writeFileSync(path.join(projA, 'nested-git', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    expect(() => deleteFsEntry(projA, { path: 'nested-git/.git/HEAD' })).toThrow(WorkspaceError);
    expect(() => deleteFsEntry(projA, { path: 'nested-git' })).toThrow(WorkspaceError);
    await expect(pasteFsEntries(projB, {
      mode: 'copy', targetDir: '', sourceProjectId: 'a', sourcePath: 'nested-git',
    }, (id) => (id === 'a' ? projA : null))).rejects.toThrow(WorkspaceError);

    // Copy in same dir auto-generates unique suffix without overwriting
    const copy1 = await pasteFsEntries(projA, { mode: 'copy', targetDir: 'src', sourcePath: 'src/a.ts' });
    expect(copy1).toEqual({ paths: ['src/a copy.ts'], targetDir: 'src' });
    const copy2 = await pasteFsEntries(projA, { mode: 'copy', targetDir: 'src', sourcePath: 'src/a.ts' });
    expect(copy2).toEqual({ paths: ['src/a copy 2.ts'], targetDir: 'src' });

    // Copying a directory into itself or its child is rejected
    expect(createFsEntry(projA, { parentDir: 'src', name: 'nested', kind: 'dir' })).toEqual({ path: 'src/nested', kind: 'dir' });
    await expect(pasteFsEntries(projA, { mode: 'copy', targetDir: 'src/nested', sourcePath: 'src' })).rejects.toThrow(WorkspaceError);

    // Cut into same dir skips cleanly; cut into subdir moves without leaving source
    expect(await pasteFsEntries(projA, { mode: 'cut', targetDir: 'src', sourcePath: 'src/a copy.ts' })).toEqual({
      paths: ['src/a copy.ts'], targetDir: 'src', skipped: true,
    });
    expect(await pasteFsEntries(projA, { mode: 'cut', targetDir: 'src/nested', sourcePath: 'src/a copy.ts' })).toEqual({
      paths: ['src/nested/a copy.ts'], targetDir: 'src/nested',
    });
    expect(fs.existsSync(path.join(projA, 'src', 'a copy.ts'))).toBe(false);
    expect(fs.existsSync(path.join(projA, 'src', 'nested', 'a copy.ts'))).toBe(true);

    // Cross-project copy & external clipboard paste (plus rollback on batch error)
    const cross = await pasteFsEntries(projB, {
      mode: 'copy', targetDir: '', sourceProjectId: 'a', sourcePath: 'src/a.ts',
    }, (id) => (id === 'a' ? projA : null));
    expect(cross).toEqual({ paths: ['a.ts'], targetDir: '' });
    expect(fs.readFileSync(path.join(projB, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

    await expect(pasteFsEntries(projB, {
      mode: 'copy', targetDir: '', externalPaths: [path.join(externalDir, 'clip.txt'), path.join(externalDir, 'missing.txt')],
    })).rejects.toThrow(WorkspaceError);
    expect(fs.existsSync(path.join(projB, 'clip.txt'))).toBe(false);

    const extPaste = await pasteFsEntries(projB, { mode: 'copy', targetDir: '', externalPaths: [path.join(externalDir, 'clip.txt')] });
    expect(extPaste).toEqual({ paths: ['clip.txt'], targetDir: '' });
    expect(fs.readFileSync(path.join(projB, 'clip.txt'), 'utf8')).toBe('from-clipboard\n');

    // Rename + conflict protection + delete
    expect(renameFsEntry(projA, { path: 'src/a copy 2.ts', newName: 'b.ts' })).toEqual({
      oldPath: 'src/a copy 2.ts', newPath: 'src/b.ts', kind: 'file',
    });
    expect(() => renameFsEntry(projA, { path: 'src/b.ts', newName: 'a.ts' })).toThrow(WorkspaceError);
    expect(deleteFsEntry(projA, { path: 'src/b.ts' })).toEqual({ path: 'src/b.ts', kind: 'file' });
    expect(fs.existsSync(path.join(projA, 'src', 'b.ts'))).toBe(false);
    expect(() => deleteFsEntry(projA, { path: '' })).toThrow(WorkspaceError);
    expect(() => deleteFsEntry(projA, { path: '../outside' })).toThrow(WorkspaceError);
  });
});
