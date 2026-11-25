import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELEGATION_RULES, DELEGATION_INSTRUCTIONS, DELEGATION_RULES_MAX, RICH_OUTPUT_INSTRUCTIONS, composeDelegationInstructions, composeSessionInstructions, delegationState } from '../shared/protocol.ts';
import { writeHookFiles } from './agents.ts';
import { MAX_DELEGATION_ROUNDS, MAX_OPEN_DELEGATIONS } from './collab.ts';
import { createApp } from './http.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

interface SpawnRec {
  file: string;
  args: string[];
  env: Record<string, string>;
  sessionId: string;
  peerToken: string;
  written: string[];
  killed: boolean;
  emitExit: (code: number) => void;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(err => (err ? reject(err) : resolve(p)));
    });
  });
}

function runCli(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.stdin !== undefined) {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += String(d); });
      child.stderr.on('data', d => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(opts.stdin, 'utf8');
      return;
    }
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') {
        reject(err);
        return;
      }
      const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function setupHarness() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-collab-'));
  const stateDir = path.join(rootDir, 'state');
  const projDir = path.join(rootDir, 'proj');
  const projDir2 = path.join(rootDir, 'proj2');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(projDir2, { recursive: true });
  writeHookFiles(stateDir);

  const spawns: SpawnRec[] = [];
  const spawnBySession = new Map<string, SpawnRec>();
  vi.spyOn(pty, 'spawn').mockImplementation(((file: string, args: string[] | string, options: pty.IPtyForkOptions) => {
    const env = { ...((options?.env ?? {}) as Record<string, string>) };
    const written: string[] = [];
    let exitCb: (e: { exitCode: number }) => void = () => {};
    const rec: SpawnRec = {
      file,
      args: Array.isArray(args) ? args : [args],
      env,
      sessionId: env.WORKBENCH_SESSION_ID ?? '',
      peerToken: env.WORKBENCH_PEER_TOKEN ?? '',
      written,
      killed: false,
      emitExit: code => exitCb({ exitCode: code }),
    };
    spawns.push(rec);
    if (rec.sessionId) spawnBySession.set(rec.sessionId, rec);
    return {
      pid: 7000 + spawns.length,
      cols: 120,
      rows: 36,
      process: path.basename(file),
      handleFlowControl: false,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitCb = cb;
        return { dispose() {} };
      },
      write(data: string) { written.push(data); },
      resize() {},
      kill() { rec.killed = true; },
      pause() {},
      resume() {},
      clear() {},
    } as unknown as pty.IPty;
  }) as typeof pty.spawn);

  const freePort = await getFreePort();
  const token = 'test-hook-token';
  const store = createFileStore(path.join(stateDir, 'state.json'));
  const sessions = new SessionManager({ port: freePort, token, stateDir });
  const usage = createUsage({ stateDir, source: store });
  const app = createApp({ port: freePort, token, store, sessions, stateDir, usage });
  await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${freePort}`;

  const api = async <T = any>(method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try { json = text ? JSON.parse(text) as T : null; } catch { /* ignore */ }
    return { status: res.status, json: json as T };
  };

  const hook = async (sessionId: string, agent: string, event: string, payload: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionId, agent, event, payload }),
    });
    expect(res.status).toBe(204);
  };

  const peer = async <T = any>(
    method: string,
    url: string,
    peerToken: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      ...(peerToken ? { authorization: `Bearer ${peerToken}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    };
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try { json = text ? JSON.parse(text) as T : null; } catch { /* ignore */ }
    return { status: res.status, json: json as T };
  };

  const close = async () => {
    await sessions.killAll();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  };

  return { rootDir, stateDir, projDir, projDir2, store, sessions, spawns, spawnBySession, api, hook, peer, close };
}

describe('cross-CLI collaboration (Layers 1-3)', () => {
  const prevFake = process.env.WORKBENCH_FAKE_AGENT;
  const prevLocal = process.env.LOCALAPPDATA;
  const prevAgy = process.env.AGY_CONFIG_DIR;
  const prevPath = process.env.PATH;

  afterEach(() => {
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    vi.restoreAllMocks();
    if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT; else process.env.WORKBENCH_FAKE_AGENT = prevFake;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    if (prevAgy === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prevAgy;
  });

  it('Layer 1: maintains isolated PEERS.md & turns/<taskId>-latest.md per project and cleans up on delete', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const p2 = (await h.api('POST', '/api/projects', { name: 'Beta', path: h.projDir2 })).json;
      const a1 = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A1', prompt: 'design api' })).json;
      const a2 = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A2', prompt: 'check schema' })).json;
      const b1 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Task B1', prompt: 'other proj' })).json;

      const recA1 = h.spawnBySession.get(a1.session.id)!;
      expect(recA1.env.WORKBENCH_COLLAB_DIR).toBe(path.join(h.stateDir, 'collab', p1.id));
      expect(recA1.env.WORKBENCH_PEERS_FILE).toBe(path.join(h.stateDir, 'collab', p1.id, 'PEERS.md'));
      expect(recA1.env.WORKBENCH_PEER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(recA1.env.WORKBENCH_NODE).toBe(process.execPath);
      const pathVal = recA1.env.Path ?? recA1.env.PATH ?? '';
      expect(pathVal.split(path.delimiter)[0]).toBe(path.join(h.stateDir, 'bin'));

      const peers1 = path.join(h.stateDir, 'collab', p1.id, 'PEERS.md');
      const peers2 = path.join(h.stateDir, 'collab', p2.id, 'PEERS.md');
      const md1 = fs.readFileSync(peers1, 'utf8');
      const md2 = fs.readFileSync(peers2, 'utf8');
      expect(md1).toContain('Task A1');
      expect(md1).toContain('Task A2');
      expect(md1).not.toContain('Task B1');
      expect(md2).toContain('Task B1');
      expect(md2).not.toContain('Task A1');

      await h.hook(a1.session.id, 'fake', 'Stop', { last_assistant_message: 'first | pipe\nbody line' });
      await h.hook(a2.session.id, 'fake', 'Stop', { last_assistant_message: 'a2 output' });

      const snapA1 = path.join(h.stateDir, 'collab', p1.id, 'turns', `${a1.task.id}-latest.md`);
      const snapA2 = path.join(h.stateDir, 'collab', p1.id, 'turns', `${a2.task.id}-latest.md`);
      expect(fs.readFileSync(snapA1, 'utf8')).toContain('first | pipe\nbody line');
      expect(fs.existsSync(snapA2)).toBe(true);
      expect(fs.readFileSync(peers1, 'utf8')).toContain('first / pipe');

      expect((await h.api('DELETE', `/api/tasks/${a2.task.id}`)).status).toBe(200);
      expect(fs.existsSync(snapA2)).toBe(false);
      const md1AfterTaskDelete = fs.readFileSync(peers1, 'utf8');
      expect(md1AfterTaskDelete).not.toContain('Task A2');
      expect(md1AfterTaskDelete).toContain('Task A1');

      expect((await h.api('DELETE', `/api/projects/${p1.id}`)).status).toBe(200);
      expect(fs.existsSync(path.join(h.stateDir, 'collab', p1.id))).toBe(false);
      expect(fs.existsSync(peers2)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('Layer 2: forward with replyBack isolates manual turns, preserves titleAuto/lastActiveAt, stays 1-shot, and disarms on cancel/failure', { timeout: 25_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const a = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task A', prompt: 'init a' })).json;
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'Draft API v1' });
      const cardA = h.store.cards().find(c => c.taskId === a.task.id && c.kind === 'result')!;

      const b = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', prompt: '' })).json;
      await h.hook(b.session.id, 'fake', 'UserPromptSubmit', { prompt: '' });
      const bBefore = h.store.getTask(b.task.id)!;
      expect(bBefore.titleAuto).toBe(true);
      expect(bBefore.title).toBe('新任务 1');

      const fwd = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { taskId: b.task.id },
        note: 'review v1',
        replyBack: true,
      });
      expect(fwd.status).toBe(200);
      expect(fwd.json.replyBack).toBe(true);

      // Unrelated manual turn finishes on B before the forwarded prompt is delivered: must NOT reply back to A.
      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'unrelated manual reply' });
      expect(h.store.cards().some(c => c.taskId === a.task.id && c.meta?.isAutoReply)).toBe(false);

      const recB = h.spawnBySession.get(b.session.id)!;
      const beforeDeliveryIdx = recB.written.length;
      await vi.waitFor(() => {
        const joined = recB.written.slice(beforeDeliveryIdx).join('');
        expect(joined).toContain('review v1');
        expect(recB.written.at(-1)).toBe('\r');
      }, { timeout: 6000, interval: 100 });

      await h.hook(b.session.id, 'fake', 'UserPromptSubmit', { prompt: 'injected text' });
      const bAfterPrompt = h.store.getTask(b.task.id)!;
      expect(bAfterPrompt.titleAuto).toBe(true);
      expect(bAfterPrompt.title).toBe('新任务 1');
      expect(bAfterPrompt.lastActiveAt).toBe(bBefore.lastActiveAt);

      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'LGTM from B' });
      const autoCard = h.store.cards().find(c => c.taskId === a.task.id && c.kind === 'forward' && c.meta?.isAutoReply);
      expect(autoCard).toBeDefined();
      expect(autoCard?.meta?.peerHop).toBe(2);
      expect(autoCard?.meta?.sourceTaskId).toBe(b.task.id);

      const recA = h.spawnBySession.get(a.session.id)!;
      await vi.waitFor(() => {
        const joined = recA.written.join('');
        expect(joined).toContain('LGTM from B');
        expect(recA.written.at(-1)).toBe('\r');
      }, { timeout: 6000, interval: 100 });

      // Subsequent completion on A must NOT bounce back to B (strict 1-shot).
      const bCardCountBefore = h.store.cards().filter(c => c.taskId === b.task.id).length;
      await h.hook(a.session.id, 'fake', 'UserPromptSubmit', { prompt: 'auto delivered reply' });
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'ack from A' });
      expect(h.store.cards().filter(c => c.taskId === b.task.id).length).toBe(bCardCountBefore);

      // Disarm on canceled Stop and StopFailure for newly spawned tasks.
      const fwdNew1 = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { projectId: p1.id, agent: 'fake' },
        note: 'new target canceled',
        replyBack: true,
      });
      expect(fwdNew1.status).toBe(200);
      const countBeforeCancel = h.store.cards().filter(c => c.taskId === a.task.id).length;
      await h.hook(fwdNew1.json.session.id, 'fake', 'Stop', { error: 'canceled', last_assistant_message: 'aborted' });
      expect(h.store.cards().filter(c => c.taskId === a.task.id).length).toBe(countBeforeCancel);

      const fwdNew2 = await h.api('POST', `/api/cards/${cardA.id}/forward`, {
        to: { projectId: p1.id, agent: 'fake' },
        note: 'new target failure',
        replyBack: true,
      });
      expect(fwdNew2.status).toBe(200);
      await h.hook(fwdNew2.json.session.id, 'fake', 'StopFailure', {});
      expect(h.store.cards().filter(c => c.taskId === a.task.id).length).toBe(countBeforeCancel);
    } finally {
      await h.close();
    }
  });

  it('Layer 3: shoal CLI subprocess, security checks, agy subagentWait guard, and MAX_AUTO_HOPS=4 circuit breaker', { timeout: 35_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const agyLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-local-'));
    const agyCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agycfg-'));
    fs.mkdirSync(path.join(agyLocal, 'agy', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(agyLocal, 'agy', 'bin', 'agy.exe'), '');
    process.env.LOCALAPPDATA = agyLocal;
    if (process.platform !== 'win32') {
      // POSIX finds agy on PATH, not under LOCALAPPDATA.
      const agyBin = path.join(agyLocal, 'agy', 'bin');
      fs.writeFileSync(path.join(agyBin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = `${agyBin}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    process.env.AGY_CONFIG_DIR = agyCfg;

    const h = await setupHarness();
    try {
      const p1 = (await h.api('POST', '/api/projects', { name: 'Alpha', path: h.projDir })).json;
      const a = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task Alpha', prompt: 'start a' })).json;
      const b = (await h.api('POST', '/api/tasks', { projectId: p1.id, agent: 'fake', title: 'Task Beta', prompt: 'start b' })).json;
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'alpha ready' });
      await h.hook(b.session.id, 'fake', 'Stop', { last_assistant_message: 'beta ready' });
      const recA = h.spawnBySession.get(a.session.id)!;

      // 1. Subprocess CLI via Windows shoal.cmd (Path) & shoal-cli.mjs
      const peersRes = process.platform === 'win32'
        ? await runCli('cmd.exe', ['/d', '/c', 'shoal', 'peers', '--json'], { cwd: h.projDir, env: recA.env })
        : await runCli(process.execPath, [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'peers', '--json'], { cwd: h.projDir, env: recA.env });
      expect(peersRes.code).toBe(0);
      const peersJson = JSON.parse(peersRes.stdout);
      expect(peersJson.selfTaskId).toBe(a.task.id);
      expect(peersJson.tasks).toHaveLength(2);

      // Leading @ stripping + multiline --stdin
      const sendStdin = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '@#2', '--stdin'],
        { cwd: h.projDir, env: recA.env, stdin: 'line one\nline two\n' },
      );
      expect(sendStdin.code).toBe(0);

      // --file inside project
      fs.writeFileSync(path.join(h.projDir, 'spec.md'), 'schema v1\nfields: id', 'utf8');
      const sendFile = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '--file', 'spec.md'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendFile.code).toBe(0);

      // 3rd send in same turn -> MAX_SENDS_PER_TURN = 2 -> HTTP 409 (exit 1)
      const sendThird = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '-m', 'third try'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendThird.code).toBe(1);
      expect(sendThird.stderr).toContain('上限 (2)');

      // New human turn resets per-turn limit
      await h.hook(a.session.id, 'fake', 'UserPromptSubmit', { prompt: 'new turn' });

      // --file outside project blocked with 403 (exit 3)
      fs.writeFileSync(path.join(h.rootDir, 'outside.txt'), 'secret', 'utf8');
      const sendOutside = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'send', '#2', '--file', '../outside.txt'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(sendOutside.code).toBe(3);

      // --new spawns peer task
      const askNew = await runCli(
        process.execPath,
        [path.join(h.stateDir, 'bin', 'shoal-cli.mjs'), 'ask', 'fake', '--new', '-m', 'audit auth'],
        { cwd: h.projDir, env: recA.env },
      );
      expect(askNew.code).toBe(0);
      expect(askNew.stdout).toContain('已新建协作任务');
      await h.hook(a.session.id, 'fake', 'Stop', { last_assistant_message: 'done' });

      // 2. HTTP /api/peer/* security guards
      const evilOrigin = await h.peer('GET', '/api/peer/peers', recA.peerToken, {
        headers: { origin: 'http://evil.local' },
      });
      expect(evilOrigin.status).toBe(403);

      const badTok = await h.peer('GET', '/api/peer/peers', 'not-a-valid-token');
      expect(badTok.status).toBe(401);

      // agy intermediate-stop -> subagentWait 403 -> recovered on primary Stop
      const agyTask = (await h.api('POST', '/api/tasks', {
        projectId: p1.id, agent: 'agy', title: 'Agy Peer', model: '', prompt: 'check',
      })).json;
      const recAgy = h.spawnBySession.get(agyTask.session.id)!;
      const convId = '11111111-1111-4111-8111-111111111111';
      await h.hook(agyTask.session.id, 'agy', 'Stop', {
        conversationId: convId,
        fullyIdle: false,
        workspacePaths: [h.projDir, path.join(h.stateDir, 'agy-hooks')],
      });
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(403);
      await h.hook(agyTask.session.id, 'agy', 'Stop', {
        conversationId: convId,
        fullyIdle: true,
        workspacePaths: [h.projDir, path.join(h.stateDir, 'agy-hooks')],
      });
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(200);

      // Exited session invalidates WORKBENCH_PEER_TOKEN
      recAgy.emitExit(0);
      expect((await h.peer('GET', '/api/peer/peers', recAgy.peerToken)).status).toBe(401);

      // 3. 4-Hop loop breaker (MAX_AUTO_HOPS = 4) using two fresh idle tasks H1 and H2
      const p2 = (await h.api('POST', '/api/projects', { name: 'Hops', path: h.projDir2 })).json;
      const h1 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Hop 1', prompt: 'h1' })).json;
      const h2 = (await h.api('POST', '/api/tasks', { projectId: p2.id, agent: 'fake', title: 'Hop 2', prompt: 'h2' })).json;
      await h.hook(h1.session.id, 'fake', 'Stop', { last_assistant_message: 'h1 ready' });
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'h2 ready' });
      const recH1 = h.spawnBySession.get(h1.session.id)!;
      const recH2 = h.spawnBySession.get(h2.session.id)!;

      const waitDelivery = async (rec: SpawnRec, prevLen: number, marker: string) => {
        await vi.waitFor(() => {
          const slice = rec.written.slice(prevLen);
          expect(slice.join('')).toContain(marker);
          expect(rec.written.at(-1)).toBe('\r');
        }, { timeout: 6000, interval: 100 });
      };

      let len2 = recH2.written.length;
      const s1 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-1' } });
      expect(s1.status).toBe(200);
      expect(s1.json.hop).toBe(1);
      await waitDelivery(recH2, len2, 'hop-1');
      await h.hook(h2.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-1' });

      let len1 = recH1.written.length;
      const s2 = await h.peer('POST', '/api/peer/send', recH2.peerToken, { body: { target: h1.task.id, note: 'hop-2' } });
      expect(s2.status).toBe(200);
      expect(s2.json.hop).toBe(2);
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'done 2' });
      await waitDelivery(recH1, len1, 'hop-2');
      await h.hook(h1.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-2' });

      len2 = recH2.written.length;
      const s3 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-3' } });
      expect(s3.status).toBe(200);
      expect(s3.json.hop).toBe(3);
      await h.hook(h1.session.id, 'fake', 'Stop', { last_assistant_message: 'done 3' });
      await waitDelivery(recH2, len2, 'hop-3');
      await h.hook(h2.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-3' });

      len1 = recH1.written.length;
      const s4 = await h.peer('POST', '/api/peer/send', recH2.peerToken, { body: { target: h1.task.id, note: 'hop-4' } });
      expect(s4.status).toBe(200);
      expect(s4.json.hop).toBe(4);
      await h.hook(h2.session.id, 'fake', 'Stop', { last_assistant_message: 'done 4' });
      await waitDelivery(recH1, len1, 'hop-4');
      await h.hook(h1.session.id, 'fake', 'UserPromptSubmit', { prompt: 'hop-4' });

      const s5 = await h.peer('POST', '/api/peer/send', recH1.peerToken, { body: { target: h2.task.id, note: 'hop-5' } });
      expect(s5.status).toBe(429);
    } finally {
      await h.close();
    }
  });

  it('createApp auto-archives stale exited tasks on startup before syncing PEERS.md without TDZ crash', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tdz-'));
    const stateDir = path.join(rootDir, 'state');
    const projDir = path.join(rootDir, 'proj');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    const store = createFileStore(path.join(stateDir, 'state.json'));
    const now = Date.now();
    const project = { id: 'p-tdz', name: 'Startup TDZ', path: projDir, createdAt: now - 5 * 86_400_000 };
    store.addProject(project);
    store.addTask({
      id: 't-stale-approved',
      projectId: project.id,
      title: 'Stale Approved Task',
      titleAuto: false,
      prompt: '',
      color: '#5fa4d6',
      agent: 'fake',
      sessionId: null,
      createdAt: now - 4 * 86_400_000,
      phase: 'approved',
      phaseSince: now - 3 * 86_400_000,
      lastActiveAt: now - 3 * 86_400_000,
    });
    store.addTask({
      id: 't-fresh-active',
      projectId: project.id,
      title: 'Fresh Active Task',
      titleAuto: false,
      prompt: '',
      color: '#7ab88c',
      agent: 'fake',
      sessionId: null,
      createdAt: now - 60_000,
      phase: 'active',
      phaseSince: now - 60_000,
      lastActiveAt: now - 60_000,
    });

    const freePort = await getFreePort();
    const sessions = new SessionManager({ port: freePort, token: 'tok', stateDir });
    const usage = createUsage({ stateDir, source: store });
    const app = createApp({ port: freePort, token: 'tok', store, sessions, stateDir, usage });
    try {
      expect(store.getTask('t-stale-approved')?.phase).toBe('archived');
      expect(store.getTask('t-fresh-active')?.phase).toBe('active');
      const peersMd = fs.readFileSync(path.join(stateDir, 'collab', project.id, 'PEERS.md'), 'utf8');
      expect(peersMd).toContain('Fresh Active Task');
      expect(peersMd).not.toContain('Stale Approved Task');
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => (app.server.listening ? app.server.close(() => resolve()) : resolve()));
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('cross-CLI delegation', () => {
  const prevFake = process.env.WORKBENCH_FAKE_AGENT;

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevFake === undefined) delete process.env.WORKBENCH_FAKE_AGENT; else process.env.WORKBENCH_FAKE_AGENT = prevFake;
  });

  type Harness = Awaited<ReturnType<typeof setupHarness>>;

  async function startMain(h: Harness, projectId: string, title: string) {
    const m = (await h.api('POST', '/api/tasks', { projectId, agent: 'fake', title, prompt: 'init main' })).json;
    await h.hook(m.session.id, 'fake', 'Stop', { last_assistant_message: 'main ready' });
    return { id: m.task.id as string, sid: m.session.id as string, rec: h.spawnBySession.get(m.session.id)! };
  }

  const delegate = (h: Harness, main: { rec: SpawnRec }, body: Record<string, unknown>) =>
    h.peer('POST', '/api/peer/delegate', main.rec.peerToken, { body: { agent: 'fake', ...body } });

  // Returns once the text was pasted and Enter was sent (the system-delivery markers the existing tests also wait for).
  const waitDelivered = (rec: SpawnRec, marker: string) => vi.waitFor(() => {
    expect(rec.written.join('')).toContain(marker);
    expect(rec.written.at(-1)).toBe('\r');
  }, { timeout: 9000, interval: 100 });

  const childOf = (h: Harness, id: string) => {
    const task = h.store.getTask(id)!;
    return { task, sid: task.sessionId!, rec: h.spawnBySession.get(task.sessionId!)! };
  };

  it('delegationState maps phase, session and outcome to one state', () => {
    const d = { parentTaskId: 'p', brief: 'b', round: 1, createdAt: 1 };
    // The task's phase changed at 100; a session status is older (50) or newer (150) than that.
    const run = (phase: any, delegation: any, session: any) =>
      delegationState({ phase, phaseSince: 100, delegation }, session && { statusSince: 150, ...session });
    const table: Array<[string, any, any, any, string | null]> = [
      ['not delegated', 'active', undefined, { status: 'idle' }, null],
      ['first round', 'active', d, { status: 'working' }, 'working'],
      ['later round', 'active', { ...d, round: 2 }, { status: 'working' }, 'rework'],
      ['blocked', 'active', d, { status: 'needs_you', blocked: 'permission' }, 'needs_you'],
      ['quota', 'active', d, { status: 'idle', limit: { kind: 'x' } }, 'needs_you'],
      ['stopped for the user', 'active', d, { status: 'needs_you' }, 'needs_you'],
      ['rework note not delivered yet', 'active', { ...d, round: 2 }, { status: 'needs_you', statusSince: 50 }, 'rework'],
      ['process gone', 'active', d, { status: 'exited' }, 'failed'],
      ['no session', 'active', d, undefined, 'failed'],
      ['result waiting', 'review', d, { status: 'idle' }, 'review'],
      ['approved by the user', 'approved', d, { status: 'exited' }, 'review'],
      ['accepted', 'archived', { ...d, outcome: 'accepted' }, undefined, 'accepted'],
      ['canceled', 'archived', { ...d, outcome: 'canceled' }, { status: 'exited' }, 'canceled'],
      ['archived without outcome', 'archived', d, undefined, 'canceled'],
    ];
    for (const [name, phase, delegation, session, want] of table) expect(run(phase, delegation, session), name).toBe(want);
  });

  it('delegate creates a child; results return each round and rework loops past MAX_AUTO_HOPS up to MAX_DELEGATION_ROUNDS', { timeout: 120_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Deleg', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main A');

      const d = await delegate(h, main, { title: 'Impl X', note: 'one line brief', stdinText: 'BRIEF-BODY-MARKER' });
      expect(d.status).toBe(200);
      expect(d.json.hop).toBe(1);
      expect(d.json.task).toMatchObject({ title: 'Impl X', agent: 'fake', round: 1, state: 'working', brief: 'one line brief' });
      const child = childOf(h, d.json.task.id);
      expect(child.task.delegation).toMatchObject({ parentTaskId: main.id, round: 1, brief: 'one line brief' });
      expect(child.task.lastPrompt).toBe('one line brief');
      expect(child.rec.args.some(a => a.includes('BRIEF-BODY-MARKER') && a.includes('Main A'))).toBe(true);
      expect(fs.readFileSync(path.join(h.stateDir, 'collab', p.id, 'PEERS.md'), 'utf8')).toContain('Delegated by: Main A');

      // Without --title the title comes from the brief's first line, without the label and paths around it.
      const untitled = await delegate(h, main, { note: '任务：在项目根目录（C:\\work\\demo）下新建 `hello.txt`\n第二行细节' });
      expect(untitled.status).toBe(200);
      expect(untitled.json.task.title).toBe('在项目根目录下新建 hello.txt');
      expect((await h.peer('POST', '/api/peer/cancel', main.rec.peerToken, { body: { target: untitled.json.task.handle } })).status).toBe(200);

      // A delegated task cannot delegate; unknown agents and empty briefs are refused.
      const nested = await delegate(h, child, { note: 'x' });
      expect(nested.status).toBe(403);
      expect((await delegate(h, main, { agent: 'nope', note: 'x' })).status).toBe(400);
      expect((await delegate(h, main, {})).status).toBe(400);
      // The HTTP task API cannot create a delegated task.
      const forged = (await h.api('POST', '/api/tasks', {
        projectId: p.id, agent: 'fake', title: 'forged', prompt: 'x', delegation: { parentTaskId: main.id, brief: 'x', round: 1, createdAt: 1 },
      })).json;
      expect(h.store.getTask(forged.task.id)!.delegation).toBeUndefined();

      const handle = d.json.task.handle as string;
      for (let round = 1; round <= MAX_DELEGATION_ROUNDS; round++) {
        if (round > 1) await waitDelivered(child.rec, `FIX-${round - 1}`);
        await h.hook(child.sid, 'fake', 'UserPromptSubmit', { prompt: 'turn' });
        const running = await h.peer('GET', '/api/peer/delegations', main.rec.peerToken);
        expect(running.json.tasks[0]).toMatchObject({ state: round > 1 ? 'rework' : 'working', round });
        await h.hook(child.sid, 'fake', 'Stop', { last_assistant_message: `CHILD-RESULT-${round}` });

        await waitDelivered(main.rec, `CHILD-RESULT-${round}`);
        const mainText = main.rec.written.join('');
        expect(mainText).toContain(`shoal done ${handle}`);
        expect(mainText).toContain(`第 ${round} 轮`);
        const resultCards = h.store.cards().filter(c => c.taskId === main.id && c.meta?.delegation === 'result');
        expect(resultCards).toHaveLength(round);
        expect(resultCards.at(-1)!.meta).toMatchObject({ sourceTaskId: child.task.id, isAutoReply: true });
        await h.hook(main.sid, 'fake', 'UserPromptSubmit', { prompt: 'result pasted' });
        await h.hook(main.sid, 'fake', 'Stop', { last_assistant_message: `main review ${round}` });

        const list = await h.peer('GET', '/api/peer/delegations', main.rec.peerToken);
        expect(list.json.tasks[0]).toMatchObject({ handle, state: 'review', round });

        if (round === MAX_DELEGATION_ROUNDS) break;
        const rw = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: handle, stdinText: `FIX-${round}` } });
        expect(rw.status).toBe(200);
        expect(rw.json.task.round).toBe(round + 1);
        expect(h.store.getTask(child.task.id)!.delegation!.round).toBe(round + 1);
      }
      expect(h.store.cards().filter(c => c.taskId === child.task.id && c.meta?.delegation === 'rework')).toHaveLength(MAX_DELEGATION_ROUNDS - 1);

      const tooMany = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: handle, note: 'again' } });
      expect(tooMany.status).toBe(409);
      expect(tooMany.json.error).toContain('返工');
      expect(h.store.getTask(child.task.id)!.delegation!.round).toBe(MAX_DELEGATION_ROUNDS);
    } finally {
      await h.close();
    }
  });

  it('done needs a delivered result, closes the child once, and handles are resolved strictly', { timeout: 30_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Settle', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main S');
      const c1 = (await delegate(h, main, { title: 'Build it', note: 'task one' })).json.task;
      const c2 = (await delegate(h, main, { title: 'Cancel Me', note: 'task two' })).json.task;
      const post = (action: string, target: string) => h.peer('POST', `/api/peer/${action}`, main.rec.peerToken, { body: { target } });

      const early = await post('done', c1.handle);
      expect(early.status).toBe(409);
      expect(early.json.error).toContain('shoal cancel');

      // Target resolution: the main task itself is not delegated, nothing matches, an id prefix that is too short.
      expect((await post('done', '#1')).status).toBe(400);
      expect((await post('done', 'zzz-nothing')).status).toBe(404);
      expect((await post('done', '')).status).toBe(400);

      const k1 = childOf(h, c1.id);
      await h.hook(k1.sid, 'fake', 'Stop', { last_assistant_message: 'built' });
      const ok = await post('done', c1.handle);
      expect(ok.status).toBe(200);
      expect(ok.json.task.state).toBe('accepted');
      const closed = h.store.getTask(c1.id)!;
      expect(closed).toMatchObject({ phase: 'archived', delegation: { outcome: 'accepted' } });
      expect(closed.delegation!.settledAt).toBeGreaterThan(0);
      expect(k1.rec.killed).toBe(true);

      const again = await post('done', c1.handle);
      expect(again.status).toBe(200);
      expect(again.json.task.state).toBe('accepted');
      expect((await post('cancel', c1.handle)).json.task.state).toBe('accepted');
      const reworkClosed = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: c1.handle, note: 'more' } });
      expect(reworkClosed.status).toBe(409);

      // Cancel works while the child is still running, found by a title fragment.
      const cancel = await post('cancel', 'cancel me');
      expect(cancel.status).toBe(200);
      expect(cancel.json.task.state).toBe('canceled');
      expect(childOf(h, c2.id).rec.killed).toBe(true);
      expect(h.store.getTask(c2.id)!.delegation!.outcome).toBe('canceled');

      const list = (await h.peer('GET', '/api/peer/delegations', main.rec.peerToken)).json;
      expect(list.tasks.map((t: any) => [t.title, t.state])).toEqual([['Build it', 'accepted'], ['Cancel Me', 'canceled']]);
    } finally {
      await h.close();
    }
  });

  it('archiving or deleting the main task cancels its open children; archiving a child cancels only that child', { timeout: 30_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Cascade', path: h.projDir })).json;
      const mainA = await startMain(h, p.id, 'Main A');
      const kidsA = [];
      for (let i = 0; i < MAX_OPEN_DELEGATIONS; i++) kidsA.push((await delegate(h, mainA, { title: `Kid ${i}`, note: `n${i}` })).json.task);
      const over = await delegate(h, mainA, { note: 'one too many' });
      expect(over.status).toBe(409);
      expect(over.json.error).toContain('shoal done');

      expect((await h.api('POST', `/api/tasks/${mainA.id}/archive`, {})).status).toBe(200);
      for (const k of kidsA) {
        expect(h.store.getTask(k.id)).toMatchObject({ phase: 'archived', delegation: { outcome: 'canceled' } });
        expect(childOf(h, k.id).rec.killed).toBe(true);
      }

      const mainB = await startMain(h, p.id, 'Main B');
      const kidB = (await delegate(h, mainB, { title: 'Kid B', note: 'b' })).json.task;
      expect((await h.api('DELETE', `/api/tasks/${mainB.id}`)).status).toBe(200);
      expect(h.store.getTask(mainB.id)).toBeUndefined();
      expect(h.store.getTask(kidB.id)).toMatchObject({ phase: 'archived', delegation: { outcome: 'canceled' } });
      expect(childOf(h, kidB.id).rec.killed).toBe(true);

      const mainC = await startMain(h, p.id, 'Main C');
      const kidC1 = (await delegate(h, mainC, { title: 'Kid C1', note: 'c1' })).json.task;
      const kidC2 = (await delegate(h, mainC, { title: 'Kid C2', note: 'c2' })).json.task;
      expect((await h.api('POST', `/api/tasks/${kidC1.id}/archive`, {})).status).toBe(200);
      expect(h.store.getTask(kidC1.id)).toMatchObject({ phase: 'archived', delegation: { outcome: 'canceled' } });
      expect(h.store.getTask(kidC2.id)!.phase).not.toBe('archived');
      expect(h.store.getTask(mainC.id)!.phase).not.toBe('archived');

      // Reopening a closed child clears its outcome.
      await h.api('POST', `/api/tasks/${kidC1.id}/unarchive`, {});
      const reopened = h.store.getTask(kidC1.id)!;
      expect(reopened.phase).toBe('active');
      expect(reopened.delegation!.outcome).toBeUndefined();
      expect(reopened.delegation!.settledAt).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('a blocked child is reported to the main task once per round', { timeout: 30_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Blocked', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main K');
      const d = (await delegate(h, main, { title: 'Needs perm', note: 'do it' })).json.task;
      const child = childOf(h, d.id);
      const blockedCards = () => h.store.cards().filter(c => c.taskId === main.id && c.meta?.delegation === 'blocked');

      await h.hook(child.sid, 'fake', 'UserPromptSubmit', { prompt: 'go' });
      await h.hook(child.sid, 'fake', 'PermissionRequest', {});
      expect(blockedCards()).toHaveLength(1);
      await waitDelivered(main.rec, '权限确认');
      expect(main.rec.written.join('')).toContain('Needs perm');

      // Same round: unblock and block again without a new notice.
      await h.hook(child.sid, 'fake', 'UserPromptSubmit', { prompt: 'continue' });
      await h.hook(child.sid, 'fake', 'PermissionRequest', {});
      expect(blockedCards()).toHaveLength(1);

      const rw = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: d.handle, note: 'again please' } });
      expect(rw.status).toBe(200);
      await h.hook(child.sid, 'fake', 'UserPromptSubmit', { prompt: 'round two' });
      await h.hook(child.sid, 'fake', 'PermissionRequest', {});
      expect(blockedCards()).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('shoal CLI: delegate --stdin, status, peers annotation and done', { timeout: 30_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Cli', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main CLI');
      const cli = path.join(h.stateDir, 'bin', 'shoal-cli.mjs');
      const run = (args: string[], stdin?: string) => runCli(process.execPath, [cli, ...args], { cwd: h.projDir, env: main.rec.env, stdin });

      const empty = await run(['status']);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain('还没有委派任务');

      const dg = await run(['delegate', 'fake', '--title', 'CLI child', '--stdin'], 'first line\nsecond line\n');
      expect(dg.code).toBe(0);
      const task = h.store.tasks().find(t => t.delegation)!;
      const handle = task.id.slice(0, 8);
      expect(dg.stdout).toContain(handle);
      expect(dg.stdout).toContain('不要等待或轮询');
      expect(dg.stdout).toContain(`shoal done ${handle}`);
      expect(task.title).toBe('CLI child');
      expect(h.spawnBySession.get(task.sessionId!)!.args.some(a => a.includes('second line'))).toBe(true);

      const status = await run(['status']);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain(handle);
      expect(status.stdout).toContain('执行中');
      expect(status.stdout).toContain('CLI child');

      const early = await run(['done', handle]);
      expect(early.code).toBe(1);
      expect(early.stderr).toContain('还没有交付结果');

      await h.hook(task.sessionId!, 'fake', 'Stop', { last_assistant_message: 'cli result' });
      expect((await run(['status'])).stdout).toContain('待验收');
      expect((await run(['peers'])).stdout).toContain('委派 · 待验收 · 第 1 轮');

      const rw = await run(['rework', handle, '--stdin'], 'please fix');
      expect(rw.code).toBe(0);
      expect(rw.stdout).toContain('第 2 轮');
      expect(rw.stdout).toContain('不要等待或轮询');

      await h.hook(task.sessionId!, 'fake', 'Stop', { last_assistant_message: 'cli result 2' });
      const done = await run(['done', handle]);
      expect(done.code).toBe(0);
      expect(done.stdout).toContain('已通过');
      expect(done.stdout).toContain(handle);
    } finally {
      await h.close();
    }
  });

  it('delegate --review makes a read-only reviewer child; without it there is no mode', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Deleg', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main R');
      const r = await delegate(h, main, { title: 'Rev', note: 'review the plan', review: true });
      expect(r.status).toBe(200);
      expect(r.json.task.mode).toBe('review');
      const rc = childOf(h, r.json.task.id);
      expect(rc.task.delegation?.mode).toBe('review');
      expect(rc.rec.args.some(a => a.includes('只读') && a.includes('结论：PASS') && a.includes('review the plan'))).toBe(true);
      // A reviewer's verdict reaches the main task as findings to rule on, not as work to accept.
      await h.hook(rc.sid, 'fake', 'UserPromptSubmit', { prompt: 'turn' });
      await h.hook(rc.sid, 'fake', 'Stop', { last_assistant_message: '结论：FAIL\nBLOCKING-MARKER' });
      await waitDelivered(main.rec, 'BLOCKING-MARKER');
      const relayed = main.rec.written.join('');
      expect(relayed).toContain('给出了评审结论');
      expect(relayed).toContain(`shoal done ${r.json.task.handle}`);
      expect(relayed).not.toContain('请验收');
      // Sending a reviewer back asks it to re-check; it must not be told to make the changes (it once edited files on rework).
      const rw = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: r.json.task.handle, note: 'RECHECK-MARKER' } });
      expect(rw.status).toBe(200);
      await waitDelivered(rc.rec, 'RECHECK-MARKER');
      const recheck = rc.rec.written.join('');
      expect(recheck).toContain('只读评审者');
      expect(recheck).not.toContain('请按下面的意见修改');
      const e = await delegate(h, main, { title: 'Exec', note: 'do it' });
      expect(e.json.task.mode).toBeUndefined();
      const ec = childOf(h, e.json.task.id);
      expect(ec.task.delegation && 'mode' in ec.task.delegation).toBe(false);
      expect(ec.rec.args.some(a => a.includes('结论：PASS'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('shoal delegate --plan makes a read-only advisor child whose plan comes back to merge, never as work to accept', { timeout: 120_000 }, async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      const p = (await h.api('POST', '/api/projects', { name: 'Deleg', path: h.projDir })).json;
      const main = await startMain(h, p.id, 'Main P');
      const cli = path.join(h.stateDir, 'bin', 'shoal-cli.mjs');
      // Both read-only modes at once is ambiguous: the CLI and the server each refuse it.
      const both = await runCli(process.execPath, [cli, 'delegate', 'fake', '--review', '--plan', '-m', 'x'], { cwd: h.projDir, env: main.rec.env });
      expect(both.code).toBe(2);
      expect(both.stderr).toContain('只能选一个');
      expect((await delegate(h, main, { note: 'x', review: true, plan: true })).status).toBe(400);

      const out = await runCli(process.execPath, [cli, 'delegate', 'fake', '--plan', '--title', 'Plan', '-m', 'design the storage'], { cwd: h.projDir, env: main.rec.env });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('只读方案顾问');
      expect(out.stdout).toContain('和你的方案合并后');
      expect(out.stdout).not.toContain('验收后');
      const list = await h.peer('GET', '/api/peer/delegations', main.rec.peerToken);
      const summary = list.json.tasks.find((t: { title: string }) => t.title === 'Plan');
      expect(summary.mode).toBe('plan');
      const pc = childOf(h, summary.id);
      expect(pc.task.delegation?.mode).toBe('plan');
      const first = pc.rec.args.find(a => a.includes('design the storage')) ?? '';
      expect(first).toContain('方案顾问');
      expect(first).toContain('只读');
      expect(first).not.toContain('子任务执行者');
      expect(first).not.toContain('结论：PASS');

      await h.hook(pc.sid, 'fake', 'UserPromptSubmit', { prompt: 'turn' });
      await h.hook(pc.sid, 'fake', 'Stop', { last_assistant_message: 'PLAN-MARKER' });
      await waitDelivered(main.rec, 'PLAN-MARKER');
      const relayed = main.rec.written.join('');
      expect(relayed).toContain('独立方案');
      expect(relayed).toContain('合并');
      expect(relayed).not.toContain('请验收');

      const st = await runCli(process.execPath, [cli, 'status'], { cwd: h.projDir, env: main.rec.env });
      expect(st.stdout).toContain(`${summary.handle} [fake · 方案] Plan`);
      const rw = await runCli(process.execPath, [cli, 'rework', summary.handle, '-m', 'FOLLOWUP-MARKER'], { cwd: h.projDir, env: main.rec.env });
      expect(rw.code).toBe(0);
      expect(rw.stdout).toContain('已请方案顾问补充');
      await waitDelivered(pc.rec, 'FOLLOWUP-MARKER');
      const followup = pc.rec.written.join('');
      expect(followup).toContain('只读的方案顾问');
      expect(followup).not.toContain('请按下面的意见修改');
      expect(followup).not.toContain('结论：PASS');

      // Up to the shared round cap: the last relay offers no rework, and a rework past it is refused with advisor wording.
      for (let round = 2; round <= MAX_DELEGATION_ROUNDS; round++) {
        await h.hook(pc.sid, 'fake', 'UserPromptSubmit', { prompt: 'turn' });
        await h.hook(pc.sid, 'fake', 'Stop', { last_assistant_message: `PLAN-R${round}` });
        await waitDelivered(main.rec, `PLAN-R${round}`);
        // Each relay starts a new main-task turn; the per-turn send cap counts within one turn.
        await h.hook(main.sid, 'fake', 'UserPromptSubmit', { prompt: 'plan pasted' });
        await h.hook(main.sid, 'fake', 'Stop', { last_assistant_message: `main merge ${round}` });
        if (round < MAX_DELEGATION_ROUNDS) {
          const more = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: summary.handle, note: `ASK-R${round + 1}` } });
          expect(more.status).toBe(200);
          await waitDelivered(pc.rec, `ASK-R${round + 1}`);
        }
      }
      const lastRelay = main.rec.written.join('').split(`PLAN-R${MAX_DELEGATION_ROUNDS}`).pop() ?? '';
      expect(lastRelay).toContain('不能再追问');
      expect(lastRelay).not.toContain(`shoal rework ${summary.handle}`);
      const capped = await h.peer('POST', '/api/peer/rework', main.rec.peerToken, { body: { target: summary.handle, note: 'too many' } });
      expect(capped.status).toBe(409);
      expect(JSON.stringify(capped.json)).toContain('问用户');
      expect(JSON.stringify(capped.json)).not.toContain('自己接手修改');
    } finally {
      await h.close();
    }
  });

  it('settings validate, store and reset delegationRules', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      expect(h.store.settings().delegationRules).toBeUndefined();
      // Settings opens with the default text; over the cap the user could not save even a small edit of it.
      expect([...DEFAULT_DELEGATION_RULES].length).toBeLessThanOrEqual(DELEGATION_RULES_MAX);
      expect((await h.api('POST', '/api/settings', { delegationRules: 5 })).status).toBe(400);
      expect((await h.api('POST', '/api/settings', { delegationRules: 'x'.repeat(DELEGATION_RULES_MAX + 1) })).status).toBe(400);
      expect(h.store.settings().delegationRules).toBeUndefined();
      expect((await h.api('POST', '/api/settings', { delegationRules: 'x'.repeat(DELEGATION_RULES_MAX) })).status).toBe(200);
      expect((await h.api('POST', '/api/settings', { delegationRules: '' })).status).toBe(200);
      expect(h.store.settings().delegationRules).toBe('');
      await h.api('POST', '/api/settings', { delegationRules: 'my rules' });
      expect(h.store.settings().delegationRules).toBe('my rules');
      expect(h.store.settings().autoDelegate).toBe(true);
      const reset = await h.api('POST', '/api/settings', { delegationRules: null });
      expect(reset.status).toBe(200);
      expect('delegationRules' in h.store.settings()).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('composeDelegationInstructions lists only installed CLIs and the custom rules', () => {
    const withRules = composeDelegationInstructions({ host: 'claude', available: ['claude', 'codex'], rules: '  RULE-MARKER  ' });
    expect(withRules).toContain(DELEGATION_INSTRUCTIONS);
    expect(withRules).toContain('This session runs Claude Code. CLIs installed in this Shoal: Claude Code, Codex. Only these');
    expect(withRules).not.toContain('Antigravity.');
    expect(withRules.endsWith('## 分工与评审规则（Shoal 设置，用户可修改）\nRULE-MARKER')).toBe(true);
    const none = composeDelegationInstructions({ host: 'codex', available: ['codex'], rules: '  ' });
    expect(none).not.toContain('分工与评审规则');
  });

  it('settings accept a boolean autoDelegate and richOutputHints and keep both on by default', async () => {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const h = await setupHarness();
    try {
      expect(h.store.settings().autoDelegate).toBe(true);
      expect(h.store.settings().richOutputHints).toBe(true);
      expect((await h.api('POST', '/api/settings', { autoDelegate: 'no' })).status).toBe(400);
      expect((await h.api('POST', '/api/settings', { richOutputHints: 'no' })).status).toBe(400);
      const off = await h.api('POST', '/api/settings', { autoDelegate: false, richOutputHints: false });
      expect(off.status).toBe(200);
      expect(off.json.autoDelegate).toBe(false);
      expect(off.json.richOutputHints).toBe(false);
      expect(h.store.settings().autoDelegate).toBe(false);
      expect(h.store.settings().richOutputHints).toBe(false);

      const onlyRich = composeSessionInstructions({ host: 'agy', available: ['agy'], autoDelegate: false, rules: '', richOutputHints: true });
      expect(onlyRich).toBe(RICH_OUTPUT_INSTRUCTIONS);
      const both = composeSessionInstructions({ host: 'agy', available: ['agy', 'codex'], autoDelegate: true, rules: '', richOutputHints: true });
      expect(both).toContain(DELEGATION_INSTRUCTIONS);
      expect(both).toContain(RICH_OUTPUT_INSTRUCTIONS);
      const neither = composeSessionInstructions({ host: 'agy', available: ['agy'], autoDelegate: false, rules: '', richOutputHints: false });
      expect(neither).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
