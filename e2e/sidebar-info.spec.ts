// Sidebar info: git branch chip on the project head, latest prompt under the task title.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A git project shows no branch / a long branch name overflows the head -> chip with the middle-truncated name
//    (head 10 + … + tail 10), full name and the dirty count in its title.
// 2. A non-git project shows a chip (or an error) -> no chip.
// 3. The count goes stale after files change under the agent -> follows within the 10 s poll (the medium-hard case).
// 4. A narrow sidebar pushes the head's buttons out or cuts the project name -> at 13rem the + / remove buttons stay
//    inside the sidebar and the branch chip shrinks before the name does (ends narrower than it).
// 5. The preview shows after the task ended, or when it only repeats the title -> hidden for exited tasks and
//    for a title that equals the prompt.
// 6. A follow-up prompt typed in the terminal leaves the old preview -> replaced.
// 7. A preview row drifts the glyph / status / agent icon off the title line, or plain rows change height
//    -> plain row stays 1.875rem; glyph stays level with the title.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, token } from './helpers.ts';

const OUT = path.resolve('.tmp/sidebar-info');
fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ request }) => removeAllTasks(request));

const BRANCH = 'feat/some-very-long-branch-name-here';
const group = (page: import('@playwright/test').Page, id: string) =>
  page.locator(`[data-testid="project-group"][data-project-id="${id}"]`);

test('git chip: branch, dirty count that follows changes, no chip outside a repo', async ({ page, request }) => {
  const name = token('git');
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', BRANCH], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const res = await request.post('/api/projects', { data: { name, path: dir } });
  expect(res.ok()).toBeTruthy();
  const project = await res.json();
  // Outside this checkout: the sandbox under .tmp/ sits inside the workbench's own repo, which git would report.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-nogit-'));
  const plain = await (await request.post('/api/projects', { data: { name: token('nogit'), path: plainDir } })).json();

  await page.goto('/');
  const chip = group(page, project.id).getByTestId('project-branch');
  await expect(chip).toContainText('feat/some-…-name-here');
  await expect(chip).not.toContainText('very-long');
  await expect(chip).toHaveAttribute('title', `分支 ${BRANCH}，1 个文件有未提交的改动`);
  await expect(chip).toHaveAttribute('data-private', '');
  await expect(group(page, project.id).getByTestId('project-dirty')).toHaveText('· 1');
  await expect(group(page, plain.id).getByTestId('project-branch')).toHaveCount(0);

  // Another file appears while the page is open: the poll picks it up.
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  await expect(group(page, project.id).getByTestId('project-dirty')).toHaveText('· 2', { timeout: 25_000 });
  await expect(chip).toHaveAttribute('title', `分支 ${BRANCH}，2 个文件有未提交的改动`);

  // Narrow sidebar with a collapsed count badge: the buttons must stay inside it.
  await createFakeTask(request, project.id, '任务', 'hello');
  await group(page, project.id).getByTestId('project-toggle').click();
  await page.evaluate(() => localStorage.setItem('wb.sideWidth', '13'));
  await page.reload();
  const side = (await page.locator('aside.sidebar').boundingBox())!;
  const remove = (await group(page, project.id).getByTestId('project-remove').boundingBox())!;
  const add = (await group(page, project.id).getByTestId('project-add-task').boundingBox())!;
  expect(remove.x + remove.width).toBeLessThanOrEqual(side.x + side.width + 0.5);
  expect(add.x + add.width).toBeLessThanOrEqual(side.x + side.width + 0.5);
  // The chip gives way first: it ends up narrower than the project name (13rem with a count badge leaves room for neither in full).
  const nameBox = (await group(page, project.id).locator('.group-name').boundingBox())!;
  const chipBox = (await group(page, project.id).getByTestId('project-branch').boundingBox())!;
  expect(chipBox.width).toBeLessThan(nameBox.width);
  await page.screenshot({ path: path.join(OUT, 'git-narrow.png'), clip: { x: side.x, y: side.y, width: side.width, height: 300 } });
  await page.evaluate(() => localStorage.removeItem('wb.sideWidth'));
});

test('git chip: long CJK project names never crush the dirty pill into a circle or overlap the task count', async ({ page, request }) => {
  const mkRepo = async (name: string, branch: string, dirtyCount: number) => {
    const dir = path.join(OUT, token('cjk'));
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
    for (let i = 0; i < dirtyCount; i++) fs.writeFileSync(path.join(dir, `f-${i}.txt`), String(i));
    const res = await request.post('/api/projects', { data: { name, path: dir } });
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as { id: string };
  };

  const pWechat = await mkRepo('wechat-article-个人创作资料中心', 'main', 12);
  const pXiapost = await mkRepo('xiapost-浅水虾自媒体分发平台', 'main', 3);
  const t1 = await createFakeTask(request, pXiapost.id, '任务一', 'exit 0');
  const t2 = await createFakeTask(request, pXiapost.id, '任务二', 'exit 0');

  await page.goto('/');
  await expectStatus(page, t1.session.id, 'exited');
  await expectStatus(page, t2.session.id, 'exited');
  await group(page, pXiapost.id).getByTestId('project-toggle').click();

  for (const [widthRem, file] of [['15.75', 'git-long-cjk-default.png'], ['13', 'git-long-cjk-narrow.png']] as const) {
    await page.evaluate((w) => localStorage.setItem('wb.sideWidth', w), widthRem);
    await page.reload();
    const side = (await page.locator('aside.sidebar').boundingBox())!;
    for (const pid of [pWechat.id, pXiapost.id]) {
      const g = group(page, pid);
      const nameBox = (await g.locator('.group-name').boundingBox())!;
      const chipBox = (await g.getByTestId('project-branch').boundingBox())!;
      const dirtyBox = (await g.getByTestId('project-dirty').boundingBox())!;
      const addBox = (await g.getByTestId('project-add-task').boundingBox())!;
      // Dirty count stays strictly inside the pill border, the pill never collapses into a ~14px circle, and the project name stays readable.
      expect(nameBox.width).toBeGreaterThanOrEqual(48);
      expect(chipBox.width).toBeGreaterThanOrEqual(24);
      expect(dirtyBox.x).toBeGreaterThanOrEqual(chipBox.x - 0.5);
      expect(dirtyBox.x + dirtyBox.width).toBeLessThanOrEqual(chipBox.x + chipBox.width + 0.5);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(side.x + side.width + 0.5);
    }
    const countBox = (await group(page, pXiapost.id).locator('.group-count').boundingBox())!;
    const xiaChip = (await group(page, pXiapost.id).getByTestId('project-branch').boundingBox())!;
    expect(xiaChip.x + xiaChip.width).toBeLessThanOrEqual(countBox.x + 0.5);
    await page.screenshot({ path: path.join(OUT, file), clip: { x: side.x, y: side.y, width: side.width, height: 380 } });
  }
  await page.evaluate(() => localStorage.removeItem('wb.sideWidth'));
});

test('task preview: shows the latest prompt, follows follow-ups, hides when redundant or exited', async ({ page, request }) => {
  const project = await createProject(request, token('prev'));
  const withPrompt = await createFakeTask(request, project.id, '登录问题', 'fix the login redirect loop');
  const same = await createFakeTask(request, project.id, 'sleep 60', 'sleep 60');
  const plainTask = await createFakeTask(request, project.id, '没有需求', '');
  const gone = await createFakeTask(request, project.id, '已结束', 'exit 0');
  await page.goto('/');
  await expectStatus(page, gone.session.id, 'exited');
  await expectStatus(page, withPrompt.session.id, 'needs_you');

  const preview = (sid: string) => row(page, sid).getByTestId('task-preview');
  await expect(preview(withPrompt.session.id)).toHaveText('fix the login redirect loop');
  await expect(preview(same.session.id)).toHaveCount(0);
  await expect(preview(plainTask.session.id)).toHaveCount(0);
  await expect(preview(gone.session.id)).toHaveCount(0);

  // Layout: plain rows keep their height; in a preview row the glyph sits level with the title.
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const plainBox = (await row(page, plainTask.session.id).boundingBox())!;
  expect(plainBox.height).toBeCloseTo(1.875 * rem, 0);
  const prow = row(page, withPrompt.session.id);
  const prowBox = (await prow.boundingBox())!;
  expect(prowBox.height).toBeGreaterThan(plainBox.height + 8);
  const mid = async (loc: ReturnType<typeof prow.locator>) => { const b = (await loc.boundingBox())!; return b.y + b.height / 2; };
  const titleY = await mid(prow.locator('.task-title'));
  expect(Math.abs((await mid(prow.getByTestId('row-glyph'))) - titleY)).toBeLessThan(1.5);
  expect(Math.abs((await mid(prow.getByTestId('status'))) - titleY)).toBeLessThan(1.5);
  expect(Math.abs((await mid(prow.locator('.agent-mark'))) - titleY)).toBeLessThan(1.5);
  const tx = (await prow.locator('.task-title').boundingBox())!.x;
  expect(Math.abs((await preview(withPrompt.session.id).boundingBox())!.x - tx)).toBeLessThan(1);

  // Opening the row (in-pane colour, swatch) keeps the preview aligned with the title.
  await prow.click();
  await expect(prow).toHaveClass(/in-pane/);
  const tx2 = (await prow.locator('.task-title').boundingBox())!.x;
  expect(Math.abs((await preview(withPrompt.session.id).boundingBox())!.x - tx2)).toBeLessThan(1);
  await page.locator('aside.sidebar').screenshot({ path: path.join(OUT, 'preview.png') });

  // A follow-up typed into the terminal replaces the preview; slash commands do not.
  await pane(page, 0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('/status\r'
);
  await page.keyboard.type('now add a regression test\r');
  await expect(preview(withPrompt.session.id)).toHaveText('now add a regression test');

  // Ending the task hides the preview; the data stays on the task.
  await page.keyboard.type('exit 0\r');
  await expectStatus(page, withPrompt.session.id, 'exited');
  await expect(preview(withPrompt.session.id)).toHaveCount(0);
  await page.locator('aside.sidebar').screenshot({ path: path.join(OUT, 'preview-exited.png') });
});
