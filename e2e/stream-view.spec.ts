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
  // StreamView font family & base font size match the Terminal view ("Maple Mono NF CN", 14px at 100% zoom).
  const termFontPx = await page.evaluate((id) => (window as any).__wbTermFontSize(id), sid);
  const svTypo = await sv.evaluate((root) => {
    const asst = root.querySelector('[data-testid="sv-assistant"]');
    const ta = root.querySelector('[data-testid="sv-input"]');
    return {
      asstFamily: asst ? getComputedStyle(asst).fontFamily : '',
      asstSize: asst ? parseFloat(getComputedStyle(asst).fontSize) : 0,
      inputFamily: ta ? getComputedStyle(ta).fontFamily : '',
      inputSize: ta ? parseFloat(getComputedStyle(ta).fontSize) : 0,
    };
  });
  expect(svTypo.asstFamily).toContain('Maple Mono NF CN');
  expect(svTypo.inputFamily).toContain('Maple Mono NF CN');
  expect(svTypo.asstSize).toBeCloseTo(termFontPx, 1);
  expect(svTypo.inputSize).toBeCloseTo(termFontPx, 1);
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

test('StreamView subagents visibility: live internal subagent tray, zero wrapped-tail leak, detail & file chip, plus delegation', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  const projName = token('sub');
  const project = await createProject(request, projName);
  const targetFile = path.join(project.path, 'scripts', 'boss.gd');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'var break_max := 270.0\n', 'utf8');

  await page.goto('/');

  // Launch a task that spawns an async agy-style subagent (`gemini-reviewer`) alongside update_steps and wrapped narration.
  const { session } = await createFakeTask(request, project.id, '子代理可视化验证', `subagent ${targetFile} 3500`);
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  // Switch immediately into Dialog mode ("对话") while the subagent is still running!
  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();

  // Unified tray surfaces BOTH 任务清单 and running 子代理 segment, and auto-shows subagent details while waiting!
  const subToggle = sv.getByTestId('sv-subagents-toggle');
  await expect(subToggle).toBeVisible({ timeout: 5_000 });
  await expect(subToggle).toContainText('子代理');
  await expect(sv.getByTestId('sv-todo-count')).toContainText('1/2');

  // LiveTail enters `subagent` phase and NEVER leaks wrapped "评审结论。" as a fake streaming answer!
  const live = sv.getByTestId('sv-live');
  await expect(live).toHaveAttribute('data-phase', 'subagent', { timeout: 5_000 });
  await expect(sv.getByTestId('sv-live-answer')).toHaveCount(0);

  // Subagent row displays role, model, and live PTY thinking preview ("The inconsistent break dama...").
  const subItem = sv.getByTestId('sv-subagent-item').first();
  await expect(subItem).toBeVisible();
  await expect(subItem).toContainText('gemini-reviewer');
  await expect(subItem).toContainText('首领破绽节奏只读评审员');
  await expect(subItem).toContainText('The inconsistent break dama...');

  // Expand subagent item -> shows recent steps & clickable touched file chip!
  await subItem.locator('.sv-sub-row').click();
  const subFileChip = subItem.getByTestId('sv-subagent-file').filter({ hasText: 'boss.gd' });
  await expect(subFileChip).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '07-stream-subagent-live.png') });

  // Clicking subagent's touched file opens it directly in the right Inspector!
  await subFileChip.click();
  await expect(page.locator('main.main')).toHaveClass(/layout-inspect/);
  await expect(page.locator('.inspector')).toContainText('break_max');
  await page.getByTestId('layout-1').click();

  // Wait for subagent completion -> status settles and final assistant reply renders cleanly.
  await expectStatus(page, sid, 'needs_you', 10_000);
  await expect(sv).toContainText('独立评审已通过（VERDICT: PASS）');
  await expect(subToggle).toContainText('✓');

  // Also verify Shoal cross-CLI delegation (`shoal delegate`) is surfaced inside StreamView's unified tray
  // (never hidden behind z-index: 15) and its `打开` button opens the child task side-by-side!
  const svInput = sv.getByTestId('sv-input');
  await svInput.fill('shoal delegate fake --review --title "Codex评审子任务" -m "[[sleep 4]] check code"');
  await svInput.press('Enter');
  const delegItem = sv.locator('[data-testid="sv-subagent-item"][data-kind="delegation"]').first();
  await expect(delegItem).toBeVisible({ timeout: 15_000 });
  await expect(delegItem).toContainText('Codex评审子任务');
  await expect(delegItem).toContainText('委派·评审');
  await delegItem.getByTestId('sv-subagent-open').click();
  await expect(pane(page, 1)).toBeVisible();
  await expect(pane(page, 1).getByTestId('pane-title')).toContainText('Codex评审子任务');
});

test('StreamView terminal draft sync & anti-collision: guard bar, block Enter collision, preserve Chat draft, pull, clear & direct send', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const projName = token('draftsync');
  const project = await createProject(request, projName);
  await page.goto('/');

  // Start an idle fake task in Terminal mode.
  const { session } = await createFakeTask(request, project.id, '双源输入同步验收', 'init-turn');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expectStatus(page, sid, 'needs_you');

  // 1. Type uncommitted text into the Terminal input box WITHOUT pressing Enter!
  await p0.locator('.pane-body').click();
  await page.keyboard.type('terminal_half_typed');
  await expect.poll(() => termText(page, sid)).toContain('> terminal_half_typed');

  // 2. Switch to Dialog mode via Alt+M -> Terminal Draft Guard Bar immediately surfaces the terminal text!
  await page.keyboard.press('Alt+m');
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();
  const draftBar = sv.getByTestId('sv-term-draft-bar');
  await expect(draftBar).toBeVisible();
  await expect(draftBar).toContainText('terminal_half_typed');
  await expect(draftBar.getByTestId('sv-term-send')).toBeVisible();
  await expect(draftBar.getByTestId('sv-term-pull')).toBeVisible();
  await expect(draftBar.getByTestId('sv-term-clear')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '08-stream-term-draft-guard.png') });

  // 3. Type independent text in Dialog mode -> `带入` hides to avoid clobbering Chat draft, and Enter is BLOCKED against collision!
  const svInput = sv.getByTestId('sv-input');
  await svInput.fill('chat_only_message');
  await expect(draftBar.getByTestId('sv-term-pull')).toHaveCount(0);
  await svInput.press('Enter');
  await expect(sv.getByTestId('sv-send-err')).toContainText('先发送或清空终端里的内容');
  await expect(svInput).toHaveValue('chat_only_message');

  // 4. Toggle 对话 -> 终端 -> 对话: Chat draft is PRESERVED (never wiped on unmount!), and Terminal shows draft dot on 对话 tab!
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  await expect(p0.getByTestId('pane-mode-stream')).toHaveClass(/has-draft/);
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('sv-input')).toHaveValue('chat_only_message');

  // 5. Click `清空` on the guard bar -> clears terminal with closed-loop verification, then Enter sends ONLY `chat_only_message`!
  await p0.getByTestId('sv-term-clear').click();
  await expect(p0.getByTestId('sv-term-draft-bar')).toHaveCount(0, { timeout: 5_000 });
  await p0.getByTestId('sv-input').press('Enter');
  await expect.poll(() => termText(page, sid)).toContain('reply: chat_only_message');
  expect(await termText(page, sid)).not.toContain('terminal_half_typedchat_only_message');
  await expectStatus(page, sid, 'needs_you');

  // 6. Test `带入`: type in Terminal -> switch to Dialog -> click `带入` -> terminal clears & text moves into Dialog textarea -> edit & send!
  await page.keyboard.press('Alt+m');
  await p0.locator('.pane-body').click();
  await page.keyboard.type('pulled_base');
  await expect.poll(() => termText(page, sid)).toContain('> pulled_base');
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('sv-term-draft-bar')).toContainText('pulled_base');
  await p0.getByTestId('sv-term-pull').click();
  await expect(p0.getByTestId('sv-term-draft-bar')).toHaveCount(0, { timeout: 5_000 });
  await expect(p0.getByTestId('sv-input')).toHaveValue('pulled_base');
  await p0.getByTestId('sv-input').fill('pulled_base_edited');
  await p0.getByTestId('sv-input').press('Enter');
  await expect.poll(() => termText(page, sid)).toContain('reply: pulled_base_edited');
  await expectStatus(page, sid, 'needs_you');

  // 7. Test `发送它`: type in Terminal -> switch to Dialog -> click `发送它` -> directly submits terminal content without duplication!
  await page.keyboard.press('Alt+m');
  await p0.locator('.pane-body').click();
  await page.keyboard.type('direct_term_submit');
  await expect.poll(() => termText(page, sid)).toContain('> direct_term_submit');
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('sv-term-draft-bar')).toContainText('direct_term_submit');
  await p0.getByTestId('sv-term-send').click();
  await expect(p0.getByTestId('sv-term-draft-bar')).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => termText(page, sid)).toContain('reply: direct_term_submit');
  await expectStatus(page, sid, 'needs_you');

  // 8. Focus isolation guard: open ActivityHud popover in Terminal while working, toggle to Dialog via Alt+M,
  //    then press Escape -> hidden HUD must close on switch and NEVER steal focus back into hidden xterm!
  await p0.getByTestId('sv-input').fill('sleep 5');
  await p0.getByTestId('sv-input').press('Enter');
  await expectStatus(page, sid, 'working');
  await page.keyboard.press('Alt+m'); // back to Terminal
  await expect(p0.getByTestId('activity-toggle')).toBeVisible({ timeout: 5_000 });
  await p0.getByTestId('activity-toggle').click();
  await expect(p0.getByTestId('activity-popover')).toBeVisible();
  await page.keyboard.press('Alt+m'); // back to Dialog -> HUD suspends & closes popover
  await expect(p0.getByTestId('stream-view')).toBeVisible();
  await page.keyboard.press('Escape');
  const focusedHiddenXterm = await page.evaluate(() => !!document.activeElement?.closest('.xterm'));
  expect(focusedHiddenXterm).toBe(false);
  await p0.getByTestId('sv-stop').click();
  await expectStatus(page, sid, 'needs_you');
});

test('StreamView multi-file attachments: paste Explorer .md & .mp4 paths, drag-drop common files, display chips above composer & send', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const projName = token('attach');
  const project = await createProject(request, projName);
  const mdPath = path.join(project.path, '需求 说明.md');
  const mp4Path = path.join(project.path, 'demo-clip.mp4');
  fs.writeFileSync(mdPath, '# 需求说明\nhello markdown\n', 'utf8');
  fs.writeFileSync(mp4Path, Buffer.from('fake-mp4-binary-payload'));

  // Mock /api/clipboard/files so tests never touch the host system clipboard.
  let clipPaths: string[] = [mdPath, mp4Path];
  await page.route('**/api/clipboard/files', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paths: clipPaths }) });
  });

  await page.goto('/');
  const { session } = await createFakeTask(request, project.id, '对话模式多文件附件验收', 'hello');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expectStatus(page, sid, 'needs_you');

  // Switch to Dialog mode.
  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();
  const svInput = sv.getByTestId('sv-input');

  // 1. Copy .md + .mp4 in Explorer -> Ctrl+V (paste event with empty text/plain) attaches both as chips above composer!
  await svInput.evaluate((ta) => {
    const dt = new DataTransfer();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const chips = sv.getByTestId('sv-attach-chip');
  await expect(chips).toHaveCount(2, { timeout: 5_000 });
  await expect(chips.nth(0)).toContainText('需求 说明.md');
  await expect(chips.nth(0)).toHaveAttribute('data-kind', 'local');
  await expect(chips.nth(0)).toHaveAttribute('data-category', 'markdown');
  await expect(chips.nth(1)).toContainText('demo-clip.mp4');
  await expect(chips.nth(1)).toHaveAttribute('data-kind', 'local');
  await expect(chips.nth(1)).toHaveAttribute('data-category', 'video');

  // 2. Drag & drop a .md doc, a .mp4 video, and a .png image -> all upload cleanly and show as chips with original names!
  await sv.evaluate(async (el) => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const pngBlob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File(['# dropped doc\n'], 'guide.md', { type: '' })); // empty MIME like Windows Chrome!
    dt.items.add(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'screen.mp4', { type: 'video/mp4' }));
    dt.items.add(new File([pngBlob], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(chips).toHaveCount(5, { timeout: 5_000 });
  await expect(chips.nth(2)).toContainText('guide.md');
  await expect(chips.nth(2)).toHaveAttribute('data-kind', 'uploaded');
  await expect(chips.nth(2)).toHaveAttribute('data-category', 'markdown');
  await expect(chips.nth(3)).toContainText('screen.mp4');
  await expect(chips.nth(3)).toHaveAttribute('data-category', 'video');
  await expect(chips.nth(4)).toContainText('shot.png');
  await expect(chips.nth(4)).toHaveAttribute('data-category', 'image');
  await page.screenshot({ path: path.join(OUT, '09-stream-file-attachments.png') });

  // 3. Remove one chip (guide.md), verify remaining 4 persist across 对话 -> 终端 -> 对话 toggle!
  await chips.nth(2).locator('button').click();
  await expect(chips).toHaveCount(4);
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  await expect(p0.getByTestId('pane-mode-stream')).toHaveClass(/has-draft/);
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('sv-attach-chip')).toHaveCount(4);

  // 4. Plain text paste still works natively without calling /api/clipboard/files.
  clipPaths = [];
  await p0.getByTestId('sv-input').fill('请帮我看这几个文件');
  await p0.getByTestId('sv-input').press('Enter');
  await expect(p0.getByTestId('sv-attach-chip')).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => (await termText(page, sid)).replace(/\r?\n/g, ''), { timeout: 10_000 }).toContain(`reply: 请帮我看这几个文件`);
  await expect.poll(async () => (await termText(page, sid)).replace(/\r?\n/g, ''), { timeout: 10_000 }).toContain(`"${mdPath}"`);
  await expect.poll(async () => (await termText(page, sid)).replace(/\r?\n/g, ''), { timeout: 10_000 }).toContain(mp4Path);
  await expect.poll(async () => (await termText(page, sid)).replace(/\r?\n/g, ''), { timeout: 10_000 }).toContain('-screen.mp4');
  await expect(p0.getByTestId('sv-user').last()).toContainText(mp4Path);
  await expectStatus(page, sid, 'needs_you');

  // 4b. Regression guard: a later turn typed in Terminal (no feedback card) must NEVER resurrect the prior
  //     Dialog feedback at the very bottom, and consecutive queued sends render with `排队中` then settle cleanly!
  await page.keyboard.press('Alt+m');
  await p0.locator('.pane-body').click();
  await page.keyboard.type('terminal_followup_turn\r');
  await expect.poll(() => termText(page, sid), { timeout: 10_000 }).toContain('reply: terminal_followup_turn');
  await expectStatus(page, sid, 'needs_you');
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('sv-assistant').last()).toContainText('reply: terminal_followup_turn');
  // Last block in `.sv-flow` must be the assistant reply, NOT a resurrected earlier user feedback!
  const lastBlockTestId = await p0.locator('.sv-flow > *').last().getAttribute('data-testid');
  expect(lastBlockTestId).toBe('sv-assistant');

  // Consecutive multi-send while working: both queued messages show `排队中` and finish cleanly in FIFO order.
  await p0.getByTestId('sv-input').fill('sleep 2');
  await p0.getByTestId('sv-input').press('Enter');
  await expectStatus(page, sid, 'working');
  await p0.getByTestId('sv-input').fill('queued_one');
  await p0.getByTestId('sv-input').press('Enter');
  await p0.getByTestId('sv-input').fill('queued_two');
  await p0.getByTestId('sv-input').press('Enter');
  await expect(p0.locator('[data-testid="sv-user"][data-pending="queued"]')).toHaveCount(2, { timeout: 5_000 });
  await expect.poll(() => termText(page, sid), { timeout: 15_000 }).toContain('reply: queued_two');
  await expectStatus(page, sid, 'needs_you');
  await expect(p0.locator('[data-testid="sv-user"][data-pending="queued"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(p0.getByTestId('sv-assistant').last()).toContainText('reply: queued_two');
  expect(await p0.locator('.sv-flow > *').last().getAttribute('data-testid')).toBe('sv-assistant');

  // 5. Desktop POST /api/attachments/file validates disallowed extensions, empty body, and foreign origin.
  const badExt = await request.post('/api/attachments/file', {
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('payload.exe') },
    data: Buffer.from('MZ'),
  });
  expect(badExt.status()).toBe(415);
  const emptyFile = await request.post('/api/attachments/file', {
    headers: { 'content-type': 'text/markdown', 'x-file-name': encodeURIComponent('empty.md') },
    data: Buffer.alloc(0),
  });
  expect(emptyFile.status()).toBe(400);
  const foreignFile = await request.post('/api/attachments/file', {
    headers: { 'content-type': 'text/markdown', 'x-file-name': encodeURIComponent('ok.md'), origin: 'http://evil.example' },
    data: Buffer.from('# hi'),
  });
  expect(foreignFile.status()).toBe(403);
});

test('P0 regressions: desktop CSP + sanitized Mermaid/ECharts, Backspace releases hasDraft, stale expectedSessionId returns 409', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 900 });

  // 1. Desktop static HTML must carry strict CSP & security headers (P0-1 / P1-2).
  const homeRes = await request.get('/');
  expect(homeRes.status()).toBe(200);
  const csp = homeRes.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(homeRes.headers()['x-content-type-options']).toBe('nosniff');
  expect(homeRes.headers()['x-frame-options']).toBe('DENY');

  // 2. Mermaid SVG rendered in StreamView strips Google Fonts @import and prefixes DOM IDs (P1-1),
  //    and composer icon buttons render with non-zero inner SVG geometry.
  const projName = token('p0reg');
  const project = await createProject(request, projName);
  await page.goto('/');
  const { task, session } = await createFakeTask(request, project.id, 'P0安全与退格回归', 'rich');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv.getByTestId('sv-mermaid-svg').locator('svg')).toBeVisible({ timeout: 10_000 });
  const svgHtml = await sv.getByTestId('sv-mermaid-svg').innerHTML();
  expect(svgHtml).not.toContain('fonts.googleapis.com');
  expect(svgHtml).not.toContain('id="arrowhead"');
  expect(svgHtml).toMatch(/id="mc-/);

  const addSvgBox = (await sv.getByTestId('sv-attach-add').locator('svg').boundingBox())!;
  const sendSvgBox = (await sv.getByTestId('sv-send').locator('svg').boundingBox())!;
  expect(addSvgBox.width).toBeGreaterThanOrEqual(12);
  expect(sendSvgBox.width).toBeGreaterThanOrEqual(12);

  // 3. Stale expectedSessionId is rejected with 409 Conflict (P0-5).
  const staleRes = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'should-not-deliver', mode: 'same', expectedSessionId: 'stale-session-id' },
  });
  expect(staleRes.status()).toBe(409);

  // 4. Typing in Terminal then clearing with Backspace must release server hasDraft so non-StreamView
  //    feedback (e.g. mobile / peer without draftAction: 'ignore') delivers immediately instead of wedging (P0-3).
  await page.keyboard.press('Alt+m');
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  await p0.locator('.pane-body').click();
  await page.keyboard.type('a');
  await expect.poll(() => termText(page, sid)).toContain('> a');
  await page.keyboard.press('Backspace');
  const fbRes = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'delivered_after_backspace', mode: 'same' },
  });
  expect(fbRes.status()).toBe(200);
  await expect.poll(() => termText(page, sid), { timeout: 10_000 }).toContain('reply: delivered_after_backspace');
  await expectStatus(page, sid, 'needs_you');

  // 5. Even complex terminal edits (arrow keys setting `draftComplex`, then Backspace to empty) while staying
  //    strictly in Terminal mode (StreamView unmounted) must auto-confirm empty prompt and unlock queued delivery!
  await p0.locator('.pane-body').click();
  await page.keyboard.type('ab');
  await expect.poll(() => termText(page, sid)).toContain('> ab');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  const fbRes2 = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'delivered_after_complex_backspace', mode: 'same' },
  });
  expect(fbRes2.status()).toBe(200);
  await expect.poll(() => termText(page, sid), { timeout: 10_000 }).toContain('reply: delivered_after_complex_backspace');
});

test('StreamView sticky auto-scroll: survives step collapse, typewriter reveal, dock growth, top-tab hide/show, and respects user scroll-up', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const projName = token('autoscroll');
  const project = await createProject(request, projName);
  await page.goto('/');

  // Start with a clean baseline turn, switch to Dialog mode, then stream a tall `rich` reply
  // followed by the step-collapse + typewriter + dock-growth `autoscroll` sequence.
  const { task, session } = await createFakeTask(request, project.id, '自动跟底回归验收', 'hello');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expectStatus(page, sid, 'needs_you');

  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();
  const scroller = sv.locator('.sv-scroll');
  const distFromBottom = () =>
    scroller.evaluate((el) => Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop);

  const input = sv.getByTestId('sv-input');

  // 1. Send `rich` (tall Markdown + Shiki + Mermaid + ECharts): scroller must grow well past one viewport
  //    and remain cleanly pinned at the bottom without showing any jump pill.
  await input.fill('rich');
  await input.press('Enter');
  await expect(sv.getByTestId('sv-mermaid-svg').locator('svg')).toBeVisible({ timeout: 10_000 });
  await expect(sv.getByTestId('sv-echarts-canvas').locator('canvas')).toBeVisible({ timeout: 10_000 });
  await expectStatus(page, sid, 'needs_you', 10_000);
  await expect.poll(async () => await scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10_000 }).toBeGreaterThan(300);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // 2. Core regression: expanded step -> sudden collapse into 1-line StepGroup + DockTray open + typewriter long reply.
  //    Must remain pinned to the bottom throughout and NEVER falsely pop 「↓ 有新回复」!
  await input.fill('autoscroll');
  await input.press('Enter');
  await expect(sv.getByTestId('sv-step')).toBeVisible({ timeout: 5_000 });
  await expect(sv).toContainText('AUTOSCROLL_TAIL_SENTINEL', { timeout: 10_000 });
  await expectStatus(page, sid, 'needs_you', 10_000);
  await expect(sv.getByTestId('sv-step-group')).toBeVisible();
  await expect(sv.getByTestId('sv-todo-list')).toBeVisible();
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // Verify the final sentinel line is actually inside the visible scroller viewport (not clipped behind .sv-dock!).
  const sentinelVisible = await sv.evaluate((root) => {
    const sc = root.querySelector('.sv-scroll');
    const lastAsst = root.querySelectorAll('[data-testid="sv-assistant"]');
    const tail = lastAsst[lastAsst.length - 1];
    if (!sc || !tail) return false;
    const scRect = sc.getBoundingClientRect();
    const tailRect = tail.getBoundingClientRect();
    return tailRect.bottom <= scRect.bottom + 8;
  });
  expect(sentinelVisible).toBe(true);
  await page.screenshot({ path: path.join(OUT, '10-autoscroll-after-collapse.png') });

  // 3. Top-tab switch (`工作台` -> `用量与配额` -> `工作台`) while a new reply arrives in the background:
  //    returning to the visible tab must immediately snap to the newest bottom instead of resetting to top!
  await page.getByTestId('tab-stats').click();
  await expect(page.getByTestId('stats-view')).toBeVisible();
  const bgRes = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'after_top_tab_return_sentinel', mode: 'same' },
  });
  expect(bgRes.status()).toBe(200);
  await expect.poll(() => termText(page, sid), { timeout: 10_000 }).toContain('reply: after_top_tab_return_sentinel');
  await expectStatus(page, sid, 'needs_you', 10_000);
  await page.getByTestId('tab-work').click();
  await expect(sv).toBeVisible();
  await expect(sv).toContainText('reply: after_top_tab_return_sentinel');
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // 4. Genuine user upward wheel scroll detaches sticky follow, keeps reading position on new reply,
  //    upgrades jump button to 「↓ 有新回复」, and clicking it re-enables auto-scroll!
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeGreaterThan(200);
  await expect(sv.getByTestId('sv-jump-bottom')).toContainText('↓ 回到底部');

  const topBeforeNew = await scroller.evaluate((el) => el.scrollTop);
  const unreadRes = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'unread_while_reading_history', mode: 'same' },
  });
  expect(unreadRes.status()).toBe(200);
  await expect(sv).toContainText('reply: unread_while_reading_history', { timeout: 10_000 });
  await expect(sv.getByTestId('sv-jump-bottom')).toContainText('↓ 有新回复');
  const topAfterNew = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(topAfterNew - topBeforeNew)).toBeLessThan(30);

  // Clicking 「↓ 有新回复」 returns to bottom and re-arms sticky auto-scroll for subsequent turns.
  await sv.getByTestId('sv-jump-bottom').click();
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  const rearmedRes = await request.post(`/api/tasks/${task.id}/feedback`, {
    data: { text: 'rearmed_sticky_follow', mode: 'same' },
  });
  expect(rearmedRes.status()).toBe(200);
  await expect(sv).toContainText('reply: rearmed_sticky_follow', { timeout: 10_000 });
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);
});

test('StreamView multi-line composer typing: zero conversation list vertical flicker, zero false detach, capped scroll & width reflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const projName = token('noflicker');
  const project = await createProject(request, projName);
  await page.goto('/');

  const { session } = await createFakeTask(request, project.id, '多行输入不闪烁验收', 'rich');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);
  await expectStatus(page, sid, 'needs_you', 10_000);

  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();
  await expect(sv.getByTestId('sv-mermaid-svg').locator('svg')).toBeVisible({ timeout: 10_000 });
  await expect(sv.getByTestId('sv-echarts-canvas').locator('canvas')).toBeVisible({ timeout: 10_000 });

  const scroller = sv.locator('.sv-scroll');
  const input = sv.getByTestId('sv-input');
  const distFromBottom = () =>
    scroller.evaluate((el) => Math.max(0, el.scrollHeight - el.clientHeight) - el.scrollTop);

  // Ensure the message list clearly overflows the viewport and is pinned cleanly to the bottom.
  await expect.poll(async () => await scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10_000 }).toBeGreaterThan(300);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  const startProbe = () =>
    scroller.evaluate((el) => {
      const w = window as unknown as { __svProbe?: { stop: () => { scrollEvents: number; maxDrop: number; clientHeightDelta: number; startTop: number; endTop: number } } };
      w.__svProbe?.stop();
      const startTop = el.scrollTop;
      let minTop = startTop;
      let maxTop = startTop;
      let minClientH = el.clientHeight;
      let maxClientH = el.clientHeight;
      let scrollEvents = 0;
      let rafId = 0;
      let active = true;
      const sample = () => {
        if (el.scrollTop < minTop) minTop = el.scrollTop;
        if (el.scrollTop > maxTop) maxTop = el.scrollTop;
        if (el.clientHeight < minClientH) minClientH = el.clientHeight;
        if (el.clientHeight > maxClientH) maxClientH = el.clientHeight;
      };
      const onScroll = () => {
        scrollEvents++;
        sample();
      };
      const loop = () => {
        if (!active) return;
        sample();
        rafId = requestAnimationFrame(loop);
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      rafId = requestAnimationFrame(loop);
      w.__svProbe = {
        stop: () => {
          active = false;
          cancelAnimationFrame(rafId);
          el.removeEventListener('scroll', onScroll);
          sample();
          return {
            scrollEvents,
            maxDrop: Math.max(0, startTop - minTop),
            clientHeightDelta: maxClientH - minClientH,
            startTop,
            endTop: el.scrollTop,
          };
        },
      };
    });

  const stopProbe = () =>
    scroller.evaluate(() => {
      const w = window as unknown as { __svProbe?: { stop: () => { scrollEvents: number; maxDrop: number; clientHeightDelta: number; startTop: number; endTop: number } } };
      return w.__svProbe!.stop();
    });

  const oneLineHeight = (await input.boundingBox())!.height;

  // 1. Exact video reproduction: 2-line wrapped input + rapid keystroke-by-keystroke typing.
  await input.click();
  await input.fill('第一行已经充满或者显式换行的输入内容，用来让输入框进入双行状态\n第二行继续补充：');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(oneLineHeight + 12);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await page.waitForTimeout(120);

  await startProbe();
  await page.keyboard.type('yuanlai_zhuyao_ceshi_1234', { delay: 25 });
  await page.waitForTimeout(160);
  const probe2Line = await stopProbe();
  expect(probe2Line.scrollEvents).toBe(0);
  expect(probe2Line.maxDrop).toBe(0);
  expect(probe2Line.clientHeightDelta).toBe(0);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // 2. Medium/Hard: 4-line input (collapse delta > BOTTOM_EPS=28px, which previously detached sticky scroll!).
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第三行内容', { delay: 15 });
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第四行起点', { delay: 15 });
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(oneLineHeight + 50);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);
  await page.waitForTimeout(120);

  await startProbe();
  await page.keyboard.type('_继续在第四行打字不抖动不脱底', { delay: 25 });
  await page.waitForTimeout(160);
  const probe4Line = await stopProbe();
  expect(probe4Line.scrollEvents).toBe(0);
  expect(probe4Line.maxDrop).toBe(0);
  expect(probe4Line.clientHeightDelta).toBe(0);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // 3. Hard: 9-line capped overflow (internal scroll preserved) -> shrink back to 1 line cleanly.
  await input.fill(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9_tail'].join('\n'));
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(140);
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(162);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await input.evaluate((ta: HTMLTextAreaElement) => {
    ta.scrollTop = ta.scrollHeight;
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.waitForTimeout(120);

  await startProbe();
  await page.keyboard.type('_more', { delay: 25 });
  await page.waitForTimeout(140);
  const probeCapped = await stopProbe();
  expect(probeCapped.scrollEvents).toBe(0);
  expect(probeCapped.maxDrop).toBe(0);
  const taScrollTop = await input.evaluate((ta: HTMLTextAreaElement) => ta.scrollTop);
  expect(taScrollTop).toBeGreaterThan(0);

  // Shrink back to 1 line -> textarea shrinks cleanly and scroller stays pinned at bottom with zero jump pill.
  await input.fill('回到单行');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(oneLineHeight + 2);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);

  // 4. Width reflow: toggle Inspector open/closed with a medium-length single line so it wraps/unwraps cleanly.
  await input.fill('这一行足够长，在打开右侧文件面板收窄对话区后会折成两行，关闭面板后又恢复为单行。');
  const hWide = (await input.boundingBox())!.height;
  await page.getByTestId('layout-inspect').click();
  await expect(page.locator('main.main')).toHaveClass(/layout-inspect/);
  await expect.poll(async () => (await input.boundingBox())!.height, { timeout: 5_000 }).toBeGreaterThan(hWide + 10);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await page.screenshot({ path: path.join(OUT, '11-composer-no-flicker.png') });

  await page.getByTestId('layout-1').click();
  await expect(page.locator('main.main')).toHaveClass(/layout-1/);
  await expect.poll(async () => (await input.boundingBox())!.height, { timeout: 5_000 }).toBeLessThanOrEqual(hWide + 2);
  await expect.poll(distFromBottom, { timeout: 5_000 }).toBeLessThanOrEqual(20);
  await expect(sv.getByTestId('sv-jump-bottom')).toHaveCount(0);
});

test('StreamView interactive question picker: renders native QuestionCard (no LiveTail blockquote leak), completes single/multi/write-in/review with zero PTY resize', async ({ page, request }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  const projName = token('question');
  const project = await createProject(request, projName);
  await page.goto('/');

  const { session } = await createFakeTask(request, project.id, '交互问题选择验收', 'question');
  const sid = session.id;
  const p0 = pane(page, 0);
  await row(page, sid).click();
  await expect(p0).toHaveAttribute('data-session-id', sid);

  // Wait for the terminal to render Question 1/3 while staying in `working` (no PermissionRequest hook).
  await expect.poll(() => termText(page, sid), { timeout: 10_000 }).toContain('Question 1/3');
  const initialSize = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);

  // Switch to Dialog mode -> native QuestionCard appears immediately, LiveTail does NOT leak blockquote!
  await p0.getByTestId('pane-mode-stream').click();
  const sv = p0.getByTestId('stream-view');
  await expect(sv).toBeVisible();
  const qCard = sv.getByTestId('sv-question-card');
  await expect(qCard).toBeVisible({ timeout: 5_000 });
  await expect(qCard).toHaveAttribute('data-mode', 'select');
  await expect(qCard.getByTestId('sv-question-progress')).toContainText('1 / 3');
  await expect(qCard.getByTestId('sv-question-title')).toContainText('昇龙破空重做');
  await expect(qCard.getByTestId('sv-question-opt')).toHaveCount(3);
  await expect(qCard.getByTestId('sv-question-opt').first()).toContainText('推荐');
  await expect(sv.getByTestId('sv-live-answer')).toHaveCount(0);
  await expect(sv.getByTestId('sv-term-draft-bar')).toHaveCount(0);
  await expect(sv).toContainText('向你提问（3 个问题）');
  await page.screenshot({ path: path.join(OUT, '12-question-single.png') });

  // 1. Click option 2 (1B 鎏金苍白龙) -> advances cleanly to Question 2/3 (multi-select).
  await qCard.getByTestId('sv-question-opt').nth(1).click();
  await expect(qCard).toHaveAttribute('data-mode', 'multi', { timeout: 5_000 });
  await expect(qCard.getByTestId('sv-question-progress')).toContainText('2 / 3');
  await expect(qCard.getByTestId('sv-question-opt').nth(0)).toHaveAttribute('data-checked', 'true');
  await expect(qCard.getByTestId('sv-question-opt').nth(1)).toHaveAttribute('data-checked', 'false');

  // 2. Toggle option 2 in multi-select -> checkbox turns true, zero terminal-draft false alarm!
  await qCard.getByTestId('sv-question-opt').nth(1).click();
  await expect(qCard.getByTestId('sv-question-opt').nth(1)).toHaveAttribute('data-checked', 'true', { timeout: 5_000 });
  await expect(sv.getByTestId('sv-term-draft-bar')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '13-question-multi.png') });

  // Confirm Q2 -> advances to Question 3/3.
  await qCard.getByTestId('sv-question-action-confirm').click();
  await expect(qCard).toHaveAttribute('data-mode', 'select', { timeout: 5_000 });
  await expect(qCard.getByTestId('sv-question-progress')).toContainText('3 / 3');

  // 3. Q3 has 3 options (`保持默认方案`, `精简为单段展示`, `Write-in...`). Click Write-in... (index 2: genuine 3-key
  //    batch `down, down, enter` + 160ms transition delay) and execute an actual forced second click mid-flight to verify
  //    intermediate arrow redraws NEVER unlock early or send a second batch into Q3/Write-in.
  await expect(qCard.getByTestId('sv-question-opt')).toHaveCount(3);
  const writeInOpt = qCard.locator('[data-testid="sv-question-opt"][data-write-in="true"]');
  await writeInOpt.click();
  await expect(qCard.getByTestId('sv-question-opt').first()).toBeDisabled();
  await page.waitForTimeout(55);
  await qCard.getByTestId('sv-question-opt').first().click({ force: true });
  await expect(qCard).toHaveAttribute('data-mode', 'write-in', { timeout: 5_000 });
  const writeInInput = qCard.getByTestId('sv-question-writein-input');
  await expect(writeInInput).toBeVisible();
  await expect(writeInInput).toBeFocused();
  await page.screenshot({ path: path.join(OUT, '14-question-writein.png') });

  // Write-in draft MUST survive full QuestionCard unmount/remount (e.g. peeking at Terminal mode or transient PermissionRequest).
  await writeInInput.fill('草稿切终端后仍完整保留');
  await qCard.getByTestId('sv-question-term').click();
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  await p0.getByTestId('pane-mode-stream').click();
  await expect(qCard).toHaveAttribute('data-mode', 'write-in', { timeout: 5_000 });
  await expect(writeInInput).toHaveValue('草稿切终端后仍完整保留');

  // Oversized Write-in (>32,000 chars) must show an inline alert, NEVER clear the draft, AND persist BOTH
  // draft and alert across full StreamView unmount/remount (Terminal <-> Dialog toggle)!
  const oversized = '超长测试'.repeat(8001);
  await writeInInput.fill(oversized);
  await qCard.getByTestId('sv-question-writein-submit').click();
  await expect(qCard.getByTestId('sv-question-err')).toContainText('32,000');
  await expect(writeInInput).toHaveValue(oversized);
  await expect(qCard).toHaveAttribute('data-mode', 'write-in');
  await qCard.getByTestId('sv-question-term').click();
  await expect(p0.getByTestId('stream-view')).toHaveCount(0);
  await p0.getByTestId('pane-mode-stream').click();
  await expect(qCard).toHaveAttribute('data-mode', 'write-in', { timeout: 5_000 });
  await expect(qCard.getByTestId('sv-question-err')).toContainText('32,000');
  await expect(writeInInput).toHaveValue(oversized);

  // Now submit a valid Chinese custom answer -> waits for server enterReady() + Review redraw cleanly!
  await writeInInput.fill('优先保留青龙拖尾特效');
  await qCard.getByTestId('sv-question-writein-submit').click();

  // 4. Lands on Review Answers -> shows summary of all 3 answers and Submit All button!
  await expect(qCard).toHaveAttribute('data-mode', 'review', { timeout: 5_000 });
  await expect(qCard.getByTestId('sv-question-sub')).toContainText('1B 鎏金苍白龙');
  await expect(qCard.getByTestId('sv-question-sub')).toContainText('战斗破绽回归');
  await expect(qCard.getByTestId('sv-question-sub')).toContainText('优先保留青龙拖尾特效');
  await page.screenshot({ path: path.join(OUT, '15-question-review.png') });

  // Submit All -> QuestionCard closes, session completes cleanly, final reply renders, zero PTY resize!
  await qCard.getByTestId('sv-question-opt').first().click();
  await expect(qCard).toHaveCount(0, { timeout: 5_000 });
  await expectStatus(page, sid, 'needs_you', 10_000);
  await expect(sv).toContainText('已收到全部 3 项选择');
  await expect(sv).toContainText('优先保留青龙拖尾特效');
  await expect(sv.getByTestId('sv-term-draft-bar')).toHaveCount(0);
  const sizeAfter = await page.evaluate((id) => (window as any).__wbTermSize(id), sid);
  expect(sizeAfter).toEqual(initialSize);
});
