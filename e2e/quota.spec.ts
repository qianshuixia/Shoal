// Subscription quota in the top bar and pane header, driven through the real hooks/statusline.mjs (the fake agent pipes
// both claude-style `rate_limits` via `limits` and agy-style Gemini `quota` via `agylimits`).
//
// Known failure modes -> expected behaviour (pass criterion):
// 1. The status line never reaches the page, or a window is dropped -> after `limits 85 4` both the top bar and the
//    focused pane header (next to the agent name) show 5h 85% and 7d 4%, with a multi-line tooltip.
// 2. A window at >= 80% looks like the others -> warning colour for 85%, the muted colour for 4%; 100% is also bold.
// 3. A later update leaves the old numbers or adds a second item -> the same item shows the new values (one item per agent).
// 4. A window whose reset time has passed keeps showing -> it disappears by itself (no new message needed); the other
//    window stays, and the whole item goes once none is left (the medium-hard case: expiry is driven by the clock only).
// 5. The relay disturbs the session -> it ends the turn as usual (needs_you) (a RateLimits hook is a no-op for sessions).
// 6. A narrow window or dual-pane split crowds the headers -> at 1280px both topbar and dual pane headers fit inside bounds.
// 7. Antigravity's `quota` (`gemini-5h` + `gemini-weekly`, `remaining_fraction` omitted at 0.0) fails to parse or misses 100%
//    -> `agylimits 48 6` then `agylimits 100 12 3` updates both topbar and pane header and expires cleanly.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, expectStatus, pane, removeAllTasks, row, token } from './helpers.ts';

const OUT = path.resolve('.tmp/quota');
fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(async ({ request }) => removeAllTasks(request));

test('header shows both windows, warning colour from 80%, updates in place, expired window drops out', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const project = await createProject(request, token('quota'));
  const { session } = await createFakeTask(request, project.id, '额度', '');
  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();

  const item = page.locator('[data-testid="quota"][data-agent="fake"]');
  const win = (label: string) => item.locator(`[data-testid="quota-window"][data-label="${label}"]`);
  const paneItem = pane(page, 0).getByTestId('pane-quota');
  const paneWin = (label: string) => paneItem.locator(`[data-testid="pane-quota-window"][data-label="${label}"]`);
  const type = async (text: string) => {
    await pane(page, 0).locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`${text}\r`);
  };

  // 1 + 2: both windows in topbar and pane header, tooltip, colours.
  await type('limits 85 4');
  await expect(win('5h')).toHaveText('5h 85%');
  await expect(win('7d')).toHaveText('7d 4%');
  await expect(paneWin('5h')).toHaveText('5h 85%');
  await expect(paneWin('7d')).toHaveText('7d 4%');
  await expect(item).toHaveCount(1);
  await expect(paneItem).toHaveCount(1);
  const title = (await item.getAttribute('title'))!.split('\n');
  expect(title).toHaveLength(4);
  expect(title[0]).toBe('Fake 订阅额度');
  expect(title[1]).toMatch(/^5 小时窗口：已用 85%，(?:\d+月\d+日 )?\d{2}:\d{2} 重置（(1 小时 5\d 分|2 小时)后）$/);
  expect(title[2]).toMatch(/^7 天窗口：已用 4%，\d+月\d+日 \d{2}:\d{2} 重置（[45] 天后）$/);
  expect(title[3]).toMatch(/^更新于 \d{2}:\d{2}$/);
  const color = (label: string) => win(label).evaluate(e => getComputedStyle(e).color);
  const signal = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--signal)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await color('5h')).toBe(signal);
  expect(await color('7d')).not.toBe(signal);

  // 5: the relay does not touch the session.
  await expectStatus(page, session.id, 'needs_you');

  // 6: nothing is pushed out of the header at 1280px.
  const right = (await page.locator('.topbar .top-right').boundingBox())!;
  const box = (await item.boundingBox())!;
  expect(right.x + right.width).toBeLessThanOrEqual(1280.5);
  expect(box.x + box.width).toBeLessThanOrEqual(right.x + 0.5);
  await page.locator('header.topbar').screenshot({ path: path.join(OUT, 'header-warn.png') });

  // 3 + 2: a second update replaces the numbers; 100% is bold.
  await type('limits 100 7 3');
  await expect(win('5h')).toHaveText('5h 100%');
  await expect(win('7d')).toHaveText('7d 7%');
  await expect(item).toHaveCount(1);
  expect(await win('5h').evaluate(e => getComputedStyle(e).fontWeight)).toBe('600');
  expect(await win('7d').evaluate(e => getComputedStyle(e).fontWeight)).not.toBe('600');
  await page.locator('header.topbar').screenshot({ path: path.join(OUT, 'header-full.png') });

  // 4: the 5h window resets a few seconds after the update and goes away on its own; 7d stays.
  await expect(win('5h')).toHaveCount(0, { timeout: 10_000 });
  await expect(win('7d')).toHaveText('7d 7%');
  await expect(item).toHaveCount(1);
  await page.locator('header.topbar').screenshot({ path: path.join(OUT, 'header-expired.png') });

  // A fresh page still gets the stored value from the snapshot (the server keeps it, not the browser).
  await page.reload();
  await expect(win('7d')).toHaveText('7d 7%');
  await expect(win('5h')).toHaveCount(0);
  await expect(paneWin('7d')).toHaveText('7d 7%');
  await expect(paneWin('5h')).toHaveCount(0);
});

test('agy-style Gemini quota renders in pane header and dual-pane layout without overflowing', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const project = await createProject(request, token('agyquota'));
  const { session } = await createFakeTask(request, project.id, 'Gemini 额度验证任务', '');
  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();

  const paneHeader = pane(page, 0).getByTestId('pane-header');
  const paneItem = pane(page, 0).getByTestId('pane-quota');
  const paneWin = (label: string) => paneItem.locator(`[data-testid="pane-quota-window"][data-label="${label}"]`);
  const type = async (text: string) => {
    await pane(page, 0).locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`${text}\r`);
  };

  await type('agylimits 48 6');
  await expect(paneWin('5h')).toHaveText('5h 48%');
  await expect(paneWin('7d')).toHaveText('7d 6%');
  await paneHeader.screenshot({ path: path.join(OUT, 'pane-header-gemini.png') });

  // Dual-pane layout at 1280px: switch button stays inside the pane header.
  await page.getByTestId('layout-2').click();
  const hBox = (await paneHeader.boundingBox())!;
  const swBox = (await pane(page, 0).getByTestId('pane-switch').boundingBox())!;
  expect(swBox.x + swBox.width).toBeLessThanOrEqual(hBox.x + hBox.width + 0.5);
  await page.getByTestId('layout-1').click();

  // Go omitempty at 0.0 remaining_fraction -> 100% used, bold, then expires after 3 s.
  await type('agylimits 100 12 3');
  await expect(paneWin('5h')).toHaveText('5h 100%');
  await expect(paneWin('7d')).toHaveText('7d 12%');
  expect(await paneWin('5h').evaluate(e => getComputedStyle(e).fontWeight)).toBe('600');
  await paneHeader.screenshot({ path: path.join(OUT, 'pane-header-gemini-full.png') });

  await expect(paneWin('5h')).toHaveCount(0, { timeout: 10_000 });
  await expect(paneWin('7d')).toHaveText('7d 12%');
});
