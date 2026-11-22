import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const AGY_HOME = path.resolve('.tmp/m1/agy-home');
const AGY_CFG = path.join(AGY_HOME, 'antigravity-cli');
const OUT = path.resolve('.tmp/agy-output-optimize/e2e');

fs.mkdirSync(OUT, { recursive: true });

test.beforeEach(() => {
  fs.rmSync(AGY_HOME, { recursive: true, force: true });
});

test('smoke: one-click optimize from empty agy home (cancel preserves disk, confirm writes all 3)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const dlg = page.getByTestId('settings-view');
  await expect(dlg).toBeVisible();

  const card = dlg.getByTestId('agy-optimize-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('agy-optimize-status')).toHaveText('待优化');
  await expect(card.getByTestId('agy-optimize-btn')).toHaveText('一键优化');

  await page.screenshot({ path: path.join(OUT, 'agy-optimize-before.png') });

  // Click 一键优化 -> 取消: must NOT write anything to disk.
  await card.getByTestId('agy-optimize-btn').click();
  const confirmBox = card.getByTestId('agy-optimize-confirm-box');
  await expect(confirmBox).toBeVisible();
  await confirmBox.getByTestId('agy-optimize-cancel').click();
  await expect(confirmBox).toHaveCount(0);
  expect(fs.existsSync(path.join(AGY_CFG, 'settings.json'))).toBe(false);
  expect(fs.existsSync(path.join(AGY_HOME, 'config', 'mcp_config.json'))).toBe(false);

  // Click 一键优化 -> 确定: writes all 3 targets and updates status to 已优化.
  await card.getByTestId('agy-optimize-btn').click();
  await expect(card.getByTestId('agy-optimize-confirm-box')).toBeVisible();
  await card.getByTestId('agy-optimize-confirm').click();

  await expect(card.getByTestId('agy-optimize-status')).toHaveText('已优化');
  await expect(card.getByTestId('agy-optimize-status')).toHaveClass(/is-on/);
  await expect(card.getByTestId('agy-optimize-notice')).toContainText('已完成一键优化');
  await expect(card.getByTestId('agy-optimize-btn')).toHaveText('重新应用优化');

  await page.screenshot({ path: path.join(OUT, 'agy-optimize-after.png') });

  const settingsPath = path.join(AGY_CFG, 'settings.json');
  const rulePath = path.join(AGY_HOME, 'config', 'rules', 'shoal-output-style.md');
  const mcpPath = path.join(AGY_HOME, 'config', 'mcp_config.json');

  expect(fs.existsSync(settingsPath)).toBe(true);
  expect(fs.existsSync(rulePath)).toBe(true);
  expect(fs.existsSync(mcpPath)).toBe(true);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(settings.verbosity).toBe('low');
  expect(settings.colorScheme).toBe('tokyo night');
  expect(settings.model).toBe('Gemini 4 Carbon (Medium)');

  const ruleContent = fs.readFileSync(rulePath, 'utf8');
  expect(ruleContent).toContain('trigger: always_on');
  expect(ruleContent).toContain('终端清爽排版规范');

  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  const ft = mcp.mcpServers['fast-tools'];
  expect(fs.existsSync(ft.args[0])).toBe(true);
  for (const name of ['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch']) {
    expect(ft.tools[name]?.eager).toBe(true);
  }
});

test('non-destructive upgrade: preserves BOM settings, custom model, trustedWorkspaces, other-mcp, custom fast-tools script, and creates .shoal.bak', async ({ page }) => {
  fs.mkdirSync(AGY_CFG, { recursive: true });
  fs.mkdirSync(path.join(AGY_HOME, 'config'), { recursive: true });

  const customScript = path.join(AGY_HOME, 'custom-fast-tools.mjs');
  fs.writeFileSync(customScript, '// custom fast-tools\n', 'utf8');

  const settingsPath = path.join(AGY_CFG, 'settings.json');
  const origSettings = '\uFEFF' + JSON.stringify({
    model: 'Gemini 4 Carbon (High)',
    trustedWorkspaces: ['G:/Workspace/agent-workbench'],
    permissions: { allow: ['read'] },
    verbosity: 'normal',
  }, null, 2);
  fs.writeFileSync(settingsPath, origSettings, 'utf8');

  const mcpPath = path.join(AGY_HOME, 'config', 'mcp_config.json');
  const origMcp = JSON.stringify({
    mcpServers: {
      'other-mcp': { command: 'npx', args: ['-y', 'other-server'] },
      'fast-tools': {
        command: 'node',
        args: [customScript],
        tools: { fast_search: { eager: false } },
      },
    },
  }, null, 2);
  fs.writeFileSync(mcpPath, origMcp, 'utf8');

  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const dlg = page.getByTestId('settings-view');
  const card = dlg.getByTestId('agy-optimize-card');

  await expect(card.getByTestId('agy-optimize-status')).toHaveText('待优化');
  await card.getByTestId('agy-optimize-btn').click();
  await card.getByTestId('agy-optimize-confirm').click();

  await expect(card.getByTestId('agy-optimize-status')).toHaveText('已优化');
  await expect(card.getByTestId('agy-optimize-notice')).toContainText('已完成一键优化');

  await page.screenshot({ path: path.join(OUT, 'agy-optimize-upgrade.png') });

  // Verify backups exist and match original files.
  expect(fs.readFileSync(`${settingsPath}.shoal.bak`, 'utf8')).toBe(origSettings);
  expect(fs.readFileSync(`${mcpPath}.shoal.bak`, 'utf8')).toBe(origMcp);

  // Verify non-destructive preservation.
  const nextSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  expect(nextSettings.model).toBe('Gemini 4 Carbon (High)');
  expect(nextSettings.trustedWorkspaces).toEqual(['G:/Workspace/agent-workbench']);
  expect(nextSettings.permissions).toEqual({ allow: ['read'] });
  expect(nextSettings.verbosity).toBe('low');
  expect(nextSettings.colorScheme).toBe('tokyo night');

  const nextMcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  expect(nextMcp.mcpServers['other-mcp']).toEqual({ command: 'npx', args: ['-y', 'other-server'] });
  expect(nextMcp.mcpServers['fast-tools'].command).toBe('node');
  expect(nextMcp.mcpServers['fast-tools'].args).toEqual([customScript]);
  for (const name of ['fast_search', 'fast_glob', 'fast_tree', 'read_files_batch']) {
    expect(nextMcp.mcpServers['fast-tools'].tools[name]?.eager).toBe(true);
  }

  fs.writeFileSync(
    path.join(OUT, 'verify-log.json'),
    JSON.stringify({ ok: true, settings: nextSettings, mcp: nextMcp }, null, 2),
    'utf8',
  );
});
