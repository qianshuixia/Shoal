import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeTask, createProject, pane, row, termText, token } from './helpers.ts';

const OPEN_LOG = path.resolve('.tmp/m1/open-log.jsonl');
const EDITOR = 'C:\\fake\\Code.exe'; // WORKBENCH_EDITOR in playwright.config.ts; never started, the server only logs
const dirs: string[] = [];

test.afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-links-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  return file;
}

function opened(needle: string): { cmd: string; args: string[] }[] {
  if (!fs.existsSync(OPEN_LOG)) return [];
  return fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cmd: string; args: string[] })
    .filter((e) => e.args.some((a) => a.includes(needle)));
}

async function openTerminal(page: Page, request: Parameters<typeof createProject>[0]) {
  const project = await createProject(request, token('links'));
  const { task, session } = await createFakeTask(request, project.id, token('links'));
  await page.goto('/');
  await row(page, session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(800);
  return { input, id: session.id, taskId: task.id, host: pane(page, 0).locator('.term-host') };
}

// Types `link <uri> <text>` into the fake agent and returns the screen position of the link text.
async function showLink(page: Page, t: Awaited<ReturnType<typeof openTerminal>>, uri: string, text: string) {
  await t.input.focus();
  await page.keyboard.type(`link ${uri} ${text}`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await termText(page, t.id)).split('\n').some((l) => l.startsWith(text))).toBe(true);
  const lines = (await termText(page, t.id)).split('\n');
  const screen = (await t.host.locator('.xterm-screen').boundingBox())!;
  const { cols, rows } = (await page.evaluate((id) => (window as any).__wbTermSize(id), t.id)) as { cols: number; rows: number };
  const cellW = screen.width / cols;
  const cellH = screen.height / rows;
  const r = lines.findIndex((l) => l.startsWith(text)) - (lines.length - rows);
  const y = screen.y + (r + 0.5) * cellH;
  return { at: (col: number) => ({ x: screen.x + (col + 0.5) * cellW, y }), cols: text.length };
}

test.describe('terminal links', () => {
  test('clicking a file: link with a Chinese name and #L line opens the editor at that line', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    const name = `链接-${token('f')}.ts`;
    const file = tempFile(name);
    const link = await showLink(page, t, `${pathToFileURL(file).href}#L12C3`, 'OPENME');
    const p = link.at(2);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => opened(name).length).toBe(1);
    expect(opened(name)[0]).toEqual({ cmd: EDITOR, args: ['--goto', `${file}:12:3`] });
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('a bare local path works; an exe is only selected, never run', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    const exe = tempFile(`prog-${token('x')}.exe`);
    const link = await showLink(page, t, exe, 'BAREEXE');
    const p = link.at(1);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => opened(path.basename(exe)).length).toBe(1);
    // Explorer's /select on Windows, Finder's reveal (open -R) on macOS.
    const select = process.platform === 'win32' ? { cmd: 'explorer.exe', args: [`/select,"${exe}"`] } : { cmd: 'open', args: ['-R', exe] };
    expect(opened(path.basename(exe))[0]).toEqual(select);
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('a missing file shows 文件不存在 and a UNC path is refused, with nothing opened', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    const missing = path.join(os.tmpdir(), `wb-missing-${token('m')}.ts`);
    const link = await showLink(page, t, pathToFileURL(missing).href, 'MISSING');
    await page.mouse.click(link.at(1).x, link.at(1).y);
    await expect(page.getByTestId('notice')).toContainText('文件不存在');
    expect(opened(path.basename(missing))).toHaveLength(0);

    await page.getByTestId('notice').click();
    await expect(page.getByTestId('notice')).toHaveCount(0);
    await page.waitForTimeout(500); // the terminal refits when the banner goes away
    const unc = await showLink(page, t, '\\\\evil-host\\share\\a.ts', 'UNCLINK');
    await page.mouse.click(unc.at(1).x, unc.at(1).y);
    await page.waitForTimeout(600);
    // The page never even sends a UNC path to the server.
    await expect(page.getByTestId('notice')).toHaveCount(0);
    expect(opened('evil-host')).toHaveLength(0);
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('an https link opens a new tab without a confirm dialog', async ({ page, request, context }) => {
    await context.route('https://links-test.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    const t = await openTerminal(page, request);
    const link = await showLink(page, t, 'https://links-test.invalid/page?q=1', 'WEBLINK');
    const popup = context.waitForEvent('page');
    await page.mouse.click(link.at(1).x, link.at(1).y);
    const opened = await popup;
    await expect.poll(() => opened.url()).toBe('https://links-test.invalid/page?q=1');
    expect(dialogs).toEqual([]);
    await opened.close();
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('dragging a selection across a link does not open it', async ({ page, request }) => {
    const t = await openTerminal(page, request);
    const name = `drag-${token('d')}.ts`;
    const file = tempFile(name);
    const link = await showLink(page, t, pathToFileURL(file).href, 'DRAGLINK');
    const a = link.at(0);
    const b = link.at(link.cols - 1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(opened(name)).toHaveLength(0);
    // A plain click on the same link still works afterwards.
    await page.mouse.click(link.at(2).x, link.at(2).y);
    await expect.poll(() => opened(name).length).toBe(1);
    await request.delete(`/api/tasks/${t.taskId}`);
  });

  test('POST /api/open rejects a foreign Origin, bad bodies and unsupported targets', async ({ request }) => {
    const file = tempFile(`origin-${token('o')}.ts`);
    const foreign = await request.post('/api/open', { headers: { origin: 'http://evil.example' }, data: { target: file } });
    expect(foreign.status()).toBe(403);
    expect(opened(path.basename(file))).toHaveLength(0);
    expect((await request.post('/api/open', { data: {} })).status()).toBe(400);
    expect((await request.post('/api/open', { data: { target: 'relative\\a.ts' } })).status()).toBe(400);
    expect((await request.post('/api/open', { data: { target: 'file://host/share/a.ts' } })).status()).toBe(400);
    const unc = await request.post('/api/open', { data: { target: '\\\\evil-host\\share\\a.ts' } });
    expect(unc.status()).toBe(400);
    expect(opened('evil-host')).toHaveLength(0);
    const ok = await request.post('/api/open', { data: { target: file } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ action: 'editor', path: file });
    expect(opened(path.basename(file))).toEqual([{ cmd: EDITOR, args: [file] }]);
  });
});
