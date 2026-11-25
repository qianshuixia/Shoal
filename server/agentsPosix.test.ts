import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexLaunch, codexLaunchFor, resolveAgy, resolveClaude, resolveCodex } from './agents.ts';

// Fake home and PATH dir with executables; the platform is injected, never process.platform.
let root: string;
let home: string;
let bin: string;
const touch = (p: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
  home = path.join(root, 'home');
  bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = (PATH: string) => ({ platform: 'darwin' as const, env: { PATH }, home, delimiter: path.delimiter });

describe('POSIX CLI resolution', () => {
  it('finds nothing in an empty PATH and a home without the CLIs', () => {
    const c = { platform: 'darwin' as const, env: { PATH: path.join(root, 'empty') }, home: path.join(root, 'nohome'), delimiter: path.delimiter };
    expect(resolveAgy(c)).toBeNull();
  });

  it('falls back to ~/.local/bin for claude and agy', () => {
    touch(path.join(home, '.local', 'bin', 'claude'));
    touch(path.join(home, '.local', 'bin', 'agy'));
    expect(resolveClaude(ctx(''))).toBe(path.posix.join(home, '.local', 'bin', 'claude'));
    expect(resolveAgy(ctx(''))).toBe(path.posix.join(home, '.local', 'bin', 'agy'));
  });

  it('tries ~/.claude/local/claude when ~/.local/bin has none', () => {
    const h2 = path.join(root, 'home2');
    touch(path.join(h2, '.claude', 'local', 'claude'));
    expect(resolveClaude({ platform: 'darwin', env: { PATH: '' }, home: h2, delimiter: path.delimiter })).toBe(path.posix.join(h2, '.claude', 'local', 'claude'));
  });

  it('prefers an executable on PATH over the fallbacks', () => {
    touch(path.join(bin, 'claude'));
    expect(resolveClaude(ctx(bin))).toBe(path.posix.join(bin, 'claude'));
  });

  it('finds codex on PATH', () => {
    touch(path.join(bin, 'codex'));
    expect(resolveCodex(ctx(bin))).toBe(path.posix.join(bin, 'codex'));
  });
});

describe('codex launch', () => {
  it('runs a native binary directly', () => {
    const exe = path.join(root, 'native', 'codex');
    touch(exe);
    expect(codexLaunchFor(exe)).toEqual({ file: exe, prefix: [] });
  });

  it('runs a version-manager shim by its own path, not the binary it links to', (t) => {
    const shim = path.join(root, 'volta', 'volta-shim');
    touch(shim);
    const link = path.join(root, 'volta', 'bin', 'codex');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(shim, link);
    } catch {
      t.skip(); // no symlink privilege on this machine
      return;
    }
    expect(codexLaunchFor(link)).toEqual({ file: link, prefix: [] });
  });

  it('runs a .js entry point on the bundled Node (no symlink needed)', () => {
    const js = path.join(root, 'pkg', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, '');
    expect(codexLaunchFor(js)).toEqual({ file: process.execPath, prefix: [fs.realpathSync(js)] });
  });

  it('follows a symlink to codex.js like an npm global install', (t) => {
    const js = path.join(root, 'npm', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(js), { recursive: true });
    // npm marks a bin entry executable, and PATH lookup only takes an executable target.
    fs.writeFileSync(js, '', { mode: 0o755 });
    const link = path.join(root, 'npmbin', 'codex');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(js, link);
    } catch {
      t.skip(); // no symlink privilege on this machine
      return;
    }
    expect(codexLaunch(ctx(path.dirname(link)))).toEqual({ file: process.execPath, prefix: [fs.realpathSync(js)] });
  });

  it('keeps the Windows launch unchanged when default APPDATA codex.js is used, and falls back to PATH custom-prefix codex.cmd', () => {
    const emptyAppData = path.join(root, 'empty-appdata');
    fs.mkdirSync(emptyAppData, { recursive: true });
    const fallback = codexLaunch({ platform: 'win32', env: { APPDATA: emptyAppData, PATH: '' }, home: emptyAppData });
    expect(fallback.file).toBe(process.execPath);
    expect(fallback.prefix).toEqual([path.join(emptyAppData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);

    // Custom npm prefix under a spaced directory (e.g. D:\Program Files\nodejs\codex.cmd)
    const customPrefix = path.join(root, 'Program Files', 'nodejs');
    const customJs = path.join(customPrefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(customJs), { recursive: true });
    fs.writeFileSync(customJs, '');
    const customCmd = path.join(customPrefix, 'codex.cmd');
    fs.writeFileSync(customCmd, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

    const customEnv = { platform: 'win32' as const, env: { APPDATA: emptyAppData, PATH: customPrefix }, home: emptyAppData };
    expect(resolveCodex(customEnv)).toBe(customCmd);
    expect(codexLaunch(customEnv)).toEqual({ file: process.execPath, prefix: [customJs] });
  });
});
