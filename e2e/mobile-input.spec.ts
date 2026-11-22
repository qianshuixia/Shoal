import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeTask, fakeLines, removeAllTasks, state } from './helpers.ts';

const DESKTOP_ORIGIN = 'http://127.0.0.1:47811';
const MOBILE_PORT = 47812;
const MOBILE_ORIGIN = `http://127.0.0.1:${MOBILE_PORT}`;
const OUT = path.resolve('.tmp/mobile-p0-batch1');
fs.mkdirSync(OUT, { recursive: true });

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-mobin-e2e-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'line 1\nline 2\nline 3\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const draftKey = (id: string) => `shoal.mobile.draft.${id}`;
const lsGet = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

async function openTask(page: Page, id: string) {
  await page.locator(`[data-testid="mobile-task-card-${id}"], [data-testid="mobile-attention-task-${id}"]`).first().click();
  await expect(page.getByTestId('mobile-task-view')).toBeVisible();
}

async function newMobilePage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${MOBILE_ORIGIN}/`);
  await expect(page.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
  return page;
}

const composerHeight = async (page: Page) => (await page.getByTestId('mobile-composer-input').boundingBox())!.height;
const fontSize = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const distanceFromBottom = (page: Page) =>
  page.locator('[data-testid="mobile-task-view"] .mob-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test.describe.configure({ mode: 'serial' });

test.describe('mobile P0 batch 1: back stack, composer, drafts, scrolling', () => {
  let desktopCtx: BrowserContext;
  let androidCtx: BrowserContext;
  let iosCtx: BrowserContext;
  let taskA = '';
  let taskB = '';

  test.beforeAll(async ({ browser, request }) => {
    await removeAllTasks(request);
    const repoDir = initGitProject('main');
    const projRes = await request.post('/api/projects', { data: { name: 'mob-e2e-input', path: repoDir } });
    expect(projRes.status()).toBe(200);
    const project = (await projRes.json()) as { id: string };
    taskA = (await createFakeTask(request, project.id, '输入框任务A', 'hello a')).task.id;
    taskB = (await createFakeTask(request, project.id, '输入框任务B', 'hello b')).task.id;

    // Pair an Android viewport through the desktop settings UI (same flow as mobile.spec.ts).
    desktopCtx = await browser.newContext({ baseURL: DESKTOP_ORIGIN, viewport: { width: 1600, height: 900 } });
    const desktop = await desktopCtx.newPage();
    await desktop.goto('/');
    await desktop.getByTestId('tab-settings').click();
    await expect(desktop.getByTestId('mobile-settings-section')).toBeVisible();
    await desktop.getByTestId('mobile-enable-toggle').check();
    await expect(desktop.getByTestId('mobile-settings-section')).toContainText(`监听中 :${MOBILE_PORT}`);
    await desktop.getByTestId('mobile-pair-start').click();
    await expect(desktop.getByTestId('mobile-pair-qr')).toBeVisible();
    const pairToken = (await desktop.getByTestId('mobile-pair-url').innerText()).trim().split('#pair=')[1];
    expect(pairToken).toBeTruthy();

    androidCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true,
      userAgent: ANDROID_UA,
    });
    const pairing = await androidCtx.newPage();
    await pairing.goto(`${MOBILE_ORIGIN}/#pair=${pairToken}`);
    await expect(pairing.getByTestId('mobile-claim-code')).toBeVisible();
    const claimCode = (await pairing.getByTestId('mobile-claim-code').innerText()).trim();
    await expect(desktop.getByTestId('mobile-pair-code-input')).toBeVisible();
    await desktop.getByTestId('mobile-pair-code-input').fill(claimCode);
    await desktop.getByTestId('mobile-pair-approve').click();
    await expect(pairing.getByTestId('mobile-home')).toBeVisible({ timeout: 10_000 });
    await pairing.close();

    iosCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: IOS_UA,
      deviceScaleFactor: 3,
      storageState: await androidCtx.storageState(),
    });
  });

  test.afterAll(async ({ request }) => {
    await iosCtx?.close().catch(() => {});
    await androidCtx?.close().catch(() => {});
    await desktopCtx?.close().catch(() => {});
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
    for (const d of tempDirs) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    }
  });

  test('back stack: system back closes only the top layer; deep link backs to home', async () => {
    const page = await newMobilePage(androidCtx);
    await openTask(page, taskA);
    expect(page.url()).toContain(`#task=${taskA}`);

    // Diff drawer is one layer.
    await page.getByTestId('mobile-open-diff-btn').click();
    await expect(page.getByTestId('mobile-diff-drawer')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('mobile-diff-drawer')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();
    expect(page.url()).toContain(`#task=${taskA}`);

    // More sheet is a layer; more -> switch stays on the same single entry.
    await page.getByTestId('mobile-task-more-btn').click();
    await expect(page.getByTestId('mobile-task-more-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('mobile-task-more-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();

    await page.getByTestId('mobile-task-more-btn').click();
    await page.getByRole('button', { name: '切换 Agent 接力' }).click();
    await expect(page.getByTestId('mobile-switch-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('mobile-switch-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-more-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-task-view')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'back-01-after-layers.png') });

    // One more back leaves the task.
    await page.goBack();
    await expect(page.getByTestId('mobile-home')).toBeVisible();
    expect(page.url()).not.toContain('task=');

    // The on-screen arrow uses the same stack.
    await openTask(page, taskA);
    await page.getByTestId('mobile-back-btn').click();
    await expect(page.getByTestId('mobile-home')).toBeVisible();
    expect(page.url()).not.toContain('task=');
    await page.close();

    // Cold start on a deep link: back shows home instead of leaving the app.
    const deep = await androidCtx.newPage();
    await deep.goto(`${MOBILE_ORIGIN}/#task=${taskA}`);
    await expect(deep.getByTestId('mobile-task-view')).toBeVisible({ timeout: 10_000 });
    await deep.goBack();
    await expect(deep.getByTestId('mobile-home')).toBeVisible();
    expect(deep.url()).toBe(`${MOBILE_ORIGIN}/`);
    await deep.close();
  });

  test('new-task sheet is a layer; back closes it and the draft survives', async () => {
    const page = await newMobilePage(androidCtx);
    await page.getByTestId('mobile-new-task-btn').click();
    await expect(page.getByTestId('mobile-new-task-sheet')).toBeVisible();
    await page.getByTestId('mobile-new-task-prompt').fill('新任务草稿内容');
    await expect.poll(() => lsGet(page, 'shoal.mobile.draft.new')).toContain('新任务草稿内容');
    await page.goBack();
    await expect(page.getByTestId('mobile-new-task-sheet')).toHaveCount(0);
    await expect(page.getByTestId('mobile-home')).toBeVisible();
    await page.getByTestId('mobile-new-task-btn').click();
    await expect(page.getByTestId('mobile-new-task-prompt')).toHaveValue('新任务草稿内容');
    await page.close();
  });

  test('drafts are isolated per task and survive reload', async () => {
    const page = await newMobilePage(androidCtx);
    const longText = '这是一段口述的长指令。'.repeat(30);
    await openTask(page, taskA);
    await page.getByTestId('mobile-composer-input').fill(longText);
    await page.getByTestId('mobile-back-btn').click();
    await expect(page.getByTestId('mobile-home')).toBeVisible();

    await openTask(page, taskB);
    await expect(page.getByTestId('mobile-composer-input')).toHaveValue('');
    await page.getByTestId('mobile-back-btn').click();

    await openTask(page, taskA);
    await expect(page.getByTestId('mobile-composer-input')).toHaveValue(longText);
    await expect.poll(() => lsGet(page, draftKey(taskA))).toContain('这是一段口述的长指令');

    await page.reload();
    await expect(page.getByTestId('mobile-task-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mobile-composer-input')).toHaveValue(longText);
    await page.screenshot({ path: path.join(OUT, 'draft-01-after-reload.png') });
    // Reload at a task deep link must still back to home.
    await page.goBack();
    await expect(page.getByTestId('mobile-home')).toBeVisible();

    // cleanup so later tests start with an empty draft
    await openTask(page, taskA);
    await page.getByTestId('mobile-composer-input').fill('');
    await expect.poll(() => lsGet(page, draftKey(taskA))).toBeNull();
    await page.close();
  });

  test('failed send restores text merged with new typing; retry clears draft', async () => {
    const page = await newMobilePage(androidCtx);
    await openTask(page, taskA);
    const box = page.getByTestId('mobile-composer-input');
    const send = page.getByTestId('mobile-composer-send');

    await page.route('**/api/tasks/*/feedback', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '模拟发送失败' }),
      });
    });

    await box.fill('原文本');
    await send.click();
    await expect(box).toHaveValue(''); // optimistic clear
    await box.fill('新文字'); // typed while the request is in flight
    await expect(box).toHaveValue('新文字');

    await expect(page.locator('.form-error')).toContainText('模拟发送失败');
    await expect(box).toHaveValue('原文本\n新文字');
    await page.screenshot({ path: path.join(OUT, 'send-01-failed-restored.png') });
    await expect.poll(() => lsGet(page, draftKey(taskA))).toContain('原文本');

    await page.unroute('**/api/tasks/*/feedback');
    await send.click();
    await expect(box).toHaveValue('');
    await expect(page.locator('.form-error')).toHaveCount(0);
    await expect.poll(() => lsGet(page, draftKey(taskA))).toBeNull();
    await expect(page.locator('[data-testid="mobile-turn-user"]').filter({ hasText: '原文本' })).toBeVisible({ timeout: 10_000 });
    await page.close();
  });

  test('send is disabled while an image upload is in flight', async () => {
    const page = await newMobilePage(androidCtx);
    await openTask(page, taskB);
    await page.route('**/api/attachments', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByTestId('mobile-composer-input').fill('带图指令');
    const send = page.getByTestId('mobile-composer-send');
    await expect(send).toBeEnabled();

    await page.getByTestId('mobile-image-input').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(send).toBeDisabled();
    await page.screenshot({ path: path.join(OUT, 'upload-01-uploading.png') });
    await expect(page.locator('.mob-attach-chip')).toBeVisible({ timeout: 10_000 });
    await expect(send).toBeEnabled();

    await page.unroute('**/api/attachments');
    await page.getByTestId('mobile-composer-input').fill('');
    await page.locator('.mob-attach-chip button').click();
    await expect.poll(() => lsGet(page, draftKey(taskB))).toBeNull();
    await page.close();
  });

  test('reply box auto-grows to ~6 lines and shrinks back after sending', async () => {
    const page = await newMobilePage(androidCtx);
    await openTask(page, taskB);
    const box = page.getByTestId('mobile-composer-input');
    const single = await composerHeight(page);
    expect(single).toBeGreaterThan(30);

    const lines = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行文字`).join('\n');
    await box.fill(lines);
    await expect.poll(() => composerHeight(page)).toBeGreaterThan(single * 3);
    const grown = await composerHeight(page);
    // Packet asked for >4x; the ~6 line cap (about 154px) is only ~3.5x the 44px single line, so 3x is asserted.
    expect(grown).toBeLessThanOrEqual(800 / 2);
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true); // internal scroll past the cap
    await page.screenshot({ path: path.join(OUT, 'grow-01-20-lines.png') });

    await page.getByTestId('mobile-composer-send').click();
    await expect(box).toHaveValue('');
    await expect.poll(() => composerHeight(page)).toBeLessThanOrEqual(single + 1);
    await page.close();
  });

  for (const [label, getCtx] of [
    ['android 360x800', () => androidCtx],
    ['ios 390x844', () => iosCtx],
  ] as const) {
    test(`font size >= 16px and new-task sheet field order (${label})`, async () => {
      const page = await newMobilePage(getCtx());
      await openTask(page, taskB);
      expect(await fontSize(page, 'mobile-composer-input')).toBeGreaterThanOrEqual(16);
      await page.getByTestId('mobile-back-btn').click();
      await expect(page.getByTestId('mobile-home')).toBeVisible();

      await page.getByTestId('mobile-new-task-btn').click();
      await expect(page.getByTestId('mobile-new-task-sheet')).toBeVisible();
      const prompt = page.getByTestId('mobile-new-task-prompt');
      const title = page.getByTestId('mobile-new-task-title');
      await expect(prompt).toBeFocused();
      expect(await fontSize(page, 'mobile-new-task-prompt')).toBeGreaterThanOrEqual(16);
      expect(await fontSize(page, 'mobile-new-task-title')).toBeGreaterThanOrEqual(16);
      for (const sel of await page.locator('[data-testid="mobile-new-task-sheet"] select').all()) {
        expect(await sel.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      }
      const pb = (await prompt.boundingBox())!;
      const tb = (await title.boundingBox())!;
      expect(pb.y).toBeLessThan(tb.y);
      await page.screenshot({ path: path.join(OUT, `font-${label.split(' ')[0]}-new-task.png`) });
      await page.close();
    });
  }

  test('conversation sticks to bottom only when the user is at the bottom', async ({ request }) => {
    const st = await state(request);
    const projectId = st.projects.find((p) => p.name === 'mob-e2e-input')!.id;
    const created = await createFakeTask(request, projectId, '滚动任务', 'scroll start');
    const scrollTask = created.task;
    const filler = '这是用于撑高对话区的较长消息内容，'.repeat(8);
    const sessionId = created.session.id;
    for (let i = 0; i < 8; i++) {
      const res = await request.post(`/api/tasks/${scrollTask.id}/feedback`, { data: { text: `填充${i} ${filler}`, mode: 'same' } });
      expect(res.ok()).toBeTruthy();
      await expect.poll(() => fakeLines(sessionId).filter((l) => l.startsWith(`填充${i} `)).length, { timeout: 15_000 }).toBe(1);
      // give the 300 ms fake turn time to finish so the next message is not merely queued
      await new Promise((r) => setTimeout(r, 450));
    }

    const page = await newMobilePage(androidCtx);
    await openTask(page, scrollTask.id);
    await expect(page.locator('[data-testid="mobile-turn-assistant"]')).toHaveCount(9, { timeout: 15_000 });
    // First load lands at the bottom.
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(80);
    const scroller = page.locator('[data-testid="mobile-task-view"] .mob-scroll');
    expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
    await expect(page.getByTestId('mobile-scroll-latest')).toHaveCount(0);

    // Scroll up, then new output arrives: no yank, button appears.
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(300);
    await request.post(`/api/tasks/${scrollTask.id}/feedback`, { data: { text: '新的一条输出', mode: 'same' } });
    await expect(page.getByTestId('mobile-scroll-latest')).toBeVisible({ timeout: 15_000 });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(50);
    await page.screenshot({ path: path.join(OUT, 'scroll-01-latest-button.png') });

    await page.getByTestId('mobile-scroll-latest').click();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(80);
    await expect(page.getByTestId('mobile-scroll-latest')).toHaveCount(0);

    // Back at the bottom: the next output follows automatically with no button.
    await request.post(`/api/tasks/${scrollTask.id}/feedback`, { data: { text: '再来一条', mode: 'same' } });
    await expect(page.locator('[data-testid="mobile-turn-user"]').filter({ hasText: '再来一条' })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(80);
    await expect(page.getByTestId('mobile-scroll-latest')).toHaveCount(0);
    await page.close();
  });
});
