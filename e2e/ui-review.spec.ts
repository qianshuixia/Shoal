// UI review follow-ups: 就绪 status, background counter, collapsed-project counts, exited 待验收, zoom keys, layout control.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A fresh session at an empty prompt shows amber 需要你 and counts in the queue
//    -> SessionStart makes it 就绪 (data-status="idle"); 需要你 count stays 0; it is not in the page title count.
// 2. Leaving 启动中 for 就绪 breaks delivery: a message forwarded to a fresh task never arrives
//    -> delivered once to the idle session.
// 3. The page title / taskbar does not say anything is waiting -> "(n) Shoal" with n = 需要你 + 待验收, "Shoal" at 0.
// 4. A collapsed project hides its 待验收 tasks -> collapsed head shows "1 个在等你" and "1 待验收".
// 5. The process ending wipes 待验收 from the row -> exited row still shows 待验收 next to 续接.
// 6. Zoom keys: Ctrl+= / Ctrl+0 / Ctrl+wheel work with the terminal focused; Ctrl+- stays with the CLI there (^_ = undo)
//    but zooms outside a terminal.
// 7. Layout: the segmented control shows which layout is on; the unfocused pane stays readable (opacity .85).
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { forwardText } from '../shared/protocol.ts';
import { createFakeTask, createProject, expectStatus, openReview, fakeLines, pane, removeAllTasks, row, token } from './helpers.ts';

const OUT = path.resolve('.tmp/ui-review-impl');
fs.mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page, request }) => {
  await removeAllTasks(request);
  page.on('dialog', (d) => void d.accept());
});

const group = (page: Page, id: string) => page.locator(`[data-testid="project-group"][data-project-id="${id}"]`);
const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);

test('就绪 is not 需要你; title counts 需要你 + 待验收; collapsed counts; exited keeps 待验收', async ({ page, request }) => {
  const project = await createProject(request, token('uireview'));
  const fresh = await createFakeTask(request, project.id, '刚开的', '');
  await page.goto('/');
  await expectStatus(page, fresh.session.id, 'idle');
  await expect(row(page, fresh.session.id).getByTestId('status')).toHaveText('就绪');
  await expect(page.getByTestId('needs-you-count')).toHaveText('0');
  await expect.poll(() => page.title()).toBe('Shoal');

  const done = await createFakeTask(request, project.id, '做完的', 'hello');
  await expect(taskRow(page, done.task.id)).toHaveAttribute('data-phase', 'review');
  await expect.poll(() => page.title()).toBe('(1) Shoal');
  const asking = await createFakeTask(request, project.id, '要授权的', 'ask');
  await expectStatus(page, asking.session.id, 'needs_you');
  await expect.poll(() => page.title()).toBe('(2) Shoal');
  await expectStatus(page, fresh.session.id, 'idle'); // still not counted

  await group(page, project.id).getByTestId('project-toggle').click();
  await expect(group(page, project.id).getByTestId('group-needs')).toHaveText('1 个在等你');
  await expect(group(page, project.id).getByTestId('group-review')).toHaveText('1 待验收');
  await page.screenshot({ path: path.join(OUT, 'collapsed-counts.png') });
  await group(page, project.id).getByTestId('project-toggle').click();

  // Double Ctrl+C at the prompt ends the fake CLI without a hook: the result is still waiting for a verdict.
  await row(page, done.session.id).click();
  await pane(page, 0).locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+c');
  await expectStatus(page, done.session.id, 'exited');
  await page.mouse.move(0, 0);
  const r = row(page, done.session.id);
  await expect(r.getByTestId('status')).toHaveText('待验收');
  await expect(r.getByTestId('task-resume')).toHaveCount(1);
  await expect(r.getByTestId('row-glyph')).toHaveAttribute('data-glyph', 'review');
  await expect(taskRow(page, done.task.id)).toHaveAttribute('data-phase', 'review');
  await page.screenshot({ path: path.join(OUT, 'exited-review-row.png') });
});

test('a message forwarded to a fresh (就绪) task is delivered once', async ({ page, request }) => {
  const project = await createProject(request, token('idledeliver'));
  const src = await createFakeTask(request, project.id, '出方案', 'make a plan');
  const dst = await createFakeTask(request, project.id, '空白任务', '');
  await page.goto('/');
  await expectStatus(page, dst.session.id, 'idle');
  await row(page, src.session.id).click();
  await expect(taskRow(page, src.task.id)).toHaveAttribute('data-phase', 'review');
  await openReview(page);
  await pane(page, 0).getByTestId('review-forward').click();
  const dlg = page.getByTestId('forward-dialog');
  await dlg.getByTestId('forward-target').selectOption(`task:${dst.task.id}`);
  await dlg.getByTestId('forward-submit').click();
  await expect(dlg).toBeHidden();
  const expected = forwardText({ title: '出方案', agent: 'fake' }, 'reply: make a plan', '');
  await expect.poll(() => fakeLines(dst.session.id), { timeout: 30_000 }).toEqual([expected]);
  await expectStatus(page, dst.session.id, 'needs_you'); // its turn ran and stopped
  await new Promise((r) => setTimeout(r, 2500));
  expect(fakeLines(dst.session.id)).toEqual([expected]);
});

test('zoom keys respect the CLI; layout control; unfocused pane stays readable', async ({ page, request }) => {
  const project = await createProject(request, token('zoomkeys'));
  const a = await createFakeTask(request, project.id, '左边', '');
  const b = await createFakeTask(request, project.id, '右边', '');
  await page.goto('/');
  await page.getByTestId('zoom-value').click(); // 100%
  await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  await row(page, a.session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached' });
  await expect(input).toBeFocused();

  await page.keyboard.press('Control+Equal');
  await expect(page.getByTestId('zoom-value')).toHaveText('105%');
  await page.keyboard.press('Control+Minus'); // in the terminal: goes to the CLI
  await expect(page.getByTestId('zoom-value')).toHaveText('105%');
  await page.keyboard.press('Control+Digit0');
  await expect(page.getByTestId('zoom-value')).toHaveText('100%');
  const box = (await pane(page, 0).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(page.getByTestId('zoom-value')).toHaveText('105%');
  await page.locator('.app-name').click(); // focus leaves the terminal
  await page.keyboard.press('Control+Minus');
  await expect(page.getByTestId('zoom-value')).toHaveText('100%');

  await expect(page.getByTestId('layout-1')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('layout-2').click();
  await expect(page.getByTestId('layout-2')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await pane(page, 1).click();
  await row(page, b.session.id).click();
  await expect(pane(page, 1)).toHaveClass(/focused/);
  await expect(pane(page, 0).locator('.pane-body')).toHaveCSS('opacity', '0.85');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, 'dual-focus.png') });
  await page.getByTestId('layout-1').click();
  await expect(page.getByTestId('pane')).toHaveCount(1);
});
