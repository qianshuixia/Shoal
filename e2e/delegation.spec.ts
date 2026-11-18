import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Card, Snapshot, Task } from '../shared/protocol.ts';
import { delegationHandle, delegationState } from '../shared/protocol.ts';
import { createFakeTask, createProject, expectStatus, fakeLines, pane, removeAllTasks, row, state, termText, token } from './helpers.ts';

const ARTIFACT_DIR = path.resolve('.tmp/delegation');

const typeLine = async (page: Page, paneIndex: number, text: string) => {
  await pane(page, paneIndex).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

const childrenOf = (st: Snapshot, parentId: string): Task[] =>
  st.tasks.filter(t => t.delegation?.parentTaskId === parentId).sort((a, b) => a.createdAt - b.createdAt);

const stateOf = (st: Snapshot, taskId: string) => {
  const t = st.tasks.find(x => x.id === taskId);
  return t ? delegationState(t, st.sessions.find(s => s.id === t.sessionId)) : null;
};

const delegationCards = (st: Snapshot, taskId: string, kind: NonNullable<NonNullable<Card['meta']>['delegation']>) =>
  st.cards.filter(c => c.taskId === taskId && c.kind === 'forward' && c.meta?.delegation === kind);

const taskRow = (page: Page, taskId: string) => page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);

async function waitChild(request: APIRequestContext, parentId: string, count: number): Promise<Task> {
  await expect.poll(async () => childrenOf(await state(request), parentId).length, { timeout: 15_000 }).toBe(count);
  return childrenOf(await state(request), parentId)[count - 1];
}

test.describe('cross-CLI delegation e2e', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request }) => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    await removeAllTasks(request);
  });

  test('delegate, keep working, review, rework and accept without resizing the terminal', async ({ page, request }) => {
    const project = await createProject(request, token('delegation'));
    const main = await createFakeTask(request, project.id, 'Main', '');

    await page.goto('/');
    await row(page, main.session.id).click();
    await expectStatus(page, main.session.id, 'idle', 10_000);
    await expect.poll(() => termText(page, main.session.id)).toContain('FAKE AGENT');
    const body = pane(page, 0).locator('.pane-body');
    const before = (await body.boundingBox())!;
    expect(before.height).toBeGreaterThan(100);

    // Dispatch: a child task appears under the main task and the CLI tells the agent not to wait.
    await typeLine(page, 0, 'shoal delegate fake --title "Worker" -m "[[sleep 8]] build feature"');
    const child = await waitChild(request, main.task.id, 1);
    const handle = delegationHandle(child.id);
    expect(child.title).toBe('Worker');
    expect(child.delegation?.round).toBe(1);
    await expect.poll(async () => (await state(request)).cards.find(c => c.taskId === main.task.id && c.kind === 'result')?.body ?? '', { timeout: 10_000 })
      .toContain('不要等待或轮询');

    const childRow = taskRow(page, child.id);
    await expect(childRow).toHaveAttribute('data-nested', 'true');
    await expect(childRow).toHaveAttribute('data-delegation-state', 'working');
    await expect(pane(page, 0).getByTestId('delegation-hud')).toBeVisible();
    const withHud = (await body.boundingBox())!;
    expect(Math.abs(withHud.height - before.height)).toBeLessThanOrEqual(1);
    // The child's row opens it beside the main task, which keeps its pane.
    await childRow.click();
    await expect(pane(page, 1)).toHaveAttribute('data-session-id', child.sessionId!);
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', main.session.id);

    // The main task is not locked while the child runs.
    await typeLine(page, 0, 'hello main');
    await expect.poll(() => fakeLines(main.session.id), { timeout: 10_000 }).toContain('hello main');
    expect(stateOf(await state(request), child.id)).toBe('working');

    // The child's result comes back to the main task by itself.
    await expect.poll(async () => stateOf(await state(request), child.id), { timeout: 25_000 }).toBe('review');
    await expect(childRow).toHaveAttribute('data-delegation-state', 'review');
    // Its row keeps showing the brief, not the boilerplate that opens every delegated task's prompt.
    await expect(childRow.getByTestId('task-preview')).toContainText('build feature');
    await expect.poll(async () => delegationCards(await state(request), main.task.id, 'result').length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => fakeLines(main.session.id).some(l => l.includes(`shoal done ${handle}`)), { timeout: 20_000 }).toBe(true);

    // The child's finished round is the main task's to review, so it stays out of the user's 待验收 queue.
    await expectStatus(page, main.session.id, 'needs_you', 20_000);
    await expect(page.getByTestId('review-count')).toHaveText('1');
    await expect(page.getByTestId('needs-you-count')).toHaveText('0');

    // Opening the child from the HUD puts it beside the main task. Clicking the pill leaves focus where it was, so the
    // pill never wears a focus ring.
    await pane(page, 0).getByTestId('delegation-toggle').click();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.delegation-hud'))).toBe(false);
    const item = pane(page, 0).locator(`[data-testid="delegation-item"][data-task-id="${child.id}"]`);
    await expect(item).toHaveAttribute('data-state', 'review');
    await item.click();
    await expect(pane(page, 1)).toHaveAttribute('data-session-id', child.sessionId!);
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', main.session.id);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'review-beside.png') });

    // Send it back: round 2 runs in the same child and its result returns again.
    await typeLine(page, 0, `shoal rework ${handle} -m "[[sleep 3]] fix edge case"`);
    await expect.poll(async () => childrenOf(await state(request), main.task.id)[0]?.delegation?.round, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => fakeLines(child.sessionId!).some(l => l.includes('fix edge case')), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => delegationCards(await state(request), main.task.id, 'result').length, { timeout: 30_000 }).toBe(2);
    await expect.poll(async () => stateOf(await state(request), child.id), { timeout: 10_000 }).toBe('review');

    // Accept: the child's CLI is closed and the task archived; the HUD still shows the outcome for a while.
    await expectStatus(page, main.session.id, 'needs_you', 20_000);
    await typeLine(page, 0, `shoal done ${handle}`);
    await expect.poll(async () => {
      const st = await state(request);
      const t = st.tasks.find(x => x.id === child.id);
      return { phase: t?.phase, outcome: t?.delegation?.outcome, status: st.sessions.find(s => s.id === child.sessionId)?.status };
    }, { timeout: 20_000 }).toEqual({ phase: 'archived', outcome: 'accepted', status: 'exited' });
    // The closed child stays under its main task as a compact row with its outcome, not in 已归档.
    const closedRow = page.locator(`[data-testid="project-group"] [data-testid="task-row"][data-task-id="${child.id}"]`);
    await expect(closedRow).toHaveAttribute('data-nested', 'true');
    await expect(closedRow).toHaveAttribute('data-delegation-state', 'accepted');
    await expect(closedRow.getByTestId('task-delegation-status')).toHaveText('已通过 · 第2轮');
    await expect(closedRow.getByTestId('task-unarchive')).toHaveCount(0);
    await expect(page.locator(`[data-testid="archive-section"] [data-task-id="${child.id}"]`)).toHaveCount(0);
    await page.locator('.side-list').screenshot({ path: path.join(ARTIFACT_DIR, 'sidebar-closed-child.png') });
    await expect(pane(page, 0).getByTestId('delegation-hud')).toBeVisible();
    if (!(await pane(page, 0).getByTestId('delegation-popover').count())) await pane(page, 0).getByTestId('delegation-toggle').click();
    const acceptedItem = pane(page, 0).locator(`[data-testid="delegation-item"][data-task-id="${child.id}"]`);
    await expect(acceptedItem).toHaveAttribute('data-state', 'accepted');
    // The open popover is on top: the queued-message notice, which floats right under the pills, must not cover its
    // status chip. The notice only shows while a message waits, so one is put in place here; it ignores the pointer, so
    // it is made hit-testable for elementFromPoint (stacking is unchanged).
    expect(await acceptedItem.locator('.delegation-chip').evaluate((chip) => {
      const stage = chip.closest('.pane-stage')!;
      let n = stage.querySelector<HTMLElement>('.pane-queued');
      if (!n) {
        n = document.createElement('div');
        n.className = 'pane-queued';
        n.textContent = '消息排队中，agent 空闲后自动发送';
        stage.appendChild(n);
      }
      n.style.pointerEvents = 'auto';
      const r = chip.getBoundingClientRect();
      return chip.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })).toBe(true);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'accepted.png') });
  });

  test('a blocked child is surfaced once, and archiving the main task cancels its children', async ({ page, request }) => {
    const project = await createProject(request, token('delegation-cascade'));
    const main = await createFakeTask(request, project.id, 'Main', '');

    await page.goto('/');
    await row(page, main.session.id).click();
    await expectStatus(page, main.session.id, 'idle', 10_000);
    await expect.poll(() => termText(page, main.session.id)).toContain('FAKE AGENT');

    // A child stopped at a permission prompt needs the user: it shows in 需要你 and the main task is told once.
    await typeLine(page, 0, 'shoal delegate fake --title "Asker" -m "[[ask]] needs permission"');
    const asker = await waitChild(request, main.task.id, 1);
    await expect.poll(async () => {
      const st = await state(request);
      return { state: stateOf(st, asker.id), blocked: st.sessions.find(s => s.id === asker.sessionId)?.blocked };
    }, { timeout: 15_000 }).toEqual({ state: 'needs_you', blocked: 'permission' });
    await expect(taskRow(page, asker.id)).toHaveAttribute('data-delegation-state', 'needs_you');
    await expect.poll(async () => delegationCards(await state(request), main.task.id, 'blocked').length, { timeout: 20_000 }).toBe(1);
    await expectStatus(page, main.session.id, 'needs_you', 20_000);
    await expect(page.getByTestId('needs-you-count')).toHaveText('1');

    // A second, long-running child, then `shoal status` lists both with their states.
    await typeLine(page, 0, 'shoal delegate fake --title "Runner" -m "[[sleep 60]] long job"');
    const runner = await waitChild(request, main.task.id, 2);
    await expect.poll(async () => stateOf(await state(request), runner.id), { timeout: 15_000 }).toBe('working');
    await expectStatus(page, main.session.id, 'needs_you', 20_000);
    await typeLine(page, 0, 'shoal status');
    await expect.poll(async () => {
      const results = (await state(request)).cards.filter(c => c.taskId === main.task.id && c.kind === 'result');
      return results.at(-1)?.body ?? '';
    }, { timeout: 15_000 }).toMatch(new RegExp(`${delegationHandle(asker.id)}[\\s\\S]*等你处理[\\s\\S]*${delegationHandle(runner.id)}[\\s\\S]*执行中`));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'blocked-and-running.png') });

    // Archiving the main task closes every open child and ends its CLI.
    expect((await request.post(`/api/tasks/${main.task.id}/archive`, { data: {} })).ok()).toBeTruthy();
    await expect.poll(async () => {
      const st = await state(request);
      return [asker, runner].map(c => {
        const t = st.tasks.find(x => x.id === c.id);
        return `${t?.phase}/${t?.delegation?.outcome}/${st.sessions.find(s => s.id === c.sessionId)?.status}`;
      });
    }, { timeout: 20_000 }).toEqual(['archived/canceled/exited', 'archived/canceled/exited']);
    expect(delegationCards(await state(request), main.task.id, 'blocked')).toHaveLength(1);

    // The launch-time delegation hint can be turned off in settings.
    await page.getByTestId('settings-btn').click();
    const toggle = page.getByTestId('setting-auto-delegate');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(async () => (await state(request)).settings.autoDelegate).toBe(false);
    await toggle.check();
    await expect.poll(async () => (await state(request)).settings.autoDelegate).toBe(true);

    // Division-of-labor rules: edit and save, then restore the default.
    const rulesBox = page.getByTestId('setting-delegation-rules');
    const defaultRules = await rulesBox.inputValue();
    expect(defaultRules).toContain('三方评审怎么做');
    await expect(page.getByTestId('setting-delegation-rules-save')).toBeDisabled();
    await expect(page.getByTestId('setting-delegation-rules-reset')).toBeDisabled();
    await page.getByTestId('settings-dialog').screenshot({ path: path.join(ARTIFACT_DIR, 'settings-rules.png') });
    await rulesBox.fill('x'.repeat(4001));
    await expect(page.getByTestId('setting-delegation-rules-count')).toHaveClass(/over/);
    await expect(page.getByTestId('setting-delegation-rules-save')).toBeDisabled();
    await rulesBox.fill('E2E-RULES: 评审交给另外两个 CLI');
    await page.getByTestId('setting-delegation-rules-save').click();
    await expect.poll(async () => (await state(request)).settings.delegationRules).toBe('E2E-RULES: 评审交给另外两个 CLI');
    await page.getByTestId('setting-delegation-rules-reset').click();
    await expect.poll(async () => 'delegationRules' in (await state(request)).settings).toBe(false);
    await expect(rulesBox).toHaveValue(defaultRules);

    fs.writeFileSync(
      path.join(ARTIFACT_DIR, 'verification-summary.json'),
      JSON.stringify({
        verifiedAt: new Date().toISOString(),
        command: 'npx playwright test e2e/delegation.spec.ts',
        scenarios: ['delegate → not locked → review → rework → accept', 'blocked notice once → status → cascade cancel → settings toggle'],
        artifacts: ['review-beside.png', 'accepted.png', 'sidebar-closed-child.png', 'blocked-and-running.png', 'settings-rules.png'],
      }, null, 2),
      'utf8',
    );
  });
});
