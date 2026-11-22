import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createProject, state, token } from './helpers.ts';

const OUT = path.resolve('.tmp/cli-scanner/e2e');
fs.mkdirSync(OUT, { recursive: true });

test.afterEach(async ({ request }) => {
  // Restore clean default CLI settings so other specs in the suite see untouched defaults.
  await request.post('/api/settings', { data: { cliPrefs: null, customClis: null } });
});

test('CLI scanner, permission mode toggle, custom CLI lifecycle & normal-mode pane badge', async ({ page, request }) => {
  const project = await createProject(request, token('cli-set'));

  // Prepare a harmless local executable script to test custom CLI detection & launch.
  const binDir = path.resolve('.tmp/cli-scanner/bin');
  fs.mkdirSync(binDir, { recursive: true });
  const customBin = path.join(binDir, process.platform === 'win32' ? 'demo-cli.cmd' : 'demo-cli');
  fs.writeFileSync(
    customBin,
    process.platform === 'win32' ? '@echo off\r\necho DEMO_CLI_READY\r\n' : '#!/bin/sh\necho DEMO_CLI_READY\n',
    { mode: 0o755 },
  );

  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const settingsView = page.getByTestId('settings-view');
  await expect(settingsView).toBeVisible();

  // Jump to CLI Tools section and trigger an explicit scan.
  await settingsView.getByTestId('settings-nav-clis').click();
  const section = settingsView.getByTestId('cli-tools-section');
  await expect(section).toBeVisible();
  await section.getByTestId('cli-scan-btn').click();
  await expect(section.getByTestId('cli-settings-notice')).toContainText('扫描完成');

  // Verify two-tier badges and default full-access mode on built-in deep CLI (claude/codex/agy if installed).
  await page.screenshot({ path: path.join(OUT, '01-cli-section.png') });

  // Open custom CLI form, validate and add a custom CLI.
  await section.getByTestId('cli-add-btn').click();
  const form = section.getByTestId('cli-custom-form');
  await expect(form).toBeVisible();
  await form.getByTestId('cli-custom-label').fill('Demo Agent');
  await expect(form.getByTestId('cli-custom-id')).toHaveValue('demo-agent');
  await form.getByTestId('cli-custom-command').fill(customBin);
  await form.getByTestId('cli-custom-full-args').fill('--yolo');
  await form.getByTestId('cli-custom-prompt-arg').selectOption('none');
  await page.screenshot({ path: path.join(OUT, '02-cli-custom-form.png') });
  await form.getByTestId('cli-custom-save').click();
  await expect(form).toHaveCount(0);

  const customRow = section.getByTestId('cli-row-demo-agent');
  await expect(customRow).toBeVisible();
  await expect(customRow).toContainText('通用终端');
  await expect(customRow).toContainText('自定义');
  await expect(customRow.getByTestId('cli-enable-demo-agent')).toBeChecked();
  await expect(customRow.getByTestId('cli-perm-full-demo-agent')).toHaveClass(/on/);

  // Toggle custom CLI to normal mode and verify persistence across reload.
  await customRow.getByTestId('cli-perm-normal-demo-agent').click();
  await expect(customRow.getByTestId('cli-perm-normal-demo-agent')).toHaveClass(/on/);
  await expect.poll(async () => (await state(request)).settings.cliPrefs?.['demo-agent']?.permissionMode).toBe('normal');

  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('cli-perm-normal-demo-agent')).toHaveClass(/on/);

  // Switch fake agent to normal mode via API, then create a fake task and verify the Pane header shows 正常模式 badge.
  expect((await request.post('/api/settings', { data: { cliPrefs: { fake: { enabled: true, permissionMode: 'normal' } } } })).status()).toBe(200);
  await page.getByTestId('tab-work').click();
  await page.getByTestId('new-task-btn').click();
  const select = page.getByTestId('task-agent');
  // Custom CLI must appear in the New Task agent dropdown.
  await expect(select.locator('option[value="demo-agent"]')).toHaveText('Demo Agent');
  await select.selectOption('fake');
  await page.getByTestId('task-title').fill('正常模式任务');
  await page.getByTestId('task-submit').click();

  await expect(page.getByTestId('pane-perm-mode')).toHaveText('正常模式');
  await page.screenshot({ path: path.join(OUT, '03-pane-normal-mode.png') });

  // Delete the custom CLI from Settings and verify it disappears.
  await page.getByTestId('tab-settings').click();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('cli-custom-delete-demo-agent').click();
  await expect(page.getByTestId('cli-row-demo-agent')).toHaveCount(0);
});
