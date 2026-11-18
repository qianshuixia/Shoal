// Live Activity HUD, 60s no-progress stall recovery (Esc interrupt), Inspector file jump, and Agy model settings.
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Mounting, updating, expanding, stalling, or unmounting <ActivityHud /> alters .pane-body height and triggers
//    ResizeObserver -> ConPTY resize -> TUI screen clear (exp_2a4347027322)
//    -> .pane-body boundingBox and window.__wbTermSize(sid) stay 100% identical throughout.
// 2. Double-encoded Antigravity PLANNER_RESPONSE tool_calls show raw JSON / English tool names or miss sidebar preview
//    -> HUD and sidebar [data-testid="task-activity"] display clean Chinese toolSummary & step count, and clicking a
//       touched file chip opens Inspector on that exact file.
// 3. A hung tool / silent SSE stream leaves the user staring at a spinner with no recovery path except killing the task
//    -> >= 60s without transcript/hook progress switches HUD to amber [data-stalled="true"] + "发送 Esc 中断", which sends
//       \x1b to the PTY, cancels the turn ("Escaped"), moves status to needs_you, and keeps the session alive.
// 4. Settings model selector exposes deprecated gemini-3.8-flash* or fails to persist Orchestrator (Carbon)
//    -> gemini-3.8-flash* is absent; selecting gemini-pro-orchestrator persists across reload and /api/state.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, state, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/agy-cli-audit/e2e-artifacts');
fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ request }) => removeAllTasks(request));

test('live activity HUD: Chinese tool steps, zero PTY resize, file click -> Inspector, 60s stall -> Esc interrupt', async ({ page, request }) => {
  const projName = token('hud');
  const project = await createProject(request, projName);
  const targetFile = path.join(project.path, 'src', 'service.ts');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'export const answer = 42;\n', 'utf8');

  await page.goto('/');

  // Spawn a working session (`sleep 60` stays in `working` until interrupted).
  const { session } = await createFakeTask(request, project.id, '排查 CLI 阻塞瓶颈', 'sleep 60');
  const sid = session.id;
  await expectStatus(page, sid, 'working');

  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  // Baseline terminal dimensions and .pane-body box before HUD interaction.
  const hud = p0.getByTestId('activity-hud');
  await expect(hud).toBeVisible();
  const initialSize = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(initialSize).toBeTruthy();
  const initialBodyBox = (await p0.locator('.pane-body').boundingBox())!;

  // Locate the live fake transcript and append double-encoded Antigravity PLANNER_RESPONSE + GENERIC records.
  const transcriptPath = path.join(os.tmpdir(), 'shoal-fake', `fake-${sid}.jsonl`);
  await expect.poll(() => fs.existsSync(transcriptPath)).toBe(true);

  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      model: 'gemini-pro-orchestrator',
      content: '正在并行检索配置并检查服务入口…',
      tool_calls: [
        {
          name: 'default_api:run_command',
          args: {
            CommandLine: '"npm run typecheck"',
            toolSummary: '"运行全量类型检查"',
          },
        },
        {
          name: 'default_api:edit_file',
          args: {
            Path: JSON.stringify(targetFile),
          },
        },
      ],
    }) + '\n',
  );

  // HUD and sidebar row both surface the Chinese progress summary without resizing the PTY.
  await expect(p0.getByTestId('activity-summary')).toContainText('并行调用 2 个工具：运行全量类型检查');
  await expect(p0.getByTestId('activity-step-count')).toHaveText('#2');
  await expect(row(page, sid).getByTestId('task-activity')).toContainText('并行调用 2 个工具：运行全量类型检查');

  const sizeAfterUpdate = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(sizeAfterUpdate).toEqual(initialSize);

  // Expand floating popover: verify model tag, thinking snippet, steps, touched file chip, and STILL zero PTY resize.
  await p0.getByTestId('activity-toggle').click();
  const pop = p0.getByTestId('activity-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('gemini-pro-orchestrator');
  await expect(pop.getByTestId('activity-thinking')).toContainText('正在并行检索配置并检查服务入口…');
  await expect(pop.getByTestId('activity-step')).toHaveCount(2);

  const sizeWhileExpanded = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  const expandedBodyBox = (await p0.locator('.pane-body').boundingBox())!;
  expect(sizeWhileExpanded).toEqual(initialSize);
  expect(expandedBodyBox.height).toBeCloseTo(initialBodyBox.height, 1);
  expect(expandedBodyBox.width).toBeCloseTo(initialBodyBox.width, 1);

  await page.screenshot({ path: path.join(OUT, 'activity-hud-expanded.png') });

  // Pressing Escape while popover is open — even when xterm helper textarea holds focus — closes ONLY the popover
  // in capture phase without sending \x1b ("Escaped") to the running PTY!
  await p0.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expectStatus(page, sid, 'working');
  expect(await termText(page, sid)).not.toContain('Escaped');

  // Re-open popover and click the touched project file chip -> opens Inspector directly on `src/service.ts`!
  await p0.getByTestId('activity-toggle').click();
  await expect(pop).toBeVisible();
  const fileChip = pop.getByTestId('activity-file').filter({ hasText: 'service.ts' });
  await expect(fileChip).toBeVisible();
  await fileChip.click();
  await expect(page.locator('main.main')).toHaveClass(/layout-inspect/);
  await expect(page.locator('.inspector')).toContainText('export const answer = 42;');

  // Verify clicking HUD toggle in layout-inspect does NOT steal focus into xterm or leak Escape to PTY.
  await p0.getByTestId('activity-toggle').click();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expectStatus(page, sid, 'working');

  // Switch back to single-pane layout and verify 60s no-progress amber warning + manual Esc interrupt recovery.
  await page.getByTestId('layout-1').click();
  await expect(page.locator('main.main')).toHaveClass(/layout-1/);
  const sizeSingleAgain = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(sizeSingleAgain).toEqual(initialSize);

  await expect(hud).toHaveAttribute('data-stalled', 'false');
  await page.evaluate(() => {
    const orig = Date.now.bind(Date);
    Date.now = () => orig() + 65_000;
  });

  await expect(hud).toHaveAttribute('data-stalled', 'true');
  await expect(p0.getByTestId('activity-stall-badge')).toContainText('无新进展');
  await expect(row(page, sid).getByTestId('task-activity')).toContainText('无新进展');
  const interruptBtn = p0.getByTestId('activity-interrupt');
  await expect(interruptBtn).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'activity-hud-stalled.png') });

  // Zero PTY resize when stalled badge + interrupt button appear!
  expect(await page.evaluate((id) => (window as any).__wbTermSize(id), sid)).toEqual(initialSize);

  // Click "发送 Esc 中断" -> sends \x1b -> cancels blocked sleep without killing process -> HUD disappears cleanly.
  await interruptBtn.click();
  await expectStatus(page, sid, 'needs_you');
  await expect(hud).toHaveCount(0);
  await expect.poll(() => termText(page, sid)).toContain('Escaped');
  expect(await page.evaluate((id) => (window as any).__wbTermSize(id), sid)).toEqual(initialSize);
});

test('settings dialog: Antigravity model tier selector persists Orchestrator (Carbon) and excludes 3.8-flash', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('settings-btn').click();
  const dlg = page.getByTestId('settings-dialog');
  await expect(dlg).toBeVisible();

  const select = dlg.getByTestId('setting-agy-model');
  await expect(select).toBeVisible();
  const optionValues = await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(optionValues).toContain('gemini-pro-orchestrator');
  expect(optionValues).toContain('gemini-4-hydrogen-medium');
  expect(optionValues.some((v) => v.includes('3.8-flash'))).toBe(false);

  await select.selectOption('gemini-pro-orchestrator');
  await expect.poll(async () => (await state(request)).settings.agyModel).toBe('gemini-pro-orchestrator');
  await dlg.getByTestId('settings-close').click();

  // Rejects deprecated model slug over REST API as well.
  const badRes = await request.post('/api/settings', { data: { agyModel: 'gemini-3.8-flash-high' } });
  expect(badRes.status()).toBe(400);
  // Settings are shared by every spec in the run (ai-title expects the defaults).
  expect((await request.post('/api/settings', { data: { agyModel: '' } })).status()).toBe(200);
});
