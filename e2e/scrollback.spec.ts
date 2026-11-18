// Terminal output kept on disk: an exited session (or one Shoal shut down) still shows its output after a restart,
// a session with no saved output shows its last reply and the CLI transcript, and deleting the task deletes the file.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pane, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/agy-trust/e2e-scrollback');
fs.mkdirSync(OUT, { recursive: true });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/state`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server at ${base} did not start`);
}

function startServer(port: number, stateDir: string): ChildProcess {
  return spawn(process.execPath, ['server/main.ts', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WORKBENCH_FAKE_AGENT: '1',
      WORKBENCH_STATE_DIR: stateDir,
      FAKE_AGENT_LOG: path.join(stateDir, 'fake.jsonl'),
      WORKBENCH_OPEN_LOG: path.join(stateDir, 'open-log.jsonl'),
      WORKBENCH_EDITOR: 'C:\\fake\\Code.exe',
    },
  });
}

const exited = (proc: ChildProcess) => new Promise<void>((resolve) => {
  if (proc.exitCode !== null) resolve();
  else proc.once('exit', () => resolve());
});

test('exited and shut-down sessions keep their terminal output across a restart; deleting the task deletes it', async ({ page }) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-scroll-'));
  const projDir = path.join(stateDir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const scroll = path.join(stateDir, 'scrollback');
  let srv: ChildProcess = startServer(port, stateDir);
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: body === undefined ? { origin: base } : { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  try {
    await waitForServer(base);
    const project = await api('POST', '/api/projects', { name: token('scroll'), path: projDir });
    const tokA = token('exited');
    const tokB = token('running');
    const tokC = token('legacy');
    const a = await api('POST', '/api/tasks', { projectId: project.id, title: '已退出', agent: 'fake', prompt: tokA, cols: 100, rows: 30 });
    const b = await api('POST', '/api/tasks', { projectId: project.id, title: '关机时还在跑', agent: 'fake', prompt: tokB, cols: 100, rows: 30 });
    const c = await api('POST', '/api/tasks', { projectId: project.id, title: '没有保存的输出', agent: 'fake', prompt: tokC, cols: 100, rows: 30 });

    await page.goto(base);
    for (const t of [a, b, c]) await expect(row(page, t.session.id)).toHaveAttribute('data-status', 'needs_you');

    // A and C exit; their output is written on exit. B is still running when Shoal shuts down.
    for (const t of [a, c]) {
      await row(page, t.session.id).click();
      await pane(page, 0).locator('.term-host').click();
      await page.keyboard.type('exit 0\r');
      await expect(row(page, t.session.id)).toHaveAttribute('data-status', 'exited');
    }
    await expect.poll(() => fs.existsSync(path.join(scroll, `${a.session.id}.log`))).toBe(true);
    expect(fs.existsSync(path.join(scroll, `${c.session.id}.log`))).toBe(true);

    await api('POST', '/api/shutdown', {});
    await exited(srv);
    expect(fs.readFileSync(path.join(scroll, `${b.session.id}.log`), 'utf8')).toContain(`reply: ${tokB}`);

    // C stands for a session from before output was kept; a stray file belongs to no session.
    fs.rmSync(path.join(scroll, `${c.session.id}.log`));
    fs.writeFileSync(path.join(scroll, 'stray-session.log'), 'old');

    srv = startServer(port, stateDir);
    await waitForServer(base);
    await page.reload();
    expect(fs.existsSync(path.join(scroll, 'stray-session.log'))).toBe(false);

    await row(page, a.session.id).click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', a.session.id);
    await expect.poll(() => termText(page, a.session.id)).toContain(`reply: ${tokA}`);
    await expect(pane(page, 0).getByTestId('pane-exited')).toBeVisible();
    await expect(pane(page, 0).getByTestId('pane-exited-summary')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'exited-after-restart.png') });

    await row(page, b.session.id).click();
    await expect.poll(() => termText(page, b.session.id)).toContain(`reply: ${tokB}`);

    // No saved output: the last reply and the CLI's transcript instead of an empty terminal.
    await row(page, c.session.id).click();
    const summary = pane(page, 0).getByTestId('pane-exited-summary');
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId('pane-exited-reply')).toContainText(tokC);
    await page.screenshot({ path: path.join(OUT, 'no-saved-output.png') });
    const snap = await api('GET', '/api/state');
    const transcript: string = snap.sessions.find((s: { id: string }) => s.id === c.session.id).transcriptPath;
    expect(transcript).toBeTruthy();
    await summary.getByTestId('pane-open-transcript').click();
    await expect.poll(() => fs.existsSync(path.join(stateDir, 'open-log.jsonl')) && fs.readFileSync(path.join(stateDir, 'open-log.jsonl'), 'utf8')).toContain(path.basename(transcript));

    // Back to A: its terminal is still filled, the summary does not leak across panes' sessions.
    await row(page, a.session.id).click();
    await expect(pane(page, 0).getByTestId('pane-exited-summary')).toHaveCount(0);

    await api('DELETE', `/api/tasks/${a.task.id}`);
    await expect.poll(() => fs.existsSync(path.join(scroll, `${a.session.id}.log`))).toBe(false);
    expect(fs.existsSync(path.join(scroll, `${b.session.id}.log`))).toBe(true);
  } finally {
    if (srv.exitCode === null) {
      srv.kill('SIGKILL');
      await exited(srv);
    }
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
