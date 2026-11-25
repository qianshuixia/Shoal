// Dual-source Native CLI Streaming Conversation View (终端 <-> 对话 instant toggle, zero PTY resize,
// live PTY tail -> lossless syntax-highlighted Markdown reconciliation, file chip -> Inspector,
// composer follow-up delivery, and interactive permission prompt answering).
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. Toggling 终端 <-> 对话 alters .pane-body height/width and triggers FitAddon -> ConPTY resize/clear
//    -> window.__wbTermSize(sid) and .pane-body boundingBox stay identical across all toggles and updates.
// 2. Live PTY output fails to appear before Stop or duplicates once transcript flushes
//    -> live tail shows real-time PTY text during `working`, then reconciles to a single lossless Markdown block
//       with highlighted code card and collapsible step block after Stop.
// 3. Typing in the StreamView composer leaks into the hidden xterm.js textarea or fails to reach the native PTY
//    -> Enter delivers via /feedback (mode: 'same'), PTY receives the follow-up, and new reply renders cleanly.
// 4. Interactive CLI prompts (menu/ask) leave the user stranded in Dialog mode
//    -> StreamView renders recognized option buttons inline; clicking an option answers and unblocks the PTY.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/stream-view-e2e');
fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ request }) => removeAllTasks(request));

test('dual-source StreamView: zero PTY resize, live streaming -> rich Markdown, Inspector file jump, composer & prompt card', async ({ page, request }) => {
  const projName = token('stream');
  const project = await createProject(request, projName);
  const targetFile = path.join(project.path, 'src', 'renderer.ts');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'export const streamEngine = "dual-source";\n', 'utf8');

  await page.goto('/');

  // Start a task with the deterministic multi-stage `stream` fake command.
  const { session } = await createFakeTask(request, project.id, '流式输出体验验证', `stream ${targetFile}`);
  const sid = session.id;

  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  // Baseline terminal geometry before toggling to Dialog mode.
  const initialSize = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(initialSize).toBeTruthy();
  const initialBodyBox = (await p0.locator('.pane-body').boundingBox())!;

  // Switch to StreamView ("对话") and verify zero PTY resize.
  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();

  const sizeInStream = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  const bodyBoxInStream = (await p0.locator('.pane-body').boundingBox())!;
  expect(sizeInStream).toEqual(initialSize);
  expect(bodyBoxInStream.height).toBeCloseTo(initialBodyBox.height, 1);
  expect(bodyBoxInStream.width).toBeCloseTo(initialBodyBox.width, 1);

  // Wait for final lossless Markdown block + highlighted code card + thinking/tool step block.
  await expect(sv.getByTestId('sv-code-card')).toBeVisible({ timeout: 10_000 });
  await expect(sv).toContainText('好，我就跑一下，先确认一下当前环境和关键文件。');
  await expect(sv).toContainText('验证结论');
  await expect(sv.getByTestId('sv-code-card')).toContainText('native-pty-dual-source');

  // Verify step block summarizes thinking & tools cleanly and exposes clickable file chip -> Inspector.
  const steps = sv.getByTestId('sv-step');
  await expect(steps.first()).toContainText('调用了 3 次工具');
  await expect(steps.first()).toContainText('更新任务清单');
  await expect(steps.first()).toContainText('确认执行环境与架构');

  // Verify live Todo Checklist Card renders update_steps progress cleanly!
  const todoCard = sv.getByTestId('sv-todo-card');
  await expect(todoCard).toBeVisible();
  await expect(todoCard.getByTestId('sv-todo-count')).toContainText('3/3');

  await page.screenshot({ path: path.join(OUT, '01-stream-settled.png') });

  // Click the touched file chip inside the step block -> opens Inspector directly on src/renderer.ts!
  const chip = sv.getByTestId('sv-file-chip').filter({ hasText: 'renderer.ts' }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator('main.main')).toHaveClass(/layout-inspect/);
  await expect(page.locator('.inspector')).toContainText('streamEngine');
  await page.getByTestId('layout-1').click();
  await expect(page.locator('main.main')).toHaveClass(/layout-1/);

  // Send a follow-up `stream` turn from the StreamView composer and observe live PTY streaming BEFORE Stop!
  const input = sv.getByTestId('sv-input');
  await input.fill('stream');
  await input.press('Enter');

  // During the working turn, live tail appears (preparing / thinking / tool / live PTY answer) and NEVER leaks TUI chrome or todolist rows!
  const live = sv.getByTestId('sv-live');
  await expect(live).toBeVisible({ timeout: 5_000 });
  await expect(live).not.toContainText('初始化检查任务');
  await expect(sv).not.toContainText('Use /settings');
  await expect(sv).not.toContainText('Working...');
  await page.screenshot({ path: path.join(OUT, '02-stream-live.png') });
  await expectStatus(page, sid, 'needs_you');
  await expect(live).toHaveCount(0);
  await expect(sv).not.toContainText('Use /settings');
  await expect(sv).not.toContainText('Working...');

  // Trigger an interactive `menu` prompt from the composer and answer it directly inside StreamView!
  await input.fill('menu');
  await input.press('Enter');
  const promptCard = sv.getByTestId('sv-prompt-card');
  await expect(promptCard).toBeVisible({ timeout: 10_000 });
  await expect(promptCard.getByTestId('sv-prompt-key')).toHaveCount(3);
  await page.screenshot({ path: path.join(OUT, '03-stream-prompt.png') });

  // Verify the jump-to-bottom pill (if shown) never overlaps the prompt buttons!
  const jumpBtn = sv.getByTestId('sv-jump-bottom');
  if (await jumpBtn.count()) {
    const jb = (await jumpBtn.boundingBox())!;
    const pb = (await promptCard.boundingBox())!;
    expect(jb.y + jb.height).toBeLessThanOrEqual(pb.y + 1);
  }

  await promptCard.getByTestId('sv-prompt-key').first().click();
  await expect(promptCard).toHaveCount(0);
  await expect.poll(() => termText(page, sid)).toContain('reply: menu [1]');
  await expect(sv).toContainText('reply: menu [1]');

  // Start a long `sleep 60` turn, click StreamView's Stop button, and verify focus does NOT jump into hidden xterm!
  await input.fill('sleep 60');
  await input.press('Enter');
  await expectStatus(page, sid, 'working');
  await expect(sv.getByTestId('sv-stop')).toBeVisible();
  await sv.getByTestId('sv-stop').click();
  await expectStatus(page, sid, 'needs_you');
  const focusedXterm = await page.evaluate(() => !!document.activeElement?.closest('.xterm'));
  expect(focusedXterm).toBe(false);

  // Toggle back to Terminal via Alt+M shortcut -> StreamView unmounts and PTY dimensions remain untouched!
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  const sizeBackInTerm = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(sizeBackInTerm).toEqual(initialSize);
});

test('StreamView rich visual rendering: typography, compact table pills, Shiki, Mermaid, ECharts, KaTeX, Callouts & fallback', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 960 });
  const projName = token('rich');
  const project = await createProject(request, projName);
  await page.goto('/');

  const { session } = await createFakeTask(request, project.id, '富文本与图表渲染验收', 'rich');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();

  // 1. Typography + GitHub Callouts + Smart Table with semantic status pills & non-wrapped "结果" header
  await expect(sv.getByTestId('sv-callout')).toHaveCount(2, { timeout: 10_000 });
  const tableCard = sv.getByTestId('sv-table-card');
  await expect(tableCard).toBeVisible();
  await expect(tableCard.getByTestId('sv-status-pill')).toHaveCount(4);
  const resultHeaderBox = (await tableCard.locator('th', { hasText: '结果' }).boundingBox())!;
  expect(resultHeaderBox.height).toBeLessThan(48); // Must stay single-line, never wrap vertically into 结\n果!

  // 2. Mermaid diagram renders crisp SVG + supports source toggle and zoom lightbox
  const mermaidCard = sv.getByTestId('sv-mermaid-card');
  await expect(mermaidCard).toBeVisible();
  await expect(mermaidCard.getByTestId('sv-mermaid-svg').locator('svg')).toBeVisible({ timeout: 10_000 });

  // 3. ECharts renders interactive canvas
  const echartsCard = sv.getByTestId('sv-echarts-card');
  await expect(echartsCard).toBeVisible();
  await expect(echartsCard.getByTestId('sv-echarts-canvas').locator('canvas')).toBeVisible({ timeout: 10_000 });

  // 4. Shiki highlights TypeScript code card & malformed ECharts falls back gracefully to code card with notice
  await expect(sv.getByTestId('sv-code-card').first().locator('pre[data-shiki="1"]')).toBeVisible({ timeout: 10_000 });
  await expect(sv).toContainText('图表 JSON 无法解析，已显示源码');

  // 5. KaTeX renders both inline & block math
  await expect(sv.getByTestId('sv-math-block').locator('.katex')).toBeVisible({ timeout: 10_000 });
  await expect(sv.getByTestId('sv-math-inline').locator('.katex')).toBeVisible({ timeout: 10_000 });

  // Capture visual proof screenshots (top: typography + callout + table + mermaid; bottom: echarts + shiki + katex)
  const scroller = sv.locator('.sv-scroll');
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, '04-rich-top.png') });

  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, '05-rich-bottom.png') });

  // Verify Mermaid fullscreen zoom modal opens and closes cleanly with Esc
  await mermaidCard.getByTestId('sv-viz-zoom').click();
  await expect(page.getByTestId('sv-lightbox')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '06-mermaid-lightbox.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sv-lightbox')).toHaveCount(0);

  // Verify Mermaid source toggle works
  await mermaidCard.getByTestId('sv-viz-toggle-source').click();
  await expect(mermaidCard).toContainText('flowchart LR');
  await mermaidCard.getByTestId('sv-viz-toggle-source').click();
  await expect(mermaidCard.getByTestId('sv-mermaid-svg').locator('svg')).toBeVisible();
});
