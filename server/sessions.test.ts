import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './http.ts';
import {
  agyHookDisposition, agyPrimaryWorkspaces, CODEX_NEWLINE, deliverable, isAgyIntermediateStop,
  modePrefix, nativeIdUpdate, pasteFrame, sanitizePaste, SessionManager, trackModes,
} from './sessions.ts';
import type { DeliveryState } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

describe('nativeIdUpdate', () => {
  it('takes the first id from any event', () => {
    expect(nativeIdUpdate(null, 'UserPromptSubmit', 'a', undefined)).toEqual({ id: 'a' });
    expect(nativeIdUpdate(null, 'SessionStart', 'a', 'startup')).toEqual({ id: 'a' });
  });

  it('SessionStart source resume switches the id and makes it resumable', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'resume')).toEqual({ id: 'b', resumable: true });
  });

  it('SessionStart from clear/startup/compact switches the id but waits for a prompt', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'clear')).toEqual({ id: 'b', resumable: false });
    expect(nativeIdUpdate('a', 'SessionStart', 'b', undefined)).toEqual({ id: 'b', resumable: false });
  });

  it('ignores the same id, empty ids and non-SessionStart events with another id', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'a', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', '', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', 42, 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'UserPromptSubmit', 'b', undefined)).toBeUndefined();
    expect(nativeIdUpdate('a', 'Stop', 'b', 'resume')).toBeUndefined();
  });
});

describe('pasteFrame', () => {
  it('bracketed: wraps the text, newlines become \\n and never \\r (a \\r submits in Codex)', () => {
    expect(pasteFrame('a\nb\r\nc\rd', true)).toBe('\x1b[200~a\nb\nc\nd\x1b[201~');
  });

  it('codex: every newline becomes the Ctrl+J key record', () => {
    expect(pasteFrame('一\r\n二\n三', true, CODEX_NEWLINE)).toBe(`\x1b[200~一${CODEX_NEWLINE}二${CODEX_NEWLINE}三\x1b[201~`);
  });

  it('plain: collapses newlines into single spaces', () => {
    expect(pasteFrame('a\n\nb\r\nc', false)).toBe('a b c');
  });

  it('strips paste markers and control characters but keeps tabs and newlines', () => {
    const evil = 'x\x1b[201~rm -rf\x1b[200~\x03\x07\x1b[31my\ttab\nz\x7f';
    expect(sanitizePaste(evil)).toBe('xrm -rf[31my\ttab\nz');
    expect(pasteFrame(evil, true)).not.toContain('\x1b[201~rm');
    expect(pasteFrame(evil, true).match(/\x1b/g)).toHaveLength(2);
  });
});

describe('deliverable', () => {
  const base: DeliveryState = { status: 'needs_you', statusSince: 0, permBlocked: false, lastInputAt: 0, lastDeliveryAt: 0 };
  const now = 100_000;

  it('is true for an idle session with no recent typing or delivery', () => {
    expect(deliverable(base, now)).toBe(true);
  });

  it.each([
    ['working', { status: 'working' }],
    ['starting', { status: 'starting' }],
    ['exited', { status: 'exited' }],
    ['turn ended 1.4 s ago (Codex is still settling)', { statusSince: now - 1400 }],
    ['permission prompt open', { permBlocked: true }],
    ['typed 4.9 s ago', { lastInputAt: now - 4900 }],
    ['delivered 1.9 s ago', { lastDeliveryAt: now - 1900 }],
  ] as [string, Partial<DeliveryState>][])('is false: %s', (_n, patch) => {
    expect(deliverable({ ...base, ...patch }, now)).toBe(false);
  });

  it('becomes true exactly at the 5 s / 2 s / 1.5 s boundaries', () => {
    expect(deliverable({ ...base, lastInputAt: now - 5000, lastDeliveryAt: now - 2000, statusSince: now - 1500 }, now)).toBe(true);
  });
});

describe('trackModes / modePrefix', () => {
  it('keeps the last state of replay-relevant modes, across combined and repeated sequences', () => {
    const modes = new Map<number, boolean>();
    trackModes(modes, '\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[?1000;1006h\x1b[?1003h');
    trackModes(modes, 'text\x1b[?1003l\x1b[?25h');
    expect(modePrefix(modes)).toBe('\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    trackModes(modes, '\x1b[?1049l\x1b[?1000;1006l');
    expect(modePrefix(modes)).toBe('\x1b[?2004h');
  });
});

describe('agy hook filtering, intermediate Stop, and self-healing resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('agyPrimaryWorkspaces requires both project cwd and <stateDir>/agy-hooks across slash/case variants', () => {
    expect(agyPrimaryWorkspaces(
      'G:\\Workspace\\agent-workbench',
      'C:\\Users\\Admin\\AppData\\Local\\wb',
      ['C:/Users/Admin/AppData/Local/wb/agy-hooks', 'G:/Workspace/agent-workbench'],
    )).toBe(true);
    // Nested `agy -p` run from agy-hooks lacks project cwd.
    expect(agyPrimaryWorkspaces(
      'G:\\Workspace\\agent-workbench',
      'C:\\Users\\Admin\\AppData\\Local\\wb',
      ['C:/Users/Admin/AppData/Local/wb/agy-hooks'],
    )).toBe(false);
    // Branched worker workspace lacks main project cwd.
    expect(agyPrimaryWorkspaces(
      'G:\\Workspace\\agent-workbench',
      'C:\\Users\\Admin\\AppData\\Local\\wb',
      ['C:/Users/Admin/AppData/Local/wb/agy-hooks', 'G:/Workspace/agent-workbench-share-1'],
    )).toBe(false);
    expect(isAgyIntermediateStop({ fullyIdle: false, continuationActive: false, error: '' })).toBe(true);
    expect(isAgyIntermediateStop({ fullyIdle: true, continuationActive: true, error: '' })).toBe(true);
    expect(isAgyIntermediateStop({ fullyIdle: false, error: 'RESOURCE_EXHAUSTED (code 429)' })).toBe(false);
    expect(isAgyIntermediateStop({ fullyIdle: true, continuationActive: false, error: '' })).toBe(false);
  });

  it('keeps main conversation across subagents/swarm/nested CLI, suppresses intermediate Stop, counts subagent tokens, and resumes cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agy-e2e-'));
    const stateDir = path.join(tmp, 'state');
    const projDir = path.join(tmp, 'proj');
    const agyCfg = path.join(tmp, 'agy-cfg');
    const fakeLocal = path.join(tmp, 'local');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(fakeLocal, 'agy', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fakeLocal, 'agy', 'bin', 'agy.exe'), '');

    const prevAgy = process.env.AGY_CONFIG_DIR;
    const prevLocal = process.env.LOCALAPPDATA;
    process.env.AGY_CONFIG_DIR = agyCfg;
    process.env.LOCALAPPDATA = fakeLocal;

    const MAIN = 'ae1cac0a-c6a3-47d3-968f-06ba2f139408';
    const REV3 = '27e3af25-4cf9-449a-abb1-a1a9067c3ee7';
    const FORKED = '55555555-5555-4555-8555-555555555555';
    const NESTED = '8d41fe36-576f-43a3-ba8f-23781cf46302';
    const SWITCHED = 'bca98099-0a5e-4cc7-9669-b66e40a5b579';

    const writeBrain = (id: string, entries: unknown[]) => {
      const full = path.join(agyCfg, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      return full;
    };

    const nowIso = new Date().toISOString();
    const mainTp = writeBrain(MAIN, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>三角度评审</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, input_tokens: 1000, output_tokens: 200, content: '已派生3个评审子代理' },
    ]);
    const rev3Tp = writeBrain(REV3, [
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: nowIso, content: `[Message] sender=${MAIN} content=Audit Angle 3` },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, input_tokens: 500, output_tokens: 100, content: 'VERDICT: REVISE（子代理内部汇报）' },
    ]);
    // Forked swarm worker copies step 0 USER_EXPLICIT from coordinator, so only live lastUserInput="" distinguishes it!
    const forkedTp = writeBrain(FORKED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>三角度评审</USER_REQUEST>' },
      { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: nowIso, content: `[Message] sender=${MAIN} content=You have just started.` },
    ]);
    const nestedTp = writeBrain(NESTED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>Do not use any tools.</USER_REQUEST>' },
    ]);
    const switchedTp = writeBrain(SWITCHED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>手动切到的新主会话</USER_REQUEST>' },
    ]);

    const spawns: { file: string; args: string[]; exit: (code: number) => void }[] = [];
    vi.spyOn(pty, 'spawn').mockImplementation(((file: string, args: string[]) => {
      let exitCb: ((e: { exitCode: number }) => void) | null = null;
      const rec = { file, args: [...args], exit: (exitCode: number) => exitCb?.({ exitCode }) };
      spawns.push(rec);
      return {
        pid: 1000 + spawns.length, cols: 120, rows: 36, process: 'agy', handleFlowControl: false,
        onData: () => ({ dispose() {} }),
        onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; return { dispose() {} }; },
        write() {}, resize() {}, kill() { exitCb?.({ exitCode: 0 }); },
        pause() {}, resume() {}, clear() {},
      } as unknown as pty.IPty;
    }) as typeof pty.spawn);

    const token = 'test-hook-token';
    const store = createFileStore(path.join(stateDir, 'state.json'));
    // Probe ephemeral port via server.listen(0): build sessions with placeholder port and bind once known.
    const sessions = new SessionManager({ port: 0, token, stateDir });
    const usage = createUsage({
      stateDir,
      source: {
        sessions: () => sessions.list(),
        tasks: () => store.tasks(),
        projects: () => store.projects(),
      },
    });
    // Listen on port 0 by reading dynamic host after bind; createApp checks Host against cfg.port, so pick a free port first.
    const net = await import('node:net');
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(err => (err ? reject(err) : resolve(p)));
      });
    });
    const app = createApp({ port: freePort, token, store, sessions, stateDir, usage });
    await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${freePort}`;
    const api = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: res.status === 204 ? null : await res.json() };
    };
    const postHook = (sessionId: string, event: string, payload: Record<string, unknown>) =>
      fetch(`${base}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, agent: 'agy', event, at: Date.now(), payload }),
      });

    try {
      const ws = [projDir.replaceAll('\\', '/'), path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')];
      const proj = (await api('POST', '/api/projects', { name: 'AgyProj', path: projDir })).json;
      const created = (await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', title: '评审优化', prompt: '三角度评审' })).json;
      const taskId: string = created.task.id;
      const sid1: string = created.session.id;

      // 1. Main conversation starts and enters working state.
      await postHook(sid1, 'SessionStart', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      await postHook(sid1, 'PreInvocation', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      expect(store.getSession(sid1)?.nativeSessionId).toBe(MAIN);
      expect(store.getSession(sid1)?.status).toBe('working');

      // 2. Main pauses turn to wait on async subagents (`fullyIdle: false`) -> stays `working`, no premature review card!
      await postHook(sid1, 'Stop', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, fullyIdle: false, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium' });
      expect(store.getSession(sid1)?.status).toBe('working');
      expect(store.getTask(taskId)?.phase).toBe('active');
      expect(store.cards()).toHaveLength(0);

      // 3. Subagent (`reviewer-3`), forked swarm worker (`lastUserInput: ""`), and nested `agy -p` all fire hooks.
      for (const ev of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']) {
        await postHook(sid1, ev, {
          conversationId: REV3, lastUserInput: '', transcriptPath: rev3Tp, workspacePaths: ws,
          fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium',
        });
        await postHook(sid1, ev, {
          conversationId: FORKED, lastUserInput: '', transcriptPath: forkedTp, workspacePaths: ws,
          fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-argon-medium',
        });
      }
      await postHook(sid1, 'SessionStart', {
        conversationId: NESTED, lastUserInput: 'Do not use any tools.', transcriptPath: nestedTp,
        workspacePaths: [path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')], modelName: 'gemini-3.8-flash-high',
      });
      await postHook(sid1, 'Stop', {
        conversationId: NESTED, lastUserInput: 'Do not use any tools.', transcriptPath: nestedTp,
        workspacePaths: [path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')], fullyIdle: true, error: '', modelName: 'gemini-3.8-flash-high',
      });

      // Primary session & task remain 100% anchored on MAIN!
      expect(store.getSession(sid1)?.nativeSessionId).toBe(MAIN);
      expect(store.getSession(sid1)?.transcriptPath).toBe(mainTp);
      expect(store.getSession(sid1)?.status).toBe('working');
      expect(store.getTask(taskId)?.phase).toBe('active');
      expect(store.cards()).toHaveLength(0);

      // Yet token usage still includes BOTH MAIN (1000+200) and REV3 (500+100)!
      const report = (await api('GET', '/api/usage')).json;
      expect(report.total.input + report.total.output).toBe(1800);

      // 4. Main wakes up when subagents complete, writes final synthesis, and emits terminal Stop (`fullyIdle: true`).
      fs.appendFileSync(mainTp, JSON.stringify({
        step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, content: '三轮汇总完毕，请验收。',
      }) + '\n');
      await postHook(sid1, 'PreInvocation', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      await postHook(sid1, 'Stop', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium' });

      expect(store.getSession(sid1)?.status).toBe('needs_you');
      expect(store.getTask(taskId)?.phase).toBe('review');
      expect(store.cards()).toHaveLength(1);
      expect(store.cards()[0].body).toContain('三轮汇总完毕，请验收。');

      // 5. Server restart / process exit -> clicking Resume passes `--conversation <MAIN>`, NOT reviewer-3!
      spawns[0].exit(0);
      const resumed = await api('POST', `/api/tasks/${taskId}/resume`, {});
      expect(resumed.status).toBe(200);
      expect(spawns[1].args.slice(0, 2)).toEqual(['--conversation', MAIN]);
      const sid2: string = resumed.json.session.id;

      // 6. Genuine interactive `/resume` inside agy TUI (fires PreInvocation with non-empty lastUserInput & full workspaces) tracks!
      await postHook(sid2, 'PreInvocation', {
        conversationId: SWITCHED, lastUserInput: '继续新会话', transcriptPath: switchedTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium',
      });
      expect(store.getSession(sid2)?.nativeSessionId).toBe(SWITCHED);

      // 7. Historical poisoned session in state.json (`nativeSessionId = REV3`) self-heals to MAIN on Resume!
      const poisonedTaskId = 'poisoned-task';
      const poisonedSid = 'poisoned-session';
      store.addTask({
        id: poisonedTaskId, projectId: proj.id, title: '旧污染任务', titleAuto: false, prompt: 'x', color: '#888',
        agent: 'agy', sessionId: poisonedSid, createdAt: Date.now(), phase: 'review', phaseSince: Date.now(),
      });
      const poisonedSession = {
        id: poisonedSid, taskId: poisonedTaskId, agent: 'agy' as const, nativeSessionId: REV3, resumable: true,
        transcriptPath: rev3Tp, status: 'exited' as const, statusSince: Date.now(), startedAt: Date.now(), exitCode: 0, cols: 120, rows: 36,
      };
      store.saveSession(poisonedSession);
      sessions.restore([poisonedSession]);

      const healed = await api('POST', `/api/tasks/${poisonedTaskId}/resume`, {});
      expect(healed.status).toBe(200);
      expect(spawns[2].args.slice(0, 2)).toEqual(['--conversation', MAIN]);
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
      if (prevAgy === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prevAgy;
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('agyHookDisposition handles RateLimits and initial subagent guard', () => {
    expect(agyHookDisposition({ currentId: null, event: 'RateLimits', payload: {}, cwd: '/p', stateDir: '/s' })).toEqual({ kind: 'primary' });
    expect(agyHookDisposition({ currentId: null, event: 'SessionStart', payload: {}, cwd: '/p', stateDir: '/s' })).toEqual({ kind: 'ignore' });
  });
});
