// Resuming exited tasks and the visible rename buttons.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. An exited task can only be deleted -> the row shows 续接 and the pane offers 续接上次会话 / 新开会话.
// 2. Resume starts a blank conversation -> the CLI gets its resume flag with the old native id (fake prints
//    "RESUMED <id>"), the native id is kept, input reaches the new session.
// 3. Resume lands in the wrong pane or leaves the old session behind -> same pane in dual layout; the task points at
//    the new session and the old one is gone from state.
// 4. A session that never got a prompt is "resumed" into nothing -> only 新开会话 is offered; the row button asks first
//    (cancel leaves the old session untouched) and only starts a new conversation on OK.
// 4b. The CLI switched conversation itself (/resume) -> the workbench follows the new native id and resumes that one.
// 5. Resume while running / unknown task -> 409 / 404, nothing spawned.
// 6. Rename is only discoverable by double-click -> pencil buttons on the row (hover) and in the pane header.
// 7. The agent icon outshines the state on idle rows -> dimmed on a stopped row, full again on hover.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, fakeLines, pane, removeAllTasks, row, state, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/resume');
fs.mkdirSync(OUT, { recursive: true });

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page, request }) => {
  await removeAllTasks(request);
  page.on('dialog', (d) => d.accept());
});

const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);

async function sessionOf(page: Page, taskId: string, not: string) {
  let sid = '';
  await expect.poll(async () => (sid = (await state(page.request)).tasks.find((t) => t.id === taskId)?.sessionId ?? '')).not.toBe(not);
  return sid;
}

test('退出的任务：续接上次会话、新开会话，留在原窗格，旧会话不残留', async ({ page, request }) => {
  const project = await createProject(request, token('resume'));
  const { task, session: s1 } = await createFakeTask(request, project.id, '要续接的任务', 'hello');
  const other = (await createFakeTask(request, project.id, '左边的任务', 'hi')).session;
  await page.goto('/');
  await expectStatus(page, s1.id, 'needs_you');
  await expectStatus(page, other.id, 'needs_you');
  const native1 = (await state(request)).sessions.find((s) => s.id === s1.id)!.nativeSessionId;
  expect(native1).toBe(`fake-${s1.id}`);

  // Dual layout, the task in the right pane.
  await page.getByTestId('layout-2').click();
  await pane(page, 0).click();
  await row(page, other.id).click();
  await pane(page, 1).click();
  await row(page, s1.id).click();
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', s1.id);

  // API guards while it still runs.
  expect((await request.post(`/api/tasks/${task.id}/resume`, { data: {} })).status()).toBe(409);
  expect((await request.post('/api/tasks/nope/resume', { data: {} })).status()).toBe(404);

  await page.keyboard.type('exit 0\r');
  await expectStatus(page, s1.id, 'exited');
  await expect(row(page, s1.id).getByTestId('task-resume')).toBeVisible();
  // The prompt's hook may be lost in the exit, leaving it 待验收; any other status is gone.
  await expect(row(page, s1.id).getByTestId('status').filter({ hasNotText: '待验收' })).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(row(page, s1.id).getByTestId('agent-icon')).toHaveCSS('opacity', '0.45');
  await row(page, s1.id).hover();
  await expect(row(page, s1.id).getByTestId('agent-icon')).toHaveCSS('opacity', '1');
  await expect(pane(page, 1).getByTestId('pane-exited')).toBeVisible();
  await expect(pane(page, 1).getByTestId('pane-resume')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'exited.png') });

  // Row button: reopens the same conversation in the same pane.
  await taskRow(page, task.id).getByTestId('task-resume').click();
  const s2 = await sessionOf(page, task.id, s1.id);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', s2);
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', other.id);
  await expectStatus(page, s2, 'idle');
  await expect.poll(() => termText(page, s2)).toContain(`RESUMED ${native1}`);
  await expect(pane(page, 1).getByTestId('pane-exited')).toHaveCount(0);
  let st = await state(request);
  expect(st.sessions.find((s) => s.id === s2)?.nativeSessionId).toBe(native1);
  expect(st.sessions.find((s) => s.id === s1.id)).toBeUndefined();
  await expect(page.getByTestId('notice')).toHaveCount(0);
  // Keys go to the resumed session.
  await page.keyboard.type('after resume\r');
  await expect.poll(() => fakeLines(s2)).toEqual(['after resume']);
  await page.screenshot({ path: path.join(OUT, 'resumed.png') });

  // Pane button "新开会话": a new conversation with a new native id.
  await page.keyboard.type('exit 0\r');
  await expectStatus(page, s2, 'exited');
  await pane(page, 1).getByTestId('pane-fresh').click();
  const s3 = await sessionOf(page, task.id, s2);
  await expect(pane(page, 1)).toHaveAttribute('data-session-id', s3);
  await expectStatus(page, s3, 'idle');
  await expect.poll(() => termText(page, s3)).toContain('FAKE AGENT');
  expect(await termText(page, s3)).not.toContain('RESUMED');
  st = await state(request);
  expect(st.sessions.find((s) => s.id === s3)?.nativeSessionId).toBe(`fake-${s3}`);
  expect(st.sessions.filter((s) => s.taskId === task.id).map((s) => s.id)).toEqual([s3]);
});

test('没有对话记录的会话：只提供新开会话，行内续接先询问，取消不动旧会话，确认才新开', async ({ page, request }) => {
  page.removeAllListeners('dialog'); // this test decides itself whether to accept
  const confirmText = (title: string) =>
    `任务「${title}」上次的会话找不到可续接的对话记录。\n新开会话会替换面板里这个会话的终端内容。\n要新开会话吗？`;
  const project = await createProject(request, token('fresh'));
  const { task, session: s1 } = await createFakeTask(request, project.id, '没说过话');
  await page.goto('/');
  await expectStatus(page, s1.id, 'idle');
  await row(page, s1.id).click();
  // Double Ctrl+C quits the fake CLI without any prompt.
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+C');
  await expectStatus(page, s1.id, 'exited');
  expect((await state(request)).sessions.find((s) => s.id === s1.id)?.resumable).toBe(false);
  await expect(pane(page, 0).getByTestId('pane-exited')).toBeVisible();
  await expect(pane(page, 0).getByTestId('pane-resume')).toHaveCount(0);
  await expect(pane(page, 0).getByTestId('pane-fresh')).toBeVisible();

  // Cancel: nothing changes.
  const oldText = await termText(page, s1.id);
  expect(oldText).toContain('FAKE AGENT');
  const dismissed = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.dismiss();
    }),
  );
  await taskRow(page, task.id).getByTestId('task-resume').click();
  expect(await dismissed).toBe(confirmText('没说过话'));
  await page.waitForTimeout(500);
  let st = await state(request);
  expect(st.tasks.find((t) => t.id === task.id)?.sessionId).toBe(s1.id);
  expect(st.sessions.find((s) => s.id === s1.id)?.status).toBe('exited');
  expect(st.sessions.filter((s) => s.taskId === task.id).map((s) => s.id)).toEqual([s1.id]);
  await expect(pane(page, 0)).toHaveAttribute('data-session-id', s1.id);
  expect(await termText(page, s1.id)).toContain('FAKE AGENT');
  await expect(page.getByTestId('notice')).toHaveCount(0);

  // OK: a new session replaces it.
  const accepted = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.accept();
    }),
  );
  await taskRow(page, task.id).getByTestId('task-resume').click();
  expect(await accepted).toBe(confirmText('没说过话'));
  const s2 = await sessionOf(page, task.id, s1.id);
  await expectStatus(page, s2, 'idle');
  await expect.poll(() => termText(page, s2)).toContain('FAKE AGENT');
  expect(await termText(page, s2)).not.toContain('RESUMED');
  await expect(page.getByTestId('notice')).toHaveCount(0);
  st = await state(request);
  expect(st.sessions.filter((s) => s.taskId === task.id).map((s) => s.id)).toEqual([s2]);
});

test('在 CLI 里 /resume 切换过对话：续接打开切换后的那段，不弹窗', async ({ page, request }) => {
  let dialogs = 0;
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => {
    dialogs++;
    void d.accept();
  });
  const project = await createProject(request, token('switch'));
  const { task, session: s1 } = await createFakeTask(request, project.id, '切换对话', 'hello-a');
  const other = `fake-other-${token('c')}`;
  await page.goto('/');
  await expectStatus(page, s1.id, 'needs_you');
  await row(page, s1.id).click();
  await page.keyboard.type(`/resume ${other}\r`);
  await expect.poll(() => termText(page, s1.id)).toContain(`RESUMED ${other}`);
  await expect.poll(async () => (await state(request)).sessions.find((s) => s.id === s1.id)?.nativeSessionId).toBe(other);
  // /resume is not a prompt.
  expect(fakeLines(s1.id)).toEqual(['hello-a']);
  await page.keyboard.type('hello-b\r');
  await expect.poll(() => fakeLines(s1.id)).toEqual(['hello-a', 'hello-b']);
  await expect.poll(() => termText(page, s1.id)).toContain('reply: hello-b');
  await expectStatus(page, s1.id, 'needs_you');
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+C');
  await expectStatus(page, s1.id, 'exited');
  expect((await state(request)).sessions.find((s) => s.id === s1.id)?.resumable).toBe(true);

  await taskRow(page, task.id).getByTestId('task-resume').click();
  const s2 = await sessionOf(page, task.id, s1.id);
  await expectStatus(page, s2, 'idle');
  await expect.poll(() => termText(page, s2)).toContain(`RESUMED ${other}`);
  expect((await state(request)).sessions.find((s) => s.id === s2)?.nativeSessionId).toBe(other);
  expect(dialogs).toBe(0);
  await expect(page.getByTestId('notice')).toHaveCount(0);
});

test('改名按钮：任务行悬停出现铅笔，窗格标题旁也有，输入不进终端', async ({ page, request }) => {
  const project = await createProject(request, token('rename'));
  const { task, session } = await createFakeTask(request, project.id, '旧名字', 'hi');
  await page.goto('/');
  await expectStatus(page, session.id, 'needs_you');
  await row(page, session.id).click();

  const r = row(page, session.id);
  await page.mouse.move(900, 500);
  await expect(r.getByTestId('task-rename')).toBeHidden();
  await expect(r.getByTestId('status')).toBeVisible();
  await r.hover();
  await expect(r.getByTestId('task-rename')).toBeVisible();
  await expect(r.getByTestId('status')).toBeHidden();
  await page.screenshot({ path: path.join(OUT, 'row-hover.png') });
  await r.getByTestId('task-rename').click();
  await page.getByTestId('title-input').fill('行内改名');
  await page.keyboard.press('Enter');
  await expect(r.getByTestId('task-title-text')).toHaveText('行内改名');

  await pane(page, 0).getByTestId('pane-header').hover();
  await pane(page, 0).getByTestId('pane-rename').click();
  await page.getByTestId('title-input').fill('窗格改名');
  await page.keyboard.press('Enter');
  await expect(pane(page, 0).getByTestId('pane-title')).toHaveText('窗格改名');
  await expect.poll(async () => (await state(request)).tasks.find((t) => t.id === task.id)?.title).toBe('窗格改名');
  expect(fakeLines(session.id)).toEqual(['hi']);
});
