import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isValidCustomCliId, parseCliArgs } from '../shared/protocol.ts';
import type { Settings, Snapshot } from '../shared/protocol.ts';
import { buildLaunch, FULL_ACCESS } from './agents.ts';
import {
  buildCliTools,
  buildSafeProcessLaunch,
  delegatableAgentsFrom,
  effectivePermissionMode,
  enabledAgentsFrom,
  findExecutableWin,
  isCmdBatchPath,
  unwrapNpmCmdShim,
  validateCliPrefsPatch,
  validateCustomClis,
} from './cliRegistry.ts';
import { createApp } from './http.ts';
import { sanitizeServerMsgForMobile, sanitizeSnapshotForMobile } from './mobile.ts';
import { SessionManager } from './sessions.ts';
import { reduceStatus } from './status.ts';
import { createFileStore, createMemoryStore } from './store.ts';
import { createUsage } from './usage.ts';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-cli-reg-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('cliRegistry validation & parsing', () => {
  it('validates custom CLI ids and rejects reserved / prototype keys', () => {
    expect(isValidCustomCliId('my-cli')).toBe(true);
    expect(isValidCustomCliId('a_123')).toBe(true);
    expect(isValidCustomCliId('claude')).toBe(false);
    expect(isValidCustomCliId('kimi')).toBe(false);
    expect(isValidCustomCliId('fake')).toBe(false);
    expect(isValidCustomCliId('__proto__')).toBe(false);
    expect(isValidCustomCliId('constructor')).toBe(false);
    expect(isValidCustomCliId('prototype')).toBe(false);
    expect(isValidCustomCliId('1abc')).toBe(false);
    expect(isValidCustomCliId('MyCLI')).toBe(false);
  });

  it('parses quoted CLI argument strings cleanly', () => {
    expect(parseCliArgs('--yolo --model "gpt 5" --tag=\'v1\'')).toEqual(['--yolo', '--model', 'gpt 5', '--tag=v1']);
    expect(parseCliArgs('   ')).toEqual([]);
  });

  it('rejects .ps1 commands, control characters, and duplicate custom ids', () => {
    expect(() => validateCustomClis([{ id: 'my-ps', label: 'PS', command: 'C:\\a\\foo.ps1' }])).toThrow(/\.ps1/);
    expect(() => validateCustomClis([{ id: 'my-bad', label: 'Bad', command: 'foo\nbar' }])).toThrow();
    expect(() => validateCustomClis([
      { id: 'dup-cli', label: 'A', command: 'a' },
      { id: 'dup-cli', label: 'B', command: 'b' },
    ])).toThrow(/重复/);
    expect(() => validateCliPrefsPatch(JSON.parse('{"__proto__":{"enabled":true}}'))).toThrow();
    expect(() => validateCliPrefsPatch({ constructor: { enabled: true } })).toThrow();
    expect(() => validateCliPrefsPatch({ claude: { permissionMode: 'invalid' } })).toThrow();
  });
});

describe('Windows executable resolution & BatBadBut protection', () => {
  it('prefers .exe over .cmd and never picks .ps1', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'onlyps.ps1'), 'echo hi');
    fs.writeFileSync(path.join(dir, 'both.cmd'), '@echo off');
    fs.writeFileSync(path.join(dir, 'both.exe'), 'MZ');

    const env = { PATH: dir };
    expect(findExecutableWin('onlyps', env, dir)).toBeNull();
    expect(findExecutableWin('both', env, dir)).toBe(path.join(dir, 'both.exe'));
  });

  it('unwraps standard npm .cmd shims to direct Node execution (zero cmd.exe)', () => {
    const dir = makeTmpDir();
    const jsDir = path.join(dir, 'node_modules', '@google', 'gemini-cli', 'dist');
    fs.mkdirSync(jsDir, { recursive: true });
    const jsPath = path.join(jsDir, 'index.js');
    fs.writeFileSync(jsPath, 'console.log("ok")');
    const cmdPath = path.join(dir, 'gemini.cmd');
    fs.writeFileSync(cmdPath, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n`);

    expect(unwrapNpmCmdShim(cmdPath)).toBe(jsPath);
    expect(isCmdBatchPath(cmdPath, 'win32')).toBe(false);

    const launch = buildSafeProcessLaunch(cmdPath, ['--yolo', 'fix & test "quoted"'], 'win32');
    expect(launch.file).toBe(process.execPath);
    expect(launch.args).toEqual([jsPath, '--yolo', 'fix & test "quoted"']);
  });

  it('blocks shell metacharacters and uses verbatim cmd.exe quoting for non-npm .cmd scripts', () => {
    const dir = makeTmpDir();
    const cmdPath = path.join(dir, 'raw tool.cmd');
    fs.writeFileSync(cmdPath, '@echo off\r\necho raw\r\n');

    expect(unwrapNpmCmdShim(cmdPath)).toBeNull();
    expect(isCmdBatchPath(cmdPath, 'win32')).toBe(true);

    const ok = buildSafeProcessLaunch(cmdPath, ['--flag', 'plain value'], 'win32');
    expect(ok.file.toLowerCase()).toContain('cmd.exe');
    expect(ok.args).toBe(`/d /s /c ""${cmdPath}" --flag "plain value""`);

    expect(() => buildSafeProcessLaunch(cmdPath, ['foo&calc'], 'win32')).toThrow(/不安全字符/);
    expect(() => buildSafeProcessLaunch(cmdPath, ['foo|bar'], 'win32')).toThrow(/不安全字符/);
  });
});

describe('buildLaunch permission modes (full vs normal) & generic CLIs', () => {
  it('omits FULL_ACCESS flags in normal mode and keeps them by default / full mode', () => {
    const stateDir = makeTmpDir();
    for (const agent of ['claude', 'codex', 'agy'] as const) {
      const def = buildLaunch({ agent, sessionId: 's1', prompt: 'hi', stateDir });
      expect(def.args).toContain(FULL_ACCESS[agent]);

      const full = buildLaunch({ agent, sessionId: 's2', prompt: 'hi', stateDir, permissionMode: 'full' });
      expect(full.args).toContain(FULL_ACCESS[agent]);

      const normal = buildLaunch({ agent, sessionId: 's3', prompt: 'hi', stateDir, permissionMode: 'normal' });
      expect(normal.args).not.toContain(FULL_ACCESS[agent]);
      expect(normal.args.join(' ')).not.toContain('--dangerously');
    }
  });

  it('launches generic/custom CLIs with fullAccessArgs vs normalArgs and respects promptArg', () => {
    const stateDir = makeTmpDir();
    const fakeBin = path.join(stateDir, 'my-agent.exe');
    fs.writeFileSync(fakeBin, 'MZ');

    const full = buildLaunch({
      agent: 'my-agent',
      sessionId: 's1',
      prompt: 'hello',
      stateDir,
      permissionMode: 'full',
      cliMeta: {
        path: fakeBin,
        command: 'my-agent',
        fullAccessArgs: ['--auto'],
        normalArgs: ['--safe'],
        promptArg: 'positional',
      },
    });
    expect(full.file).toBe(fakeBin);
    expect(full.args).toEqual(['--auto', 'hello']);

    const normal = buildLaunch({
      agent: 'my-agent',
      sessionId: 's2',
      prompt: 'hello',
      stateDir,
      permissionMode: 'normal',
      cliMeta: {
        path: fakeBin,
        command: 'my-agent',
        fullAccessArgs: ['--auto'],
        normalArgs: ['--safe'],
        promptArg: 'none',
      },
    });
    expect(normal.file).toBe(fakeBin);
    expect(normal.args).toEqual(['--safe']);
  });
});

describe('CLI enablement defaults, status machine, store persistence & mobile redaction', () => {
  it('defaults generic built-ins to disabled + full permission, custom CLIs to enabled + full, and excludes generic CLIs from delegation', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'kimi.exe'), 'MZ');
    fs.writeFileSync(path.join(dir, 'mycli.exe'), 'MZ');

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      customClis: [{ id: 'mycli', label: 'My CLI', command: path.join(dir, 'mycli.exe'), fullAccessArgs: ['--yolo'] }],
    };
    const tools = buildCliTools(settings, { platform: 'win32', env: { PATH: dir }, home: dir });
    const kimi = tools.find((t) => t.id === 'kimi')!;
    const custom = tools.find((t) => t.id === 'mycli')!;

    expect(kimi.installed).toBe(true);
    expect(kimi.tier).toBe('generic');
    expect(kimi.enabled).toBe(false);
    expect(kimi.permissionMode).toBe('full');

    expect(custom.installed).toBe(true);
    expect(custom.source).toBe('custom');
    expect(custom.enabled).toBe(true);
    expect(custom.permissionMode).toBe('full');

    const enabled = enabledAgentsFrom(settings, tools);
    expect(enabled).toContain('mycli');
    expect(enabled).not.toContain('kimi');
    expect(delegatableAgentsFrom(settings, tools)).not.toContain('mycli');

    const withKimi: Settings = { ...settings, cliPrefs: { kimi: { enabled: true, permissionMode: 'normal' } } };
    expect(effectivePermissionMode('kimi', withKimi.cliPrefs)).toBe('normal');
    const tools2 = buildCliTools(withKimi, { platform: 'win32', env: { PATH: dir }, home: dir });
    expect(enabledAgentsFrom(withKimi, tools2)).toContain('kimi');
    expect(delegatableAgentsFrom(withKimi, tools2)).not.toContain('kimi');
  });

  it('generic ready status transitions starting -> idle without marking needs_you', () => {
    expect(reduceStatus('starting', { type: 'ready' })).toBe('idle');
    expect(reduceStatus('idle', { type: 'ready' })).toBe('idle');
    expect(reduceStatus('exited', { type: 'ready' })).toBe('exited');
  });

  it('persists cliPrefs & customClis in store and deep-clones settings', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'state.json');
    const s1 = createFileStore(file);
    s1.setSettings({
      ...DEFAULT_SETTINGS,
      cliPrefs: { claude: { enabled: true, permissionMode: 'normal' } },
      customClis: [{ id: 'custom-a', label: 'Custom A', command: 'custom-a', fullAccessArgs: ['--yolo'], promptArg: 'none' }],
    });
    const copy = s1.settings();
    copy.cliPrefs!.claude.permissionMode = 'full';
    expect(s1.settings().cliPrefs?.claude.permissionMode).toBe('normal');

    const s2 = createFileStore(file);
    expect(s2.settings().cliPrefs?.claude.permissionMode).toBe('normal');
    expect(s2.settings().customClis?.[0].id).toBe('custom-a');
  });

  it('redacts local paths and custom CLI commands/args in mobile snapshot and WS messages', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      customClis: [{ id: 'mycli', label: 'My CLI', command: 'C:\\secret\\mycli.exe', normalArgs: ['--cfg', 'C:\\secret\\a.toml'], fullAccessArgs: ['--yolo'] }],
    };
    const snap = sanitizeSnapshotForMobile({
      projects: [],
      tasks: [],
      sessions: [],
      cards: [],
      agents: ['mycli'],
      cliTools: [{
        id: 'mycli',
        label: 'My CLI',
        tier: 'generic',
        source: 'custom',
        installed: true,
        usable: true,
        path: 'C:\\secret\\mycli.exe',
        command: 'C:\\secret\\mycli.exe',
        enabled: true,
        permissionMode: 'full',
        fullAccessArgs: ['--yolo'],
        normalArgs: ['--cfg', 'C:\\secret\\a.toml'],
        supportsFullAccessFlag: true,
        capabilities: [],
        promptArg: 'positional',
      }],
      settings,
      git: {},
      quota: {},
    });
    expect(snap.cliTools?.[0].path).toBeNull();
    expect(snap.cliTools?.[0].command).toBe('');
    expect(snap.cliTools?.[0].normalArgs).toEqual([]);
    expect(snap.settings.customClis?.[0].command).toBe('');
    expect(snap.settings.customClis?.[0].normalArgs).toBeUndefined();

    const wsMsg = sanitizeServerMsgForMobile({ t: 'settings', settings });
    expect(wsMsg.t).toBe('settings');
    if (wsMsg.t === 'settings') {
      expect(wsMsg.settings.customClis?.[0].command).toBe('');
      expect(wsMsg.settings.customClis?.[0].fullAccessArgs).toBeUndefined();
    }
  });
});

describe('HTTP integration: CLI scan, toggle, permission mode & parent-to-child delegation inheritance', () => {
  it('inherits parent permissionMode on delegation (even when child global setting differs) and blocks delegating to generic CLIs', async () => {
    const prevFake = process.env.WORKBENCH_FAKE_AGENT;
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const stateDir = makeTmpDir();
    const projDir = makeTmpDir();
    const customBin = path.join(stateDir, process.platform === 'win32' ? 'echo-cli.cmd' : 'echo-cli');
    fs.writeFileSync(customBin, process.platform === 'win32' ? '@echo off\r\necho ready\r\n' : '#!/bin/sh\necho ready\n', { mode: 0o755 });

    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });

    const store = createMemoryStore();
    const sessions = new SessionManager({ port, token: 'test-hook-token', stateDir });
    const usage = createUsage({ stateDir, source: store });
    const { server, mobile } = createApp({ port, token: 'test-hook-token', store, sessions, stateDir, usage });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1) Add a custom generic CLI + set fake to normal mode.
      const setRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cliPrefs: { fake: { enabled: true, permissionMode: 'normal' } },
          customClis: [{ id: 'my-echo', label: 'My Echo', command: customBin, fullAccessArgs: ['--auto'], promptArg: 'none' }],
        }),
      });
      expect(setRes.status).toBe(200);

      const clisRes = await fetch(`${base}/api/clis`);
      expect(clisRes.status).toBe(200);
      const clisBody = (await clisRes.json()) as { agents: string[]; cliTools: { id: string; enabled: boolean }[] };
      expect(clisBody.agents).toContain('fake');
      expect(clisBody.agents).toContain('my-echo');

      // 2) Create project & parent task in 'normal' mode.
      const proj = (await (await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'p', path: projDir }),
      })).json()) as { id: string };

      const created = (await (await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: proj.id, agent: 'fake', title: '主任务' }),
      })).json()) as { task: { id: string; permissionMode?: string }; session: { id: string; permissionMode?: string } };
      expect(created.task.permissionMode).toBe('normal');
      expect(created.session.permissionMode).toBe('normal');

      // 3) Now switch global fake setting to 'full' while parent is STILL running in 'normal' mode!
      await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliPrefs: { fake: { permissionMode: 'full' } } }),
      });

      // Extract parent's peerToken from SessionManager via internal map to invoke /api/peer/delegate.
      const peerToken = [...(sessions as unknown as { peerTokens: Map<string, string> }).peerTokens.entries()]
        .find(([, sid]) => sid === created.session.id)?.[0];
      expect(peerToken).toBeTruthy();

      // 4) Delegating to a generic custom CLI must fail cleanly with 400.
      const badDeleg = await fetch(`${base}/api/peer/delegate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${peerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'my-echo', note: 'try generic' }),
      });
      expect(badDeleg.status).toBe(400);
      expect((await badDeleg.json() as { error: string }).error).toContain('通用终端模式');

      // 5) Delegating to 'fake' (whose global setting is now 'full') MUST inherit parent's 'normal' mode!
      const okDeleg = await fetch(`${base}/api/peer/delegate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${peerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'fake', note: 'child work' }),
      });
      expect(okDeleg.status).toBe(200);
      const snap = (await (await fetch(`${base}/api/state`)).json()) as Snapshot;
      const childTask = snap.tasks.find((t) => t.delegation?.parentTaskId === created.task.id)!;
      const childSession = snap.sessions.find((s) => s.id === childTask.sessionId)!;
      expect(childTask.permissionMode).toBe('normal');
      expect(childSession.permissionMode).toBe('normal');
    } finally {
      await Promise.allSettled([mobile.close(), sessions.killAll()]);
      server.close();
      if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT;
      else process.env.WORKBENCH_FAKE_AGENT = prevFake;
    }
  }, 20_000);
});
