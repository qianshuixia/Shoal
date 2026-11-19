import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DirListing } from '../shared/protocol.ts';
import { SANDBOX, state, createFakeTask, row, expectStatus, termText, token } from './helpers.ts';

// JSON string quoting doubles as CSS string escaping for backslashes.
const dirEntry = (page: Page, p: string) => page.locator(`[data-testid="dir-entry"][data-path=${JSON.stringify(p)}]`);

test('目录浏览：点选子目录（含中文名）创建项目，出错后可回到磁盘列表', async ({ page, request }) => {
  const root = path.join(SANDBOX, token('browse'));
  for (const d of ['alpha', 'beta', '中文目录']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x');

  // API: listing, files excluded, errors are 400 with a message.
  const listing: DirListing = await (await request.get(`/api/dirs?path=${encodeURIComponent(root)}`)).json();
  expect(listing.path).toBe(root);
  expect(listing.parent).toBe(path.dirname(root));
  expect(listing.entries.map(e => e.name).sort()).toEqual(['alpha', 'beta', '中文目录'].sort());
  const missing = await request.get(`/api/dirs?path=${encodeURIComponent(path.join(root, 'nope'))}`);
  expect(missing.status()).toBe(400);
  expect((await missing.json()).error).toContain('目录不存在');
  const file = await request.get(`/api/dirs?path=${encodeURIComponent(path.join(root, 'not-a-dir.txt'))}`);
  expect(file.status()).toBe(400);

  await page.goto('/');
  await page.getByTestId('new-project-btn').click();

  // Bad typed path → error shown, dialog stays usable, drive list reachable.
  await page.getByTestId('project-path').fill(path.join(root, 'nope'));
  await page.getByTestId('project-browse').click();
  await expect(page.getByTestId('dir-error')).toBeVisible();
  await page.getByTestId('dir-drives').click();
  // The drive list is "此电脑" with drive letters on Windows, "根目录 / 卷" with / and /Volumes/* on macOS.
  const mac = process.platform === 'darwin';
  await expect(page.getByTestId('dir-current')).toHaveText(mac ? '根目录 / 卷' : '此电脑');
  await expect(dirEntry(page, mac ? '/' : 'C:\\')).toBeVisible();
  await expect(page.getByTestId('dir-select')).toBeDisabled();

  // Typed path → browser opens there; navigate into a child, up, and into the Chinese-named one.
  await page.getByTestId('project-browse').click(); // close
  await page.getByTestId('project-path').fill(root);
  await page.getByTestId('project-browse').click();
  await expect(page.getByTestId('dir-current')).toHaveText(root);
  await expect(page.getByTestId('dir-entry')).toHaveCount(3);
  await dirEntry(page, path.join(root, 'alpha')).click();
  await expect(page.getByTestId('dir-current')).toHaveText(path.join(root, 'alpha'));
  await page.getByTestId('dir-up').click();
  await expect(page.getByTestId('dir-current')).toHaveText(root);
  await page.getByTestId('dir-entry').filter({ hasText: '中文目录' }).click();
  const chosen = path.join(root, '中文目录');
  await expect(page.getByTestId('dir-current')).toHaveText(chosen);
  await page.getByTestId('dir-select').click();
  await expect(page.getByTestId('dir-browser')).toBeHidden();
  await expect(page.getByTestId('project-path')).toHaveValue(chosen);
  await expect(page.getByTestId('project-name')).toHaveValue('中文目录');
  await page.getByTestId('project-submit').click();
  await expect(page.getByTestId('project-name')).toBeHidden();

  const project = (await state(request)).projects.find(p => p.path === chosen);
  expect(project?.name).toBe('中文目录');

  // Default start dir follows the latest project.
  const def: DirListing = await (await request.get('/api/dirs')).json();
  expect(def.path).toBe(root);

  // Name typed by the user is not overwritten by the picker.
  await page.getByTestId('new-project-btn').click();
  await page.getByTestId('project-name').fill('自定义名');
  await page.getByTestId('project-browse').click();
  await expect(page.getByTestId('dir-current')).toHaveText(root);
  await page.getByTestId('dir-entry').filter({ hasText: 'beta' }).click();
  await page.getByTestId('dir-select').click();
  await expect(page.getByTestId('project-name')).toHaveValue('自定义名');
  await expect(page.getByTestId('project-path')).toHaveValue(path.join(root, 'beta'));
  await page.screenshot({ path: path.resolve('.tmp/m1/dir-browser.png') });
});

// Own server instance so the shared webServer is not killed.
const RPORT = 47812;
const RBASE = `http://127.0.0.1:${RPORT}`;
const RDIR = path.resolve('.tmp/m1/restart');

function startServer(n: number): ChildProcess {
  const out = fs.openSync(path.join(RDIR, `server-${n}.log`), 'w');
  return spawn(process.execPath, ['server/main.ts', '--port', String(RPORT)], {
    stdio: ['ignore', out, out],
    env: { ...process.env, WORKBENCH_FAKE_AGENT: '1', WORKBENCH_STATE_DIR: path.join(RDIR, 'state'), FAKE_AGENT_LOG: path.join(RDIR, 'fake-agent.jsonl') },
  });
}

async function waitUp(api: APIRequestContext) {
  for (let i = 0; i < 100; i++) {
    try { if ((await api.get('/api/state')).ok()) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('restart server did not come up');
}

// Windows: kill the whole tree (the server's ConPTY children too). POSIX: SIGKILL the server and wait for it to exit,
// so the next server can bind the same port.
async function hardKill(p: ChildProcess) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()));
  p.kill('SIGKILL');
  await exited;
}

test('服务被强杀重启后：项目和任务还在，会话显示已退出，可续接，可删除，可继续建新任务', async ({ page }) => {
  fs.rmSync(RDIR, { recursive: true, force: true });
  fs.mkdirSync(RDIR, { recursive: true });
  const proj = path.join(RDIR, 'proj');
  fs.mkdirSync(proj);
  let srv = startServer(1);
  const api = await pwRequest.newContext({ baseURL: RBASE });
  try {
    await waitUp(api);
    const project = await (await api.post('/api/projects', { data: { name: '持久化', path: proj } })).json();
    const a = await createFakeTask(api, project.id, '活着的任务', 'hello');
    const b = await createFakeTask(api, project.id, '退出的任务');
    page.on('dialog', d => d.accept()); // beforeunload guard + delete confirm
    await page.goto(RBASE);
    await expectStatus(page, a.session.id, 'needs_you');
    // b exits cleanly before the crash; a is still running when the server dies.
    await page.locator('[data-testid="task-row"]').filter({ hasText: '退出的任务' }).click();
    await page.keyboard.type('exit 3\r');
    await expectStatus(page, b.session.id, 'exited');
    const before = await state(api);
    const nativeA = before.sessions.find(s => s.id === a.session.id)?.nativeSessionId;
    expect(nativeA).toBeTruthy();

    await hardKill(srv);
    srv = startServer(2);
    await waitUp(api);

    const after = await state(api);
    expect(after.projects.map(p => p.name)).toEqual(['持久化']);
    expect(after.tasks.map(t => t.title).sort()).toEqual(['活着的任务', '退出的任务'].sort());
    const sa = after.sessions.find(s => s.id === a.session.id)!;
    const sb = after.sessions.find(s => s.id === b.session.id)!;
    expect(sa.status).toBe('exited');
    expect(sa.exitCode).toBeNull();
    expect(sa.nativeSessionId).toBe(nativeA);
    expect(sb.status).toBe('exited');
    expect(sb.exitCode).toBe(3);

    // The open page reconnects by itself and shows the rows as exited instead of going blank.
    await expectStatus(page, a.session.id, 'exited');
    await expectStatus(page, b.session.id, 'exited');
    // Input to a dead session must not crash anything.
    await row(page, a.session.id).click();
    await page.keyboard.type('ignored\r');

    // After a restart the persisted native id still reopens the conversation (a had a prompt; b never did).
    await expect(row(page, a.session.id).getByTestId('task-resume')).toBeVisible();
    await row(page, a.session.id).getByTestId('task-resume').click();
    let resumedA = '';
    await expect.poll(async () => (resumedA = (await state(api)).tasks.find(t => t.title === '活着的任务')?.sessionId ?? '')).not.toBe(a.session.id);
    await expectStatus(page, resumedA, 'idle'); // reopened at an empty prompt: 就绪
    await expect.poll(() => termText(page, resumedA)).toContain(`RESUMED ${nativeA}`);
    expect((await state(api)).sessions.find(s => s.id === resumedA)?.nativeSessionId).toBe(nativeA);
    const noConv = await api.post(`/api/tasks/${b.task.id}/resume`, { data: { cols: 100, rows: 30 } });
    expect(noConv.status()).toBe(409);
    expect((await noConv.json()).code).toBe('no-conversation');
    const rb = await (await api.post(`/api/tasks/${b.task.id}/resume`, { data: { fresh: true, cols: 100, rows: 30 } })).json();
    expect(rb.resumed).toBe(false);

    // × archives first; × on the archived row deletes.
    await row(page, resumedA).hover();
    await row(page, resumedA).getByTestId('task-remove').click();
    await expect(row(page, resumedA)).toHaveCount(0);
    await page.getByTestId('archived-toggle').click();
    await row(page, resumedA).hover();
    await row(page, resumedA).getByTestId('task-remove').click();
    await expect(row(page, resumedA)).toHaveCount(0);
    await expect.poll(async () => (await state(api)).tasks.map(t => t.title)).toEqual(['退出的任务']);

    // A new task still works after restart.
    const c = await createFakeTask(api, project.id, '重启后新任务', 'again');
    await expectStatus(page, c.session.id, 'needs_you');
    await page.screenshot({ path: path.join(RDIR, 'after-restart.png') });

    // Deletion survives another restart too.
    await hardKill(srv);
    srv = startServer(3);
    await waitUp(api);
    const final = await state(api);
    expect(final.tasks.map(t => t.title).sort()).toEqual(['退出的任务', '重启后新任务'].sort());
    expect(final.sessions.find(s => s.id === a.session.id || s.id === resumedA)).toBeUndefined();
    const stateFile = JSON.parse(fs.readFileSync(path.join(RDIR, 'state', 'state.json'), 'utf8'));
    expect(stateFile.version).toBe(1);
  } finally {
    await api.dispose();
    await hardKill(srv);
  }
});
