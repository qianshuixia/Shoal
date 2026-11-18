import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createFakeTask, FAKE_LOG, fakeLines, removeAllTasks, state } from './helpers.ts';

const DESKTOP_ORIGIN = 'http://127.0.0.1:47811';
const MOBILE_PORT = 47812;
const MOBILE_ORIGIN = `http://127.0.0.1:${MOBILE_PORT}`;
const OUT = path.resolve('.tmp/mobile-p0-batch2');
fs.mkdirSync(OUT, { recursive: true });

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-mobconf-e2e-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'line 1\nline 2\nline 3\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/** Keys the fake agent received while answering ask / menu / trust prompts (written by test/fixtures/fake-agent.mjs). */
function fakeKeys(sessionId: string): string[] {
  const file = `${FAKE_LOG}.keys`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l) as { sessionId: string; key: string })
    .filter((e) => e.sessionId === sessionId).map((e) => e.key);
}

/** Types into a session the way the desktop terminal does (raw WS 'in' message). */
function desktopInput(sessionId: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${DESKTOP_ORIGIN.replace('http', 'ws')}/ws`, { headers: { origin: DESKTOP_ORIGIN } });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'in', id: sessionId, d: data }));
      setTimeout(() => { ws.close(); resolve(); }, 300);
    });
    ws.on('error', reject);
  });
}

/** Mobile page whose live WebSocket the test can cut (drop), keep from reconnecting, or mute (freeze server pushes). */
interface WsControl { drop(): Promise<void>; restore(): void; freeze(on: boolean): void }

async function newMobilePage(ctx: BrowserContext, taskId?: string): Promise<{ page: Page; ws: WsControl }> {
  const page = await ctx.newPage();
  let refuse = false;
  let frozen = false;
  const conns: { close(): Promise<void> }[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (refuse) {
      void ws.close();
      return;
    }
    const server = ws.connectToServer();
    server.onMessage((m) => { if (!frozen) ws.send(m); });
    ws.onMessage((m) => server.send(m));
    server.onClose(() => void ws.close());
    conns.push(ws);
  });
  const ctl: WsControl = {
    async drop() {
      refuse = true;
      await Promise.all(conns.splice(0).map((c) => c.close().catch(() => {})));
    },
    restore() { refuse = false; },
    freeze(on) { frozen = on; },
  };
  await page.goto(taskId ? `${MOBILE_ORIGIN}/#task=${taskId}` : `${MOBILE_ORIGIN}/`);
  if (taskId) await expect(page.getByTestId('mobile-task-view')).toBeVisible({ timeout: 10_000 });
  else await expect(page.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
  return { page, ws: ctl };
}

test.describe.configure({ mode: 'serial' });

test.describe('mobile P0 batch 2: confirm banner, dangerous actions, idempotent send, connection state', () => {
  let desktopCtx: BrowserContext;
  let androidCtx: BrowserContext;
  let projectId = '';

  test.beforeAll(async ({ browser, request }) => {
    await removeAllTasks(request);
    const repoDir = initGitProject('main');
    const projRes = await request.post('/api/projects', { data: { name: 'mob-e2e-confirm', path: repoDir } });
    expect(projRes.status()).toBe(200);
    projectId = ((await projRes.json()) as { id: string }).id;

    desktopCtx = await browser.newContext({ baseURL: DESKTOP_ORIGIN, viewport: { width: 1600, height: 900 } });
    const desktop = await desktopCtx.newPage();
    await desktop.goto('/');
    await desktop.getByTestId('settings-btn').click();
    await expect(desktop.getByTestId('mobile-settings-section')).toBeVisible();
    await desktop.getByTestId('mobile-enable-toggle').check();
    await expect(desktop.getByTestId('mobile-settings-section')).toContainText(`监听中 :${MOBILE_PORT}`);
    await desktop.getByTestId('mobile-pair-start').click();
    await expect(desktop.getByTestId('mobile-pair-qr')).toBeVisible();
    const pairToken = (await desktop.getByTestId('mobile-pair-url').innerText()).trim().split('#pair=')[1];
    expect(pairToken).toBeTruthy();

    androidCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });
    const pairing = await androidCtx.newPage();
    await pairing.goto(`${MOBILE_ORIGIN}/#pair=${pairToken}`);
    await expect(pairing.getByTestId('mobile-claim-code')).toBeVisible();
    const claimCode = (await pairing.getByTestId('mobile-claim-code').innerText()).trim();
    await expect(desktop.getByTestId('mobile-pair-code-input')).toBeVisible();
    await desktop.getByTestId('mobile-pair-code-input').fill(claimCode);
    await desktop.getByTestId('mobile-pair-approve').click();
    await expect(pairing.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
    await pairing.close();
  });

  test.afterAll(async ({ request }) => {
    await androidCtx?.close().catch(() => {});
    await desktopCtx?.close().catch(() => {});
    await request.post('/api/mobile/admin/devices/revoke-all', { data: {} }).catch(() => {});
    await request.post('/api/mobile/admin/config', {
      data: {
        enabled: false, tunnelEnabled: false, publicOrigin: '', cfAccessTeamDomain: '', cfAccessAud: '',
        feishuEnabled: false, feishuWebhookUrl: '', feishuSecret: '', quietWhenDesktopActive: true,
      },
    }).catch(() => {});
    await removeAllTasks(request);
    const st = await state(request);
    for (const p of st.projects) {
      if (p.name.startsWith('mob-e2e-')) await request.delete(`/api/projects/${p.id}`);
    }
    for (const d of tempDirs) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    }
  });

  test('(y/n) prompt: banner shows the original text, y reaches the agent and the turn continues', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '确认任务yn', 'ask yn-flow');
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const banner = page.getByTestId('mobile-prompt-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('mobile-prompt-line').filter({ hasText: 'Allow? (y/n)' })).toBeVisible({ timeout: 10_000 });
    const keys = page.getByTestId('mobile-prompt-key');
    await expect(keys).toHaveCount(2);
    await expect(keys.nth(0)).toHaveAttribute('data-key', 'y');
    await expect(keys.nth(1)).toHaveAttribute('data-key', 'n');
    await expect(page.getByTestId('mobile-prompt-open-term')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'prompt-01-yn.png') });

    await keys.nth(0).click();
    await expect.poll(() => fakeKeys(created.session.id)).toEqual(['y']);
    await expect(page.getByTestId('mobile-blocked-banner')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="mobile-turn-assistant"]').filter({ hasText: 'yn-flow' })).toBeVisible({ timeout: 15_000 });
    await page.close();
  });

  test('numbered menu gives 1/2/3 and the chosen digit reaches the agent', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '确认任务menu', 'menu pick-flow');
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const keys = page.getByTestId('mobile-prompt-key');
    await expect(keys).toHaveCount(3, { timeout: 15_000 });
    await expect(keys.nth(0)).toHaveAttribute('data-key', '1');
    await expect(keys.nth(1)).toHaveAttribute('data-key', '2');
    await expect(keys.nth(2)).toHaveAttribute('data-key', '3');
    await expect(page.getByTestId('mobile-prompt-line').filter({ hasText: 'Do you want to proceed?' })).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'prompt-02-menu.png') });
    await keys.nth(1).click();
    await expect.poll(() => fakeKeys(created.session.id)).toEqual(['2']);
    await expect(page.locator('[data-testid="mobile-turn-assistant"]').filter({ hasText: 'pick-flow [2]' })).toBeVisible({ timeout: 15_000 });
    await page.close();
  });

  test('startup trust prompt: one Enter button, Enter reaches the agent before the first turn', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '确认任务trust', '[[trust]] after-trust');
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const keys = page.getByTestId('mobile-prompt-key');
    await expect(keys).toHaveCount(1, { timeout: 15_000 });
    await expect(keys.first()).toHaveAttribute('data-key', '\r');
    await expect(page.getByTestId('mobile-prompt-line').filter({ hasText: 'Do you trust the files in this folder' })).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'prompt-03-trust.png') });
    await keys.first().click();
    await expect.poll(() => fakeKeys(created.session.id)).toEqual(['\r']);
    await expect.poll(() => fakeLines(created.session.id), { timeout: 15_000 }).toContain('after-trust');
    await expect(page.getByTestId('mobile-blocked-banner')).toHaveCount(0, { timeout: 15_000 });
    await page.close();
  });

  test('already answered elsewhere: the phone says so and the agent receives the key only once', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '确认任务stale', 'ask stale-flow');
    const { page, ws } = await newMobilePage(androidCtx, created.task.id);
    await expect(page.getByTestId('mobile-prompt-key')).toHaveCount(2, { timeout: 15_000 });
    // The phone keeps its old picture: server pushes are muted and the prompt read is replayed from the first answer.
    ws.freeze(true);
    let staleBody: string | null = null;
    await page.route('**/api/mobile/tasks/*/prompt', async (route: Route) => {
      if (staleBody === null) staleBody = await (await route.fetch()).text();
      await route.fulfill({ status: 200, contentType: 'application/json', body: staleBody });
    });
    await expect.poll(() => staleBody !== null, { timeout: 8_000 }).toBe(true);
    // Answered on the desktop terminal while the phone still shows the banner.
    await desktopInput(created.session.id, 'y');
    await expect.poll(() => fakeKeys(created.session.id)).toEqual(['y']);
    await expect(page.getByTestId('mobile-prompt-key').first()).toBeVisible();
    await page.getByTestId('mobile-prompt-key').first().click();
    await expect(page.getByTestId('mobile-prompt-note')).toContainText('已在别处处理', { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, 'prompt-04-stale.png') });
    expect(fakeKeys(created.session.id)).toEqual(['y']);
    await page.close();
  });

  test('double tap sends one prompt-answer request', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '确认任务dbl', 'ask dbl-flow');
    const { page } = await newMobilePage(androidCtx, created.task.id);
    await expect(page.getByTestId('mobile-prompt-key')).toHaveCount(2, { timeout: 15_000 });
    let hits = 0;
    await page.route('**/api/mobile/tasks/*/prompt-answer', async (route) => {
      hits++;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const yKey = page.getByTestId('mobile-prompt-key').first();
    await yKey.dispatchEvent('click');
    await yKey.dispatchEvent('click');
    await expect(page.getByTestId('mobile-prompt-key').first()).toBeDisabled();
    await expect.poll(() => fakeKeys(created.session.id), { timeout: 15_000 }).toEqual(['y']);
    expect(hits).toBe(1);
    await page.close();
  });

  test('send retry after a lost response reuses clientMsgId and the agent gets the text once', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '幂等任务', 'hello idem');
    await expect.poll(() => fakeLines(created.session.id).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 600));
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const ids: string[] = [];
    let calls = 0;
    await page.route('**/api/tasks/*/feedback', async (route) => {
      calls++;
      ids.push((route.request().postDataJSON() as { clientMsgId: string }).clientMsgId);
      if (calls === 1) {
        await route.fetch(); // the server receives and delivers it...
        await route.abort('connectionreset'); // ...but the phone never sees the answer
      } else {
        await route.continue();
      }
    });
    const box = page.getByTestId('mobile-composer-input');
    await box.fill('idem-text-777');
    await page.getByTestId('mobile-composer-send').click();
    await expect(page.locator('.form-error')).toBeVisible({ timeout: 10_000 });
    await expect(box).toHaveValue('idem-text-777');
    await page.screenshot({ path: path.join(OUT, 'send-01-lost-response.png') });
    await page.getByTestId('mobile-composer-send').click();
    await expect(box).toHaveValue('');
    await expect(page.getByTestId('mobile-send-status')).toBeVisible();
    await expect.poll(() => fakeLines(created.session.id).filter((l) => l.includes('idem-text-777')).length).toBe(1);
    await new Promise((r) => setTimeout(r, 800));
    expect(fakeLines(created.session.id).filter((l) => l.includes('idem-text-777')).length).toBe(1);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await expect(page.getByTestId('mobile-send-status')).toHaveCount(0, { timeout: 8_000 });

    // Edited content gets a fresh id.
    await page.unroute('**/api/tasks/*/feedback');
    const ids2: string[] = [];
    await page.route('**/api/tasks/*/feedback', async (route) => {
      ids2.push((route.request().postDataJSON() as { clientMsgId: string }).clientMsgId);
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟失败' }) });
    });
    await box.fill('first-draft-1');
    await page.getByTestId('mobile-composer-send').click();
    await expect(box).toHaveValue('first-draft-1');
    await box.fill('first-draft-1 edited');
    await page.getByTestId('mobile-composer-send').click();
    await expect.poll(() => ids2.length).toBe(2);
    expect(ids2[0]).not.toBe(ids2[1]);
    await page.unroute('**/api/tasks/*/feedback');
    await box.fill('');
    await page.close();
  });

  test('lost response, leave the task and come back: the resend keeps the clientMsgId and the agent gets the text once', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '跨页幂等任务', 'hello idem2');
    await expect.poll(() => fakeLines(created.session.id).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 600));
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const ids: string[] = [];
    let calls = 0;
    await page.route('**/api/tasks/*/feedback', async (route) => {
      calls++;
      ids.push((route.request().postDataJSON() as { clientMsgId: string }).clientMsgId);
      if (calls === 1) {
        await route.fetch();
        await route.abort('connectionreset');
      } else {
        await route.continue();
      }
    });
    const box = page.getByTestId('mobile-composer-input');
    await box.fill('idem-cross-555');
    await page.getByTestId('mobile-composer-send').click();
    await expect(page.locator('.form-error')).toBeVisible({ timeout: 10_000 });
    await expect(box).toHaveValue('idem-cross-555');
    // Leave the task (the composer component unmounts) and come back: the draft is restored from storage.
    await page.getByTestId('mobile-back-btn').click();
    await expect(page.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`mobile-task-card-${created.task.id}`).first().click();
    await expect(page.getByTestId('mobile-task-view')).toBeVisible({ timeout: 10_000 });
    const box2 = page.getByTestId('mobile-composer-input');
    await expect(box2).toHaveValue('idem-cross-555');
    await expect(page.getByTestId('mobile-composer-send')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('mobile-composer-send').click();
    await expect(box2).toHaveValue('');
    await expect.poll(() => fakeLines(created.session.id).filter((l) => l.includes('idem-cross-555')).length).toBe(1);
    await new Promise((r) => setTimeout(r, 800));
    expect(fakeLines(created.session.id).filter((l) => l.includes('idem-cross-555')).length).toBe(1);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    await page.unroute('**/api/tasks/*/feedback');
    await page.close();
  });

  test('send status shows queued while the agent is still working', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '排队状态任务', 'sleep 3');
    await expect.poll(() => fakeLines(created.session.id).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const { page } = await newMobilePage(androidCtx, created.task.id);
    await page.getByTestId('mobile-composer-input').fill('queued-while-busy');
    await page.getByTestId('mobile-composer-send').click();
    await expect(page.getByTestId('mobile-send-status')).toHaveAttribute('data-status', 'queued', { timeout: 10_000 });
    await expect(page.getByTestId('mobile-send-status')).toContainText('已排队');
    await page.close();
  });

  test('archive needs confirmation; cancel and back are both cancel; back closes only the confirm layer', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '归档确认任务', 'sleep 30');
    await expect.poll(() => fakeLines(created.session.id).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const { page } = await newMobilePage(androidCtx, created.task.id);
    const taskUrlPart = `#task=${created.task.id}`;

    // Cancel button.
    await page.getByTestId('mobile-task-more-btn').click();
    await page.getByTestId('mobile-archive-btn').click();
    await expect(page.getByTestId('mobile-confirm-sheet')).toBeVisible();
    await expect(page.getByTestId('mobile-confirm-message')).toContainText('会结束正在运行的会话，归档后恢复也不能续上这次进程');
    await expect(page.getByTestId('mobile-confirm-ok')).toHaveClass(/danger/);
    await page.screenshot({ path: path.join(OUT, 'archive-01-confirm.png') });
    await page.getByTestId('mobile-confirm-cancel').click();
    await expect(page.getByTestId('mobile-confirm-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-more-sheet')).toBeVisible();

    // Nested back: first back closes only the confirm, second closes the sheet, the page stays on the task.
    await page.getByTestId('mobile-archive-btn').click();
    await expect(page.getByTestId('mobile-confirm-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('mobile-confirm-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-more-sheet')).toBeVisible();
    expect(page.url()).toContain(taskUrlPart);
    await page.goBack();
    await expect(page.getByTestId('mobile-task-more-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();
    expect(page.url()).toContain(taskUrlPart);

    // Still running, not archived.
    let st = await state(request);
    expect(st.tasks.find((t) => t.id === created.task.id)!.phase).not.toBe('archived');
    expect(st.sessions.find((s) => s.id === created.session.id)!.status).not.toBe('exited');

    // Confirm archives and ends the session; the sheet closes and the page stays on the task.
    await page.getByTestId('mobile-task-more-btn').click();
    await page.getByTestId('mobile-archive-btn').click();
    await page.getByTestId('mobile-confirm-ok').click();
    await expect(page.getByTestId('mobile-confirm-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-more-sheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => {
      st = await state(request);
      return st.tasks.find((t) => t.id === created.task.id)!.phase;
    }).toBe('archived');
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();
    expect(page.url()).toContain(taskUrlPart);
    await page.close();
  });

  test('logout lives in the home menu, needs confirmation, and a failed logout keeps the device paired', async () => {
    const { page } = await newMobilePage(androidCtx);
    await expect(page.getByTestId('mobile-logout-btn')).toHaveCount(0); // no longer in the header
    await page.getByTestId('mobile-home-more-btn').click();
    await page.getByTestId('mobile-logout-btn').click();
    await expect(page.getByTestId('mobile-confirm-sheet')).toBeVisible();
    // Cancel does nothing.
    await page.getByTestId('mobile-confirm-cancel').click();
    await expect(page.getByTestId('mobile-home-more-sheet')).toBeVisible();

    // Server failure: error shown, still paired.
    await page.route('**/api/mobile/logout', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '服务端暂时不可用' }) }));
    await page.getByTestId('mobile-logout-btn').click();
    await page.getByTestId('mobile-confirm-ok').click();
    await expect(page.getByTestId('mobile-logout-error')).toContainText('服务端暂时不可用');
    await expect(page.getByTestId('mobile-pair-screen')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'logout-01-failed.png') });
    await page.close();
  });

  test('connection drop shows a reconnect bar, disables send and keys, and recovers', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '断线任务', 'ask offline-flow');
    const { page, ws } = await newMobilePage(androidCtx, created.task.id);
    await expect(page.getByTestId('mobile-prompt-key')).toHaveCount(2, { timeout: 15_000 });
    await page.getByTestId('mobile-composer-input').fill('typed while online');
    await expect(page.getByTestId('mobile-composer-send')).toBeEnabled();
    await expect(page.getByTestId('mobile-reconnect-bar')).toHaveCount(0);

    await ws.drop();
    const bar = page.getByTestId('mobile-reconnect-bar');
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText('重连中');
    await expect(bar).toContainText(/上次同步 \d\d:\d\d/);
    await expect(page.getByTestId('mobile-composer-send')).toBeDisabled();
    await expect(page.getByTestId('mobile-prompt-key').first()).toBeDisabled();
    await expect(page.getByTestId('mobile-send-offline')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'offline-01-task.png') });

    await page.getByTestId('mobile-open-term-btn').click();
    await expect(page.getByTestId('mobile-key-y')).toBeDisabled();
    await expect(page.getByTestId('mobile-term-offline')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('mobile-term-drawer')).toHaveCount(0);

    // Home shows the same bar.
    await page.getByTestId('mobile-back-btn').click();
    await expect(page.getByTestId('mobile-home')).toBeVisible();
    await expect(page.getByTestId('mobile-reconnect-bar')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'offline-02-home.png') });

    ws.restore();
    await expect(page.getByTestId('mobile-reconnect-bar')).toHaveCount(0, { timeout: 20_000 });
    await page.locator(`[data-testid="mobile-attention-task-${created.task.id}"]`).click();
    await expect(page.getByTestId('mobile-composer-send')).toBeEnabled();
    await expect(page.getByTestId('mobile-prompt-key').first()).toBeEnabled();
    await page.close();
  });

  test('startup check: a network error retries instead of dropping to the pairing page', async () => {
    const page = await androidCtx.newPage();
    let calls = 0;
    await page.route('**/api/mobile/session', async (route) => {
      calls++;
      if (calls <= 2) await route.abort('connectionrefused');
      else await route.continue();
    });
    await page.goto(`${MOBILE_ORIGIN}/`);
    await expect(page.getByTestId('mobile-checking')).toContainText('无法连接到电脑，正在重试');
    await expect(page.getByTestId('mobile-pair-screen')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'startup-01-retrying.png') });
    await expect(page.getByTestId('mobile-home')).toBeVisible({ timeout: 15_000 });
    expect(calls).toBeGreaterThanOrEqual(3);

    // A 5xx is transient too; an explicit unauthenticated answer goes to pairing.
    const p2 = await androidCtx.newPage();
    let n2 = 0;
    await p2.route('**/api/mobile/session', async (route) => {
      n2++;
      if (n2 === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' });
      else await route.continue();
    });
    await p2.goto(`${MOBILE_ORIGIN}/`);
    await expect(p2.getByTestId('mobile-home')).toBeVisible({ timeout: 15_000 });
    await p2.close();

    const p3 = await androidCtx.newPage();
    await p3.route('**/api/mobile/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":false,"via":"lan"}' }));
    await p3.goto(`${MOBILE_ORIGIN}/`);
    await expect(p3.getByTestId('mobile-pair-screen')).toBeVisible();
    await p3.close();
    await page.close();
  });

  test('stale approve: a new review round makes the old page refuse with the server wording', async ({ request }) => {
    const created = await createFakeTask(request, projectId, '过期通过任务', 'review round one');
    await expect.poll(async () => (await state(request)).tasks.find((t) => t.id === created.task.id)?.phase, { timeout: 20_000 }).toBe('review');
    const oldSince = (await state(request)).tasks.find((t) => t.id === created.task.id)!.phaseSince;
    const { page, ws } = await newMobilePage(androidCtx, created.task.id);
    await expect(page.getByTestId('mobile-approve-btn')).toBeVisible({ timeout: 10_000 });
    ws.freeze(true); // this page keeps the old round's button

    const fb = await request.post(`/api/tasks/${created.task.id}/feedback`, { data: { text: 'round two', mode: 'same' } });
    expect(fb.ok()).toBeTruthy();
    await expect.poll(async () => {
      const t = (await state(request)).tasks.find((x) => x.id === created.task.id)!;
      return t.phase === 'review' && t.phaseSince !== oldSince;
    }, { timeout: 20_000 }).toBe(true);

    await expect(page.getByTestId('mobile-approve-btn')).toBeVisible();
    await page.getByTestId('mobile-approve-btn').click();
    await expect(page.locator('.form-error')).toContainText('这一轮验收已变化', { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, 'approve-01-stale.png') });
    expect((await state(request)).tasks.find((t) => t.id === created.task.id)!.phase).toBe('review');
    ws.freeze(false);
    await page.close();
  });

  test('home counts match the desktop rules, and privacy mode blurs names and survives a reload', async ({ request }) => {
    await removeAllTasks(request);
    // A finished turn leaves the session needs_you while the task waits in review: that is 待验收, not 需要你.
    const done = await createFakeTask(request, projectId, '同源待验收', 'finish this round');
    await expect.poll(async () => (await state(request)).tasks.find((t) => t.id === done.task.id)?.phase, { timeout: 20_000 }).toBe('review');
    const asking = await createFakeTask(request, projectId, '同源需要你', 'ask count-flow');
    await expect.poll(async () => (await state(request)).sessions.find((s) => s.id === asking.session.id)?.blocked, { timeout: 15_000 }).toBeTruthy();

    const { page } = await newMobilePage(androidCtx);
    await expect(page.getByTestId('mobile-attention-title')).toHaveText('需要你 1 · 待验收 1', { timeout: 10_000 });
    await expect(page.getByTestId('mobile-home-sub')).toHaveText('1 需要你 · 1 待验收');
    const cards = page.getByTestId('mobile-attention-list').locator('.mob-task-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute('data-testid', `mobile-attention-task-${asking.task.id}`);
    await expect(cards.nth(0).locator('.mob-pill')).toHaveText('待终端授权');
    await expect(cards.nth(1).locator('.mob-pill')).toHaveText('待验收');

    const name = cards.nth(1).locator('.mob-task-name');
    const blur = () => name.evaluate((el) => getComputedStyle(el).filter);
    expect(await blur()).toBe('none');
    await page.getByTestId('mobile-home-more-btn').click();
    await page.getByTestId('mobile-privacy-toggle').click();
    await expect(page.getByTestId('mobile-privacy-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.goBack(); // closes the menu sheet, stays on home
    await expect(page.getByTestId('mobile-home-more-sheet')).toHaveCount(0);
    expect(await blur()).toContain('blur');
    await page.screenshot({ path: path.join(OUT, 'privacy-01-home.png') });

    await page.reload();
    await expect(page.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
    expect(await page.getByTestId('mobile-attention-list').locator('.mob-task-name').first().evaluate((el) => getComputedStyle(el).filter)).toContain('blur');
    await page.getByTestId(`mobile-attention-task-${asking.task.id}`).click();
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();
    expect(await page.locator('.mob-title').evaluate((el) => getComputedStyle(el).filter)).toContain('blur');
    expect(await page.getByTestId('mobile-prompt-line').first().evaluate((el) => getComputedStyle(el.closest('pre')!).filter)).toContain('blur');

    await page.getByTestId('mobile-back-btn').click();
    await page.getByTestId('mobile-home-more-btn').click();
    await page.getByTestId('mobile-privacy-toggle').click();
    await expect(page.getByTestId('mobile-privacy-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.close();
  });
});
