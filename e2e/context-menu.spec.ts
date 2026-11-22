// Project & File right-click context menus:
// - Sidebar project context menu: inspect files, reveal in Explorer, copy path, send path to terminal, paste into root.
// - Inspector file tree & changes context menus: new file/folder, copy, cut, paste (duplicate & cross-folder & cross-project),
//   copy absolute/relative path, send path to terminal, reveal exact file (/select), rename with conflict check, delete,
//   locate in tree, and discard changes.
// - Invariant: opening/using context menus never resizes the terminal or PTY.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeTask, expectStatus, pane, removeAllTasks, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/context-menu');
const OPEN_LOG = path.resolve('.tmp/m1/open-log.jsonl');
fs.mkdirSync(OUT, { recursive: true });

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-ctx-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  return dir;
}

function readOpenLogSince(offset: number): Array<{ cmd: string; args: string[] }> {
  if (!fs.existsSync(OPEN_LOG)) return [];
  const raw = fs.readFileSync(OPEN_LOG).subarray(offset).toString('utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await removeAllTasks(request);
});

test.afterAll(async ({ request }) => {
  await removeAllTasks(request);
  const st = await (await request.get('/api/state')).json();
  for (const p of st.projects) {
    if (String(p.name).startsWith('ctx-')) await request.delete(`/api/projects/${p.id}`);
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore locked temp dir on Windows */ }
  }
});

test('project and file context menus: copy/cut/paste, paths, reveal exact file, create/rename/delete, zero PTY resize', async ({ page, request }) => {
  // Capture clipboard writes deterministically without depending on OS clipboard focus rules.
  await page.addInitScript(() => {
    (window as any).__copiedTexts = [] as string[];
    const writeText = async (text: string) => {
      (window as any).__copiedTexts.push(text);
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  page.on('dialog', (d) => void d.accept());

  const dirA = initGitProject('proj-a');
  const dirB = initGitProject('proj-b');
  fs.mkdirSync(path.join(dirA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dirA, 'src', 'hello.ts'), 'export const hello = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dirA, 'README.md'), '# Project A\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dirA });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dirA });
  // Dirty change for changes-tab context menu test.
  fs.writeFileSync(path.join(dirA, 'src', 'hello.ts'), 'export const hello = 2;\n', 'utf8');

  fs.writeFileSync(path.join(dirB, 'index.txt'), 'project b\n', 'utf8');

  const projARes = await request.post('/api/projects', { data: { name: token('ctx-a'), path: dirA } });
  const projBRes = await request.post('/api/projects', { data: { name: token('ctx-b'), path: dirB } });
  const projA = await projARes.json();
  const projB = await projBRes.json();

  const { session } = await createFakeTask(request, projA.id, '右键菜单测试', '');

  const resizeEvents: Array<{ id: string; cols: number; rows: number }> = [];
  let trackResize = false;
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      if (trackResize && typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          if (parsed?.t === 'resize') resizeEvents.push(parsed);
        } catch { /* ignore */ }
      }
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });

  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();
  await pane(page, 0).locator('.xterm-helper-textarea').waitFor({ state: 'attached' });

  // 1. Project right-click menu: reveal folder, copy project path, send path to terminal, open files tab.
  const groupAHead = page.locator(`[data-testid="project-group"][data-project-id="${projA.id}"] .group-head`);
  const logStart0 = fs.existsSync(OPEN_LOG) ? fs.statSync(OPEN_LOG).size : 0;

  await groupAHead.click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '01-project-context-menu.png') });
  await menu.getByTestId('ctx-project-reveal').click();
  await expect(menu).toHaveCount(0);

  await expect.poll(() => readOpenLogSince(logStart0).length).toBeGreaterThanOrEqual(1);
  const revealProjEntry = readOpenLogSince(logStart0).at(-1)!;
  expect(revealProjEntry.args.join(' ')).toContain(path.normalize(dirA));

  await groupAHead.click({ button: 'right' });
  await menu.getByTestId('ctx-project-copy-path').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copiedTexts.at(-1))).toBe(dirA);

  await groupAHead.click({ button: 'right' });
  await menu.getByTestId('ctx-project-send-path').click();
  await expect.poll(() => termText(page, session.id)).toContain(path.basename(dirA));

  await groupAHead.click({ button: 'right' });
  await menu.getByTestId('ctx-project-files').click();
  const insp = page.getByTestId('inspector');
  await expect(insp).toBeVisible();
  await expect(insp.getByTestId('insp-tab-files')).toHaveAttribute('aria-selected', 'true');

  // Lock terminal PTY size AND enable WS resize frame capture after Inspector opens -> context menus & file ops must emit 0 resizes.
  await page.waitForTimeout(250);
  const ptyBefore = await page.evaluate((id) => (window as any).__wbTermSize(id), session.id);
  expect(ptyBefore).toBeTruthy();
  trackResize = true;

  // 2. File tree: expand src, test file context menu (reveal exact file, copy abs/rel path, send to terminal).
  const srcRow = insp.locator('[data-testid="tree-entry"][data-path="src"]');
  await srcRow.click();
  const helloRow = insp.locator('[data-testid="tree-entry"][data-path="src/hello.ts"]');
  await expect(helloRow).toBeVisible();

  const logStart1 = fs.existsSync(OPEN_LOG) ? fs.statSync(OPEN_LOG).size : 0;
  await helloRow.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: path.join(OUT, '02-file-context-menu.png') });
  await menu.getByTestId('ctx-reveal').click();

  await expect.poll(() => readOpenLogSince(logStart1).length).toBeGreaterThanOrEqual(1);
  const revealFileEntry = readOpenLogSince(logStart1).at(-1)!;
  const expectedFileAbs = path.join(dirA, 'src', 'hello.ts');
  if (process.platform === 'win32') {
    expect(revealFileEntry.cmd).toBe('explorer.exe');
    expect(revealFileEntry.args).toEqual([`/select,"${expectedFileAbs}"`]);
  } else {
    expect(revealFileEntry.args.join(' ')).toContain('hello.ts');
  }

  await helloRow.click({ button: 'right' });
  await menu.getByTestId('ctx-copy-abs-path').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copiedTexts.at(-1))).toBe(expectedFileAbs);

  await helloRow.click({ button: 'right' });
  await menu.getByTestId('ctx-copy-rel-path').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copiedTexts.at(-1))).toBe('src/hello.ts');

  await helloRow.click({ button: 'right' });
  await menu.getByTestId('ctx-send-to-term').click();
  await expect.poll(() => termText(page, session.id)).toContain('src/hello.ts');

  // 3. Create folder & file via context menu, then copy + duplicate paste + cut + move + cross-project paste.
  await srcRow.click({ button: 'right' });
  await menu.getByTestId('ctx-new-dir').click();
  await page.getByTestId('name-prompt-input').fill('sub');
  await page.getByTestId('name-prompt-submit').click();
  const subRow = insp.locator('[data-testid="tree-entry"][data-path="src/sub"]');
  await expect(subRow).toBeVisible();

  await subRow.click({ button: 'right' });
  await menu.getByTestId('ctx-new-file').click();
  await page.getByTestId('name-prompt-input').fill('draft.ts');
  await page.getByTestId('name-prompt-submit').click();
  const draftRow = insp.locator('[data-testid="tree-entry"][data-path="src/sub/draft.ts"]');
  await expect(draftRow).toBeVisible();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('src/sub/draft.ts');

  // Copy src/hello.ts and verify both internal paste and actual system-clipboard paste work independently.
  const externalClipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-ctx-clip-'));
  tempDirs.push(externalClipDir);
  const externalClipFile = path.join(externalClipDir, 'from-explorer.txt');
  fs.writeFileSync(externalClipFile, 'copied-in-explorer\n', 'utf8');
  await page.route('**/api/clipboard/files', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paths: [externalClipFile] }) });
      return;
    }
    await route.continue();
  });

  await helloRow.click({ button: 'right' });
  await menu.getByTestId('ctx-copy').click();
  await helloRow.click({ button: 'right' });
  await expect(menu.getByTestId('ctx-paste-system')).toBeVisible();
  await menu.getByTestId('ctx-paste').click();
  const dupRow = insp.locator('[data-testid="tree-entry"][data-path="src/hello copy.ts"]');
  await expect(dupRow).toBeVisible();

  // While internal fsClipboard is still populated, pick "粘贴系统剪贴板文件" and verify Explorer file lands on disk.
  await subRow.click({ button: 'right' });
  await menu.getByTestId('ctx-paste-system').click();
  const extRow = insp.locator('[data-testid="tree-entry"][data-path="src/sub/from-explorer.txt"]');
  await expect(extRow).toBeVisible();
  expect(fs.readFileSync(path.join(dirA, 'src', 'sub', 'from-explorer.txt'), 'utf8')).toBe('copied-in-explorer\n');

  // Select src/sub/from-explorer.txt in Changes tab (untracked), switch back to Files tab & dirty draft.ts,
  // then delete the file still remembered by the inactive Changes tab -> draft.ts unsaved draft must remain intact!
  await insp.getByTestId('insp-tab-changes').click();
  const changeExt = insp.locator('[data-testid="change-entry"][data-path="src/sub/from-explorer.txt"]');
  await expect(changeExt).toBeVisible();
  await changeExt.click();
  await expect(insp.getByTestId('insp-filepath')).toHaveText('src/sub/from-explorer.txt');
  await insp.getByTestId('insp-tab-files').click();
  await draftRow.click();
  const cm = insp.locator('.cm-content');
  await cm.click();
  await page.keyboard.type('// unsaved-keep');
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await extRow.click({ button: 'right' });
  await menu.getByTestId('ctx-delete').click();
  await expect(extRow).toHaveCount(0);
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await expect(insp.locator('.cm-content')).toContainText('// unsaved-keep');

  // Cross-project paste: right-click Project B in sidebar -> paste hello.ts into Project B root.
  const groupBHead = page.locator(`[data-testid="project-group"][data-project-id="${projB.id}"] .group-head`);
  await groupBHead.click({ button: 'right' });
  await expect(menu.getByTestId('ctx-project-paste-system')).toBeVisible();
  await menu.getByTestId('ctx-project-paste').click();
  await expect.poll(() => fs.existsSync(path.join(dirB, 'hello.ts'))).toBe(true);

  // Cut src/hello copy.ts -> verify .is-cut visual state -> paste into src/sub.
  await dupRow.click({ button: 'right' });
  await menu.getByTestId('ctx-cut').click();
  await expect(dupRow).toHaveClass(/is-cut/);
  await subRow.click({ button: 'right' });
  await menu.getByTestId('ctx-paste').click();
  await expect(dupRow).toHaveCount(0);
  const movedRow = insp.locator('[data-testid="tree-entry"][data-path="src/sub/hello copy.ts"]');
  await expect(movedRow).toBeVisible();

  // 4. Rename movedRow with conflict rejection, then valid rename, then delete (draft.ts stays dirty & intact!).
  await movedRow.click({ button: 'right' });
  await menu.getByTestId('ctx-rename').click();
  await page.getByTestId('name-prompt-input').fill('draft.ts');
  await page.getByTestId('name-prompt-submit').click();
  await expect(page.getByTestId('name-prompt-error')).toContainText('已存在');

  await page.getByTestId('name-prompt-input').fill('renamed.ts');
  await page.getByTestId('name-prompt-submit').click();
  const renamedRow = insp.locator('[data-testid="tree-entry"][data-path="src/sub/renamed.ts"]');
  await expect(renamedRow).toBeVisible();
  expect(fs.existsSync(path.join(dirA, 'src', 'sub', 'renamed.ts'))).toBe(true);

  await renamedRow.click({ button: 'right' });
  await menu.getByTestId('ctx-delete').click();
  await expect(renamedRow).toHaveCount(0);
  expect(fs.existsSync(path.join(dirA, 'src', 'sub', 'renamed.ts'))).toBe(false);
  await expect(insp.getByTestId('unsaved-dot')).toBeVisible();
  await expect(insp.locator('.cm-content')).toContainText('// unsaved-keep');

  // 5. Changes tab context menu: locate in tree.
  await insp.getByTestId('insp-tab-changes').click();
  const changeHello = insp.locator('[data-testid="change-entry"][data-path="src/hello.ts"]');
  await expect(changeHello).toBeVisible();
  await changeHello.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByTestId('ctx-locate-tree').click();
  await expect(insp.getByTestId('insp-tab-files')).toHaveAttribute('aria-selected', 'true');
  await expect(insp.getByTestId('insp-filepath')).toHaveText('src/hello.ts');

  // Verify PTY dimensions stayed untouched throughout and zero extra WS resize frames were sent.
  expect(await page.evaluate((id) => (window as any).__wbTermSize(id), session.id)).toEqual(ptyBefore);
  expect(resizeEvents).toEqual([]);
});
