// Sidebar scanning and keyboard: state glyph, swatch only for rows in a pane, 活跃/全部 filter, Alt+K task search, Alt+1/2 pane focus.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. State only readable from the status text -> every row has a glyph; working / idle differ.
// 2. Every row carries a task color -> only the row shown in a pane has the swatch.
// 3. Stopped tasks pile up -> 活跃 hides them with a count, the choice survives reload, the count button shows them again.
// 4. Search steals or loses focus -> Alt+K opens, typing filters, Enter opens the task in the focused pane, Esc closes.
// 5. Pane focus needs the mouse in dual layout -> Alt+2 / Alt+1 move the focused pane.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, state, token } from './helpers.ts';

const OUT = path.resolve('.tmp/sidebar-ux');
fs.mkdirSync(OUT, { recursive: true });
const group = (page: Page, id: string) => page.locator(`[data-testid="project-group"][data-project-id="${id}"]`);

test.beforeEach(async ({ request }) => removeAllTasks(request));

const glyph = (page: Page, sessionId: string) => row(page, sessionId).getByTestId('row-glyph');

test('row glyph reflects state; the swatch is only on the row shown in a pane', async ({ page, request }) => {
  const project = await createProject(request, token('ux'));
  const busy = await createFakeTask(request, project.id, 'busy', 'sleep 30');
  const calm = await createFakeTask(request, project.id, 'calm', '');
  await page.goto('/');
  await expectStatus(page, busy.session.id, 'working');
  await expectStatus(page, calm.session.id, 'idle');
  await expect(glyph(page, busy.session.id)).toHaveAttribute('data-glyph', 'working');
  await expect(glyph(page, calm.session.id)).toHaveAttribute('data-glyph', 'idle');

  await row(page, calm.session.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', calm.session.id);
  await expect(row(page, calm.session.id).getByTestId('task-swatch')).toHaveCount(1);
  await expect(row(page, busy.session.id).getByTestId('task-swatch')).toHaveCount(0);
  // The agent icon is the last thing in the row.
  await expect(row(page, calm.session.id).locator(':scope > *').last().getByTestId('agent-icon')).toHaveCount(1);
});

test('活跃 hides stopped tasks with a count, survives reload, and expands locally without leaking other projects', async ({ page, request }) => {
  const projectA = await createProject(request, token('fltA'));
  const projectB = await createProject(request, token('fltB'));
  const liveA = await createFakeTask(request, projectA.id, 'live-a', '');
  const deadA = await createFakeTask(request, projectA.id, 'dead-a', 'exit 0');
  const deadB = await createFakeTask(request, projectB.id, 'dead-b', 'exit 0');
  await page.goto('/');
  await expectStatus(page, deadA.session.id, 'exited');
  await expectStatus(page, deadB.session.id, 'exited');
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('filter-active').click();
  await expect(row(page, deadA.session.id)).toHaveCount(0);
  await expect(row(page, deadB.session.id)).toHaveCount(0);
  await expect(row(page, liveA.session.id)).toHaveCount(1);
  await expect(group(page, projectA.id).getByTestId('group-hidden')).toHaveText('另有 1 个已退出');
  await expect(group(page, projectB.id).getByTestId('group-hidden')).toHaveText('另有 1 个已退出');

  await page.reload();
  await expect(page.getByTestId('filter-active')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, deadA.session.id)).toHaveCount(0);

  // Expanding projectA locally shows only projectA's stopped task while keeping global 活跃 checked and projectB hidden.
  await group(page, projectA.id).getByTestId('group-hidden').click();
  await expect(page.getByTestId('filter-active')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, deadA.session.id)).toHaveCount(1);
  await expect(row(page, deadB.session.id)).toHaveCount(0);
  await group(page, projectA.id).getByTestId('group-collapse-stopped').click();
  await expect(row(page, deadA.session.id)).toHaveCount(0);
});

test('全部 folds stopped tasks past the latest 2 and archives only non-review stopped tasks in one click', async ({ page, request }) => {
  const project = await createProject(request, token('fold'));
  const stoppedList: Awaited<ReturnType<typeof createFakeTask>>[] = [];
  for (let i = 1; i <= 5; i++) {
    const t = await createFakeTask(request, project.id, `旧会话-${i}`, 'exit 0');
    stoppedList.push(t);
  }
  const reviewTask = await createFakeTask(request, project.id, '待验收会话', 'hello');
  const liveTask = await createFakeTask(request, project.id, '正在工作会话', 'sleep 30');

  // Wait via API for all 5 short-lived sessions to exit (3 of them are folded out of the DOM by default).
  await expect
    .poll(async () => {
      const snap = await state(request);
      return stoppedList.every((s) => snap.sessions.find((x) => x.id === s.session.id)?.status === 'exited');
    })
    .toBe(true);

  await page.goto('/');
  await expect(page.getByTestId('filter-all')).toHaveAttribute('aria-checked', 'true');
  await expectStatus(page, liveTask.session.id, 'working');
  await expectStatus(page, reviewTask.session.id, 'needs_you');
  // Exit the review task's session while keeping its phase === 'review' (must stay visible and protected from bulk tidy).
  await row(page, reviewTask.session.id).click();
  await page.keyboard.type('exit 0\r');
  await expectStatus(page, reviewTask.session.id, 'exited');
  await expect(row(page, reviewTask.session.id)).toHaveAttribute('data-phase', 'review');
  // Move focus back to the live working session so no older stopped task is held open in the pane.
  await row(page, liveTask.session.id).click();

  const g = group(page, project.id);
  // Visible: liveTask + reviewTask + latest 2 stopped = 4 rows; oldest 3 stopped are folded.
  await expect(g.getByTestId('task-row')).toHaveCount(4);
  await expect(g.getByTestId('group-hidden')).toHaveText('展开其余 3 个已退出');
  await expect(g.getByTestId('group-archive-stopped')).toHaveText('归档已退出 (5)');
  await page.locator('aside.sidebar').screenshot({ path: path.join(OUT, 'progressive-fold.png') });

  // Local expand & collapse back.
  await g.getByTestId('group-hidden').click();
  await expect(g.getByTestId('task-row')).toHaveCount(7);
  await g.getByTestId('group-collapse-stopped').click();
  await expect(g.getByTestId('task-row')).toHaveCount(4);

  // One-click bulk archive moves all 5 non-review stopped tasks to 已归档 while preserving liveTask and reviewTask.
  await g.getByTestId('group-archive-stopped').click();
  await expect(g.getByTestId('task-row')).toHaveCount(2);
  await expect(row(page, liveTask.session.id)).toHaveCount(1);
  await expect(row(page, reviewTask.session.id)).toHaveCount(1);
  await expect(g.getByTestId('group-foot')).toHaveCount(0);
  await expect(page.getByTestId('archived-toggle')).toHaveText(/已归档\s*5/);
  await page.locator('aside.sidebar').screenshot({ path: path.join(OUT, 'after-bulk-tidy.png') });
});

test('Alt+K searches tasks: filter, Enter opens in the focused pane, Esc closes', async ({ page, request }) => {
  const project = await createProject(request, token('srch'));
  const needle = token('needle');
  const target = await createFakeTask(request, project.id, `alpha-${needle}`, '');
  const other = await createFakeTask(request, project.id, 'beta-other', '');
  await page.goto('/');
  await expectStatus(page, target.session.id, 'idle');
  await row(page, other.session.id).click();
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', other.session.id);

  await page.keyboard.press('Alt+KeyK');
  const input = page.getByTestId('task-search-input');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('task-search-item')).toHaveCount(2);
  await input.fill(needle.toUpperCase());
  await expect(page.getByTestId('task-search-item')).toHaveCount(1);
  await expect(page.getByTestId('task-search-item')).toHaveAttribute('data-session-id', target.session.id);
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', target.session.id);

  await page.keyboard.press('Alt+KeyK');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);

  // The sidebar button opens it too; no match shows no items.
  await page.getByTestId('search-btn').click();
  await input.fill('no-such-task-anywhere');
  await expect(page.getByTestId('task-search-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Alt+2 / Alt+1 move the focused pane in dual layout', async ({ page, request }) => {
  const project = await createProject(request, token('dual'));
  const a = await createFakeTask(request, project.id, 'left', '');
  await createFakeTask(request, project.id, 'right', '');
  await page.goto('/');
  await expectStatus(page, a.session.id, 'idle');
  await page.getByTestId('layout-2').click();
  await pane(page, 0).click();
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');

  await page.keyboard.press('Alt+Digit2');
  await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'false');
  await page.keyboard.press('Alt+Digit1');
  await expect(pane(page, 0)).toHaveAttribute('data-focused', 'true');
});
