import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adoptLoginShellEnv, defaultStateDir, findExecutable, loginShellPath, mergePath } from './platform.ts';

describe('defaultStateDir', () => {
  it('macOS: ~/Library/Application Support/Shoal', () => {
    expect(defaultStateDir({}, 'darwin', '/Users/me')).toBe('/Users/me/Library/Application Support/Shoal');
  });

  it('Linux: $XDG_DATA_HOME/Shoal, else ~/.local/share/Shoal', () => {
    expect(defaultStateDir({ XDG_DATA_HOME: '/x/data' }, 'linux', '/home/me')).toBe('/x/data/Shoal');
    expect(defaultStateDir({}, 'linux', '/home/me')).toBe('/home/me/.local/share/Shoal');
  });

  describe('Windows', () => {
    let base: string;
    beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sd-')); });
    afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

    it('uses Shoal, falling back to the pre-rename agent-workbench folder until Shoal has a state.json', () => {
      const env = { LOCALAPPDATA: base };
      expect(defaultStateDir(env, 'win32')).toBe(path.join(base, 'Shoal'));
      fs.mkdirSync(path.join(base, 'agent-workbench'));
      expect(defaultStateDir(env, 'win32')).toBe(path.join(base, 'agent-workbench'));
      fs.mkdirSync(path.join(base, 'Shoal'));
      fs.writeFileSync(path.join(base, 'Shoal', 'state.json'), '{}');
      expect(defaultStateDir(env, 'win32')).toBe(path.join(base, 'Shoal'));
    });
  });
});

describe('mergePath', () => {
  it('puts shell entries first, then entries only the current PATH has, then extras, without duplicates', () => {
    expect(mergePath('/a:/b:/c', '/usr/bin:/b:/bin', ['/opt/homebrew/bin', '/a'])).toBe('/a:/b:/c:/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('drops empty entries and works with an empty shell PATH', () => {
    expect(mergePath('', '/usr/bin::/bin', [])).toBe('/usr/bin:/bin');
    expect(mergePath('/a::/b', '', ['/c'], ':')).toBe('/a:/b:/c');
  });

  it('supports another delimiter', () => {
    expect(mergePath('C:\\a;C:\\b', 'C:\\b;C:\\c', [], ';')).toBe('C:\\a;C:\\b;C:\\c');
  });
});

describe('findExecutable', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fe-'));
    fs.mkdirSync(path.join(dir, 'asdir'));
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds a regular file on PATH, skipping missing dirs, directories and empty entries', () => {
    const PATH = ['', path.join(dir, 'nope'), dir].join(path.delimiter);
    expect(findExecutable('tool', { PATH }, 'darwin', path.delimiter)).toBe(path.posix.join(dir, 'tool'));
    expect(findExecutable('asdir', { PATH }, 'darwin', path.delimiter)).toBeNull();
    expect(findExecutable('missing', { PATH }, 'darwin', path.delimiter)).toBeNull();
    expect(findExecutable('tool', {}, 'darwin')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('ignores files without the execute bit', () => {
    fs.writeFileSync(path.join(dir, 'plain'), 'x', { mode: 0o644 });
    expect(findExecutable('plain', { PATH: dir }, 'linux')).toBeNull();
  });
});

describe('adoptLoginShellEnv', () => {
  it('does nothing off macOS', async () => {
    const before = process.env.PATH;
    await adoptLoginShellEnv(5000, 'linux');
    expect(process.env.PATH).toBe(before);
  });
});

// Fake login shells: called as `shell -ilc <command>`, like the real one.
describe.skipIf(process.platform === 'win32')('loginShellPath', () => {
  let dir: string;
  const shell = (name: string, ...lines: string[]) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
    return p;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ls-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Startup noise around the markers, PATH from the environment with its colons.
  const chatty = () => shell('chatty', 'echo "Last login: today"', 'export PATH="/x/a:/x/b:$PATH"', 'shift', 'exec /bin/sh -c "$1"');

  it('reads PATH between the markers, ignoring startup output', async () => {
    expect(await loginShellPath(chatty(), 5000)).toMatch(/^\/x\/a:\/x\/b:/);
  });

  it('answers once the shell exits even if a job it left in the background holds stdout, and leaves that job alone', async () => {
    const pidFile = path.join(dir, 'bg.pid');
    const bg = shell('bg', 'sleep 30 &', `echo $! > '${pidFile}'`, 'shift', 'exec /bin/sh -c "$1"');
    const t0 = Date.now();
    try {
      expect(await loginShellPath(bg, 10000)).toMatch(/\//);
      expect(Date.now() - t0).toBeLessThan(3000);
      // The shell is gone and its group ID may be reused: nothing is signalled after the exit.
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('gives up after the timeout even if the shell ignores SIGTERM, and kills what it started', async () => {
    const pidFile = path.join(dir, 'sleep.pid');
    const hung = shell('hung', "trap '' TERM", 'sleep 30 &', `echo $! > '${pidFile}'`, 'wait');
    const t0 = Date.now();
    // Long enough for a slow runner to start the shell and write the pid file.
    expect(await loginShellPath(hung, 1000)).toBe('');
    expect(Date.now() - t0).toBeLessThan(4000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a SIGTERM mid-probe kills the shell group and still ends the process', async () => {
    const pidFile = path.join(dir, 'sleep2.pid');
    const hung = shell('hung2', "trap '' TERM", 'sleep 30 &', `echo $! > '${pidFile}'`, 'wait');
    const mod = pathToFileURL(path.join(import.meta.dirname, 'platform.ts')).href;
    const node = spawn(process.execPath, ['--input-type=module', '-e',
      `const { loginShellPath } = await import(${JSON.stringify(mod)}); await loginShellPath(${JSON.stringify(hung)}, 20000);`]);
    const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')); } catch { return 0; } };
    for (let i = 0; i < 100 && !readPid(); i++) await new Promise(r => setTimeout(r, 50));
    const sleepPid = readPid();
    expect(sleepPid).toBeGreaterThan(0);
    const t0 = Date.now();
    const exited = new Promise<NodeJS.Signals | null>(r => node.on('exit', (_code, sig) => r(sig)));
    node.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(Date.now() - t0).toBeLessThan(3000);
    await new Promise(r => setTimeout(r, 200));
    expect(() => process.kill(sleepPid, 0)).toThrow();
  });

  it('returns empty for a missing shell or one that prints no PATH', async () => {
    expect(await loginShellPath(path.join(dir, 'nope'), 5000)).toBe('');
    expect(await loginShellPath(shell('mute', 'echo hello', 'exit 3'), 5000)).toBe('');
  });

  it('macOS: puts the login shell PATH first', async () => {
    const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL, LANG: process.env.LANG };
    try {
      process.env.SHELL = chatty();
      await adoptLoginShellEnv(5000, 'darwin');
      expect(process.env.PATH).toMatch(/^\/x\/a:\/x\/b:/);
      expect(process.env.PATH!.split(':')).toContain('/usr/bin');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

it('loginShellPath returns empty when the shell cannot even be spawned', async () => {
  // A NUL in the path makes spawn() throw synchronously, before any timer exists.
  expect(await loginShellPath('/bin/sh\0', 1000)).toBe('');
});
