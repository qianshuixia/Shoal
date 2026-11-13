// Right-hand Inspector panel ("变更 / 文件"):
// 3-mode layout, sidebar git-chip linkage, unified diff & quick edit, file tree & Ctrl+P,
// external disk-modification hot-reload & optimistic-lock conflict banner, Markdown XSS safety,
// terminal in-project file:line link routing, and the zero-terminal-resize invariant.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeTask, expectStatus, pane, removeAllTasks, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/inspector');
const OPEN_LOG = path.resolve('.tmp/m1/open-log.jsonl');
fs.mkdirSync(OUT, { recursive: true });

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-insp-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  return dir;
}

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await removeAllTasks(request);
});

test.afterAll(async ({ request }) => {
  await removeAllTasks(request);
  const st = await (await request.get('/api/state')).json();
  for (const p of st.projects) {
    if (String(p.name).startsWith('insp-')) await request.delete(`/api/projects/${p.id}`);
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore locked temp dir on Windows */ }
  }
});

test('3-mode layout, branch chip linkage, diff/edit/save/discard, tree & Ctrl+P, with zero terminal resize', async ({ page, request }) => {
  page.on('dialog', (d) => void d.accept());

  const dir = initGitProject('main');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'demo', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 'discard.ts'), 'export const keep = true;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });

  // Create working-tree modifications + gitignored .env + untracked note.txt
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 20;\nexport const c = 30;\n');
  fs.writeFileSync(path.join(dir, 'src', 'discard.ts'), 'export const keep = false;\n');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'untracked note\n');
  fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=local-dev\n');

  const projName = token('insp-main');
  const projRes = await request.post('/api/projects', { data: { name: projName, path: dir } });
  expect(projRes.ok()).toBeTruthy();
  const project = await projRes.json();
  const { task, session } = await createFakeTask(request, project.id, '检视任务', '');

  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();
  await pane(page, 0).locator('.xterm-helper-textarea').waitFor({ state: 'attached' });

  // Clicking the sidebar Git branch chip opens Inspector directly on the Changes tab without folding the project!
  const group = page.locator(`[data-testid="project-group"][data-project-id="${project.id}"]`);
  await expect(group.getByTestId('project-dirty')).toHaveText('· 3');
  await group.getByTestId('project-branch').click();
  await expect(group).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('layout-inspect')).toHaveAttribute('aria-checked', 'true');

  const insp = page.getByTestId('inspector');
  await expect(insp).toBeVisible();
  await expect(insp.getByTestId('insp-tab-changes')).toHaveAttribute('aria-selected', 'true');
  await expect(insp.getByTestId('change-entry')).toHaveCount(3);

  // Select src/app.ts and inspect Unified Diff
  await insp.locator('[data-testid="change-entry"][data-path="src/app.ts"]').click();
  await expect(insp.getByTestId('code-editor')).toHaveAttribute('data-mode', 'diff');
  await expect(insp.locator('.cm-content')).toContainText('export const b = 20;');
  await page.screenshot({ path: path.join(OUT, '01-changes-diff.png') });

  // Let initial split resize settle, then lock in terminal geometry & PTY cols/rows
  await page.waitForTimeout(250);
  const bodyBefore = (await pane(page, 0).locator('.pane-body').boundingBox())!;
  const ptyBefore = await page.evaluate((id) => (window as any).__wbTermSize(id), session.id);
  expect(ptyBefore).toBeTruthy();

  // Switch to Edit mode inside Changes tab, modify text, and Ctrl+S save
  await insp.getByTestId('mode-edit').click();
  const cm = insp.locator('.cm-content');
  await cm.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nexport const savedFromInspector = 42;');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(insp.getByTestId('unsaved-dot')).toHaveCount(0);
  expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toContain('savedFromInspector = 42');

  // Discard src/discard.ts and verify file returns to HEAD
  const discardRow = insp.locator('[data-testid="change-entry"][data-path="src/discard.ts"]');
  await discardRow.hover();
  await discardRow.getByTestId('discard-file').click();
  await expect(insp.getByTestId('change-entry')).toHaveCount(2);
  expect(fs.readFileSync(path.join(dir, 'src', 'discard.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const keep = true;\n');

  // Switch to Files tab: .env is visible, node_modules is dimmed, and Ctrl+P opens .env
  await insp.getByTestId('insp-tab-files').click();
  await expect(insp.locator('[data-testid="tree-entry"][data-path=".env"]')).toBeVisible();
  await expect(insp.locator('[data-testid="tree-entry"][data-path="node_modules"]')).toHaveClass(/ignored/);

  await insp.focus();
  await page.keyboard.press('Control+p');
  const finder = insp.getByTestId('file-finder');
  await expect(finder).toBeVisible();
  await finder.getByTestId('file-finder-input').fill('.env');
  await finder.getByTestId('file-finder-input').press('Enter');
  await expect(finder).toHaveCount(0);
  await expect(insp.getByTestId('insp-filepath')).toHaveText('.env');
  await expect(insp.locator('.cm-content')).toContainText('API_TOKEN=local-dev');

  // ZERO TERMINAL FLICKER INVARIANT: every action inside Inspector caused 0 px geometry change and 0 PTY resize!
  const bodyAfter = (await pane(page, 0).locator('.pane-body').boundingBox())!;
  const ptyAfter = await page.evaluate((id) => (window as any).__wbTermSize(id), session.id);
  expect(Math.abs(bodyAfter.width - bodyBefore.width)).toBeLessThan(0.5);
  expect(Math.abs(bodyAfter.height - bodyBefore.height)).toBeLessThan(0.5);
  expect(ptyAfter).toEqual(ptyBefore);

  // Resizable divider persists split width and double-click resets to 50%
  const resizer = page.getByTestId('inspect-resizer');
  const rBox = (await resizer.boundingBox())!;
  await page.mouse.move(rBox.x + rBox.width / 2, rBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(rBox.x - 120, rBox.y + 100, { steps: 5 });
  await page.mouse.up();
  const savedSplit = Number(await page.evaluate(() => localStorage.getItem('wb.inspectSplit')));
  expect(savedSplit).toBeGreaterThan(52);
  await resizer.dblclick();
  expect(await page.evaluate(() => localStorage.getItem('wb.inspectSplit'))).toBe('50');

  // Alt+E toggles Inspector off and back on even while terminal is focused
  await pane(page, 0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Alt+e');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await expect(page.getByTestId('layout-1')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Alt+e');
  await expect(page.getByTestId('inspector')).toBeVisible();

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
});

test('concurrent external disk edits: clean editor hot-reloads silently; dirty draft shows conflict banner without data loss', async ({ page, request }) => {
  const dir = initGitProject('conflict');
  const targetFile = path.join(dir, 'config.ts');
  fs.writeFileSync(targetFile, 'export const port = 3000;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  const project = await (await request.post('/api/projects', { data: { name: token('insp-conf'), path: dir } })).json();
  const { task, session } = await createFakeTask(request, project.id, '并发任务', '');

  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();
  await page.getByTestId('layout-inspect').click();

  const insp = page.getByTestId('inspector');
  await insp.locator('[data-testid="tree-entry"][data-path="config.ts"]').click();
  await expect(insp.locator('.cm-content')).toContainText('port = 3000');

  // 1. Clean editor: external Agent updates disk -> silently reloads within the 2.5s check!
  const t1 = new Date(Date.now() + 5000);
  fs.writeFileSync(targetFile, 'export const port = 4000; // updated by agent\n');
  fs.utimesSync(targetFile, t1, t1);
  await expect(insp.locator('.cm-content')).toContainText('updated by agent', { timeout: 8000 });
  await expect(insp.getByTestId('insp-conflict')).toHaveCount(0);

  // 2. Dirty editor: user types local unsaved draft, then external Agent updates disk -> conflict bar appears, draft stays intact!
  await page.waitForTimeout(200);
  const paneBoxBefore = (await pane(page, 0).locator('.pane-body').boundingBox())!;

  await insp.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nexport const myUnsavedEdit = true;');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();

  const t2 = new Date(Date.now() + 15000);
  fs.writeFileSync(targetFile, 'export const port = 5000; // second agent write\n');
  fs.utimesSync(targetFile, t2, t2);

  const conflictBar = insp.getByTestId('insp-conflict');
  await expect(conflictBar).toBeVisible({ timeout: 8000 });
  // User's unsaved text is NOT overwritten!
  await expect(insp.locator('.cm-content')).toContainText('myUnsavedEdit = true');
  // Left terminal geometry did NOT move a single pixel when conflict banner appeared!
  const paneBoxAfter = (await pane(page, 0).locator('.pane-body').boundingBox())!;
  expect(Math.abs(paneBoxAfter.height - paneBoxBefore.height)).toBeLessThan(0.5);
  await page.screenshot({ path: path.join(OUT, '02-conflict-banner.png') });

  // User clicks "保留并覆盖": forces save of user's draft to disk
  await conflictBar.getByTestId('conflict-overwrite').click();
  await expect(conflictBar).toHaveCount(0);
  await expect(insp.getByTestId('unsaved-dot')).toHaveCount(0);
  expect(fs.readFileSync(targetFile, 'utf8')).toContain('myUnsavedEdit = true');

  // Trigger another conflict and choose "重新加载磁盘版本"
  await insp.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// discard this');
  const t3 = new Date(Date.now() + 30000);
  fs.writeFileSync(targetFile, 'export const port = 9000; // disk wins\n');
  fs.utimesSync(targetFile, t3, t3);
  await expect(conflictBar).toBeVisible({ timeout: 8000 });
  await conflictBar.getByTestId('conflict-reload').click();
  await expect(conflictBar).toHaveCount(0);
  await expect(insp.locator('.cm-content')).toContainText('port = 9000; // disk wins');

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
});

test('safe Markdown preview (blocks XSS), inline image preview, and terminal file:line link jumps into Inspector', async ({ page, request }) => {
  const dir = initGitProject('mdlink');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'pixel.png'), TINY_PNG);
  fs.writeFileSync(
    path.join(dir, 'docs', 'README.md'),
    [
      '# 安全预览测试',
      '',
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| Inspector | Ready |',
      '',
      '![pixel](../assets/pixel.png)',
      '',
      '<img src="x" onerror="window.__xss=1">',
      '<script>window.__xss=2</script>',
      '[危险链接](javascript:window.__xss=3)',
    ].join('\n'),
  );
  const lines = Array.from({ length: 60 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join('\n') + '\n';
  const longFile = path.join(dir, 'src', 'long.ts');
  fs.writeFileSync(longFile, lines);

  const project = await (await request.post('/api/projects', { data: { name: token('insp-md'), path: dir } })).json();
  const { task, session } = await createFakeTask(request, project.id, '链接联动', '');

  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();
  await page.getByTestId('layout-inspect').click();

  const insp = page.getByTestId('inspector');
  await insp.getByTestId('insp-tab-files').click();
  await insp.locator('[data-testid="tree-entry"][data-path="docs"]').click();
  await insp.locator('[data-testid="tree-entry"][data-path="docs/README.md"]').click();

  const md = insp.getByTestId('markdown-preview');
  await expect(md).toBeVisible();
  await expect(md.locator('h1')).toHaveText('安全预览测试');
  await expect(md.locator('table')).toContainText('Inspector');
  // Relative image rendered via /api/projects/:id/raw
  await expect.poll(() => md.locator('img.md-img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  // Click the neutralized javascript: span and verify zero XSS execution!
  await md.getByText('危险链接').click();
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await md.locator('script').count()).toBe(0);
  expect(await md.locator('img[onerror]').count()).toBe(0);
  await page.screenshot({ path: path.join(OUT, '03-markdown-safe.png') });

  // Direct image preview in tree
  await insp.locator('[data-testid="tree-entry"][data-path="assets"]').click();
  await insp.locator('[data-testid="tree-entry"][data-path="assets/pixel.png"]').click();
  await expect.poll(() => insp.getByTestId('image-preview').locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);

  // Switch back to single-pane terminal, emit an in-project file:48:3 link, and click it!
  await page.getByTestId('layout-1').click();
  await expect(page.getByTestId('inspector')).toHaveCount(0);

  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type(`link ${longFile}:48:3 JUMPLINK`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await termText(page, session.id)).split('\n').some((l) => l.startsWith('JUMPLINK'))).toBe(true);

  // Compute screen coordinates of JUMPLINK in xterm
  const bufLines = (await termText(page, session.id)).split('\n');
  const screen = (await pane(page, 0).locator('.xterm-screen').boundingBox())!;
  const { cols, rows } = (await page.evaluate((id) => (window as any).__wbTermSize(id), session.id)) as { cols: number; rows: number };
  const cellW = screen.width / cols;
  const cellH = screen.height / rows;
  const r = bufLines.findIndex((l) => l.startsWith('JUMPLINK')) - (bufLines.length - rows);
  await page.mouse.click(screen.x + 2.5 * cellW, screen.y + (r + 0.5) * cellH);

  // Opens directly inside Shoal's Inspector at line 48 without spawning external VS Code!
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('inspector').getByTestId('insp-filepath')).toHaveText('src/long.ts');
  await expect(page.getByTestId('inspector').locator('.cm-activeLine')).toContainText('line_48 = 48');
  const dirTag = path.basename(dir);
  const externalBefore = fs.existsSync(OPEN_LOG)
    ? fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter((l) => l.includes(dirTag)).length
    : 0;
  expect(externalBefore).toBe(0);

  // Fallback "外部打开" button still opens VS Code when explicitly clicked!
  await page.getByTestId('inspector').getByTestId('insp-open-external').click();
  await expect.poll(() =>
    fs.existsSync(OPEN_LOG) ? fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter((l) => l.includes(dirTag)).length : 0,
  ).toBe(1);

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
});
