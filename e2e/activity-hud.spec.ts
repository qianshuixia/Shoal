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

test('activity uses the same paint row through status changes, popovers and task switches', async ({ page, request }) => {
  const projName = token('hud-layer');
  const project = await createProject(request, projName);
  const { session } = await createFakeTask(request, project.id, '浮层合成层回归', 'sleep 60');
  const { session: other } = await createFakeTask(request, project.id, '浮层切换会话');
  const sid = session.id;

  await page.goto('/');
  await expectStatus(page, sid, 'working');
  await expectStatus(page, other.id, 'idle');

  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  const hud = p0.getByTestId('activity-hud');
  const bar = p0.locator('.activity-bar');
  const pill = p0.getByTestId('activity-toggle');
  const summary = p0.getByTestId('activity-summary');
  const paintRow = p0.locator('.pane-status-activity');
  await expect(hud).toBeVisible();

  const initialSize = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  const transcriptPath = path.join(os.tmpdir(), 'shoal-fake', `fake-${sid}.jsonl`);
  await expect.poll(() => fs.existsSync(transcriptPath)).toBe(true);

  const appendStep = (stepIndex: number, toolSummary: string) => {
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: stepIndex,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        tool_calls: [{ name: 'default_api:run_command', args: { CommandLine: '"echo ok"', toolSummary: JSON.stringify(toolSummary) } }],
      }) + '\n',
    );
  };
  const width = async (l: typeof bar) => (await l.boundingBox())!.width;

  const stageBox = (await p0.locator('.pane-stage').boundingBox())!;
  const terminalBox = (await p0.locator('.pane-body').boundingBox())!;
  const expectedW = Math.min(544, stageBox.width - 24);

  appendStep(1, '正在推理');
  await expect(summary).toHaveText('正在推理');
  const hudBox = (await hud.boundingBox())!;
  const rowHandle = await paintRow.elementHandle();
  expect(hudBox.width).toBeCloseTo(expectedW, 0);
  expect(hudBox.y + hudBox.height).toBeLessThanOrEqual(terminalBox.y);
  expect(await width(bar)).toBeCloseTo(expectedW, 0);

  const pillCss = await pill.evaluate((el) => {
    const cs = getComputedStyle(el);
    const hudCs = getComputedStyle(el.closest('.activity-hud')!);
    return {
      backdropFilter: cs.backdropFilter,
      boxShadow: cs.boxShadow,
      hudTransform: hudCs.transform,
      hudPointer: hudCs.pointerEvents,
      dotAnim: getComputedStyle(el.querySelector('.activity-dot')!).animationName,
    };
  });
  expect(pillCss.backdropFilter).toBe('none');
  expect(pillCss.boxShadow).toBe('none');
  expect(pillCss.hudTransform).toBe('none');
  expect(pillCss.hudPointer).toBe('none');
  expect(pillCss.dotAnim).toBe('none');

  appendStep(2, '正在核对修复清单与自测日志里的全部条目');
  await expect(summary).toContainText('正在核对修复清单');
  const wideW = await width(bar);
  expect(wideW).toBeCloseTo(expectedW, 0);
  const wideBarBox = (await bar.boundingBox())!;

  // Shorter text again: the row keeps its width, the pill fills it, text sits left and the clock/chevron stay right.
  appendStep(3, '正在推理');
  await expect(summary).toHaveText('正在推理');
  expect(await width(bar)).toBeCloseTo(wideW, 0);
  expect(await width(pill)).toBeCloseTo(wideW, 0);
  expect((await bar.boundingBox())!.x).toBeCloseTo(wideBarBox.x, 0);
  expect(await summary.evaluate((el) => getComputedStyle(el).textAlign)).toBe('left');
  const chevBox = (await p0.locator('.activity-pill .activity-chev').boundingBox())!;
  expect(chevBox.x + chevBox.width).toBeGreaterThan(wideBarBox.x + wideW - 20);
  expect((await hud.boundingBox())!).toEqual(hudBox);
  await bar.screenshot({ path: path.join(OUT, 'activity-hud-fixed-row.png') });

  await page.evaluate(() => {
    const orig = Date.now.bind(Date);
    (window as any).__origNow = orig;
    Date.now = () => orig() + 65_000;
  });
  await expect(hud).toHaveAttribute('data-stalled', 'true');
  await expect(p0.getByTestId('activity-interrupt')).toBeVisible();
  const stalledW = await width(bar);
  expect(stalledW).toBeCloseTo(wideW, 0);
  expect(await width(pill)).toBeLessThan(stalledW);
  await page.evaluate(() => { Date.now = (window as any).__origNow; });
  await expect(hud).toHaveAttribute('data-stalled', 'false');
  await expect(p0.getByTestId('activity-interrupt')).toHaveCount(0);
  expect(await width(bar)).toBeCloseTo(stalledW, 0);
  expect(await width(pill)).toBeCloseTo(stalledW, 0);

  // Open popover -> absolutely positioned below the pill, inside .pane-stage, and does not grow the HUD box.
  await pill.click();
  const pop = p0.getByTestId('activity-popover');
  await expect(pop).toBeVisible();
  const pillBox = (await pill.boundingBox())!;
  const popBox = (await pop.boundingBox())!;
  expect(popBox.width).toBeGreaterThan(360);
  expect(popBox.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height);
  expect(popBox.x).toBeGreaterThanOrEqual(stageBox.x);
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
  expect((await hud.boundingBox())!.height).toBeCloseTo(pillBox.height, 1);
  await pill.click();
  await expect(pop).toHaveCount(0);

  await row(page, other.id).click();
  await expect(p0).toHaveAttribute('data-session-id', other.id);
  await expect(hud).toHaveCount(0);
  await expect(paintRow).toHaveAttribute('data-occupied', 'false');
  expect(await rowHandle?.evaluate((element) => element.isConnected)).toBe(true);
  expect(await paintRow.boundingBox()).toEqual(hudBox);
  expect(await p0.locator('.pane-body').boundingBox()).toEqual(terminalBox);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expect(summary).toHaveText('正在推理');
  expect(await width(bar)).toBeCloseTo(wideW, 0);

  // Narrow viewport + dual pane: the row and the popover are clamped inside the pane.
  appendStep(4, '正在核对修复清单与自测日志里的全部条目，并把结论写进汇总报告的最后一节');
  await expect(summary).toContainText('汇总报告');
  await page.setViewportSize({ width: 920, height: 700 });
  await page.getByTestId('layout-2').click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await pill.click();
  await expect(pop).toBeVisible();
  const narrowStageBox = (await p0.locator('.pane-stage').boundingBox())!;
  const clampedHudBox = (await hud.boundingBox())!;
  const clampedPopBox = (await pop.boundingBox())!;
  expect(clampedHudBox.width).toBeCloseTo(Math.min(544, narrowStageBox.width - 24), 0);
  expect(await width(bar)).toBeLessThanOrEqual(clampedHudBox.width + 0.5);
  expect(clampedPopBox.x).toBeGreaterThanOrEqual(narrowStageBox.x);
  expect(clampedPopBox.x + clampedPopBox.width).toBeLessThanOrEqual(narrowStageBox.x + narrowStageBox.width + 1);
  await pill.click();
  await expect(pop).toHaveCount(0);
  expect((await hud.boundingBox())!.height).toBeCloseTo((await pill.boundingBox())!.height, 1);

  // Restore viewport & single-pane layout and verify zero stray PTY resize from any HUD change on a steady viewport.
  await page.getByTestId('layout-1').click();
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => (await page.evaluate((id) => (window as any).__wbTermSize(id), sid))).toEqual(initialSize);
  appendStep(5, '收尾');
  await expect(summary).toHaveText('收尾');
  expect(await page.evaluate((id) => (window as any).__wbTermSize(id), sid)).toEqual(initialSize);
});

test('settings tab: Antigravity model tier selector persists Orchestrator (Carbon) and excludes 3.8-flash', async ({ page, request }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const view = page.getByTestId('settings-view');
  await expect(view).toBeVisible();

  const select = view.getByTestId('setting-agy-model');
  await expect(select).toBeVisible();
  const optionValues = await select.locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(optionValues).toContain('gemini-pro-orchestrator');
  expect(optionValues).toContain('gemini-4-hydrogen-medium');
  expect(optionValues.some((v) => v.includes('3.8-flash'))).toBe(false);

  await select.selectOption('gemini-pro-orchestrator');
  await expect.poll(async () => (await state(request)).settings.agyModel).toBe('gemini-pro-orchestrator');
  await page.getByTestId('tab-work').click();
  await expect(view).toBeHidden();

  // Rejects deprecated model slug over REST API as well.
  const badRes = await request.post('/api/settings', { data: { agyModel: 'gemini-3.8-flash-high' } });
  expect(badRes.status()).toBe(400);
  // Settings are shared by every spec in the run (ai-title expects the defaults).
  expect((await request.post('/api/settings', { data: { agyModel: '' } })).status()).toBe(200);
});
