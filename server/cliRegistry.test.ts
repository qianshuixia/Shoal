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
  detectCustomCodex,
  effectivePermissionMode,
  enabledAgentsFrom,
  findExecutableWin,
  isCmdBatchPath,
  resolveCustomCodexHomes,
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

  it('unwraps custom-prefix codex.cmd (ignoring node.exe guard) and native .exe claude.cmd shims under spaced directories', () => {
    const root = makeTmpDir();
    const nodejsDir = path.join(root, 'Program Files', 'nodejs');
    const codexBin = path.join(nodejsDir, 'node_modules', '@openai', 'codex', 'bin');
    const claudeBin = path.join(nodejsDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    fs.mkdirSync(codexBin, { recursive: true });
    fs.mkdirSync(claudeBin, { recursive: true });

    fs.writeFileSync(path.join(nodejsDir, 'node.exe'), 'MZ');
    const codexJsPath = path.join(codexBin, 'codex.js');
    fs.writeFileSync(codexJsPath, 'console.log("codex")');
    const codexCmdPath = path.join(nodejsDir, 'codex.cmd');
    fs.writeFileSync(codexCmdPath, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join('\r\n'));

    const claudeExePath = path.join(claudeBin, 'claude.exe');
    fs.writeFileSync(claudeExePath, 'MZ');
    const claudeCmdPath = path.join(nodejsDir, 'claude.cmd');
    fs.writeFileSync(claudeCmdPath, [
      '@ECHO off',
      'SETLOCAL',
      'SET dp0=%~dp0',
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    ].join('\r\n'));

    expect(unwrapNpmCmdShim(codexCmdPath)).toBe(codexJsPath);
    expect(isCmdBatchPath(codexCmdPath, 'win32')).toBe(false);
    expect(unwrapNpmCmdShim(claudeCmdPath)).toBe(claudeExePath);
    expect(isCmdBatchPath(claudeCmdPath, 'win32')).toBe(false);

    const claudeLaunch = buildSafeProcessLaunch(claudeCmdPath, ['--append-system-prompt', 'line1\n"quoted" & ok'], 'win32');
    expect(claudeLaunch.file).toBe(claudeExePath);
    expect(claudeLaunch.args).toEqual(['--append-system-prompt', 'line1\n"quoted" & ok']);

    const codexBuilt = buildLaunch({
      agent: 'codex',
      sessionId: 's-custom-codex',
      prompt: 'hi',
      stateDir: root,
      cliMeta: {
        path: codexCmdPath,
        command: 'codex',
        normalArgs: [],
        fullAccessArgs: [FULL_ACCESS.codex],
        promptArg: 'positional',
      },
    });
    expect(codexBuilt.file).toBe(process.execPath);
    expect(codexBuilt.args[0]).toBe(codexJsPath);
    expect(codexBuilt.args.at(-1)).toBe('hi');

    // Native codex.exe in a spaced custom directory also launches directly without cmd.exe.
    const nativeCodex = path.join(nodejsDir, 'codex.exe');
    fs.writeFileSync(nativeCodex, 'MZ');
    const nativeBuilt = buildLaunch({
      agent: 'codex',
      sessionId: 's-native-codex',
      prompt: 'hello',
      stateDir: root,
      cliMeta: {
        path: nativeCodex,
        command: 'codex',
        normalArgs: [],
        fullAccessArgs: [FULL_ACCESS.codex],
        promptArg: 'positional',
      },
    });
    expect(nativeBuilt.file).toBe(nativeCodex);
    expect(nativeBuilt.args[0]).toBe('-c');
    expect(nativeBuilt.args.at(-1)).toBe('hello');

    // pnpm %~dp0 shim and Scoop absolute-path pass-through shim both unwrap cleanly.
    const pnpmCmd = path.join(nodejsDir, 'codex-pnpm.cmd');
    fs.writeFileSync(pnpmCmd, '@ECHO off\r\n"%_prog%" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    expect(unwrapNpmCmdShim(pnpmCmd)).toBe(codexJsPath);

    const scoopCmd = path.join(nodejsDir, 'codex-scoop.cmd');
    fs.writeFileSync(scoopCmd, `@"${nativeCodex}" %*\r\n`);
    expect(unwrapNpmCmdShim(scoopCmd)).toBe(process.platform === 'win32' ? nativeCodex : null);

    // Negative cases: interpreter wrappers, fixed-arg wrappers, and comments must NEVER unwrap (would drop fixed args!).
    const fakePython = path.join(nodejsDir, 'python.exe');
    fs.writeFileSync(fakePython, 'MZ');
    const pythonWrap = path.join(nodejsDir, 'aider.cmd');
    fs.writeFileSync(pythonWrap, `@"${fakePython}" -m aider %*\r\n`);
    expect(unwrapNpmCmdShim(pythonWrap)).toBeNull();

    const fixedArgExe = path.join(nodejsDir, 'codex-profile.cmd');
    fs.writeFileSync(fixedArgExe, `@"%dp0%\\codex.exe" --profile work %*\r\n`);
    expect(unwrapNpmCmdShim(fixedArgExe)).toBeNull();

    const fixedArgJs = path.join(nodejsDir, 'codex-fixed-js.cmd');
    fs.writeFileSync(fixedArgJs, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" --profile work %*\r\n');
    expect(unwrapNpmCmdShim(fixedArgJs)).toBeNull();

    const commentOnly = path.join(nodejsDir, 'commented.cmd');
    fs.writeFileSync(commentOnly, '@echo off\r\nREM "%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\necho custom %*\r\n');
    expect(unwrapNpmCmdShim(commentOnly)).toBeNull();

    if (process.platform === 'win32') {
      expect(() => buildLaunch({
        agent: 'codex',
        sessionId: 's-bad-batch',
        prompt: 'hi',
        stateDir: root,
        cliMeta: {
          path: fixedArgExe,
          command: 'codex',
          normalArgs: [],
          fullAccessArgs: [FULL_ACCESS.codex],
          promptArg: 'positional',
        },
      })).toThrow(/无法直接解包的批处理脚本/);
    }
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
      expect(snap.settings.closeAction).toBe('tray');
      const childTask = snap.tasks.find((t) => t.delegation?.parentTaskId === created.task.id)!;
      const childSession = snap.sessions.find((s) => s.id === childTask.sessionId)!;
      expect(childTask.permissionMode).toBe('normal');
      expect(childSession.permissionMode).toBe('normal');

      // 6) closeAction setting validates enum values, persists, and reflects in GET /api/state.
      const badClose = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ closeAction: 'hide' }),
      });
      expect(badClose.status).toBe(400);

      const quitRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ closeAction: 'quit' }),
      });
      expect(quitRes.status).toBe(200);
      expect(((await quitRes.json()) as Settings).closeAction).toBe('quit');
      expect(((await (await fetch(`${base}/api/state`)).json()) as Snapshot).settings.closeAction).toBe('quit');

      const trayRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ closeAction: 'tray' }),
      });
      expect(trayRes.status).toBe(200);
      expect(((await trayRes.json()) as Settings).closeAction).toBe('tray');
    } finally {
      await Promise.allSettled([mobile.close(), sessions.killAll()]);
      server.close();
      if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT;
      else process.env.WORKBENCH_FAKE_AGENT = prevFake;
    }
  }, 20_000);

  it('detects custom Codex CLIs (direct binary, npm shim, args, wrapper + distinct CODEX_HOME) without false positives', () => {
    const dir = makeTmpDir();
    const directBin = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.writeFileSync(directBin, 'bin', { mode: 0o755 });

    const fakeNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.writeFileSync(fakeNode, 'bin', { mode: 0o755 });

    const workHome = path.join(dir, 'codex-work-home');
    const wrapperBin = path.join(dir, process.platform === 'win32' ? 'work-cli.cmd' : 'work-cli.sh');
    fs.writeFileSync(
      wrapperBin,
      process.platform === 'win32'
        ? `@echo off\r\nset "CODEX_HOME=${workHome}"\r\ncall "${directBin}" %*\r\n`
        : `#!/bin/sh\nexport CODEX_HOME="${workHome}"\nexec "${directBin}" "$@"\n`,
      { mode: 0o755 },
    );

    // Contract: Windows .cmd wrapper setting CODEX_HOME or arbitrary `if defined ... cd` must NOT be unwrapped.
    if (process.platform === 'win32') {
      expect(unwrapNpmCmdShim(wrapperBin)).toBeNull();
      const safeLaunch = buildSafeProcessLaunch(wrapperBin, [], 'win32');
      expect(typeof safeLaunch.args).toBe('string');
      expect(String(safeLaunch.args)).toContain(wrapperBin);

      const ifCdCmd = path.join(dir, 'if-cd-codex.cmd');
      fs.writeFileSync(ifCdCmd, `@echo off\r\nif defined USERPROFILE cd /d "${dir}"\r\ncall "${directBin}" %*\r\n`);
      expect(unwrapNpmCmdShim(ifCdCmd)).toBeNull();
    }

    // Batch %~dp0 expansion + shell `exec ./bin/codex`, `exec env CODEX_HOME=...`, single-quote RHS & inherited export semantics
    const dp0Cmd = path.join(dir, 'dp0-codex.cmd');
    fs.writeFileSync(dp0Cmd, `@echo off\r\nset "CODEX_HOME=%~dp0account"\r\ncall "${directBin}" %*\r\n`);
    const relSh = path.join(dir, 'rel-codex.sh');
    fs.writeFileSync(relSh, '#!/bin/sh\nexec ./bin/codex "$@"\n', { mode: 0o755 });
    const envSh = path.join(dir, 'env-codex.sh');
    fs.writeFileSync(envSh, '#!/bin/sh\nexec env CODEX_HOME="$HOME/.codex-work" codex "$@"\n', { mode: 0o755 });
    const singleQuoteSh = path.join(dir, 'sq-codex.sh');
    fs.writeFileSync(singleQuoteSh, "#!/bin/sh\nexport CODEX_HOME='/var/$HOME/codex'\nexec codex \"$@\"\n", { mode: 0o755 });
    const unexportedSh = path.join(dir, 'unexported-codex.sh');
    fs.writeFileSync(unexportedSh, '#!/bin/sh\nCODEX_HOME="$HOME/.codex-local"\nexec codex "$@"\n', { mode: 0o755 });
    const echoSh = path.join(dir, 'echo-only.sh');
    fs.writeFileSync(echoSh, '#!/bin/sh\necho "codex"\n', { mode: 0o755 });
    const echoCmd = path.join(dir, 'echo-only.cmd');
    fs.writeFileSync(echoCmd, '@echo off\r\necho "codex"\r\n');

    const otherBin = path.join(dir, process.platform === 'win32' ? 'decoder.exe' : 'decoder');
    fs.writeFileSync(otherBin, 'bin', { mode: 0o755 });

    const defaultHome = path.join(dir, 'default-codex-home');
    const env = { platform: process.platform, env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: defaultHome, PATH: '' }, home: dir };
    const envWithoutCodexHome = { platform: process.platform, env: { HOME: dir, USERPROFILE: dir, PATH: '' }, home: dir };

    expect(detectCustomCodex({ id: 'my-c', label: 'Custom Codex', command: directBin }, directBin, env)).toEqual({ isCodex: true });
    expect(detectCustomCodex({ id: 'node-c', label: 'Node Codex', command: fakeNode, fullAccessArgs: ['D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] }, fakeNode, env)).toEqual({ isCodex: true });
    expect(detectCustomCodex({ id: 'npx-c', label: 'NPX Codex', command: 'npx', normalArgs: ['@openai/codex@latest'] }, null, env)).toEqual({ isCodex: true });
    expect(detectCustomCodex({ id: 'work-c', label: 'Work CLI', command: wrapperBin }, wrapperBin, env)).toEqual({ isCodex: true, codexHome: workHome });
    expect(detectCustomCodex({ id: 'dp0-c', label: 'DP0 CLI', command: dp0Cmd }, dp0Cmd, env)).toEqual({ isCodex: true, codexHome: path.join(dir, 'account') });
    expect(detectCustomCodex({ id: 'rel-c', label: 'Rel CLI', command: relSh }, relSh, env)).toEqual({ isCodex: true });
    expect(detectCustomCodex({ id: 'env-c', label: 'Env CLI', command: envSh }, envSh, env)).toEqual({ isCodex: true, codexHome: path.join(dir, '.codex-work') });
    // Single-quoted RHS preserves literal `$HOME` instead of expanding it.
    expect(detectCustomCodex({ id: 'sq-c', label: 'SQ CLI', command: singleQuoteSh }, singleQuoteSh, env)).toEqual({ isCodex: true, codexHome: path.normalize('/var/$HOME/codex') });
    // POSIX inherited-export semantics: exported when CODEX_HOME is in env, local-only when absent from env.
    expect(detectCustomCodex({ id: 'unexp-c', label: 'Unexp CLI', command: unexportedSh }, unexportedSh, env)).toEqual({ isCodex: true, codexHome: path.join(dir, '.codex-local') });
    expect(detectCustomCodex({ id: 'unexp-c', label: 'Unexp CLI', command: unexportedSh }, unexportedSh, envWithoutCodexHome)).toEqual({ isCodex: true });

    // False-positive guards: non-entry args (`node other.js codex`), non-runner (`rg codex`), and echo scripts must NEVER match.
    expect(detectCustomCodex({ id: 'node-other', label: 'Node Other', command: fakeNode, normalArgs: ['other.js', 'codex'] }, fakeNode, env)).toEqual({ isCodex: false });
    expect(detectCustomCodex({ id: 'rg-tool', label: 'RG', command: 'rg', normalArgs: ['codex'] }, null, env)).toEqual({ isCodex: false });
    expect(detectCustomCodex({ id: 'echo-sh', label: 'Echo SH', command: echoSh }, echoSh, env)).toEqual({ isCodex: false });
    expect(detectCustomCodex({ id: 'echo-cmd', label: 'Echo CMD', command: echoCmd }, echoCmd, env)).toEqual({ isCodex: false });
    expect(detectCustomCodex({ id: 'decoder', label: 'Decoder', command: otherBin }, otherBin, env)).toEqual({ isCodex: false });

    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      cliPrefs: { codex: { enabled: false } },
      customClis: [
        { id: 'my-c', label: 'Custom Codex', command: directBin },
        { id: 'work-c', label: 'Work CLI', command: wrapperBin },
        { id: 'decoder', label: 'Decoder', command: otherBin },
      ],
    };
    const tools = buildCliTools(settings, env);
    const myTool = tools.find((t) => t.id === 'my-c')!;
    const workTool = tools.find((t) => t.id === 'work-c')!;
    const decTool = tools.find((t) => t.id === 'decoder')!;
    expect(myTool.quotaAgent).toBe('codex');
    expect(myTool.quotaKey).toBe('codex');
    expect(myTool.capabilities).toContain('Codex 订阅额度');
    expect(workTool.quotaAgent).toBe('codex');
    expect(workTool.quotaKey).toBe('work-c');
    expect(decTool.quotaAgent).toBeUndefined();
    expect(decTool.quotaKey).toBeUndefined();

    const homes = resolveCustomCodexHomes(settings, env);
    expect(homes.hasDefaultCodex).toBe(true);
    expect(homes.customHomes).toEqual([{ id: 'work-c', codexHome: workHome }]);

    // Mobile snapshot redacts local path/command/args while keeping quotaAgent & quotaKey metadata.
    const mob = sanitizeSnapshotForMobile({
      projects: [], tasks: [], sessions: [], cards: [], agents: ['my-c', 'work-c'],
      cliTools: [myTool, workTool], settings, git: {}, quota: {},
    });
    expect(mob.cliTools?.[0].path).toBeNull();
    expect(mob.cliTools?.[0].command).toBe('');
    expect(mob.cliTools?.[0].quotaAgent).toBe('codex');
    expect(mob.cliTools?.[0].quotaKey).toBe('codex');
    expect(mob.cliTools?.[1].quotaKey).toBe('work-c');
  });

  it('refreshes Codex subscription quota from disk for custom Codex CLIs even when built-in codex is disabled, ignores stale built-in transcripts, and prunes removed/disabled custom buckets', async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const stateDir = makeTmpDir();
    const defaultCodexHome = makeTmpDir();
    const workCodexHome = makeTmpDir();
    process.env.CODEX_HOME = defaultCodexHome;

    const pastReset = Math.floor((Date.now() - 3_600_000) / 1000);
    const futureReset = Math.floor((Date.now() + 3_600_000) / 1000);
    const writeRollout = (homeDir: string, used5h: number, plan: string, resetSec = futureReset, fileName = 'rollout-2026-11-25T16-00-00-abc.jsonl') => {
      const sessDir = path.join(homeDir, 'sessions', '2026', '11', '25');
      fs.mkdirSync(sessDir, { recursive: true });
      const line = JSON.stringify({
        timestamp: '2026-11-25T16:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: used5h, window_minutes: 300, resets_at: resetSec },
            secondary: { used_percent: 12, window_minutes: 10080, resets_at: resetSec + 86400 },
            plan_type: plan,
          },
        },
      });
      const full = path.join(sessDir, fileName);
      fs.writeFileSync(full, `${line}\n`);
      return full;
    };
    // Transcript from a DIFFERENT old CODEX_HOME with a live weekly window and newer mtime must NOT override current default CODEX_HOME!
    const foreignHome = makeTmpDir();
    const foreignTranscript = writeRollout(foreignHome, 99, 'plus', futureReset, 'rollout-foreign.jsonl');
    const futureTouch = new Date(Date.now() + 5_000);
    fs.utimesSync(foreignTranscript, futureTouch, futureTouch);
    writeRollout(defaultCodexHome, 25, 'plus');
    writeRollout(workCodexHome, 60, 'pro');

    const directBin = path.join(stateDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.writeFileSync(directBin, 'bin', { mode: 0o755 });
    const wrapperBin = path.join(stateDir, process.platform === 'win32' ? 'codex-work.cmd' : 'codex-work.sh');
    fs.writeFileSync(
      wrapperBin,
      process.platform === 'win32'
        ? `@echo off\r\nset "CODEX_HOME=${workCodexHome}"\r\ncall "${directBin}" %*\r\n`
        : `#!/bin/sh\nexport CODEX_HOME="${workCodexHome}"\nexec "${directBin}" "$@"\n`,
      { mode: 0o755 },
    );

    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });

    const store = createMemoryStore();
    // Seed an exited built-in codex session pointing to a foreign CODEX_HOME transcript with newer mtime: must NOT override default CODEX_HOME!
    store.saveSession({
      id: 'old-codex-sess',
      taskId: 'old-task',
      agent: 'codex',
      status: 'exited',
      statusSince: Date.now() - 10_000,
      nativeSessionId: 'old-native',
      transcriptPath: foreignTranscript,
      startedAt: Date.now() - 20_000,
      exitCode: 0,
      cols: 120,
      rows: 36,
    });
    const sessions = new SessionManager({ port, token: 'test-token', stateDir });
    sessions.restore(store.sessions());
    const usage = createUsage({ stateDir, source: store });
    const { server, mobile } = createApp({
      port, token: 'test-token', store, sessions, stateDir, usage, codexDiskQuota: true,
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const base = `http://127.0.0.1:${port}`;

    try {
      const setRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cliPrefs: { codex: { enabled: false } },
          customClis: [
            { id: 'my-codex', label: '自定义 Codex', command: directBin },
            { id: 'codex-work', label: 'Codex 工作号', command: wrapperBin },
          ],
        }),
      });
      expect(setRes.status).toBe(200);

      const snap = (await (await fetch(`${base}/api/state`)).json()) as Snapshot;
      expect(snap.quota.codex?.plan).toBe('plus');
      expect(snap.quota.codex?.windows[0].usedPercent).toBe(25);
      expect(snap.quota['codex-work']?.plan).toBe('pro');
      expect(snap.quota['codex-work']?.windows[0].usedPercent).toBe(60);

      // Updating the rollout file and hitting /api/quota/refresh picks up fresh percentages immediately.
      writeRollout(defaultCodexHome, 42, 'plus');
      const refRes = await fetch(`${base}/api/quota/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refRes.status).toBe(200);
      const refBody = (await refRes.json()) as { quota: Snapshot['quota'] };
      expect(refBody.quota.codex?.windows[0].usedPercent).toBe(42);

      // Retargeting the same custom CLI id to an empty isolated CODEX_HOME must clear Account A's stale quota!
      const emptyWorkHome = makeTmpDir();
      fs.writeFileSync(
        wrapperBin,
        process.platform === 'win32'
          ? `@echo off\r\nset "CODEX_HOME=${emptyWorkHome}"\r\ncall "${directBin}" %*\r\n`
          : `#!/bin/sh\nexport CODEX_HOME="${emptyWorkHome}"\nexec "${directBin}" "$@"\n`,
        { mode: 0o755 },
      );
      const bump = new Date(Date.now() + 2000);
      fs.utimesSync(wrapperBin, bump, bump);
      const retargetRes = await fetch(`${base}/api/quota/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(retargetRes.status).toBe(200);
      const retargetBody = (await retargetRes.json()) as { quota: Snapshot['quota'] };
      expect(retargetBody.quota['codex-work']).toBeUndefined();
      expect(retargetBody.quota.codex?.windows[0].usedPercent).toBe(42);

      // Disabling `codex-work` keeps state clean as well.
      const disRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliPrefs: { 'codex-work': { enabled: false } } }),
      });
      expect(disRes.status).toBe(200);
      const afterDis = (await (await fetch(`${base}/api/state`)).json()) as Snapshot;
      expect(afterDis.quota['codex-work']).toBeUndefined();
      expect(afterDis.quota.codex?.windows[0].usedPercent).toBe(42);
    } finally {
      await Promise.allSettled([mobile.close(), sessions.killAll()]);
      server.close();
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
    }
  }, 20_000);
});

describe('Pi Agent built-in deep discovery', () => {
  it('auto-discovers pi or pi-agent alias and extra install paths as deep tier', () => {
    const home = makeTmpDir();
    const aliasDir = path.join(home, 'alias-bin');
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasExe = path.join(aliasDir, 'pi-agent.exe');
    fs.writeFileSync(aliasExe, 'MZ');

    const byAlias = buildCliTools(DEFAULT_SETTINGS, { platform: 'win32', env: { PATH: aliasDir }, home }).find((t) => t.id === 'pi')!;
    expect(byAlias.tier).toBe('deep');
    expect(byAlias.installed).toBe(true);
    expect(byAlias.usable).toBe(true);
    expect(byAlias.enabled).toBe(true);
    expect(byAlias.path).toBe(aliasExe);

    const bunDir = path.join(home, '.bun', 'bin');
    fs.mkdirSync(bunDir, { recursive: true });
    const bunExe = path.join(bunDir, 'pi.exe');
    fs.writeFileSync(bunExe, 'MZ');

    const byExtra = buildCliTools(DEFAULT_SETTINGS, { platform: 'win32', env: { PATH: '' }, home }).find((t) => t.id === 'pi')!;
    expect(byExtra.installed).toBe(true);
    expect(byExtra.usable).toBe(true);
    expect(byExtra.path).toBe(bunExe);
  });
});
