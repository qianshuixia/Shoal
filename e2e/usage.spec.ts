// Token stats tab and UI zoom.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A message reported twice (Claude writes one line per content block) is counted twice -> totals count each message id once.
// 2. Models / vendors are lumped together -> rows per model and per vendor, with the right numbers.
// 3. Switching to the stats tab tears down the terminals -> back on 工作台 the same terminal still has its history and takes input.
// 4. The time filter is ignored -> a custom range that ends yesterday shows nothing; a bad range is a 400.
// 5. Deleting a task deletes its spend -> totals stay, the task keeps its title and is marked 已删除.
//    Same for removing the whole project: its row keeps the name and is marked deleted.
// 6. Zoom only scales part of the UI -> root font size and the terminal font follow the slider, the terminal refits
//    (fewer columns), the value survives a reload and double-click resets to 100%.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { UsageReport } from '../shared/protocol.ts';
import { createFakeTask, createProject, fakeLines, removeAllTasks, row, state, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/token-stats');
fs.mkdirSync(OUT, { recursive: true });

async function usage(request: APIRequestContext, q = ''): Promise<UsageReport> {
  const res = await request.get(`/api/usage${q}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

async function typeLine(page: Page, sessionId: string, text: string) {
  const before = fakeLines(sessionId).length;
  await page.keyboard.type(text + '\r');
  await expect.poll(() => fakeLines(sessionId).length).toBe(before + 1);
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test.describe('Token 统计与缩放', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ request }) => removeAllTasks(request));

  test('去重、按模型/厂商分组、页签切换不丢终端、时间筛选、删除任务后保留', async ({ page, request }) => {
    // The state dir is fresh per run and only this spec reports usage.
    expect((await usage(request)).total.requests).toBe(0);
    const project = await createProject(request, token('usage'));
    const { task, session } = await createFakeTask(request, project.id, '统计任务甲');
    await page.goto('/');
    await row(page, session.id).click();
    await expect.poll(() => termText(page, session.id)).toContain('FAKE AGENT');

    // Same message id twice (one line per content block), then another vendor's model.
    await typeLine(page, session.id, 'usage claude-test m1 100 20 1000 50');
    await typeLine(page, session.id, 'usage claude-test m1 100 20 1000 50');
    await typeLine(page, session.id, 'usage gpt-test r1 10 5 0 0');
    await expect.poll(async () => (await usage(request)).total.requests, { timeout: 20_000 }).toBe(2);
    const r = await usage(request);
    expect(r.total.input).toBe(110);
    expect(r.total.output).toBe(25);
    expect(r.total.cacheRead).toBe(1000);
    expect(r.total.cacheWrite).toBe(50);
    expect(r.byModel.find((m) => m.label === 'claude-test')).toMatchObject({ vendor: 'Anthropic', input: 100, output: 20, cacheRead: 1000, cacheWrite: 50, requests: 1 });
    expect(r.byModel.find((m) => m.label === 'gpt-test')).toMatchObject({ vendor: 'OpenAI', input: 10, output: 5, requests: 1 });
    expect(r.byTask.find((t) => t.key === task.id)).toMatchObject({ label: '统计任务甲', project: project.name, deleted: false, requests: 2 });

    // Live telemetry pills in topbar & pane header reflect tokens and cache hit rate without switching tabs.
    await expect(page.getByTestId('top-telemetry')).toContainText('1.19K');
    await expect(page.getByTestId('top-telemetry')).toContainText('86%');
    await expect(page.getByTestId('pane-metrics')).toContainText('1.19K');
    await expect(page.getByTestId('pane-metrics')).toContainText('86%');
    await page.screenshot({ path: path.join(OUT, 'telemetry-pills.png') });

    // Stats tab: the workbench is hidden, not unmounted.
    await page.getByTestId('tab-stats').click();
    await expect(page.getByTestId('stats-view')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByTestId('usage-total')).toHaveText('1.19K');
    await expect(page.getByTestId('usage-total').locator('..')).toHaveAttribute('title', '1,185');
    await expect(page.getByTestId('usage-hit-rate')).toHaveText('86%'); // 1000 / (110 + 1000 + 50)
    await expect(page.getByTestId('usage-requests')).toHaveText('2');

    await page.getByTestId('group-byModel').click();
    const modelRow = (name: string) => page.getByTestId('usage-row').filter({ hasText: name });
    await expect(modelRow('claude-test')).toContainText('Anthropic');
    await expect(modelRow('claude-test')).toContainText('1.17K');
    await expect(modelRow('gpt-test')).toContainText('OpenAI');
    await page.getByTestId('group-byVendor').click();
    await expect(page.getByTestId('usage-row').filter({ hasText: 'Anthropic' })).toBeVisible();
    await expect(page.getByTestId('usage-row').filter({ hasText: 'OpenAI' })).toBeVisible();

    // Hover today's column (last of 7 days) -> tooltip with exact numbers.
    const svg = page.getByTestId('usage-trend').locator('svg');
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
    await expect(page.getByTestId('trend-tooltip')).toContainText('1,000');
    await page.screenshot({ path: path.join(OUT, 'stats-7d.png') });

    // Back to the workbench: same terminal, history intact, still takes input.
    await page.getByTestId('tab-work').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    expect(await termText(page, session.id)).toContain('reply: usage gpt-test r1 10 5 0 0');
    await typeLine(page, session.id, 'still here');

    // Custom range ending yesterday: nothing. Invalid range: 400.
    await page.getByTestId('tab-stats').click();
    await page.getByTestId('range-custom').click();
    await page.getByTestId('range-start').fill(day(-3));
    await page.getByTestId('range-end').fill(day(-1));
    await expect(page.getByTestId('usage-total')).toHaveText('0');
    await expect(page.getByText('这个时间段没有 token 记录。')).toBeVisible();
    expect((await request.get('/api/usage?from=abc')).status()).toBe(400);
    await page.getByTestId('range-today').click();
    await expect(page.getByTestId('usage-row').first()).toBeVisible();

    // Delete the task: spend stays, the row keeps its title and is marked deleted.
    await request.delete(`/api/tasks/${task.id}`);
    await expect.poll(async () => (await usage(request)).byTask.find((t) => t.key === task.id)?.deleted).toBe(true);
    expect((await usage(request)).byTask.find((t) => t.key === task.id)).toMatchObject({ label: '统计任务甲', requests: 2 });
    expect((await state(request)).tasks.some((t) => t.id === task.id)).toBe(false);
    await page.getByTestId('group-byTask').click();
    const deletedRow = page.locator(`[data-testid="usage-row"][data-key="${task.id}"]`);
    await expect(deletedRow).toContainText('统计任务甲', { timeout: 15_000 }); // next 10 s refresh at the latest
    await expect(deletedRow).toContainText('已删除');
    await page.screenshot({ path: path.join(OUT, 'stats-deleted-task.png') });

    // Removing the whole project from the workbench keeps its spend too.
    expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
    const after = await usage(request);
    expect(after.total.requests).toBe(2);
    expect(after.byProject.find((p) => p.key === project.id)).toMatchObject({ label: project.name, deleted: true, requests: 2 });
  });

  test('缩放步进：根字号和终端字号跟随、终端重新适配、到边界禁用、滚轮、刷新后保留、点数字恢复', async ({ page, request }) => {
    const project = await createProject(request, token('zoom'));
    const { session } = await createFakeTask(request, project.id, '缩放');
    await page.goto('/');
    await row(page, session.id).click();
    await expect.poll(() => termText(page, session.id)).toContain('FAKE AGENT');
    const cols = async () => (await state(request)).sessions.find((s) => s.id === session.id)!.cols;
    // The page sends a size once it settles: wait until the server has the fitted one, not the spawn default.
    const termCols = () => page.evaluate((id) => (window as any).__wbTermSize(id).cols as number, session.id);
    await expect.poll(async () => (await cols()) === (await termCols())).toBe(true);
    const cols100 = await cols();
    expect(cols100).toBeGreaterThan(60);
    const rootPx = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    const termPx = () => page.evaluate((id) => window.__wbTermFontSize?.(id), session.id);
    expect(await rootPx()).toBe('16px');
    expect(await termPx()).toBe(14);

    const step = async (id: 'zoom-in' | 'zoom-out', n: number) => { for (let i = 0; i < n; i++) await page.getByTestId(id).click(); };
    await step('zoom-in', 5);
    await expect(page.getByTestId('zoom-value')).toHaveText('125%');
    expect(await rootPx()).toBe('20px');
    expect(await termPx()).toBe(18);
    await expect.poll(cols).toBeLessThan(cols100);
    await page.screenshot({ path: path.join(OUT, 'zoom-125.png') });

    // Zoom changed while the terminal is hidden behind the stats tab: it refits when shown again.
    await page.getByTestId('tab-stats').click();
    await step('zoom-out', 9);
    await expect(page.getByTestId('zoom-out')).toBeDisabled();
    await page.getByTestId('tab-work').click();
    expect(await termPx()).toBe(11);
    await expect.poll(cols).toBeGreaterThan(cols100);

    await page.locator('.zoom').hover();
    await page.mouse.wheel(0, -100);
    await expect(page.getByTestId('zoom-value')).toHaveText('85%');
    await step('zoom-in', 5);
    await page.reload();
    await expect(page.getByTestId('zoom-value')).toHaveText('110%');
    expect(await rootPx()).toBe('17.6px');

    await page.getByTestId('zoom-value').click();
    await expect(page.getByTestId('zoom-value')).toHaveText('100%');
    expect(await rootPx()).toBe('16px');
  });
});
