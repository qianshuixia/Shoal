import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findEditor, OpenError, openAction, resolveOpenTarget, runOpen } from './open.ts';

let dir: string;
let ts: string; // <dir>\带 空格 中文.ts
let plain: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-open-'));
  ts = path.join(dir, '带 空格 中文.ts');
  plain = path.join(dir, 'a.ts');
  fs.writeFileSync(ts, 'x');
  fs.writeFileSync(plain, 'x');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// These tests describe Windows behaviour; the ones that touch the real filesystem need Windows paths, so they only run on win32.
const notWindows = process.platform !== 'win32';

const fail = (target: string): OpenError => {
  try {
    resolveOpenTarget(target, 'win32');
  } catch (e) {
    expect(e).toBeInstanceOf(OpenError);
    return e as OpenError;
  }
  throw new Error(`expected ${target} to be rejected`);
};

describe('resolveOpenTarget', () => {
  it.skipIf(notWindows)('resolves a file URI, decoding percent-encoded Chinese and spaces', () => {
    const uri = pathToFileURL(ts).href;
    expect(uri).toContain('%');
    expect(resolveOpenTarget(uri)).toEqual({ path: ts });
  });

  it.skipIf(notWindows)('accepts file://localhost/ and a bare path with either slash', () => {
    expect(resolveOpenTarget(pathToFileURL(plain).href.replace('file:///', 'file://localhost/'))).toEqual({ path: plain });
    expect(resolveOpenTarget(plain)).toEqual({ path: plain });
    expect(resolveOpenTarget(plain.replaceAll('\\', '/'))).toEqual({ path: plain });
  });

  it.skipIf(notWindows)('takes line and column from a fragment, a colon suffix, or a hash suffix when the full path does not exist', () => {
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}#L12`)).toEqual({ path: plain, line: 12 });
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}#L12C3`)).toEqual({ path: plain, line: 12, col: 3 });
    expect(resolveOpenTarget(`${plain}:12`)).toEqual({ path: plain, line: 12 });
    expect(resolveOpenTarget(`${plain}:12:3`)).toEqual({ path: plain, line: 12, col: 3 });
    expect(resolveOpenTarget(`${plain}#L7C2`)).toEqual({ path: plain, line: 7, col: 2 });
    expect(resolveOpenTarget(`${pathToFileURL(plain).href}:12:3`)).toEqual({ path: plain, line: 12, col: 3 });
  });

  it.skipIf(notWindows)('prefers the full path over stripping a suffix when it exists', () => {
    const odd = path.join(dir, 'odd#L5');
    fs.writeFileSync(odd, 'x');
    expect(resolveOpenTarget(odd)).toEqual({ path: odd });
  });

  it.skipIf(notWindows)('resolves a directory', () => {
    expect(resolveOpenTarget(dir)).toEqual({ path: dir });
  });

  it.skipIf(notWindows)('404s on a missing file, naming the path', () => {
    const missing = path.join(dir, 'nope.ts');
    const e = fail(missing);
    expect(e.status).toBe(404);
    expect(e.message).toBe(`文件不存在：${missing}`);
    expect(fail(`${missing}:3`).status).toBe(404);
  });

  it('400s on UNC, remote host, relative paths, other schemes and junk', () => {
    expect(fail('\\\\host\\share\\a.ts').status).toBe(400);
    expect(fail('//host/share/a.ts').status).toBe(400);
    expect(fail('file://host/share/a.ts').status).toBe(400);
    expect(fail('file:////host/share/a.ts').status).toBe(400);
    expect(fail('src/a.ts').status).toBe(400);
    expect(fail('.\\a.ts').status).toBe(400);
    expect(fail('C:a.ts').status).toBe(400);
    expect(fail('/etc/passwd').status).toBe(400);
    expect(fail('ftp://x/a').status).toBe(400);
    expect(fail('javascript:alert(1)').status).toBe(400);
    expect(fail('file:///a/b').status).toBe(400);
    expect(fail('  ').status).toBe(400);
  });
});

describe('openAction', () => {
  const editor = 'D:\\VS\\Code.exe';
  const at = (p: string, line?: number, col?: number) => ({ path: p, ...(line && { line }), ...(col && { col }) });

  it('opens directories in Explorer', () => {
    expect(openAction(at('C:\\d'), true, editor, 'win32')).toEqual({ kind: 'dir', cmd: 'explorer.exe', args: ['C:\\d'] });
  });

  it('opens images, pdf and html with the default program', () => {
    for (const ext of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'html', 'htm']) {
      expect(openAction(at(`C:\\d\\a.${ext}`), false, editor, 'win32')).toEqual({ kind: 'default', cmd: 'explorer.exe', args: [`C:\\d\\a.${ext}`] });
    }
  });

  it('only selects binaries and shortcuts, even with an editor', () => {
    for (const ext of ['exe', 'com', 'msi', 'lnk', 'url', 'scr', 'cpl', 'dll', 'sys', 'appref-ms', 'EXE']) {
      expect(openAction(at(`C:\\d\\a.${ext}`, 3), false, editor, 'win32')).toEqual({ kind: 'select', cmd: 'explorer.exe', args: [`/select,"C:\\d\\a.${ext}"`], verbatim: true });
    }
  });

  it('opens code files in the editor, with --goto when there is a line', () => {
    expect(openAction(at('C:\\d\\a.ts'), false, editor, 'win32')).toEqual({ kind: 'editor', cmd: editor, args: ['C:\\d\\a.ts'] });
    expect(openAction(at('C:\\d\\a.ts', 12), false, editor, 'win32').args).toEqual(['--goto', 'C:\\d\\a.ts:12']);
    expect(openAction(at('C:\\d\\a.bat', 12, 3), false, editor, 'win32')).toEqual({ kind: 'editor', cmd: editor, args: ['--goto', 'C:\\d\\a.bat:12:3'] });
    for (const ext of ['cmd', 'ps1', 'js', 'py', 'md', 'json', 'noext']) {
      expect(openAction(at(`C:\\d\\a.${ext}`), false, editor, 'win32').kind).toBe('editor');
    }
  });

  it('falls back to selecting the file without an editor', () => {
    expect(openAction(at('C:\\d\\a.ts', 12), false, null, 'win32')).toEqual({ kind: 'select', cmd: 'explorer.exe', args: ['/select,"C:\\d\\a.ts"'], verbatim: true });
  });
});

describe('findEditor and runOpen', () => {
  it('prefers WORKBENCH_EDITOR', () => {
    expect(findEditor({ WORKBENCH_EDITOR: 'X:\\e.exe', PATH: '' }, 'win32')).toBe('X:\\e.exe');
  });

  it.skipIf(notWindows)('finds Code.exe next to bin\\code.cmd on PATH, never the .cmd', () => {
    const root = path.join(dir, 'vs');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'code.cmd'), '');
    expect(findEditor({ PATH: path.join(root, 'bin') })).toBeNull();
    fs.writeFileSync(path.join(root, 'Code.exe'), '');
    expect(findEditor({ PATH: `C:\\nowhere;${path.join(root, 'bin')}` })).toBe(path.join(root, 'Code.exe'));
  });

  it('logs instead of spawning when WORKBENCH_OPEN_LOG is set', () => {
    const log = path.join(dir, 'log', 'open.jsonl');
    runOpen({ kind: 'select', cmd: 'explorer.exe', args: ['/select,C:\\a'] }, { WORKBENCH_OPEN_LOG: log });
    runOpen({ kind: 'dir', cmd: 'explorer.exe', args: ['C:\\b'] }, { WORKBENCH_OPEN_LOG: log });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ cmd: 'explorer.exe', args: ['/select,C:\\a'] }, { cmd: 'explorer.exe', args: ['C:\\b'] }]);
  });
});

describe('macOS / POSIX open', () => {
  // On a Windows host a rooted path resolves against the current drive, so build one for a file that exists there.
  const rooted = (p: string) => (process.platform === 'win32' ? p.slice(2).replaceAll('\\', '/') : p);
  const pkg = path.join(process.cwd(), 'package.json');
  const failMac = (target: string): OpenError => {
    try {
      resolveOpenTarget(target, 'darwin');
    } catch (e) {
      expect(e).toBeInstanceOf(OpenError);
      return e as OpenError;
    }
    throw new Error(`expected ${target} to be rejected`);
  };

  it('resolves absolute paths and file URLs, with line and column suffixes', () => {
    const p = rooted(pkg);
    expect(resolveOpenTarget(p, 'darwin')).toEqual({ path: p });
    expect(resolveOpenTarget(`${p}:12:3`, 'darwin')).toEqual({ path: p, line: 12, col: 3 });
    expect(resolveOpenTarget(`${p}#L7C2`, 'darwin')).toEqual({ path: p, line: 7, col: 2 });
    expect(resolveOpenTarget(`file://${p}#L5`, 'darwin')).toEqual({ path: p, line: 5 });
    expect(resolveOpenTarget(`file://localhost${p}`, 'darwin')).toEqual({ path: p });
    expect(resolveOpenTarget(`${path.posix.dirname(p)}/../${path.posix.basename(path.posix.dirname(p))}/package.json`, 'darwin')).toEqual({ path: p });
  });

  it('decodes percent-encoded file URL paths and 404s with the POSIX path', () => {
    const e = failMac('file:///Users/me/%E4%B8%AD%E6%96%87%20a.ts');
    expect(e.status).toBe(404);
    expect(e.message).toBe('文件不存在：/Users/me/中文 a.ts');
  });

  it('400s on //, remote hosts, relative paths and Windows drive paths, with a neutral message', () => {
    expect(failMac('//host/share/a.ts').status).toBe(400);
    expect(failMac('file://host/a.ts').status).toBe(400);
    expect(failMac('file:////host/a.ts').status).toBe(400);
    expect(failMac('src/a.ts').status).toBe(400);
    expect(failMac('C:\\a.ts').status).toBe(400);
    expect(failMac('ftp://x/a').status).toBe(400);
    expect(failMac('src/a.ts').message).toBe('只支持 file: 链接和绝对路径：src/a.ts');
  });

  const at = (p: string, line?: number, col?: number) => ({ path: p, ...(line && { line }), ...(col && { col }) });
  const code = '/usr/local/bin/code';

  it('macOS: open for dirs and default types, open -R for programs, installers and .command', () => {
    expect(openAction(at('/d'), true, code, 'darwin')).toEqual({ kind: 'dir', cmd: 'open', args: ['/d'] });
    expect(openAction(at('/d/a.PNG'), false, code, 'darwin')).toEqual({ kind: 'default', cmd: 'open', args: ['/d/a.PNG'] });
    for (const ext of ['exe', 'app', 'command', 'tool', 'terminal', 'pkg', 'mpkg', 'dmg', 'scpt', 'applescript', 'workflow', 'jar', 'COMMAND']) {
      expect(openAction(at(`/d/a.${ext}`, 3), false, code, 'darwin')).toEqual({ kind: 'select', cmd: 'open', args: ['-R', `/d/a.${ext}`] });
    }
    expect(openAction(at('/d/a.ts'), false, null, 'darwin')).toEqual({ kind: 'select', cmd: 'open', args: ['-R', '/d/a.ts'] });
  });

  it('macOS: bundle directories are only revealed, never opened', () => {
    for (const ext of ['app', 'bundle', 'framework', 'pkg', 'mpkg', 'prefPane', 'workflow']) {
      expect(openAction(at(`/Applications/Foo.${ext}`), true, code, 'darwin')).toEqual({ kind: 'select', cmd: 'open', args: ['-R', `/Applications/Foo.${ext}`] });
    }
    expect(openAction(at('/Applications/Foo'), true, code, 'darwin').kind).toBe('dir');
  });

  it('macOS and Linux: code files go to the editor, with --goto when there is a line', () => {
    expect(openAction(at('/d/a.ts'), false, code, 'darwin')).toEqual({ kind: 'editor', cmd: code, args: ['/d/a.ts'] });
    expect(openAction(at('/d/a.ts', 12, 3), false, code, 'linux')).toEqual({ kind: 'editor', cmd: code, args: ['--goto', '/d/a.ts:12:3'] });
  });

  it('Linux: xdg-open, and select opens the containing folder', () => {
    expect(openAction(at('/d'), true, code, 'linux')).toEqual({ kind: 'dir', cmd: 'xdg-open', args: ['/d'] });
    expect(openAction(at('/d/a.pdf'), false, code, 'linux')).toEqual({ kind: 'default', cmd: 'xdg-open', args: ['/d/a.pdf'] });
    expect(openAction(at('/d/a.ts'), false, null, 'linux')).toEqual({ kind: 'select', cmd: 'xdg-open', args: ['/d'] });
  });

  it('findEditor on macOS: WORKBENCH_EDITOR, then an executable code on PATH, else null', () => {
    expect(findEditor({ WORKBENCH_EDITOR: '/x/code' }, 'darwin')).toBe('/x/code');
    const bin = path.join(dir, 'macbin');
    fs.mkdirSync(bin, { recursive: true });
    // A Mac with VS Code installed falls back to the app bundle's CLI when `code` is not on PATH.
    expect([null, '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']).toContain(findEditor({ PATH: bin }, 'darwin'));
    fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findEditor({ PATH: `${path.join(dir, 'none')}${path.delimiter}${bin}` }, 'darwin')).toBe(path.posix.join(bin, 'code'));
  });
});
