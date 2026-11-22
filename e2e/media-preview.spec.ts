// Inspector inline preview for video, audio and PDF:
// Files tab playback (webm + H.264 mp4) with Range-based seeking, audio, PDF in an iframe, the decode-error fallback
// that opens the file with the system default program, the Changes tab past the 2 MB diff cap, the /raw endpoint's
// Range / whitelist / path guards, and terminal links to a video opening in the panel instead of externally.
// Fixtures: e2e/fixtures/media/clip.{webm,mp4} are 3 s 160x90 ffmpeg testsrc clips (VP9 / H.264 baseline, no audio).
import { test, expect, type Page, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeTask, expectStatus, pane, removeAllTasks, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/media-preview');
const OPEN_LOG = path.resolve('.tmp/m1/open-log.jsonl');
const FIXTURES = path.resolve('e2e/fixtures/media');
fs.mkdirSync(OUT, { recursive: true });

const tempDirs: string[] = [];

function initGitProject(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoal-media-${label}-`));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  return dir;
}

// 1 s, 8 kHz, 16-bit mono 440 Hz sine.
function makeWav(): Buffer {
  const rate = 8000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

// One-page PDF with a text line, correct xref offsets.
function makePdf(text: string): Buffer {
  const content = `BT /F1 28 Tf 40 80 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const openLogLines = (dirTag: string) =>
  fs.existsSync(OPEN_LOG)
    ? fs.readFileSync(OPEN_LOG, 'utf8').split('\n').filter((l) => l.includes(dirTag)).map((l) => JSON.parse(l) as { cmd: string; args: string[] })
    : [];

async function waitMetadata(media: Locator): Promise<number> {
  await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  return media.evaluate((el: HTMLMediaElement) => el.duration);
}

async function openInspectorFiles(page: Page, sessionId: string) {
  await page.goto('/');
  await expectStatus(page, sessionId, 'idle');
  await row(page, sessionId).click();
  await page.getByTestId('layout-inspect').click();
  const insp = page.getByTestId('inspector');
  await expect(insp).toBeVisible();
  return insp;
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await removeAllTasks(request);
});

test.afterAll(async ({ request }) => {
  await removeAllTasks(request);
  const st = await (await request.get('/api/state')).json();
  for (const p of st.projects) {
    if (String(p.name).startsWith('media-')) await request.delete(`/api/projects/${p.id}`);
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore locked temp dir on Windows */ }
  }
});

test('Files tab plays video and audio, seeks through Range, renders PDF, and falls back on undecodable media', async ({ page, request }) => {
  const dir = initGitProject('files');
  fs.mkdirSync(path.join(dir, 'media'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(FIXTURES, 'clip.webm'), path.join(dir, 'media', 'clip.webm'));
  fs.copyFileSync(path.join(FIXTURES, 'clip.mp4'), path.join(dir, 'media', 'clip.mp4'));
  fs.writeFileSync(path.join(dir, 'media', 'tone.wav'), makeWav());
  fs.writeFileSync(path.join(dir, 'media', 'guide.pdf'), makePdf('Shoal PDF preview'));
  fs.writeFileSync(path.join(dir, 'media', 'broken.avi'), Buffer.alloc(64 * 1024, 0x5a));
  fs.writeFileSync(path.join(dir, 'media', 'fake.pdf'), 'this is plain text renamed to .pdf\n');
  fs.writeFileSync(path.join(dir, 'media', 'truncated.pdf'), makePdf('cut off').subarray(0, 120));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');

  const project = await (await request.post('/api/projects', { data: { name: token('media-files'), path: dir } })).json();
  const { task, session } = await createFakeTask(request, project.id, '媒体预览', '');

  const rawResponses: { url: string; status: number; range?: string }[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/raw?')) rawResponses.push({ url: res.url(), status: res.status(), range: res.headers()['content-range'] });
  });

  const insp = await openInspectorFiles(page, session.id);
  await insp.getByTestId('insp-tab-files').click();
  await insp.locator('[data-testid="tree-entry"][data-path="media"]').click();

  // VP9 webm: metadata loads, playback advances and a seek near the end lands. The element fetches with Range from byte 0
  // (206); this 8 KB clip is fully buffered by that request, so mid-file ranges are asserted against the API in the
  // Changes test instead.
  await insp.locator('[data-testid="tree-entry"][data-path="media/clip.webm"]').click();
  const webm = insp.getByTestId('video-preview').locator('video');
  expect(await waitMetadata(webm)).toBeCloseTo(3, 0);
  await webm.evaluate((el: HTMLVideoElement) => { el.muted = true; return el.play(); });
  await expect.poll(() => webm.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);
  await webm.evaluate((el: HTMLVideoElement) => el.pause());
  await webm.evaluate((el: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
    el.addEventListener('seeked', () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('video error')), { once: true });
    el.currentTime = 2.5;
  }));
  await expect.poll(() => webm.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2);
  expect(rawResponses.some((r) => r.url.includes('clip.webm') && r.status === 206 && /^bytes \d+-\d+\/8512$/.test(r.range ?? ''))).toBe(true);
  await expect(insp.getByTestId('video-preview')).toContainText('8.3 KB');
  await page.screenshot({ path: path.join(OUT, '01-video-webm.png') });

  // H.264 mp4 (Chrome / WebView2 / WKWebView all decode it).
  await insp.locator('[data-testid="tree-entry"][data-path="media/clip.mp4"]').click();
  const mp4 = insp.getByTestId('video-preview').locator('video');
  expect(await waitMetadata(mp4)).toBeCloseTo(3, 0);
  await expect.poll(() => mp4.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(160);

  // Audio.
  await insp.locator('[data-testid="tree-entry"][data-path="media/tone.wav"]').click();
  const audio = insp.getByTestId('audio-preview').locator('audio');
  expect(await waitMetadata(audio)).toBeCloseTo(1, 1);
  await expect(insp.getByTestId('save-file')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '02-audio.png') });

  // PDF: an unsandboxed iframe on the raw URL, served as application/pdf.
  await insp.locator('[data-testid="tree-entry"][data-path="media/guide.pdf"]').click();
  const frame = insp.getByTestId('pdf-preview').locator('iframe');
  await expect(frame).toHaveAttribute('src', /\/raw\?path=media%2Fguide\.pdf/);
  expect(await frame.getAttribute('sandbox')).toBeNull();
  const box = (await frame.boundingBox())!;
  expect(box.height).toBeGreaterThan(300);
  const pdfRes = await request.get(new URL((await frame.getAttribute('src'))!, page.url()).toString());
  expect(pdfRes.headers()['content-type']).toBe('application/pdf');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '03-pdf.png') });

  // A file named .pdf without a PDF header: the iframe would show a blank viewer, so the header probe falls back instead.
  await insp.locator('[data-testid="tree-entry"][data-path="media/fake.pdf"]').click();
  await expect(insp.getByTestId('media-unsupported')).toContainText('不是有效的 PDF');
  await expect(insp.locator('iframe')).toHaveCount(0);

  // Undecodable video: the player errors, the fallback explains it, and 在外部打开 uses the system default program.
  const dirTag = path.basename(dir);
  const before = openLogLines(dirTag).length;
  await insp.locator('[data-testid="tree-entry"][data-path="media/broken.avi"]').click();
  const unsupported = insp.getByTestId('media-unsupported');
  await expect(unsupported).toContainText('AVI');
  await expect(insp.getByTestId('video-preview')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '04-unsupported.png') });
  await unsupported.getByRole('button', { name: '在外部打开' }).click();
  await expect.poll(() => openLogLines(dirTag).length).toBe(before + 1);
  const opened = openLogLines(dirTag).at(-1)!;
  expect(opened.cmd).toBe(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open');
  expect(opened.args.at(-1)).toMatch(/broken\.avi$/);

  // Valid header, truncated body: the probe passes and the viewer reports the damage itself, with no signal to the page,
  // so the bar under the viewer keeps 在外部打开 in reach.
  await insp.locator('[data-testid="tree-entry"][data-path="media/truncated.pdf"]').click();
  await expect(insp.getByTestId('pdf-preview').locator('iframe')).toHaveAttribute('src', /path=media%2Ftruncated\.pdf/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '04b-pdf-truncated.png') });
  await insp.getByTestId('pdf-open-external').click();
  await expect.poll(() => openLogLines(dirTag).length).toBe(before + 2);
  expect(openLogLines(dirTag).at(-1)!.args.at(-1)).toMatch(/truncated\.pdf$/);

  // Switching back to a playable file clears the error state; a .ts file still opens in the editor.
  await insp.locator('[data-testid="tree-entry"][data-path="media/clip.webm"]').click();
  expect(await waitMetadata(insp.getByTestId('video-preview').locator('video'))).toBeCloseTo(3, 0);
  await insp.locator('[data-testid="tree-entry"][data-path="src"]').click();
  await insp.locator('[data-testid="tree-entry"][data-path="src/app.ts"]').click();
  await expect(insp.locator('.cm-content')).toContainText('answer = 42');

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
});

test('Changes tab previews untracked media past the 2 MB diff cap; /raw enforces Range, whitelist and project bounds', async ({ page, request }) => {
  const dir = initGitProject('changes');
  fs.writeFileSync(path.join(dir, 'README.md'), '# media\n');
  fs.writeFileSync(path.join(dir, 'old.pdf'), makePdf('committed then deleted'));
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.copyFileSync(path.join(FIXTURES, 'clip.webm'), path.join(dir, 'clip.webm'));
  // 3 MB of noise named .mp4: over the diff cap (tooLarge) and undecodable.
  fs.writeFileSync(path.join(dir, 'big.mp4'), Buffer.alloc(3 * 1024 * 1024, 0x33));
  fs.writeFileSync(path.join(dir, 'notes.ts'), 'export {};\n');
  // A small PDF has no NUL byte, so a byte sniff alone would call it text; it must preview, never open in the editor.
  fs.writeFileSync(path.join(dir, 'small.pdf'), makePdf('Changes tab PDF'));
  fs.rmSync(path.join(dir, 'old.pdf'));
  fs.writeFileSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.mp4`), 'x');

  const project = await (await request.post('/api/projects', { data: { name: token('media-changes'), path: dir } })).json();
  const { task, session } = await createFakeTask(request, project.id, '媒体变更', '');
  const raw = (rel: string) => `/api/projects/${encodeURIComponent(project.id)}/raw?path=${encodeURIComponent(rel)}`;

  // Range semantics.
  const size = fs.statSync(path.join(dir, 'clip.webm')).size;
  const part = await request.get(raw('clip.webm'), { headers: { Range: 'bytes=0-99' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toBe(`bytes 0-99/${size}`);
  expect((await part.body()).length).toBe(100);
  const tail = await request.get(raw('clip.webm'), { headers: { Range: 'bytes=-12' } });
  expect(tail.status()).toBe(206);
  expect(Buffer.compare(await tail.body(), fs.readFileSync(path.join(dir, 'clip.webm')).subarray(size - 12))).toBe(0);
  // If-Range is not validated here (no ETag), so a conditional range always gets the full current file.
  const conditional = await request.get(raw('clip.webm'), { headers: { Range: 'bytes=0-99', 'If-Range': '"stale"' } });
  expect(conditional.status()).toBe(200);
  expect((await conditional.body()).length).toBe(size);
  const past = await request.get(raw('clip.webm'), { headers: { Range: `bytes=${size}-` } });
  expect(past.status()).toBe(416);
  expect(past.headers()['content-range']).toBe(`bytes */${size}`);
  const whole = await request.get(raw('clip.webm'));
  expect(whole.status()).toBe(200);
  expect(whole.headers()['accept-ranges']).toBe('bytes');
  expect(whole.headers()['content-type']).toBe('video/webm');
  expect(whole.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(whole.headers()['x-content-type-options']).toBe('nosniff');
  expect((await whole.body()).length).toBe(size);
  // Whitelist and project bounds: TypeScript sources are never streamed raw, and paths can't leave the project.
  expect((await request.get(raw('notes.ts'))).status()).toBe(415);
  expect((await request.get(raw(`../${path.basename(dir)}-outside.mp4`))).status()).toBeGreaterThanOrEqual(400);

  const insp = await openInspectorFiles(page, session.id);
  await insp.getByTestId('insp-tab-changes').click();
  await insp.locator('[data-testid="change-entry"][data-path="clip.webm"]').click();
  expect(await waitMetadata(insp.getByTestId('video-preview').locator('video'))).toBeCloseTo(3, 0);
  await expect(insp.getByTestId('guard-binary')).toHaveCount(0);

  await insp.locator('[data-testid="change-entry"][data-path="small.pdf"]').click();
  await expect(insp.getByTestId('pdf-preview').locator('iframe')).toHaveAttribute('src', /path=small\.pdf/);
  await expect(insp.locator('.cm-content')).toHaveCount(0);
  await expect(insp.getByTestId('save-file')).toHaveCount(0);

  // Deleted media has nothing on disk to preview or diff.
  await insp.locator('[data-testid="change-entry"][data-path="old.pdf"]').click();
  await expect(insp.getByTestId('guard-binary')).toBeVisible();
  await expect(insp.locator('.cm-content')).toHaveCount(0);

  await insp.locator('[data-testid="change-entry"][data-path="big.mp4"]').click();
  await expect(insp.getByTestId('media-unsupported')).toContainText('3.00 MB');
  await expect(insp.getByTestId('guard-too-large')).toHaveCount(0);
  await page.screenshot({ path: path.join(OUT, '05-changes.png') });

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
  fs.rmSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.mp4`), { force: true });
});

test('terminal link to an in-project video opens it in the Inspector instead of an external player', async ({ page, request }) => {
  const dir = initGitProject('link');
  fs.copyFileSync(path.join(FIXTURES, 'clip.mp4'), path.join(dir, 'demo.mp4'));
  const project = await (await request.post('/api/projects', { data: { name: token('media-link'), path: dir } })).json();
  const { task, session } = await createFakeTask(request, project.id, '视频链接', '');

  await page.goto('/');
  await expectStatus(page, session.id, 'idle');
  await row(page, session.id).click();
  const input = pane(page, 0).locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type(`link ${path.join(dir, 'demo.mp4')} VIDEOLINK`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await termText(page, session.id)).split('\n').some((l) => l.startsWith('VIDEOLINK'))).toBe(true);

  const bufLines = (await termText(page, session.id)).split('\n');
  const screen = (await pane(page, 0).locator('.xterm-screen').boundingBox())!;
  const { cols, rows } = (await page.evaluate((id) => (window as any).__wbTermSize(id), session.id)) as { cols: number; rows: number };
  const r = bufLines.findIndex((l) => l.startsWith('VIDEOLINK')) - (bufLines.length - rows);
  await page.mouse.click(screen.x + 2.5 * (screen.width / cols), screen.y + (r + 0.5) * (screen.height / rows));

  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('insp-filepath')).toHaveText('demo.mp4');
  expect(await waitMetadata(insp.getByTestId('video-preview').locator('video'))).toBeCloseTo(3, 0);
  expect(openLogLines(path.basename(dir))).toHaveLength(0);

  await request.delete(`/api/tasks/${task.id}`);
  await request.delete(`/api/projects/${project.id}`);
});
