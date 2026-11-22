// Settings dialog and AI task titles (the fake agent's headless generator answers title prompts with 「AI：<first 10 chars>」).
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. The feature spends quota without being asked -> off by default: the title stays the first line of the prompt.
// 2. The explanation is missing or always in the way -> the "?" tip is hidden until hovered, and says what it costs.
// 3. The switch is forgotten -> it is stored by the server: still on after a reload, and visible in /api/state.
// 4. Only one of the two title paths is covered -> a task created with a prompt, and a "新任务 N" task whose first
//    prompt is typed in the terminal, both end up with the generated title (quotes and the explanation line removed).
// 5. A slow generator overwrites a name the user chose meanwhile -> the manual title stays.
// 6. A failed generator leaves a broken title -> the first-line title stays.
// 7. A task created with an explicit title is retitled -> it never is.
// 8. Bad setting values are stored -> 400, setting unchanged.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo, Task } from '../shared/protocol.ts';
import { titleFromPrompt } from '../server/titles.ts';
import { createFakeTask, createProject, expectStatus, removeAllTasks, row, state, token } from './helpers.ts';

const OUT = path.resolve('.tmp/ai-title');
fs.mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });

const setAi = async (request: APIRequestContext, on: boolean) => {
  const res = await request.post('/api/settings', { data: { aiTitles: on } });
  expect(res.ok(), await res.text()).toBeTruthy();
};
test.beforeEach(async ({ request }) => {
  await removeAllTasks(request);
  await setAi(request, false);
});
// The server is shared with the other specs: leave the setting off.
test.afterAll(async ({ request }) => setAi(request, false));

// What the fake generator turns a requirement into, after titleFromReply cleaned it.
const ai = (prompt: string) => `AI：${[...prompt.split('\n')[0]].slice(0, 10).join('')}`.trim();
const titleOf = async (request: APIRequestContext, taskId: string) => (await state(request)).tasks.find((t) => t.id === taskId)?.title;
const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);

async function createUntitled(request: APIRequestContext, projectId: string, prompt: string) {
  const res = await request.post('/api/tasks', { data: { projectId, agent: 'fake', prompt, cols: 120, rows: 30 } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { task: Task; session: SessionInfo };
}

test('off by default: first-line title stays; the ? tip explains the cost only when hovered', async ({ page, request }) => {
  expect((await state(request)).settings).toEqual({ aiTitles: false, autoDelegate: true });
  const project = await createProject(request, token('aioff'));
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const settingsView = page.getByTestId('settings-view');
  await expect(settingsView).toBeVisible();
  await expect(settingsView.getByTestId('setting-ai-titles')).not.toBeChecked();
  const tip = settingsView.getByTestId('setting-ai-titles-tip');
  await expect(tip).toBeHidden();
  await settingsView.getByTestId('setting-ai-titles-help').hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('少量额度');
  await expect(tip).toContainText('Haiku');
  await expect(tip).toContainText('默认关闭');
  // The whole tip is on screen, not clipped by the card or the window.
  const box = (await tip.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  await page.screenshot({ path: path.join(OUT, 'settings-tip.png') });
  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
  await page.getByTestId('tab-work').click();
  await expect(settingsView).toBeHidden();

  const prompt = 'plain first line of the request';
  const { task } = await createUntitled(request, project.id, prompt);
  await expect(taskRow(page, task.id)).toHaveAttribute('data-phase', 'review');
  await new Promise((r) => setTimeout(r, 1500));
  expect(await titleOf(request, task.id)).toBe(titleFromPrompt(prompt));
  expect(titleFromPrompt(prompt)).toContain('…'); // cut at 24 characters, not the generated form
});

test('switched on in the settings tab: persists, and both title paths get the generated title', async ({ page, request }) => {
  const project = await createProject(request, token('aion'));
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const box = page.getByTestId('setting-ai-titles');
  await box.click();
  await expect(box).toBeChecked();
  await expect.poll(async () => (await state(request)).settings.aiTitles).toBe(true);
  await page.screenshot({ path: path.join(OUT, 'settings-on.png') });

  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('setting-ai-titles')).toBeChecked();
  await page.getByTestId('tab-work').click();
  await expect(page.getByTestId('settings-view')).toBeHidden();

  // Path 1: created with a prompt and no title.
  const prompt = '重构登录表单的校验逻辑，顺便补上单元测试\n第二行不该出现';
  const { task, session } = await createUntitled(request, project.id, prompt);
  await expect.poll(() => titleOf(request, task.id), { timeout: 20_000 }).toBe(ai(prompt));
  expect(ai(prompt)).toBe('AI：重构登录表单的校验逻');
  await expect(row(page, session.id).getByTestId('task-title-text')).toHaveText(ai(prompt));

  // Path 2: a "新任务 N" task, first prompt typed in the terminal.
  const blank = await createUntitled(request, project.id, '');
  expect(blank.task.title).toBe('新任务 1');
  await expectStatus(page, blank.session.id, 'idle');
  await row(page, blank.session.id).click();
  await page.keyboard.type('fix the search box IME bug\r');
  await expect.poll(() => titleOf(request, blank.task.id), { timeout: 20_000 }).toBe(ai('fix the search box IME bug'));
  await expect(row(page, blank.session.id).getByTestId('task-title-text')).toHaveText('AI：fix the se');
  await page.mouse.move(5, 5);
  await page.screenshot({ path: path.join(OUT, 'ai-titles.png') });

  // Switching it off again stops it.
  await setAi(request, false);
  const later = await createUntitled(request, project.id, 'after switching it off');
  await expect(taskRow(page, later.task.id)).toHaveAttribute('data-phase', 'review');
  await new Promise((r) => setTimeout(r, 1500));
  expect(await titleOf(request, later.task.id)).toBe('after switching it off');
});

test('a manual title wins over a slow generator; a failed one keeps the first line; explicit titles are left alone; bad values rejected', async ({ page, request }) => {
  await setAi(request, true);
  const project = await createProject(request, token('aihard'));
  await page.goto('/');

  // The generator takes 3 s; the user renames the task meanwhile.
  const slow = await createUntitled(request, project.id, 'TITLE_SLOW 慢慢起名');
  expect(slow.task.title).toBe('TITLE_SLOW 慢慢起名');
  const renamed = await request.patch(`/api/tasks/${slow.task.id}`, { data: { title: '我自己起的名字' } });
  expect(renamed.ok()).toBeTruthy();

  const failing = await createUntitled(request, project.id, 'TITLE_FAIL 起名失败');
  const explicit = await createFakeTask(request, project.id, '创建时就写好的标题', 'hello there');

  // Control: proves the generator is running in this test, and by then the slow one has long answered.
  const control = await createUntitled(request, project.id, 'TITLE_SLOW control task');
  await expect.poll(() => titleOf(request, control.task.id), { timeout: 20_000 }).toBe(ai('TITLE_SLOW control task'));

  expect(await titleOf(request, slow.task.id)).toBe('我自己起的名字');
  expect(await titleOf(request, failing.task.id)).toBe('TITLE_FAIL 起名失败');
  expect(await titleOf(request, explicit.task.id)).toBe('创建时就写好的标题');
  await expect(row(page, slow.session.id).getByTestId('task-title-text')).toHaveText('我自己起的名字');

  const bad = await request.post('/api/settings', { data: { aiTitles: 'yes' } });
  expect(bad.status()).toBe(400);
  expect((await state(request)).settings).toEqual({ aiTitles: true, autoDelegate: true });
});
