import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Snapshot } from '../shared/protocol.ts';
import { createFakeTask, expectStatus, fakeLines, removeAllTasks, state } from './helpers.ts';

const MOBILE_PORT = 47812;
const MOBILE_ORIGIN = `http://127.0.0.1:${MOBILE_PORT}`;
const OUT = path.resolve('.tmp/mobile');
fs.mkdirSync(OUT, { recursive: true });

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-mob-e2e-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'line 1\nline 2\nline 3\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function rawHttp(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function verifyFeishuSign(body: Record<string, unknown>, secret: string): void {
  const ts = String(body.timestamp ?? '');
  const sign = String(body.sign ?? '');
  expect(ts).toMatch(/^\d{10}$/);
  const expected = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
  expect(sign).toBe(expected);
}

test.describe.configure({ mode: 'serial' });

test.describe('mobile access gateway & Android PWA', () => {
  let feishuServer: http.Server;
  let feishuPort = 0;
  const feishuDeliveries: Record<string, unknown>[] = [];

  test.beforeAll(async () => {
    feishuServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          feishuDeliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok' }));
      });
    });
    await new Promise<void>((resolve) => feishuServer.listen(0, '127.0.0.1', resolve));
    feishuPort = (feishuServer.address() as AddressInfo).port;
  });

  test.afterAll(async ({ request }) => {
    await request.post('/api/mobile/admin/devices/revoke-all', { data: {} }).catch(() => {});
    await request.post('/api/mobile/admin/config', {
      data: {
        enabled: false,
        tunnelEnabled: false,
        publicOrigin: '',
        cfAccessTeamDomain: '',
        cfAccessAud: '',
        feishuEnabled: false,
        feishuWebhookUrl: '',
        feishuSecret: '',
        quietWhenDesktopActive: true,
      },
    }).catch(() => {});

    await removeAllTasks(request);
    const st = await state(request);
    for (const p of st.projects) {
      if (p.name.startsWith('mob-e2e-')) await request.delete(`/api/projects/${p.id}`);
    }
    await new Promise<void>((resolve) => feishuServer.close(() => resolve()));
    for (const d of tempDirs) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    }
  });

  test('full flow: security gates, QR/PIN pairing, chat queue + image + diff + zero desktop resize, Feishu alert + emergency key y, instant revoke', async ({ page, browser, request }) => {
    await removeAllTasks(request);
    const repoDir = initGitProject('main');

    const projRes = await request.post('/api/projects', { data: { name: 'mob-e2e-repo', path: repoDir } });
    expect(projRes.status()).toBe(200);
    const project = (await projRes.json()) as { id: string; name: string };

    const mainTask = await createFakeTask(request, project.id, '手机协同主任务', 'sleep 2');
    await page.goto('/');
    await expectStatus(page, mainTask.session.id, 'needs_you');

    // Measure desktop session cols/rows after desktop FitAddon settled.
    const snapBefore = await state(request);
    const desktopSessionBefore = snapBefore.sessions.find((s) => s.id === mainTask.session.id)!;
    const desktopCols = desktopSessionBefore.cols;
    const desktopRows = desktopSessionBefore.rows;
    expect(desktopCols).toBeGreaterThan(20);

    // Desktop enables Mobile Gateway from SettingsView.
    await page.getByTestId('tab-settings').click();
    await expect(page.getByTestId('mobile-settings-section')).toBeVisible();
    await page.getByTestId('mobile-enable-toggle').check();
    await expect(page.getByTestId('mobile-settings-section')).toContainText(`监听中 :${MOBILE_PORT}`);

    // 1) Pre-pairing security gates on 47812 (zero loopback bypass, Host check, CSRF custom header check).
    const noAuth = await rawHttp(MOBILE_PORT, 'GET', '/api/state', {
      host: `127.0.0.1:${MOBILE_PORT}`,
      'x-forwarded-for': '127.0.0.1',
    });
    expect(noAuth.status).toBe(401);

    const badHost = await rawHttp(MOBILE_PORT, 'GET', '/api/mobile/session', {
      host: 'evil.example.com',
    });
    expect(badHost.status).toBe(403);

    const noCsrf = await rawHttp(MOBILE_PORT, 'POST', '/api/mobile/pair/claim', {
      host: `127.0.0.1:${MOBILE_PORT}`,
      origin: MOBILE_ORIGIN,
      'content-type': 'application/json',
    }, JSON.stringify({ pairToken: 'fake' }));
    expect(noCsrf.status).toBe(403);

    // 2) Pairing flow: Desktop generates QR/URL -> Android viewport claims -> wrong PIN once -> right PIN approves.
    await page.getByTestId('mobile-pair-start').click();
    await expect(page.getByTestId('mobile-pair-qr')).toBeVisible();
    const rawPairUrl = (await page.getByTestId('mobile-pair-url').innerText()).trim();
    const pairToken = rawPairUrl.split('#pair=')[1];
    expect(pairToken).toBeTruthy();

    const mobileCtx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    });
    const mobilePage = await mobileCtx.newPage();
    try {
      await mobilePage.goto(`${MOBILE_ORIGIN}/#pair=${pairToken}`);
      await expect(mobilePage.getByTestId('mobile-claim-code')).toBeVisible();
      const claimCode = (await mobilePage.getByTestId('mobile-claim-code').innerText()).trim();
      expect(claimCode).toMatch(/^\d{6}$/);
      // Token must be wiped from browser address bar immediately after claiming.
      expect(mobilePage.url()).not.toContain('#pair=');

      // Wait until desktop polls the claimed state.
      await expect(page.getByTestId('mobile-pair-code-input')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, '01-desktop-pairing.png') });

      // Enter wrong PIN first -> error notice, attempts left decremented.
      const wrongCode = claimCode === '000000' ? '111111' : '000000';
      await page.getByTestId('mobile-pair-code-input').fill(wrongCode);
      await page.getByTestId('mobile-pair-approve').click();
      await expect(page.getByTestId('mobile-settings-error')).toContainText('还剩 2 次机会');

      // Enter right PIN -> mobile enters MobileHome.
      await page.getByTestId('mobile-pair-code-input').fill(claimCode);
      await page.getByTestId('mobile-pair-approve').click();
      await expect(mobilePage.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
      await expect(mobilePage.getByTestId('mobile-conn-pill')).toContainText('ms');
      await mobilePage.screenshot({ path: path.join(OUT, '02-mobile-home.png') });

      // 3) Post-pairing security cropping & sanitization checks via mobile cookie context.
      for (const [m, p] of [
        ['GET', '/api/dirs'],
        ['POST', '/api/shutdown'],
        ['PUT', `/api/projects/${project.id}/file`],
        ['DELETE', `/api/tasks/${mainTask.task.id}`],
      ] as const) {
        const res = await mobileCtx.request.fetch(`${MOBILE_ORIGIN}${p}`, {
          method: m,
          headers: { 'x-shoal-mobile': '1', 'content-type': 'application/json' },
          data: m === 'GET' ? undefined : {},
        });
        expect(res.status(), `cropped ${m} ${p}`).toBe(403);
      }

      const mobSnap = (await (await mobileCtx.request.get(`${MOBILE_ORIGIN}/api/state`)).json()) as Snapshot;
      expect(mobSnap.projects[0].path).toBe('');
      expect(mobSnap.sessions[0].transcriptPath).toBeUndefined();

      // The phone's raw endpoint stays image-only even though the desktop Inspector now streams video/audio/PDF.
      fs.writeFileSync(path.join(repoDir, 'pic.png'), TINY_PNG);
      fs.writeFileSync(path.join(repoDir, 'clip.mp4'), Buffer.alloc(4096, 1));
      const mobileRaw = (rel: string) =>
        mobileCtx.request.get(`${MOBILE_ORIGIN}/api/projects/${project.id}/raw?path=${encodeURIComponent(rel)}`, { headers: { 'x-shoal-mobile': '1' } });
      const rawPng = await mobileRaw('pic.png');
      expect(rawPng.status()).toBe(200);
      expect(rawPng.headers()['content-type']).toBe('image/png');
      expect((await mobileRaw('clip.mp4')).status()).toBe(415);
      fs.rmSync(path.join(repoDir, 'pic.png'));
      fs.rmSync(path.join(repoDir, 'clip.mp4'));

      // 4) Chat workflow on running task: queue follow-up + image upload + readonly Diff + approve + zero resize.
      // Start a sleep 2 turn from desktop REST so mobile sees working session & queues follow-up.
      await request.post(`/api/tasks/${mainTask.task.id}/feedback`, { data: { text: 'sleep 2', mode: 'same' } });
      await mobilePage.getByTestId(`mobile-task-card-${mainTask.task.id}`).click();
      await expect(mobilePage.getByTestId('mobile-task-view')).toBeVisible();

      await mobilePage.getByTestId('mobile-image-input').setInputFiles({
        name: 'screen.png',
        mimeType: 'image/png',
        buffer: TINY_PNG,
      });
      await expect(mobilePage.locator('.mob-attach-chip')).toBeVisible();
      await mobilePage.getByTestId('mobile-composer-input').fill('手机端排队指令');
      await mobilePage.getByTestId('mobile-composer-send').click();

      // Verify both turns eventually reached fake-agent log in order and attachment text stayed clean.
      await expect.poll(() => fakeLines(mainTask.session.id).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      await expect(mobilePage.locator('[data-testid="mobile-turn-user"]').filter({ hasText: '[图片附件:' })).toBeVisible({ timeout: 10_000 });
      await expect(mobilePage.getByTestId('mobile-approve-btn')).toBeVisible({ timeout: 10_000 });

      // Modify repo file and check read-only Diff drawer on mobile.
      fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'line 1\nline 2 modified from test\nline 3\n');
      await mobilePage.getByTestId('mobile-open-diff-btn').click();
      await expect(mobilePage.getByTestId('mobile-diff-drawer')).toBeVisible();
      await expect(mobilePage.getByTestId('mobile-diff-drawer')).toHaveCSS('position', 'fixed');
      await expect(mobilePage.getByTestId('mobile-diff-content')).toContainText('line 2 modified from test');
      await mobilePage.screenshot({ path: path.join(OUT, '03-mobile-diff.png') });
      await mobilePage.getByTestId('mobile-diff-close').click();

      await mobilePage.screenshot({ path: path.join(OUT, '04-mobile-task.png') });
      await mobilePage.getByTestId('mobile-approve-btn').click();
      await expect.poll(async () => {
        const s = await state(request);
        return s.tasks.find((t) => t.id === mainTask.task.id)?.phase;
      }).toBe('approved');

      // Invariant check: desktop session cols/rows remained 100% untouched!
      const snapMid = await state(request);
      const desktopSessionMid = snapMid.sessions.find((s) => s.id === mainTask.session.id)!;
      expect(desktopSessionMid.cols).toBe(desktopCols);
      expect(desktopSessionMid.rows).toBe(desktopRows);

      // 5) Feishu HMAC-SHA256 webhook alert -> deep link #task=<id> -> EmergencyTerminalDrawer key 'y'.
      const feishuSecret = 'e2e-feishu-secret';
      await page.getByTestId('mobile-feishu-toggle').check();
      await page.getByTestId('mobile-feishu-webhook').fill(`http://127.0.0.1:${feishuPort}/hook`);
      await page.getByTestId('mobile-feishu-secret').fill(feishuSecret);
      await page.getByTestId('mobile-feishu-quiet').uncheck();
      await page.getByTestId('mobile-feishu-save').click();
      await expect(page.getByTestId('mobile-settings-notice')).toContainText('已保存');

      await page.getByTestId('mobile-feishu-test').click();
      await expect.poll(() => feishuDeliveries.length).toBeGreaterThanOrEqual(1);
      verifyFeishuSign(feishuDeliveries[0], feishuSecret);

      const askTask = await createFakeTask(request, project.id, '权限弹窗任务', 'ask confirm change');
      let alertDelivery: Record<string, unknown> | undefined;
      await expect.poll(() => {
        alertDelivery = feishuDeliveries.find((d) => JSON.stringify(d).includes(`#task=${askTask.task.id}`));
        return Boolean(alertDelivery);
      }, { timeout: 10_000 }).toBe(true);

      verifyFeishuSign(alertDelivery!, feishuSecret);
      const alertJson = JSON.stringify(alertDelivery);
      expect(alertJson).toContain(`#task=${askTask.task.id}`);
      expect(alertJson).not.toContain(repoDir);

      // Navigate mobile directly using deep link hash from Feishu notification.
      await mobilePage.goto(`${MOBILE_ORIGIN}/#task=${askTask.task.id}`);
      await expect(mobilePage.getByTestId('mobile-blocked-banner')).toBeVisible({ timeout: 10_000 });
      await mobilePage.getByTestId('mobile-prompt-open-term').click();
      await expect(mobilePage.getByTestId('mobile-term-drawer')).toBeVisible();
      await expect(mobilePage.getByTestId('mobile-term-drawer')).toHaveCSS('position', 'fixed');
      await expect(mobilePage.getByTestId('mobile-term-drawer')).toContainText('Allow? (y/n)', { timeout: 10_000 });
      await mobilePage.screenshot({ path: path.join(OUT, '05-mobile-emergency-term.png') });

      const askBeforeSnap = await state(request);
      const askColsBefore = askBeforeSnap.sessions.find((s) => s.id === askTask.session.id)!.cols;
      const askRowsBefore = askBeforeSnap.sessions.find((s) => s.id === askTask.session.id)!.rows;

      await mobilePage.getByTestId('mobile-key-y').click();
      await expect(mobilePage.getByTestId('mobile-term-drawer')).toContainText('reply: ask confirm change', { timeout: 10_000 });
      await mobilePage.getByTestId('mobile-term-close').click();
      await expect(mobilePage.getByTestId('mobile-blocked-banner')).toHaveCount(0);

      const askAfterSnap = await state(request);
      const askSessAfter = askAfterSnap.sessions.find((s) => s.id === askTask.session.id)!;
      expect(askSessAfter.cols).toBe(askColsBefore);
      expect(askSessAfter.rows).toBe(askRowsBefore);

      // 6) Instant device revocation on desktop kicks mobile WS & session out immediately.
      await expect(page.getByTestId('mobile-device-revoke').first()).toBeVisible();
      await page.getByTestId('mobile-device-revoke').first().click();

      await expect(mobilePage.getByTestId('mobile-pair-screen')).toBeVisible({ timeout: 10_000 });
      await mobilePage.screenshot({ path: path.join(OUT, '06-mobile-revoked.png') });
      const revokedApi = await mobileCtx.request.get(`${MOBILE_ORIGIN}/api/state`);
      expect(revokedApi.status()).toBe(401);
    } finally {
      await mobileCtx.close();
    }
  });
});
