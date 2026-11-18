import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileAdminStatus, MobilePairClaimResult, ServerMsg, Snapshot, TaskConversationResponse } from '../shared/protocol.ts';
import { createApp } from './http.ts';
import { sanitizeTaskForMobile, scrubErrorForMobile, scrubStatePaths } from './mobile.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function rawHttp(port: number, method: string, reqPath: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('mobile gateway & security integration', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const prevFake = process.env.WORKBENCH_FAKE_AGENT;

  afterEach(async () => {
    process.env.WORKBENCH_FAKE_AGENT = prevFake;
    vi.restoreAllMocks();
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  async function bootApp() {
    process.env.WORKBENCH_FAKE_AGENT = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-mob-'));
    const repo = path.join(tmp, 'proj');
    fs.mkdirSync(repo, { recursive: true });
    const mainPort = await getFreePort();
    const sessions = new SessionManager({ port: mainPort, token: 'hook-tok', stateDir: tmp });
    const store = createFileStore(path.join(tmp, 'state.json'));
    const usage = createUsage({
      stateDir: tmp,
      source: { sessions: () => sessions.list(), tasks: () => store.tasks(), projects: () => store.projects() },
    });
    const app = createApp({
      port: mainPort,
      mobilePort: 0,
      token: 'hook-tok',
      store,
      sessions,
      stateDir: tmp,
      usage,
    });
    await new Promise<void>(resolve => app.server.listen(mainPort, '127.0.0.1', resolve));
    await app.mobile.ready();

    cleanups.push(async () => {
      await app.mobile.close();
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    });

    return { tmp, repo, mainPort, sessions, store, app };
  }

  it('enforces pairing security, anti-brute-force, zero-loopback auth bypass, route cropping, zero resize, and instant WS revocation', async () => {
    const { tmp, repo, mainPort, sessions, store, app } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;

    // Create a desktop project + task first.
    const projRes = await fetch(`${baseMain}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DemoProj', path: repo }),
    });
    expect(projRes.status).toBe(200);
    const project = (await projRes.json()) as { id: string; path: string };

    const taskRes = await fetch(`${baseMain}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, agent: 'fake', title: '初始任务', cols: 118, rows: 44 }),
    });
    expect(taskRes.status).toBe(200);
    const createdTask = (await taskRes.json()) as { task: { id: string }; session: { id: string; cols: number; rows: number } };

    // Enable mobile gateway on 47801 (ephemeral).
    const enableRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, lanEnabled: false }),
    });
    expect(enableRes.status).toBe(200);
    const st = (await enableRes.json()) as MobileAdminStatus;
    expect(st.listening).toBe(true);
    expect(st.listenHost).toBe('127.0.0.1');
    const mobPort = st.actualPort!;
    expect(mobPort).toBeGreaterThan(0);
    const mobOrigin = `http://127.0.0.1:${mobPort}`;

    // 1) Security checks BEFORE pairing:
    // - Loopback + X-Forwarded-For MUST NOT bypass auth!
    const unauthState = await rawHttp(mobPort, 'GET', '/api/state', {
      host: `127.0.0.1:${mobPort}`,
      'x-forwarded-for': '127.0.0.1',
    });
    expect(unauthState.status).toBe(401);

    // - Spoofed Host -> 403
    const badHost = await rawHttp(mobPort, 'GET', '/api/state', { host: 'evil.example.com' });
    expect(badHost.status).toBe(403);

    // - Admin endpoints on mobile port -> 403
    const adminOnMob = await rawHttp(mobPort, 'POST', '/api/mobile/admin/pair/start', {
      host: `127.0.0.1:${mobPort}`,
      origin: mobOrigin,
      'x-shoal-mobile': '1',
      'content-type': 'application/json',
    }, '{}');
    expect(adminOnMob.status).toBe(403);

    // - Unauthenticated WebSocket upgrade -> non-101 failure
    await expect(new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mobPort}/ws`, { headers: { origin: mobOrigin } });
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`status:${res.statusCode}`)));
      ws.on('error', reject);
    })).rejects.toThrow('status:401');

    // 2) Start pairing & test 3-wrong-PIN brute-force lockout:
    const pairStart1 = (await (await fetch(`${baseMain}/api/mobile/admin/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json()) as MobileAdminStatus;
    const tok1 = pairStart1.activePair!.pairUrl.split('#pair=')[1];
    expect(tok1).toBeTruthy();

    // Missing X-Shoal-Mobile CSRF header -> 403
    const noCsrfClaim = await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: tok1 }),
    });
    expect(noCsrfClaim.status).toBe(403);

    const claim1Res = await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ pairToken: tok1, deviceName: 'Pixel 9' }),
    });
    expect(claim1Res.status).toBe(200);
    const claim1 = (await claim1Res.json()) as MobilePairClaimResult;
    expect(claim1.code).toMatch(/^\d{6}$/);

    // Admin view MUST NEVER leak the 6-digit PIN!
    const adminPoll = (await (await fetch(`${baseMain}/api/mobile/admin/status`)).json()) as MobileAdminStatus;
    expect(JSON.stringify(adminPoll.activePair)).not.toContain(claim1.code);

    // Re-claiming same token fails
    const reclaim = await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ pairToken: tok1 }),
    });
    expect(reclaim.status).toBe(400);

    // 3 wrong PIN guesses lock out & destroy challenge
    for (let i = 0; i < 3; i++) {
      const badCode = claim1.code === '000000' ? '111111' : '000000';
      const r = await fetch(`${baseMain}/api/mobile/admin/pair/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: badCode }),
      });
      expect(r.status).toBe(i === 2 ? 410 : 400);
    }
    const redeemDead = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ claimId: claim1.claimId, claimSecret: claim1.claimSecret }),
    });
    expect(redeemDead.status).toBe(410);
    expect(await redeemDead.json()).toMatchObject({ code: 'pair-expired' });

    // 3) Happy-path pairing: start -> claim -> approve with exact PIN -> redeem cookie
    const pairStart2 = (await (await fetch(`${baseMain}/api/mobile/admin/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json()) as MobileAdminStatus;
    const tok2 = pairStart2.activePair!.pairUrl.split('#pair=')[1];
    const claim2 = (await (await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ pairToken: tok2, deviceName: 'Pixel 9 Pro' }),
    })).json()) as MobilePairClaimResult;

    const appRes = await fetch(`${baseMain}/api/mobile/admin/pair/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: claim2.code }),
    });
    expect(appRes.status).toBe(200);

    const redeemOk = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ claimId: claim2.claimId, claimSecret: claim2.claimSecret }),
    });
    expect(redeemOk.status).toBe(200);
    const setCookie = redeemOk.headers.get('set-cookie') ?? '';
    // The phone may never see that response: its next poll gets the same approval; a wrong secret is told apart.
    const redeemAgain = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ claimId: claim2.claimId, claimSecret: claim2.claimSecret }),
    });
    expect(redeemAgain.status).toBe(200);
    expect((redeemAgain.headers.get('set-cookie') ?? '').split(';')[0]).toBe(setCookie.split(';')[0]);
    const redeemWrong = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ claimId: claim2.claimId, claimSecret: 'not-the-secret' }),
    });
    expect(redeemWrong.status).toBe(403);
    expect(await redeemWrong.json()).toMatchObject({ code: 'pair-mismatch' });
    expect(setCookie).toContain('shoal_mobile=');
    expect(setCookie).toContain('HttpOnly');
    const cookiePair = setCookie.split(';')[0];
    const rawDeviceToken = cookiePair.split('.')[1];

    // Verify mobile.json on disk stores SHA-256 hash ONLY, never raw token!
    const mobileDiskRaw = fs.readFileSync(path.join(tmp, 'mobile.json'), 'utf8');
    expect(mobileDiskRaw).not.toContain(rawDeviceToken);
    expect(mobileDiskRaw).toContain(crypto.createHash('sha256').update(rawDeviceToken).digest('hex'));

    // 4) Authenticated mobile requests: verify path sanitization & dangerous route cropping (403):
    const mobStateRes = await fetch(`${mobOrigin}/api/state`, { headers: { cookie: cookiePair } });
    expect(mobStateRes.status).toBe(200);
    const mobState = (await mobStateRes.json()) as Snapshot;
    expect(mobState.projects[0].path).toBe('');
    expect(mobState.sessions[0].transcriptPath).toBeUndefined();

    for (const [m, p] of [
      ['GET', '/api/dirs'],
      ['POST', '/api/shutdown'],
      ['POST', '/api/open'],
      ['PUT', `/api/projects/${project.id}/file`],
      ['POST', `/api/projects/${project.id}/discard`],
      ['DELETE', `/api/tasks/${createdTask.task.id}`],
      ['DELETE', `/api/projects/${project.id}`],
    ] as const) {
      const blocked = await fetch(`${mobOrigin}${p}`, {
        method: m,
        headers: { cookie: cookiePair, 'content-type': 'application/json', 'x-shoal-mobile': '1' },
        body: m === 'GET' ? undefined : '{}',
      });
      expect(blocked.status, `${m} ${p} should be forbidden on mobile`).toBe(403);
    }

    // Attachment upload returns basename only; feedback resolves it server-side & enforces 120x40 default cols/rows
    const uploadRes = await fetch(`${mobOrigin}/api/attachments`, {
      method: 'POST',
      headers: { cookie: cookiePair, 'content-type': 'image/png', 'x-shoal-mobile': '1' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(uploadRes.status).toBe(200);
    const upJson = (await uploadRes.json()) as { name?: string; path?: string };
    expect(upJson.name).toMatch(/^\d+-[0-9a-f]{8}\.png$/);
    expect(upJson.path).toBeUndefined();

    // Send mobile feedback with attachment -> desktop PTY cols/rows stay intact, disk paths are scrubbed
    const fbRes = await fetch(`${mobOrigin}/api/tasks/${createdTask.task.id}/feedback`, {
      method: 'POST',
      headers: { cookie: cookiePair, 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ text: '看图定位问题', mode: 'same', attachments: [upJson.name] }),
    });
    expect(fbRes.status).toBe(200);
    const fbJson = (await fbRes.json()) as { card: { body: string }; session: { cols: number; rows: number } };
    expect(fbJson.card.body).toContain(`[图片附件: ${upJson.name}]`);
    expect(fbJson.card.body).not.toContain(tmp);
    expect(sessions.list().find(s => s.id === createdTask.session.id)?.cols).toBe(118);

    // Record a transcriptPath via /hook -> /api/mobile/tasks/:id/conversation reads transcript on server
    const transcriptFile = path.join(tmp, 'fake-transcript.jsonl');
    fs.writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ role: 'user', text: '转写内用户需求' }),
        JSON.stringify({ role: 'assistant', text: '转写内回复内容' }),
      ].join('\n'),
    );
    const hookRes = await fetch(`${baseMain}/hook`, {
      method: 'POST',
      headers: { authorization: 'Bearer hook-tok', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: createdTask.session.id,
        agent: 'fake',
        event: 'Stop',
        at: Date.now(),
        payload: { transcript_path: transcriptFile },
      }),
    });
    expect(hookRes.status).toBe(204);

    const convRes = await fetch(`${mobOrigin}/api/mobile/tasks/${createdTask.task.id}/conversation`, {
      headers: { cookie: cookiePair },
    });
    expect(convRes.status).toBe(200);
    const conv = (await convRes.json()) as TaskConversationResponse;
    expect(conv.items.some(i => i.kind === 'assistant' && i.text.includes('转写内回复内容'))).toBe(true);
    expect(conv.items.some(i => i.kind === 'user' && i.text.includes(`[图片附件: ${upJson.name}]`))).toBe(true);
    expect(JSON.stringify(conv)).not.toContain(tmp);

    // After feedback card + state update, GET /api/state still scrubs disk paths everywhere
    const mobState2 = (await (await fetch(`${mobOrigin}/api/state`, { headers: { cookie: cookiePair } })).json()) as Snapshot;
    expect(JSON.stringify(mobState2.cards)).not.toContain(tmp);

    // Inject a custom-drive project + task outside homedir/tmpdir so WS initial snapshot must scrub via getExtraDirs().
    store.addProject({ id: 'p-custom-drive', name: 'CustomDriveProj', path: 'Z:\\secret-enterprise-repo', createdAt: 2 });
    store.addTask({
      id: 't-custom-drive',
      projectId: 'p-custom-drive',
      title: '盘符脱敏',
      titleAuto: false,
      color: '#90b5dc',
      prompt: '读取（Z:\\secret-enterprise-repo\\config.yaml）并检查',
      agent: 'fake',
      phase: 'active',
      phaseSince: 2,
      sessionId: null,
      createdAt: 2,
    });

    // 5) WebSocket connection: no replays on connect, resize ignored, watch-term works, revoke disconnects immediately!
    const resizeSpy = vi.spyOn(sessions, 'resize');
    const msgs: ServerMsg[] = [];
    let clientWs!: WebSocket;
    const wsClosed = new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mobPort}/ws`, {
        headers: { cookie: cookiePair, origin: mobOrigin },
      });
      clientWs = ws;
      ws.on('message', data => {
        const msg = JSON.parse(data.toString()) as ServerMsg;
        msgs.push(msg);
      });
      ws.on('close', code => resolve({ code }));
    });

    await vi.waitFor(() => expect(msgs.some(m => m.t === 'snapshot')).toBe(true));
    const initSnap = msgs.find((m): m is Extract<ServerMsg, { t: 'snapshot' }> => m.t === 'snapshot')!;
    expect(JSON.stringify(initSnap.state)).not.toContain('secret-enterprise-repo');
    expect(initSnap.state.projects.find(p => p.id === 'p-custom-drive')?.path).toBe('');
    expect(initSnap.state.tasks.find(t => t.id === 't-custom-drive')?.prompt).toBe('读取（[本机路径]）并检查');
    await new Promise(r => setTimeout(r, 60));
    expect(msgs.filter(m => m.t === 'replay')).toHaveLength(0);

    clientWs.send(JSON.stringify({ t: 'resize', id: createdTask.session.id, cols: 38, rows: 20 }));
    clientWs.send(JSON.stringify({ t: 'ping', ts: 12345 }));
    clientWs.send(JSON.stringify({ t: 'watch-term', id: createdTask.session.id }));
    await vi.waitFor(() => expect(msgs.some(m => m.t === 'pong')).toBe(true));
    await new Promise(r => setTimeout(r, 60));
    expect(resizeSpy).not.toHaveBeenCalled();

    // Revoke device on desktop -> mobile WS gets 'revoked' and closes cleanly
    const devices = (await (await fetch(`${baseMain}/api/mobile/admin/status`)).json()) as MobileAdminStatus;
    const revRes = await fetch(`${baseMain}/api/mobile/admin/devices/${devices.devices[0].id}`, { method: 'DELETE' });
    expect(revRes.status).toBe(200);

    const closed = await wsClosed;
    expect(closed.code).toBe(4001);
    expect(msgs.some(m => m.t === 'revoked')).toBe(true);

    // Subsequent HTTP call with revoked cookie -> 401
    const afterRevoke = await fetch(`${mobOrigin}/api/state`, { headers: { cookie: cookiePair } });
    expect(afterRevoke.status).toBe(401);
  });

  async function pairPhone(baseMain: string) {
    const st = (await (await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, lanEnabled: false }),
    })).json()) as MobileAdminStatus;
    const mobOrigin = `http://127.0.0.1:${st.actualPort}`;
    const start = (await (await fetch(`${baseMain}/api/mobile/admin/pair/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json()) as MobileAdminStatus;
    const claim = (await (await fetch(`${mobOrigin}/api/mobile/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ pairToken: start.activePair!.pairUrl.split('#pair=')[1], deviceName: 'Pixel' }),
    })).json()) as MobilePairClaimResult;
    await fetch(`${baseMain}/api/mobile/admin/pair/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: claim.code }),
    });
    const redeem = await fetch(`${mobOrigin}/api/mobile/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }),
    });
    const cookie = (redeem.headers.get('set-cookie') ?? '').split(';')[0];
    const call = (method: string, p: string, body?: unknown) => fetch(`${mobOrigin}${p}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'x-shoal-mobile': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { call };
  }

  async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 25));
    }
  }

  it('answers a blocked prompt only while the same prompt waits, replays retried feedback, and binds approval to the round', async () => {
    const { repo, mainPort, sessions, store } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;
    const project = (await (await fetch(`${baseMain}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'P', path: repo }),
    })).json()) as { id: string };
    const created = (await (await fetch(`${baseMain}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, agent: 'fake', title: 't', cols: 100, rows: 30 }),
    })).json()) as { task: { id: string }; session: { id: string } };
    const taskId = created.task.id;
    const sid = created.session.id;
    const { call } = await pairPhone(baseMain);
    const promptPath = `/api/mobile/tasks/${taskId}/prompt`;
    const answerPath = `/api/mobile/tasks/${taskId}/prompt-answer`;
    const sessionOf = () => sessions.list().find(s => s.id === sid);

    expect(await (await call('GET', promptPath)).json()).toEqual({ prompt: null });

    await waitFor(() => sessions.replayOf(sid)?.includes('> '));
    sessions.input(sid, 'ask\r');
    await waitFor(() => sessionOf()?.blocked === 'permission');
    const { prompt } = (await (await call('GET', promptPath)).json()) as {
      prompt: { kind: string; lines: string[]; keys: { data: string }[]; fingerprint: string };
    };
    expect(prompt.kind).toBe('yn');
    expect(prompt.lines.at(-1)).toContain('Allow? (y/n)');
    expect(prompt.keys.map(k => k.data)).toEqual(['y', 'n']);

    expect((await call('POST', answerPath, { fingerprint: prompt.fingerprint, data: 'x' })).status).toBe(400);
    const wrongFp = await call('POST', answerPath, { fingerprint: 'nope', data: 'y' });
    expect(wrongFp.status).toBe(409);
    expect(await wrongFp.json()).toMatchObject({ code: 'stale' });

    // A double tap: the first answer clears the block, so the second no longer matches and writes nothing.
    const writes = vi.spyOn(sessions, 'input');
    const both = await Promise.all([0, 1].map(() => call('POST', answerPath, { fingerprint: prompt.fingerprint, data: 'y' })));
    expect(both.map(r => r.status).sort()).toEqual([200, 409]);
    expect(writes.mock.calls.filter(c => c[0] === sid && c[1] === 'y')).toHaveLength(1);
    writes.mockRestore();

    // The desktop answers while the phone's answer is being checked: the phone's answer is refused, not written.
    await waitFor(() => !sessionOf()?.blocked && sessionOf()?.status !== 'working');
    sessions.input(sid, 'ask\r');
    await waitFor(() => sessionOf()?.blocked === 'permission');
    const asked = ((await (await call('GET', promptPath)).json()) as { prompt: { fingerprint: string } }).prompt;
    const seq = sessions.promptWait(sid)!.waitSeq;
    expect(sessions.answerPrompt(sid, seq + 1, 'y')).toBe(false);
    const realWait = sessions.promptWait.bind(sessions);
    const wait = vi.spyOn(sessions, 'promptWait').mockImplementationOnce(id => {
      const w = realWait(id);
      queueMicrotask(() => sessions.input(sid, 'n'));
      return w;
    });
    const raceWrites = vi.spyOn(sessions, 'input');
    const raced = await call('POST', answerPath, { fingerprint: asked.fingerprint, data: 'y' });
    expect(raced.status).toBe(409);
    expect(raceWrites.mock.calls.filter(c => c[0] === sid && c[1] === 'y')).toHaveLength(0);
    raceWrites.mockRestore();
    wait.mockRestore();

    // Feedback retried with the same clientMsgId is delivered once and answered with the first result.
    await waitFor(() => !sessionOf()?.blocked && sessionOf()?.status !== 'working');
    const fbPath = `/api/tasks/${taskId}/feedback`;
    expect((await call('POST', fbPath, { text: 'x', mode: 'same', clientMsgId: 'bad id!' })).status).toBe(400);
    const cardsBefore = store.cards().length;
    const first = (await (await call('POST', fbPath, { text: 'deliver once', mode: 'same', clientMsgId: 'retry-0001' })).json()) as { card: { id: string } };
    const again = (await (await call('POST', fbPath, { text: 'deliver once', mode: 'same', clientMsgId: 'retry-0001' })).json()) as { card: { id: string } };
    expect(again.card.id).toBe(first.card.id);
    expect(store.cards().length).toBe(cardsBefore + 1);

    // Approval only applies to the review round the phone saw.
    const t0 = store.getTask(taskId)!;
    store.updateTask({ ...t0, phase: 'review', phaseSince: 1000 });
    const stale = await call('POST', `/api/tasks/${taskId}/approve`, { phaseSince: 999 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale-round' });
    expect((await call('POST', `/api/tasks/${taskId}/approve`, {})).status).toBe(409);
    const ok = await call('POST', `/api/tasks/${taskId}/approve`, { phaseSince: 1000 });
    expect(ok.status).toBe(200);
    expect(store.getTask(taskId)?.phase).toBe('approved');
    expect((await call('POST', `/api/tasks/${taskId}/approve`, { phaseSince: 1000 })).status).toBe(409);
  }, 30_000);

  it('rejects tunnel host requests without valid Cloudflare Access JWT when configured', async () => {
    const { mainPort } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;
    const cfgRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        lanEnabled: false,
        publicOrigin: 'https://shoal-test.example.com',
        cfAccessTeamDomain: 'shoal-team.cloudflareaccess.com',
        cfAccessAud: 'aud-secret-123',
      }),
    });
    expect(cfgRes.status).toBe(200);
    const st = (await cfgRes.json()) as MobileAdminStatus;
    const mobPort = st.actualPort!;

    // Accessing with the configured public tunnel Host without Cf-Access-Jwt-Assertion -> 403
    const denied = await rawHttp(mobPort, 'GET', '/api/mobile/session', {
      host: 'shoal-test.example.com',
      'cf-connecting-ip': '203.0.113.5',
      'cf-ray': 'ray-123',
    });
    expect(denied.status).toBe(403);
  });

  it('survives malformed URLs on both main and mobile HTTP/Upgrade servers with 400', async () => {
    const { mainPort } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;
    const cfg = (await (await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })).json()) as MobileAdminStatus;
    const mobPort = cfg.actualPort!;

    const rawSocket = (port: number, payload: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port });
        let data = '';
        sock.setTimeout(3000);
        sock.on('connect', () => sock.write(payload));
        sock.on('data', chunk => { data += chunk.toString('utf8'); });
        sock.on('end', () => resolve(data));
        sock.on('timeout', () => { sock.destroy(); resolve(data); });
        sock.on('error', reject);
      });

    const badMobileHttp = await rawSocket(mobPort, `GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${mobPort}\r\nConnection: close\r\n\r\n`);
    expect(badMobileHttp).toContain('400');

    const badMainHttp = await rawSocket(mainPort, `GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${mainPort}\r\nConnection: close\r\n\r\n`);
    expect(badMainHttp).toContain('400');

    const badMobUpgrade = await rawSocket(
      mobPort,
      `GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1:${mobPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    expect(badMobUpgrade).toContain('400 Bad Request');

    // Both servers keep running normally after malformed requests.
    const alive = await rawHttp(mobPort, 'GET', '/api/mobile/session', { host: `127.0.0.1:${mobPort}` });
    expect(alive.status).toBe(200);
  });

  it('scrubs lastPrompt, Chinese-bracketed paths, homedir transcript paths, and WorkspaceError messages while preserving attachment names', () => {
    const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-scrub-state-'));
    cleanups.push(async () => { fs.rmSync(tmpState, { recursive: true, force: true }); });
    const homeSecret = path.join(os.homedir(), '.claude', 'projects', 'demo', 'trace.jsonl');
    const noteSecret = path.join(os.homedir(), 'secret-notes', 'plan.md');
    const customRepo = 'D:\\custom-secret-repo\\src\\index.ts';

    const sanitized = sanitizeTaskForMobile(
      {
        id: 't1',
        projectId: 'p1',
        title: '测试脱敏',
        titleAuto: false,
        color: '#90b5dc',
        prompt: `附图 ${path.join(tmpState, 'attachments', 'pic.png')}`,
        lastPrompt: `看(${noteSecret})，补充`,
        agent: 'claude',
        phase: 'active',
        phaseSince: 1,
        sessionId: null,
        createdAt: 1,
      },
      tmpState,
    );
    expect(sanitized.prompt).toContain('[图片附件: pic.png]');
    expect(sanitized.prompt).not.toContain(tmpState);
    expect(sanitized.lastPrompt).toBe('看([本机路径])，补充');
    expect(sanitized.lastPrompt).not.toContain(os.homedir());

    const sanitizedFullwidth = sanitizeTaskForMobile(
      { ...sanitized, prompt: `看（${noteSecret}）补充`, lastPrompt: `见「${noteSecret}」、补充` },
      tmpState,
    );
    expect(sanitizedFullwidth.prompt).toBe('看（[本机路径]）补充');
    expect(sanitizedFullwidth.lastPrompt).toBe('见「[本机路径]」、补充');

    const handoffScrubbed = scrubStatePaths(
      `完整对话记录在 ${homeSecret}。项目文件 ${customRepo}。`,
      tmpState,
      ['D:\\custom-secret-repo'],
    );
    expect(handoffScrubbed).toBe('完整对话记录在 [本机路径]。项目文件 [本机路径]。');

    const errScrubbed = scrubErrorForMobile('项目目录不存在：D:\\very-secret\\repo', tmpState);
    expect(errScrubbed).toBe('项目目录不存在：[本机路径]');
  });

  it('ignores spoofed CF-Connecting-IP when tunnel/Access verification is not enabled and enforces sockIp rate limit', async () => {
    const { mainPort } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;
    const cfg = (await (await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        publicOrigin: 'https://shoal-spoof.example.com',
        tunnelEnabled: false,
        cfAccessTeamDomain: '',
        cfAccessAud: '',
      }),
    })).json()) as MobileAdminStatus;
    const mobPort = cfg.actualPort!;

    for (let i = 1; i <= 5; i += 1) {
      const failRes = await rawHttp(
        mobPort,
        'POST',
        '/api/mobile/pair/claim',
        {
          host: 'shoal-spoof.example.com',
          origin: 'https://shoal-spoof.example.com',
          'x-shoal-mobile': '1',
          'content-type': 'application/json',
          'cf-ray': `fake-ray-${i}`,
          'cf-connecting-ip': `203.0.113.${10 + i}`,
        },
        JSON.stringify({ pairToken: `bad-${i}` }),
      );
      expect(failRes.status).toBe(400);
    }

    const limitedRes = await rawHttp(
      mobPort,
      'POST',
      '/api/mobile/pair/claim',
      {
        host: 'shoal-spoof.example.com',
        origin: 'https://shoal-spoof.example.com',
        'x-shoal-mobile': '1',
        'content-type': 'application/json',
        'cf-ray': 'fake-ray-6',
        'cf-connecting-ip': '203.0.113.99',
      },
      JSON.stringify({ pairToken: 'bad-6' }),
    );
    expect(limitedRes.status).toBe(429);
  });

  it('infers tunnelMode backward-compatibly, rejects SSRF webhooks, and masks Telegram tokens', async () => {
    // 1) Legacy mobile.json without tunnelMode but with publicOrigin/token infers 'named'.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-mob-legacy-'));
    cleanups.push(async () => {
      fs.rmSync(legacyDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    });
    fs.writeFileSync(
      path.join(legacyDir, 'mobile.json'),
      JSON.stringify({
        version: 1,
        config: {
          enabled: false,
          lanEnabled: false,
          keepAwake: false,
          publicOrigin: 'https://legacy.example.com',
          tunnelEnabled: false,
          tunnelToken: 'eyJhIjoiYWJjZGVmZ2hpamsiLCJ0IjoidHVubmVsIn0=',
        },
        devices: [],
      }),
    );
    const legacyPort = await getFreePort();
    const legacySessions = new SessionManager({ port: legacyPort, token: 'tok', stateDir: legacyDir });
    const legacyStore = createFileStore(path.join(legacyDir, 'state.json'));
    const legacyUsage = createUsage({
      stateDir: legacyDir,
      source: { sessions: () => legacySessions.list(), tasks: () => legacyStore.tasks(), projects: () => legacyStore.projects() },
    });
    const legacyApp = createApp({
      port: legacyPort,
      mobilePort: 0,
      token: 'tok',
      store: legacyStore,
      sessions: legacySessions,
      stateDir: legacyDir,
      usage: legacyUsage,
    });
    await new Promise<void>(resolve => legacyApp.server.listen(legacyPort, '127.0.0.1', resolve));
    await legacyApp.mobile.ready();
    cleanups.push(async () => {
      await legacyApp.mobile.close();
      await legacySessions.killAll();
      await new Promise<void>(resolve => legacyApp.server.close(() => resolve()));
    });
    expect(legacyApp.mobile.adminStatus().config.tunnelMode).toBe('named');

    // 2) Fresh mobile.json defaults to 'quick', validates webhooks against SSRF, and masks Telegram token.
    const { mainPort } = await bootApp();
    const baseMain = `http://127.0.0.1:${mainPort}`;
    const initSt = (await (await fetch(`${baseMain}/api/mobile/admin/status`)).json()) as MobileAdminStatus;
    expect(initSt.config.tunnelMode).toBe('quick');

    // Turn off fake-agent bypass briefly when testing real SSRF gate on config update.
    process.env.WORKBENCH_FAKE_AGENT = '0';
    const badHookRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feishuWebhookUrl: 'https://192.168.1.20/hook' }),
    });
    expect(badHookRes.status).toBe(400);

    const tgRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tunnelMode: 'named',
        feishuWebhookUrl: 'https://api.telegram.org/bot998877:SECRET_TOKEN/sendMessage?chat_id=-1001234',
      }),
    });
    expect(tgRes.status).toBe(200);
    const tgSt = (await tgRes.json()) as MobileAdminStatus;
    expect(tgSt.config.tunnelMode).toBe('named');
    expect(tgSt.config.feishuWebhookUrlMasked).toBe('https://api.telegram.org/bot****/sendMessage');
    expect(JSON.stringify(tgSt)).not.toContain('SECRET_TOKEN');

    // Half-configured Cloudflare Access (domain without AUD, or AUD without domain) must fail 400.
    const halfDomainRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cfAccessTeamDomain: 'team-x', cfAccessAud: '' }),
    });
    expect(halfDomainRes.status).toBe(400);

    const halfAudRes = await fetch(`${baseMain}/api/mobile/admin/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cfAccessTeamDomain: '', cfAccessAud: 'aud-only' }),
    });
    expect(halfAudRes.status).toBe(400);

    // Corrupted field types in hand-edited mobile.json degrade cleanly without crashing.
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-mob-corrupt-'));
    cleanups.push(async () => {
      fs.rmSync(corruptDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    });
    fs.writeFileSync(
      path.join(corruptDir, 'mobile.json'),
      JSON.stringify({ version: 1, config: { enabled: 'yes', tunnelToken: 12345, publicOrigin: null } }),
    );
    const corruptPort = await getFreePort();
    const corruptSessions = new SessionManager({ port: corruptPort, token: 'tok', stateDir: corruptDir });
    const corruptStore = createFileStore(path.join(corruptDir, 'state.json'));
    const corruptUsage = createUsage({
      stateDir: corruptDir,
      source: { sessions: () => corruptSessions.list(), tasks: () => corruptStore.tasks(), projects: () => corruptStore.projects() },
    });
    const corruptApp = createApp({
      port: corruptPort,
      mobilePort: 0,
      token: 'tok',
      store: corruptStore,
      sessions: corruptSessions,
      stateDir: corruptDir,
      usage: corruptUsage,
    });
    await new Promise<void>(resolve => corruptApp.server.listen(corruptPort, '127.0.0.1', resolve));
    await corruptApp.mobile.ready();
    cleanups.push(async () => {
      await corruptApp.mobile.close();
      await corruptSessions.killAll();
      await new Promise<void>(resolve => corruptApp.server.close(() => resolve()));
    });
    expect(corruptApp.mobile.adminStatus().config.enabled).toBe(false);
    expect(corruptApp.mobile.adminStatus().config.tunnelMode).toBe('quick');
  });
});
