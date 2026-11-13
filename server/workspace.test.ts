import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_TEXT_BYTES, WorkspaceError, discardFile, listAllFiles, listChanges, listTree, readDiff, readFileEntry, resolveProjectPath, resolveRawImage, writeFileEntry,
} from './workspace.ts';
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

afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveProjectPath security boundaries', () => {
  it('resolves valid relative paths and blocks traversal, UNC, absolute paths, .git, and external junctions', () => {
    const root = makeTempDir('sec');
    const outside = makeTempDir('outside');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');

    const ok = resolveProjectPath(root, 'src\\index.ts');
    expect(ok.relPosix).toBe('src/index.ts');

    expect(() => resolveProjectPath(root, '../outside/secret.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, 'src/../../outside/secret.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, '\\\\evil\\share\\a.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, path.join(outside, 'secret.txt'))).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, '.git/config')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, '.GIT\\HEAD')).toThrow(WorkspaceError);

    // Directory junction pointing outside project root (works on Windows without admin rights)
    const linkDir = path.join(root, 'linked-out');
    fs.symlinkSync(outside, linkDir, 'junction');
    expect(() => resolveProjectPath(root, 'linked-out/secret.txt')).toThrow(WorkspaceError);
    expect(() => resolveProjectPath(root, 'linked-out/new-file.txt')).toThrow(WorkspaceError);
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

    // Ctrl+P listAllFiles includes gitignored .env and src/main.ts, excludes node_modules
    const all = await listAllFiles(repo);
    expect(all.files).toContain('.env');
    expect(all.files).toContain('src/main.ts');
    expect(all.files.some((f) => f.startsWith('node_modules/'))).toBe(false);

    expect(readFileEntry(repo, 'logo.png').kind).toBe('image');
    expect(resolveRawImage(repo, 'logo.png').mime).toBe('image/png');
    expect(() => resolveRawImage(repo, 'src/main.ts')).toThrow(WorkspaceError);
    expect(readFileEntry(repo, 'bin.dat').kind).toBe('binary');
    expect(readFileEntry(repo, 'huge.log').kind).toBe('too_large');
  });

  it('parses terminal file links and matches deepest in-project files while leaving external/exe links untouched', () => {
    expect(parseLocalFileLink('file:///G:/Workspace/app/src/%E4%B8%AD%E6%96%87.ts#L12C3')).toEqual({
      winPath: 'G:\\Workspace\\app\\src\\中文.ts',
      line: 12,
      col: 3,
    });
    expect(parseLocalFileLink('G:\\Workspace\\app\\src\\auth.ts:42:5')).toEqual({
      winPath: 'G:\\Workspace\\app\\src\\auth.ts',
      line: 42,
      col: 5,
    });
    expect(parseLocalFileLink('\\\\evil-host\\share\\a.ts')).toBeNull();

    const projects = [
      { id: 'p-outer', name: 'outer', path: 'G:\\Workspace', createdAt: 1 },
      { id: 'p-inner', name: 'inner', path: 'G:\\Workspace\\app', createdAt: 2 },
    ];
    const hit = matchProjectFileLink('G:\\Workspace\\app\\src\\auth.ts:42:5', projects);
    expect(hit?.project.id).toBe('p-inner');
    expect(hit?.relPosix).toBe('src/auth.ts');
    expect(hit?.line).toBe(42);
    expect(hit?.col).toBe(5);

    // Executables, .git internals, and outside paths return null so /api/open handles them
    expect(matchProjectFileLink('G:\\Workspace\\app\\tool.exe', projects)).toBeNull();
    expect(matchProjectFileLink('G:\\Workspace\\app\\.git\\config', projects)).toBeNull();
    expect(matchProjectFileLink('C:\\Temp\\random.ts#L3', projects)).toBeNull();
  });
});
