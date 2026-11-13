// M2 acceptance: result cards, the 待验收 queue, feedback into a new or the same session.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A finished turn is lost among running sessions -> the task enters 待验收 with the agent's last reply as its card;
//    it is counted under 待验收, not 需要你.
// 2. Feedback in a new session starts without context -> its first prompt carries the task prompt, the last result
//    and the feedback (multi-line intact); the old session is gone; the feedback is kept as a card.
// 3. Pasting while the agent is busy or the user is typing corrupts the turn -> the text waits (queued shown) until the
//    session is idle and 5 s after the last keystroke, then arrives exactly once, as one submission, newlines intact.
// 4. "Send to the same session" on an exited session goes nowhere -> it is resumed first and then receives the text.
// 5. 通过 archives a task the user still wants to see -> it only leaves 待验收 (已通过, not counted in 需要你), session untouched.
// 8. × kills a task for good -> it ends the session process and archives; 恢复 + 续接 reopens the conversation.
//    An agent still working is not ended without a confirm; × on an archived task deletes it.
// 6. Typing a follow-up in the terminal leaves a stale 待验收 entry -> the task goes back to active.
// 7. A restart loses the queue state -> cards and phases survive a hard kill.
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Card, FeedbackResult, Snapshot } from '../shared/protocol.ts';
import { FAKE_LOG, createFakeTask, createProject, expectStatus, openReview, fakeLines, pane, removeAllTasks, row, state, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/m2');
fs.mkdirSync(OUT, { recursive: true });

const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);
const taskOf = async (request: APIRequestContext, taskId: string) => (await state(request)).tasks.find((t) => t.id === taskId)!;
const cardsOf = (st: Snapshot, taskId: string) => st.cards.filter((c) => c.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);

async function newSessionOf(request: APIRequestContext, taskId: string, not: string) {
  let sid = '';
  await expect.poll(async () => (sid = (await taskOf(request, taskId))?.sessionId ?? '')).not.toBe(not);
  return sid;
}

async function expectPhase(page: Page, taskId: string, phase: string) {
  await expect(taskRow(page, taskId)).toHaveAttribute('data-phase', phase);
}

test.describe('待验收闭环', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page, request }) => {
    await removeAllTasks(request);
    page.on('dialog', (d) => d.accept());
  });

  test('做完进待验收 → 写反馈 → 新会话收到任务、结果和反馈 → 通过 → × 归档 → 恢复续接 → 删除', async ({ page, request }) => {
    const project = await createProject(request, token('review'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '做个登录页', 'build the login page');
    const other = (await createFakeTask(request, project.id, '还在跑的', 'sleep 60')).session;
    await page.goto('/');
    await row(page, s1.id).click();

    // 1. The finished turn lands in 待验收 with its card; the busy one does not.
    await expectPhase(page, task.id, 'review');
    await expect(taskRow(page, task.id).getByTestId('status')).toHaveText('待验收');
    await expect(page.getByTestId('review-count')).toHaveText('1');
    await expect(page.getByTestId('needs-you-count')).toHaveText('0');
    await expectStatus(page, other.id, 'working');
    // Approve sits right in the header; secondary actions float in a popover so .pane-body and the PTY size never move.
    const pop = pane(page, 0).getByTestId('review-popover');
    const chip = pane(page, 0).getByTestId('review-toggle');
    const approveBtn = pane(page, 0).getByTestId('review-approve');
    await expect(approveBtn).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(pop).toHaveCount(0);
    const termHeight = async () => (await pane(page, 0).locator('.pane-body').boundingBox())!.height;
    const termSize = () => page.evaluate((id) => (window as any).__wbTermSize(id), s1.id);
    const baseHeight = await termHeight();
    const baseSize = await termSize();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(pop).toBeVisible();
    expect(await termHeight()).toBe(baseHeight);
    expect(await termSize()).toEqual(baseSize);
    // Escape closes the popover and hands focus back to the terminal without resizing.
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    expect(await termHeight()).toBe(baseHeight);
    await chip.click();
    await expect(pop.getByTestId('review-summary')).toHaveText('reply: build the login page');
    let st = await state(request);
    expect(cardsOf(st, task.id).map((c) => [c.kind, c.sessionId, c.body])).toEqual([['result', s1.id, 'reply: build the login page']]);
    await pop.getByTestId('review-expand').click();
    await expect(pop.getByTestId('review-body')).toHaveText('reply: build the login page');
    expect(await termHeight()).toBe(baseHeight);
    expect(await termSize()).toEqual(baseSize);
    await page.screenshot({ path: path.join(OUT, 'review-bar.png') });

    // The queue button opens it from elsewhere (clicking outside closes the popover).
    await row(page, other.id).click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', other.id);
    await page.getByTestId('review-queue').click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', s1.id);

    // 2. Feedback dialog -> new session; typing in the modal textarea never reaches the terminal.
    await openReview(page);
    await pop.getByTestId('review-feedback').click();
    await expect(pop).toHaveCount(0);
    const dlg = page.getByTestId('feedback-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('feedback-new')).toBeDisabled();
    const input = dlg.getByTestId('feedback-input');
    await input.fill('按钮改成蓝色');
    await input.press('Shift+Enter');
    await input.pressSequentially('第二行：加上忘记密码');
    await page.screenshot({ path: path.join(OUT, 'feedback-form.png') });
    await dlg.getByTestId('feedback-new').click();
    await expect(dlg).toHaveCount(0);
    const s2 = await newSessionOf(request, task.id, s1.id);
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', s2);
    expect(fakeLines(s1.id)).toEqual(['build the login page']);
    await expect.poll(() => fakeLines(s2).length).toBe(1);
    const first = fakeLines(s2)[0];
    expect(first).toContain('继续任务「做个登录页」');
    expect(first).toContain('build the login page'); // task prompt
    expect(first).toContain('reply: build the login page'); // last result
    expect(first).toContain('按钮改成蓝色\n第二行：加上忘记密码'); // feedback, newline kept
    st = await state(request);
    expect(st.sessions.find((s) => s.id === s1.id)).toBeUndefined();
    const fb = cardsOf(st, task.id).filter((c) => c.kind === 'feedback');
    expect(fb.map((c) => [c.sessionId, c.body])).toEqual([[s2, '按钮改成蓝色\n第二行：加上忘记密码']]);

    // The new session's turn ends -> back in 待验收 with the new card, popover closed by default.
    await expectStatus(page, s2, 'needs_you');
    await expectPhase(page, task.id, 'review');
    await expect(pop).toHaveCount(0);
    await openReview(page);
    await expect(pane(page, 0).getByTestId('review-summary')).toHaveText('reply: 继续任务「做个登录页」。上一个会话已经结束，下面是你需要的上下文。');
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(page.getByTestId('review-count')).toHaveText('1');

    // 5. One-click 通过 directly in the pane header (without opening the popover) -> 已通过; terminal height unchanged.
    const beforeApproveH = await termHeight();
    await pane(page, 0).getByTestId('review-approve').click();
    await expect(page.getByTestId('review-count')).toHaveText('0');
    await expectPhase(page, task.id, 'approved');
    await expect(taskRow(page, task.id).getByTestId('status')).toHaveText('已通过');
    await expect(page.getByTestId('needs-you-count')).toHaveText('0');
    await expect(pane(page, 0).getByTestId('review-approve')).toHaveCount(0);
    await expect(pane(page, 0).getByTestId('review-popover')).toHaveCount(0);
    expect(await termHeight()).toBe(beforeApproveH);
    const group = page.locator(`[data-testid="project-group"][data-project-id="${project.id}"]`);
    await expect(group.getByTestId('archived-toggle')).toHaveCount(0);
    expect((await taskOf(request, task.id)).phase).toBe('approved');
    expect((await state(request)).sessions.find((s) => s.id === s2)?.status).toBe('needs_you');
    await page.screenshot({ path: path.join(OUT, 'approved.png') });

    // 8. × -> archived, session process ended but kept; 恢复 then 续接 reopens the same conversation.
    await taskRow(page, task.id).hover();
    await taskRow(page, task.id).getByTestId('task-remove').click();
    await expect(taskRow(page, task.id)).toHaveCount(0);
    await expect(group.getByTestId('archived-toggle')).toHaveCount(0);
    const toggle = page.getByTestId('archived-toggle');
    await expect(toggle).toHaveText(/已归档\s*1/);
    await expect.poll(async () => (await state(request)).sessions.find((s) => s.id === s2)?.status).toBe('exited');
    expect((await taskOf(request, task.id)).phase).toBe('archived');
    expect((await taskOf(request, task.id)).sessionId).toBe(s2);
    await toggle.click();
    await expectPhase(page, task.id, 'archived');
    await page.screenshot({ path: path.join(OUT, 'archived.png') });
    await taskRow(page, task.id).getByTestId('task-unarchive').click();
    await expectPhase(page, task.id, 'active');
    expect((await taskOf(request, task.id)).phase).toBe('active');
    await taskRow(page, task.id).getByTestId('task-resume').click();
    const s3 = await newSessionOf(request, task.id, s2);
    await expect.poll(() => termText(page, s3)).toContain(`RESUMED fake-${s2}`);

    // An agent still working: dismissing the confirm leaves it running; × on an archived row deletes the task.
    const busy = (await createFakeTask(request, project.id, '还在跑的 2', 'sleep 60')).session;
    page.removeAllListeners('dialog');
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
    await expectStatus(page, busy.id, 'working');
    await row(page, busy.id).hover();
    await row(page, busy.id).getByTestId('task-remove').click();
    await expect.poll(() => asked).toContain('还在工作');
    expect((await state(request)).sessions.find((s) => s.id === busy.id)?.status).toBe('working');
    expect((await state(request)).tasks.find((t) => t.sessionId === busy.id)?.phase).toBe('active');
    page.on('dialog', (d) => d.accept());
    await row(page, busy.id).hover();
    await row(page, busy.id).getByTestId('task-remove').click();
    await expect.poll(async () => (await state(request)).sessions.find((s) => s.id === busy.id)?.status).toBe('exited');
    await row(page, busy.id).hover();
    await row(page, busy.id).getByTestId('task-remove').click();
    await expect(row(page, busy.id)).toHaveCount(0);
    await expect.poll(async () => (await state(request)).tasks.some((t) => t.sessionId === busy.id)).toBe(false);

    // API guards.
    expect((await request.post(`/api/tasks/${task.id}/feedback`, { data: { text: '   ', mode: 'new' } })).status()).toBe(400);
    expect((await request.post('/api/tasks/nope/feedback', { data: { text: 'x', mode: 'new' } })).status()).toBe(404);
    expect((await request.post('/api/tasks/nope/approve', { data: {} })).status()).toBe(404);
    expect((await request.post('/api/tasks/nope/archive', { data: {} })).status()).toBe(404);
  });

  test('发到原会话：agent 忙或刚打过字时排队，空闲 5 秒后整段只送达一次', async ({ page, request }) => {
    const project = await createProject(request, token('queue'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '排队', 'first');
    await page.goto('/');
    await row(page, s1.id).click();
    await expectPhase(page, task.id, 'review');

    // 6. A follow-up typed in the terminal takes the task out of 待验收.
    await page.keyboard.type('sleep 3\r');
    const typedAt = Date.now();
    await expectStatus(page, s1.id, 'working');
    await expectPhase(page, task.id, 'active');
    await expect(page.getByTestId('review-count')).toHaveText('0');

    // 3. Feedback while busy -> queued badge floats without shrinking .pane-body, nothing pasted yet.
    const workingHeight = (await pane(page, 0).locator('.pane-body').boundingBox())!.height;
    const text = '改一下：\n第二行 with "quotes" and 中文';
    const res = await request.post(`/api/tasks/${task.id}/feedback`, { data: { text, mode: 'same' } });
    expect(res.ok(), await res.text()).toBeTruthy();
    const r = (await res.json()) as FeedbackResult;
    expect(r.session.id).toBe(s1.id);
    expect(r.card.kind).toBe('feedback');
    await expect(pane(page, 0).getByTestId('pane-queued')).toBeVisible();
    expect((await pane(page, 0).locator('.pane-body').boundingBox())!.height).toBe(workingHeight);
    await page.screenshot({ path: path.join(OUT, 'queued.png') });
    expect(fakeLines(s1.id)).toEqual(['first', 'sleep 3']);

    // Delivered after the turn ends and 5 s after the last keystroke, as one submission; .pane-body stays the same height.
    await expect.poll(() => fakeLines(s1.id), { timeout: 20_000 }).toEqual(['first', 'sleep 3', text]);
    const entry = fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e: { sessionId: string }) => e.sessionId === s1.id).at(-1) as { at: number };
    expect(entry.at - typedAt).toBeGreaterThanOrEqual(4900);
    await expect(pane(page, 0).getByTestId('pane-queued')).toHaveCount(0);
    expect((await pane(page, 0).locator('.pane-body').boundingBox())!.height).toBe(workingHeight);
    expect((await state(request)).sessions.find((s) => s.id === s1.id)?.queued ?? 0).toBe(0);
    await expectPhase(page, task.id, 'review');
    await page.waitForTimeout(3000);
    expect(fakeLines(s1.id)).toHaveLength(3); // exactly once
  });

  test('发到原会话：会话已退出时先续接再送达；没有对话记录时拒绝', async ({ page, request }) => {
    const project = await createProject(request, token('same-exited'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '已退出', 'hello');
    await page.goto('/');
    await row(page, s1.id).click();
    await expectPhase(page, task.id, 'review');
    // Double Ctrl+C quits without submitting anything, so the task stays in 待验收.
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+C');
    await expectStatus(page, s1.id, 'exited');
    await expectPhase(page, task.id, 'review');
    const native1 = (await state(request)).sessions.find((s) => s.id === s1.id)!.nativeSessionId;

    // 4. mode 'same' (API only since the button was dropped) resumes the conversation and pastes once it is idle.
    const same = await request.post(`/api/tasks/${task.id}/feedback`, { data: { text: '再检查一遍', mode: 'same', cols: 120, rows: 30 } });
    expect(same.ok(), await same.text()).toBeTruthy();
    const s2 = await newSessionOf(request, task.id, s1.id);
    await row(page, s2).click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', s2);
    await expect.poll(() => termText(page, s2)).toContain(`RESUMED ${native1}`);
    await expect.poll(() => fakeLines(s2), { timeout: 20_000 }).toEqual(['再检查一遍']);
    expect((await state(request)).sessions.find((s) => s.id === s2)?.nativeSessionId).toBe(native1);

    // No conversation to reopen -> 400, nothing spawned.
    const { task: t2, session: e1 } = await createFakeTask(request, project.id, '没说过话');
    await row(page, e1.id).click();
    await expectStatus(page, e1.id, 'idle');
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+C');
    await expectStatus(page, e1.id, 'exited');
    const bad = await request.post(`/api/tasks/${t2.id}/feedback`, { data: { text: 'x', mode: 'same' } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain('没有对话记录');
    expect((await taskOf(request, t2.id)).sessionId).toBe(e1.id);
  });
});

// 7. Own server instance so the shared webServer is not killed.
const RPORT = 47813;
const RBASE = `http://127.0.0.1:${RPORT}`;
const RDIR = path.join(OUT, 'restart');

function startServer(n: number): ChildProcess {
  const out = fs.openSync(path.join(RDIR, `server-${n}.log`), 'w');
  return spawn(process.execPath, ['server/main.ts', '--port', String(RPORT)], {
    stdio: ['ignore', out, out],
    env: { ...process.env, WORKBENCH_FAKE_AGENT: '1', WORKBENCH_STATE_DIR: path.join(RDIR, 'state'), FAKE_AGENT_LOG: path.join(RDIR, 'fake-agent.jsonl') },
  });
}

async function waitUp(api: APIRequestContext) {
  for (let i = 0; i < 100; i++) {
    try { if ((await api.get('/api/state')).ok()) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('restart server did not come up');
}

const hardKill = (p: ChildProcess) => spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });

test('待验收重启：强杀后卡片、阶段和反馈记录都还在，续接后可以继续反馈', async ({ page }) => {
  fs.rmSync(RDIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RDIR, 'proj'), { recursive: true });
  let srv = startServer(1);
  const api = await pwRequest.newContext({ baseURL: RBASE });
  try {
    await waitUp(api);
    const project = await (await api.post('/api/projects', { data: { name: '重启', path: path.join(RDIR, 'proj') } })).json();
    const a = await createFakeTask(api, project.id, '待验收的', 'alpha');
    const b = await createFakeTask(api, project.id, '归档的', 'beta');
    let before: Card[] = [];
    await expect.poll(async () => (before = (await state(api)).cards).length).toBe(2);
    await api.post(`/api/tasks/${b.task.id}/archive`, { data: {} });
    page.on('dialog', (d) => d.accept());

    hardKill(srv);
    srv = startServer(2);
    await waitUp(api);

    const after = await state(api);
    expect(after.cards.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
    expect(after.tasks.find((t) => t.id === a.task.id)?.phase).toBe('review');
    expect(after.tasks.find((t) => t.id === b.task.id)?.phase).toBe('archived');
    expect(after.sessions.every((s) => !s.queued)).toBe(true);

    await page.goto(RBASE);
    await expectPhase(page, a.task.id, 'review');
    await expect(page.getByTestId('review-count')).toHaveText('1');
    await taskRow(page, a.task.id).click();
    await openReview(page);
    await expect(pane(page, 0).getByTestId('review-summary')).toHaveText('reply: alpha');

    // Feedback into the old conversation after the restart.
    const res = await api.post(`/api/tasks/${a.task.id}/feedback`, { data: { text: 'after restart', mode: 'same', cols: 100, rows: 30 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    const r = (await res.json()) as FeedbackResult;
    expect(r.session.id).not.toBe(a.session.id);
    expect(r.session.nativeSessionId).toBe(`fake-${a.session.id}`);
    await expect.poll(() => termText(page, r.session.id)).toContain(`RESUMED fake-${a.session.id}`);
    await page.screenshot({ path: path.join(RDIR, 'after-restart.png') });
  } finally {
    await api.dispose();
    hardKill(srv);
  }
});
