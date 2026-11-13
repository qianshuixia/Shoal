// M3 acceptance: switching agent with a handoff card, and forwarding a result card.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. A session runs out of quota and the user only notices later -> the pane shows 额度用完 with the CLI's message and a
//    「换 agent」button; the sidebar row says 额度用完; no result card is made from the error.
// 2. The new agent starts from zero -> its first prompt carries the handoff card, the user's note and the path of the old
//    transcript; the card was written from the old transcript (it quotes the last request); the old session is gone.
// 3. The generator fails (bad output, crash) -> a fallback card built from the records is used: it keeps the first and
//    the last request, marks what it left out, and the UI says it was not summarised.
// 4. Two switch requests race, or the task is deleted while the card is generated -> one wins, the other gets 409;
//    a deleted task gets 404 and no session is spawned for it.
// 5. A forwarded multi-line card is mangled or pasted into a busy agent -> it waits until the target is idle and
//    arrives once, byte-identical to the preview.
// 6. Forwarding to a new task / bad targets -> a new task gets it as its first prompt; same task, unknown card and a
//    target with nothing to resume are rejected.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { forwardText, type Card, type Snapshot, type SwitchResult } from '../shared/protocol.ts';
import { createFakeTask, createProject, expectStatus, openReview, fakeLines, pane, removeAllTasks, row, state, token } from './helpers.ts';

const OUT = path.resolve('.tmp/m3');
fs.mkdirSync(OUT, { recursive: true });

const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);
const taskOf = async (request: APIRequestContext, taskId: string) => (await state(request)).tasks.find((t) => t.id === taskId);
const sessionOf = async (request: APIRequestContext, id: string) => (await state(request)).sessions.find((s) => s.id === id);
const cardsOf = (st: Snapshot, taskId: string) => st.cards.filter((c) => c.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);

async function newSessionOf(request: APIRequestContext, taskId: string, not: string, timeout = 30_000) {
  let sid = '';
  await expect.poll(async () => (sid = (await taskOf(request, taskId))?.sessionId ?? ''), { timeout }).not.toBe(not);
  return sid;
}

async function reviewed(page: Page, taskId: string) {
  await expect(taskRow(page, taskId)).toHaveAttribute('data-phase', 'review');
}

test.describe('换 agent 和转发', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page, request }) => {
    await removeAllTasks(request);
    page.on('dialog', (d) => d.accept());
  });

  test('额度用完 → 换 agent → 新会话收到交接卡片', async ({ page, request }) => {
    const project = await createProject(request, token('handoff'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '做搜索页', 'build the search page');
    await page.goto('/');
    await row(page, s1.id).click();
    await reviewed(page, task.id);

    // 1. Quota runs out mid-task.
    await page.keyboard.type('quota\r');
    const p0 = pane(page, 0);
    const limitBar = p0.getByTestId('pane-limit');
    await expect(limitBar).toBeVisible();
    await expect(limitBar).toContainText('额度用完');
    await expect(limitBar).toContainText("You've hit your session limit · resets 5pm");
    await expect(taskRow(page, task.id)).toHaveAttribute('data-limit', '1');
    await expect(taskRow(page, task.id).getByTestId('status')).toHaveText('额度用完');
    let st = await state(request);
    const old = st.sessions.find((s) => s.id === s1.id)!;
    expect(old.limit?.message).toBe("You've hit your session limit · resets 5pm");
    expect(old.transcriptPath && fs.existsSync(old.transcriptPath)).toBeTruthy();
    expect(cardsOf(st, task.id).map((c) => c.kind)).toEqual(['result']); // the error is not a result
    await page.screenshot({ path: path.join(OUT, 'limit-bar.png') });

    // 2. Switch from the banner; the generator is slow enough to see the pending state.
    await limitBar.getByTestId('pane-limit-switch').click();
    const dlg = page.getByTestId('switch-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('switch-agent').selectOption('fake');
    const note = '先把搜索框做完，HANDOFF_SLOW';
    await dlg.getByTestId('switch-note').fill(note);
    await dlg.getByTestId('switch-submit').click();
    await expect(dlg.getByTestId('switch-pending')).toBeVisible();
    await expect(dlg.getByTestId('switch-submit')).toBeDisabled();
    await page.screenshot({ path: path.join(OUT, 'switch-pending.png') });

    const s2 = await newSessionOf(request, task.id, s1.id);
    await expect(dlg).toBeHidden();
    await expect(p0).toHaveAttribute('data-session-id', s2);
    await expect.poll(() => fakeLines(s2).length).toBe(1);
    const first = fakeLines(s2)[0];
    expect(first).toContain('继续任务「做搜索页」');
    expect(first).toContain('## 交接卡片');
    expect(first).toContain('FAKE-HANDOFF');
    expect(first).toContain('## 用户的补充');
    expect(first).toContain(note);
    expect(first).toContain('## 原始记录');
    expect(first).toContain(old.transcriptPath!);

    st = await state(request);
    expect(st.sessions.find((s) => s.id === s1.id)).toBeUndefined();
    expect(st.sessions.find((s) => s.id === s2)?.limit).toBeUndefined();
    expect(st.tasks.find((t) => t.id === task.id)?.agent).toBe('fake');
    const handoff = cardsOf(st, task.id).filter((c) => c.kind === 'handoff');
    expect(handoff).toHaveLength(1);
    expect(handoff[0].sessionId).toBe(s2);
    expect(handoff[0].meta).toMatchObject({ from: 'fake', to: 'fake', generated: true });
    // Written from the old transcript: the generator saw the last request.
    expect(handoff[0].body).toContain('FAKE-HANDOFF');
    expect(handoff[0].body).toMatch(/## 下一步\n.*quota/);
    expect(first).toContain(handoff[0].body);

    await expect(limitBar).toBeHidden();
    const strip = p0.getByTestId('pane-handoff');
    await expect(strip).toContainText('由 Fake 交接（自动整理）');
    const handoffBaseH = (await p0.locator('.pane-body').boundingBox())!.height;
    await strip.getByTestId('pane-handoff-expand').click();
    await expect(p0.getByTestId('pane-handoff-body')).toContainText('FAKE-HANDOFF');
    // Expanding the handoff body floats over the terminal instead of resizing .pane-body.
    expect((await p0.locator('.pane-body').boundingBox())!.height).toBe(handoffBaseH);
    await page.screenshot({ path: path.join(OUT, 'handoff-strip.png') });
    await page.keyboard.press('Escape');
    await expect(p0.getByTestId('pane-handoff-body')).toHaveCount(0);
    expect((await p0.locator('.pane-body').boundingBox())!.height).toBe(handoffBaseH);

    // The new session's turn ends normally -> back in 待验收; the old banner never comes back.
    await expectStatus(page, s2, 'needs_you');
    await reviewed(page, task.id);
    await expect(taskRow(page, task.id).getByTestId('status')).toHaveText('待验收');
  });

  test('交接生成失败 → 按记录摘录兜底，保留第一条和最后一条需求', async ({ page, request }) => {
    const project = await createProject(request, token('fallback'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '兜底', 'FIRST-REQUEST keep me');
    await page.goto('/');
    await row(page, s1.id).click();
    await reviewed(page, task.id);
    // Fixed input: a long middle history appended to the fake transcript, then one more real turn.
    const tp = (await sessionOf(request, s1.id))!.transcriptPath!;
    const filler = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ role: i % 2 ? 'assistant' : 'user', text: `MIDDLE-${i} ` + 'x'.repeat(900) })).join('\n') + '\n';
    fs.appendFileSync(tp, filler);
    await page.keyboard.type('LAST-REQUEST finish it\r');
    await expectStatus(page, s1.id, 'needs_you');
    await expect.poll(() => fs.readFileSync(tp, 'utf8')).toContain('reply: LAST-REQUEST finish it');

    await pane(page, 0).getByTestId('pane-switch').click();
    const dlg = page.getByTestId('switch-dialog');
    await dlg.getByTestId('switch-agent').selectOption('fake');
    await dlg.getByTestId('switch-note').fill('HANDOFF_FAIL');
    await dlg.getByTestId('switch-note').press('Control+Enter');
    const s2 = await newSessionOf(request, task.id, s1.id);
    await expect(page.getByTestId('notice')).toContainText('已按记录摘录');

    const card = cardsOf(await state(request), task.id).filter((c) => c.kind === 'handoff')[0];
    expect(card.meta).toMatchObject({ from: 'fake', to: 'fake', generated: false });
    expect(card.body.startsWith('（自动整理失败')).toBeTruthy();
    expect(card.body).toContain('## 任务需求');
    expect(card.body).toContain('## 对话摘录');
    expect(card.body).toContain('FIRST-REQUEST keep me');
    expect(card.body).toContain('LAST-REQUEST finish it');
    expect(card.body).toMatch(/（中间省略了 \d+ 条记录）/);
    expect(card.body).not.toContain('MIDDLE-0 '); // the oldest filler is what gets dropped
    await expect.poll(() => fakeLines(s2).length).toBe(1);
    // Over 8000 chars the prompt goes to a file the CLI is told to read (preparePrompt).
    const file = /^请先阅读 (.+\.md) 中的任务说明/.exec(fakeLines(s2)[0])?.[1];
    expect(file, fakeLines(s2)[0]).toBeTruthy();
    const prompt = fs.readFileSync(file!, 'utf8');
    expect(prompt).toContain('## 交接卡片');
    expect(prompt).toContain(card.body);
    await expect(pane(page, 0).getByTestId('pane-handoff')).toContainText('（按记录摘录）');
    await page.screenshot({ path: path.join(OUT, 'fallback.png') });
  });

  test('并发换 agent 只生效一次；生成期间删除任务不会留下会话', async ({ request }) => {
    const project = await createProject(request, token('race'));
    const { task, session: s1 } = await createFakeTask(request, project.id, '并发', 'race me');
    await expect.poll(async () => (await sessionOf(request, s1.id))?.status).toBe('needs_you');

    const body = { agent: 'fake', note: 'HANDOFF_SLOW', cols: 120, rows: 30 };
    const [a, b] = await Promise.all([
      request.post(`/api/tasks/${task.id}/switch`, { data: body }),
      request.post(`/api/tasks/${task.id}/switch`, { data: body }),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([200, 409]);
    const won = (await (a.status() === 200 ? a : b).json()) as SwitchResult;
    let st = await state(request);
    expect(st.sessions.filter((s) => s.taskId === task.id).map((s) => s.id)).toEqual([won.session.id]);
    expect(cardsOf(st, task.id).filter((c) => c.kind === 'handoff')).toHaveLength(1);

    // Deleted while the (slow) card is being generated.
    const pending = request.post(`/api/tasks/${task.id}/switch`, { data: body });
    await new Promise((r) => setTimeout(r, 800));
    expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBeTruthy();
    expect((await pending).status()).toBe(404);
    st = await state(request);
    expect(st.tasks.find((t) => t.id === task.id)).toBeUndefined();
    expect(st.sessions.filter((s) => s.taskId === task.id)).toEqual([]);

    // Guards.
    expect((await request.post('/api/tasks/nope/switch', { data: { agent: 'fake' } })).status()).toBe(404);
    const other = await createFakeTask(request, project.id, '守卫', '');
    expect((await request.post(`/api/tasks/${other.task.id}/switch`, { data: { agent: 'nope' } })).status()).toBe(400);
  });

  test('转发：目标忙时排队，空闲后多行内容完整送达一次', async ({ page, request }) => {
    const project = await createProject(request, token('forward'));
    const src = await createFakeTask(request, project.id, '写接口文档', 'write the API spec');
    const dst = await createFakeTask(request, project.id, '实现接口', 'sleep 8');
    await page.goto('/');
    await row(page, src.session.id).click();
    await reviewed(page, src.task.id);
    await expectStatus(page, dst.session.id, 'working');

    const p0 = pane(page, 0);
    await openReview(page);
    await p0.getByTestId('review-forward').click();
    const dlg = page.getByTestId('forward-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('forward-target').selectOption(`task:${dst.task.id}`);
    await expect(dlg.getByTestId('forward-agent')).toBeHidden();
    const note = '按这份文档实现：\n先做 "GET /items"，再做 中文 分页';
    await dlg.getByTestId('forward-note').fill(note);
    const expected = forwardText({ title: '写接口文档', agent: 'fake' }, 'reply: write the API spec', note);
    await expect.poll(() => dlg.getByTestId('forward-preview').textContent()).toBe(expected);
    await page.screenshot({ path: path.join(OUT, 'forward-dialog.png') });
    await dlg.getByTestId('forward-submit').click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId('notice')).toContainText('已转发到「实现接口」，它还在工作，消息排队中');

    // Busy target: queued, nothing pasted yet; the sidebar row says so even though the target is not in a pane.
    await expect.poll(async () => (await sessionOf(request, dst.session.id))?.queued).toBe(1);
    expect(fakeLines(dst.session.id)).toEqual(['sleep 8']);
    await expect(row(page, dst.session.id).getByTestId('task-queued')).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(OUT, 'forward-queued-row.png') });
    await row(page, dst.session.id).click();
    await expect(p0.getByTestId('pane-queued')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'forward-queued.png') });

    // Idle -> delivered once, byte-identical, as one submission.
    await expect.poll(() => fakeLines(dst.session.id), { timeout: 30_000 }).toEqual(['sleep 8', expected]);
    await page.mouse.move(0, 0); // hovering a row hides the mark anyway
    await expect(row(page, dst.session.id).getByTestId('task-queued')).toHaveCount(0);
    await new Promise((r) => setTimeout(r, 3000));
    expect(fakeLines(dst.session.id)).toEqual(['sleep 8', expected]);
    const st = await state(request);
    const fwd = cardsOf(st, dst.task.id).filter((c) => c.kind === 'forward');
    expect(fwd.map((c) => [c.sessionId, c.body])).toEqual([[dst.session.id, expected]]);
    const srcCard = cardsOf(st, src.task.id).find((c) => c.kind === 'result')!;
    expect(fwd[0].meta).toMatchObject({ sourceTaskId: src.task.id, sourceCardId: srcCard.id });
    expect(st.tasks.find((t) => t.id === src.task.id)?.phase).toBe('review'); // the source stays where it was
    expect(st.sessions.find((s) => s.id === dst.session.id)?.queued ?? 0).toBe(0);
  });

  test('转发到新任务；同任务、未知卡片、没有对话的目标被拒绝', async ({ page, request }) => {
    const project = await createProject(request, token('fwdnew'));
    const src = await createFakeTask(request, project.id, '调研方案', 'research the options');
    await page.goto('/');
    await row(page, src.session.id).click();
    await reviewed(page, src.task.id);
    const before = new Set((await state(request)).tasks.map((t) => t.id));

    await openReview(page);
    await pane(page, 0).getByTestId('review-forward').click();
    const dlg = page.getByTestId('forward-dialog');
    await dlg.getByTestId('forward-target').selectOption(`new:${project.id}`);
    await expect(dlg.getByTestId('forward-agent')).toBeVisible();
    await dlg.getByTestId('forward-agent').selectOption('fake');
    await dlg.getByTestId('forward-note').press('Control+Enter');
    await expect(page.getByTestId('notice')).toContainText('已转发到新任务「转发：调研方案」');
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', src.session.id); // the current pane is kept

    let st = await state(request);
    const created = st.tasks.find((t) => !before.has(t.id))!;
    expect(created.title).toBe('转发：调研方案');
    const expected = forwardText({ title: '调研方案', agent: 'fake' }, 'reply: research the options');
    expect(created.prompt).toBe(expected);
    await expect.poll(() => fakeLines(created.sessionId!)).toEqual([expected]);
    expect(cardsOf(st, created.id).filter((c) => c.kind === 'forward').map((c) => c.body)).toEqual([expected]);

    // Guards.
    const card = cardsOf(st, src.task.id).find((c) => c.kind === 'result') as Card;
    expect((await request.post(`/api/cards/${card.id}/forward`, { data: { to: { taskId: src.task.id } } })).status()).toBe(400);
    expect((await request.post('/api/cards/nope/forward', { data: { to: { taskId: created.id } } })).status()).toBe(404);
    expect((await request.post(`/api/cards/${card.id}/forward`, { data: { to: { taskId: 'nope' } } })).status()).toBe(404);
    // A target that exited before any prompt has nothing to resume.
    const blank = await createFakeTask(request, project.id, '空白', '');
    await row(page, blank.session.id).click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', blank.session.id);
    await page.keyboard.press('Control+C');
    await page.keyboard.press('Control+C');
    await expectStatus(page, blank.session.id, 'exited');
    const res = await request.post(`/api/cards/${card.id}/forward`, { data: { to: { taskId: blank.task.id } } });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('请转发到新任务');
    st = await state(request);
    expect(cardsOf(st, blank.task.id).filter((c) => c.kind === 'forward')).toEqual([]);
  });
});
