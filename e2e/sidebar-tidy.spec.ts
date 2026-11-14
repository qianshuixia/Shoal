// Sidebar tidiness: row order inside a project, one archive for all projects, resizable width.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Stopped tasks bury the running ones, or older tasks stay above newly active ones
//    -> running first, approved next, stopped last; most recently active first within each band.
// 2. An archived task still shows inside its project / each project grows its own 已归档 line
//    -> no archive toggle inside any project; one folded 已归档 section at the bottom, grouped by project.
// 3. The archive fold is forgotten on reload -> open state survives reload.
// 4. The task count clutters an expanded project -> shown only while collapsed.
// 4b. Working is hard to spot -> bright title, a ring leaving the dot (none under reduced motion), and a folded
//     project shows "N 工作中".
// 5. Sidebar width: dragging does nothing, escapes its bounds, or is lost on reload
//    -> follows the pointer, clamps to 13..32rem, survives reload, double-click resets to 17rem.
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { createFakeTask, createProject, expectStatus, removeAllTasks, row, token } from './helpers.ts';

const OUT = path.resolve('.tmp/sidebar-tidy');
fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ request }) => removeAllTasks(request));

const group = (page: Page, id: string) => page.locator(`[data-testid="project-group"][data-project-id="${id}"]`);
const sideWidth = (page: Page) => page.locator('aside.sidebar').evaluate((el) => el.getBoundingClientRect().width);
const remPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

test('rows: running, approved, stopped; archive at the bottom; count only when collapsed', async ({ page, request }) => {
  const project = await createProject(request, token('tidy'));
  const stopped = await createFakeTask(request, project.id, '已停止的', 'exit 0');
  const done = await createFakeTask(request, project.id, '已通过的', 'hello');
  const busy = await createFakeTask(request, project.id, '还在跑的', 'sleep 60');
  const later = await createFakeTask(request, project.id, '后建的', 'hello');
  await page.goto('/');
  await expectStatus(page, stopped.session.id, 'exited');
  await expectStatus(page, done.session.id, 'needs_you');
  await expect((await request.post(`/api/tasks/${done.task.id}/approve`, { data: {} })).ok()).toBeTruthy();
  await expect(row(page, done.session.id).getByTestId('status')).toHaveText('已通过');

  const titles = group(page, project.id).locator('.task-title');
  await expect(titles).toHaveText(['后建的', '还在跑的', '已通过的', '已停止的']);
  // Status changes inside the running band do not move rows.
  await expectStatus(page, later.session.id, 'needs_you');
  await expect(titles).toHaveText(['后建的', '还在跑的', '已通过的', '已停止的']);

  await expect(group(page, project.id).locator('.group-count')).toHaveCount(0);

  // Working reads at a glance: bright title, a ring leaving the dot (still under reduced motion), and a folded
  // project counts its working tasks ahead of its other chips.
  await expectStatus(page, busy.session.id, 'working');
  const busyRow = row(page, busy.session.id);
  const ring = () => busyRow.getByTestId('row-glyph').evaluate((el) => getComputedStyle(el, '::after').animationName);
  await expect(busyRow.locator('.task-title')).toHaveCSS('color', 'rgb(243, 244, 246)');
  expect(await ring()).toBe('ping');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await ring()).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.screenshot({ path: path.join(OUT, 'working.png') });
  await group(page, project.id).getByTestId('project-toggle').click();
  await expect(group(page, project.id).getByTestId('group-live')).toHaveText('1 工作中');
  // 后建的 has finished its turn by now (在等你 or 待验收): that chip follows the working mark.
  await expect(group(page, project.id).locator('[data-testid="group-live"] + :is(.group-needs, .group-review)')).toHaveCount(1);
  await page.screenshot({ path: path.join(OUT, 'working-folded.png') });
  await group(page, project.id).getByTestId('project-toggle').click();

  // Archive the running one (confirm) and the stopped one.
  page.on('dialog', (d) => void d.accept());
  for (const s of [busy.session.id, stopped.session.id]) {
    await row(page, s).hover();
    await row(page, s).getByTestId('task-remove').click();
    await expect(row(page, s)).toHaveCount(0);
  }
  await expect(group(page, project.id).getByTestId('archived-toggle')).toHaveCount(0);
  const toggle = page.getByTestId('archived-toggle');
  await expect(toggle).toHaveText(/已归档\s*2/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const archived = page.locator(`[data-testid="archive-section"] .archive-group[data-project-id="${project.id}"]`);
  await expect(archived.locator('.archive-project')).toHaveText(project.name);
  await expect(archived.locator('.task-title')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('archived-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(archived.getByTestId('task-unarchive')).toHaveCount(2);
  await page.screenshot({ path: path.join(OUT, 'archive.png') });

  // Unarchive puts it back in its project, stopped band.
  await row(page, busy.session.id).getByTestId('task-unarchive').click();
  await expect(titles).toHaveText(['后建的', '已通过的', '还在跑的']);

  // Resuming a stopped task promotes its new live session to the very top of the project.
  await row(page, busy.session.id).getByTestId('task-resume').click();
  await expect(titles).toHaveText(['还在跑的', '后建的', '已通过的']);

  // Collapse check: 1 待验收 ('后建的') shows on the collapsed header instead of plain count.
  await group(page, project.id).getByTestId('project-toggle').click();
  await expect(group(page, project.id).getByTestId('group-review')).toHaveText('1 待验收');
  await expect(group(page, project.id).locator('.group-count')).toHaveCount(0);
});

test('sidebar width drags, clamps, persists and resets', async ({ page, request }) => {
  await createProject(request, token('width'));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('wb.sideWidth'));
  await page.reload();
  const rem = await remPx(page);
  await expect.poll(() => sideWidth(page)).toBeCloseTo(17 * rem, 0);

  const handle = page.getByTestId('side-resizer');
  const drag = async (toX: number) => {
    const b = (await handle.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(toX, b.y + 220, { steps: 5 });
    await page.mouse.up();
  };
  await drag(22 * rem);
  await expect.poll(() => sideWidth(page)).toBeCloseTo(22 * rem, -1);
  await page.reload();
  await expect.poll(() => sideWidth(page)).toBeCloseTo(22 * rem, -1);

  await drag(2);
  await expect.poll(() => sideWidth(page)).toBeCloseTo(13 * rem, 0);
  await drag(5000);
  await expect.poll(() => sideWidth(page)).toBeCloseTo(32 * rem, 0);
  await page.screenshot({ path: path.join(OUT, 'wide.png') });

  await handle.dblclick();
  await expect.poll(() => sideWidth(page)).toBeCloseTo(17 * rem, 0);
});
