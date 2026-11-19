import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeTask, createProject, pane, row, token } from './helpers.ts';

const STATE_DIR = path.resolve('.tmp/m1/state');
const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';
// What a paste with no text or files sends so the CLI reads the clipboard image itself: Claude Code's image-paste key,
// Alt+V (ESC v) on Windows and Ctrl+V (^V) on macOS.
const IMAGE_KEY = process.platform === 'darwin' ? '\x16' : '\x1bv';

// The server reads copied files from the real system clipboard; tests answer for it instead (no files unless a test sets some).
let clipboardFiles: { status: number; body: unknown };
test.beforeEach(async ({ page }) => {
  clipboardFiles = { status: 200, body: { paths: [] } };
  await page.route('**/api/clipboard/files', (route) => route.fulfill({ status: clipboardFiles.status, json: clipboardFiles.body }));
});

// Opens a fresh fake task and records everything the page types into its PTY.
async function openTerminal(page: Page, request: Parameters<typeof createProject>[0]) {
  const project = await createProject(request, token('paste'));
  const { task, session } = await createFakeTask(request, project.id, token('paste'));
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const m = JSON.parse(String(f.payload));
    if (m.t === 'in' && m.id === session.id) sent.push(m.d);
  }));
  await page.goto('/');
  await row(page, session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(800);
  sent.length = 0;
  return { sent, input, taskId: task.id, host: pane(page, 0).locator('.term-host') };
}

const settle = (page: Page) => page.waitForTimeout(400);

// Builds a small solid-colour PNG in the page; returns it as base64 alongside a File.
const PNG_SNIPPET = `
  async function makePng(color, size) {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
    const blob = await new Promise((r) => c.toBlob((b) => r(b), 'image/png'));
    return blob;
  }
`;

test.describe('paste and drop images', () => {
  test('image-only paste sends the image-paste key and no bracketed paste', async ({ page, request }) => {
    const { sent, input, taskId } = await openTerminal(page, request);
    const prevented = await input.evaluate(async (ta) => {
      const c = document.createElement('canvas'); c.width = 4; c.height = 4;
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    await settle(page);
    expect(prevented).toBe(true);
    expect(sent.join('')).toBe(IMAGE_KEY);
    expect(sent.join('')).not.toContain(BP_START);

    // Chrome's native paste of a bitmap clipboard (measured with Ctrl+V) carries no types, items or files at all.
    sent.length = 0;
    await input.evaluate((ta) => {
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
    });
    await settle(page);
    expect(sent.join('')).toBe(IMAGE_KEY);
    await request.delete(`/api/tasks/${taskId}`);
  });

  // Chrome's native paste of files copied in Explorer (measured with Ctrl+V): only `Files`, no text, no paths.
  const pasteCopiedFile = (ta: HTMLElement) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], '视频 a.mp4', { type: 'video/mp4' }));
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  };

  test('files copied in Explorer paste as their paths, quoted when they contain spaces', async ({ page, request }) => {
    const { sent, input, taskId } = await openTerminal(page, request);
    clipboardFiles.body = { paths: ['C:\视频\录屏 a.mp4', 'D:\clips\b.mov'] };
    await input.evaluate(pasteCopiedFile);
    await settle(page);
    expect(sent.join('')).toBe(`${BP_START}"C:\视频\录屏 a.mp4" D:\clips\b.mov${BP_END}`);
    expect(sent.join('')).not.toContain(IMAGE_KEY);

    // The clipboard could not be read: say so, and still let the CLI try its own clipboard image paste.
    sent.length = 0;
    clipboardFiles = { status: 500, body: { error: '读取剪贴板失败：timeout' } };
    await input.evaluate(pasteCopiedFile);
    await settle(page);
    await expect(page.getByTestId('notice')).toContainText('读取剪贴板失败：timeout');
    expect(sent.join('')).toBe(IMAGE_KEY);
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('text paste stays a bracketed paste; text with image is still text', async ({ page, request }) => {
    const { sent, input, taskId } = await openTerminal(page, request);
    await input.evaluate((ta) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello-text');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await settle(page);
    expect(sent.join('')).toBe(`${BP_START}hello-text${BP_END}`);

    sent.length = 0;
    await input.evaluate(async (ta) => {
      const c = document.createElement('canvas'); c.width = 4; c.height = 4;
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.setData('text/plain', 'cell-text');
      dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await settle(page);
    expect(sent.join('')).toBe(`${BP_START}cell-text${BP_END}`);
    expect(sent.join('')).not.toContain(IMAGE_KEY);
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('Ctrl+V is not sent as ^V, Alt+V still sends ESC v', async ({ page, request }) => {
    test.skip(process.platform === 'darwin', 'macOS: Cmd+V pastes, Ctrl+V goes to the CLI (next test)');
    const { sent, input, taskId } = await openTerminal(page, request);
    await input.focus();
    await page.keyboard.press('Control+V');
    await settle(page);
    expect(sent.join('')).not.toContain('\x16');
    sent.length = 0;
    await page.keyboard.press('Alt+V');
    await settle(page);
    expect(sent.join('')).toBe('\x1bv');
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('macOS: Ctrl+V reaches the CLI as ^V, its image-paste key there', async ({ page, request }) => {
    test.skip(process.platform !== 'darwin', 'macOS only');
    const { sent, input, taskId } = await openTerminal(page, request);
    await input.focus();
    await page.keyboard.press('Control+V');
    await settle(page);
    expect(sent.join('')).toBe('\x16');
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('dropping [png, text file, png] saves both images and pastes their paths in order', async ({ page, request }) => {
    const { sent, host, taskId } = await openTerminal(page, request);
    const dropped = await host.evaluate(async (el, snippet) => {
      const makePng = new Function(`${snippet}; return makePng;`)() as (c: string, s: number) => Promise<Blob>;
      const a = await makePng('#c0392b', 6);
      const b = await makePng('#2980b9', 9);
      const toB64 = async (blob: Blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (const x of bytes) s += String.fromCharCode(x);
        return btoa(s);
      };
      const dt = new DataTransfer();
      dt.items.add(new File([a], 'a.png', { type: 'image/png' }));
      dt.items.add(new File(['plain'], 'notes.txt', { type: 'text/plain' }));
      dt.items.add(new File([b], 'b.png', { type: 'image/png' }));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { a: await toB64(a), b: await toB64(b), prevented: ev.defaultPrevented };
    }, PNG_SNIPPET);
    expect(dropped.prevented).toBe(true);
    await expect.poll(() => sent.join('').split(BP_START).length - 1, { timeout: 10_000 }).toBe(2);
    const paths = [...sent.join('').matchAll(/\x1b\[200~(.*?)\x1b\[201~/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(path.dirname(p)).toBe(path.join(STATE_DIR, 'attachments'));
      expect(p.endsWith('.png')).toBe(true);
    }
    expect(fs.readFileSync(paths[0]).toString('base64')).toBe(dropped.a);
    expect(fs.readFileSync(paths[1]).toString('base64')).toBe(dropped.b);
    await expect(page.getByTestId('notice')).toHaveText('已跳过 1 个非图片文件（只支持拖入图片）');
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('upload failure shows a notice and later files are still handled', async ({ page, request }) => {
    const { sent, host, taskId } = await openTerminal(page, request);
    // First upload is refused by the server; the second goes through.
    let n = 0;
    await page.route('**/api/attachments', (route) => {
      if (n++ === 0) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
      return route.continue();
    });
    await host.evaluate(async (el, snippet) => {
      const makePng = new Function(`${snippet}; return makePng;`)() as (c: string, s: number) => Promise<Blob>;
      const dt = new DataTransfer();
      dt.items.add(new File([await makePng('#111111', 5)], 'bad.png', { type: 'image/png' }));
      dt.items.add(new File([await makePng('#eeeeee', 7)], 'good.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, PNG_SNIPPET);
    await expect(page.getByTestId('notice')).toContainText('图片上传失败：bad.png');
    await expect.poll(() => sent.join('').split(BP_START).length - 1, { timeout: 10_000 }).toBe(1);
    await request.delete(`/api/tasks/${taskId}`);
  });

  test('POST /api/attachments validates type, size, body and origin', async ({ request }) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const ok = await request.post('/api/attachments', { headers: { 'content-type': 'image/png' }, data: png });
    expect(ok.status()).toBe(200);
    const saved = (await ok.json()).path as string;
    expect(fs.readFileSync(saved).equals(png)).toBe(true);

    const wrongType = await request.post('/api/attachments', { headers: { 'content-type': 'text/plain' }, data: Buffer.from('x') });
    expect(wrongType.status()).toBe(415);
    const empty = await request.post('/api/attachments', { headers: { 'content-type': 'image/png' }, data: Buffer.alloc(0) });
    expect(empty.status()).toBe(400);
    const big = await request.post('/api/attachments', { headers: { 'content-type': 'image/png' }, data: Buffer.alloc(21 * 1024 * 1024, 1) });
    expect(big.status()).toBe(413);
    const foreign = await request.post('/api/attachments', { headers: { 'content-type': 'image/png', origin: 'http://evil.example' }, data: png });
    expect(foreign.status()).toBe(403);
    // Other POST routes still insist on JSON.
    const json = await request.post('/api/projects', { headers: { 'content-type': 'text/plain' }, data: '{}' });
    expect(json.status()).toBe(415);
  });
});
