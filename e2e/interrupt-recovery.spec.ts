// Server crash / restart recovery: auto-reconnects WebSocket, flags previously live resumable sessions, and resumes
// them back into their respective panes in one click (or dismisses cleanly).
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pane, row, termText, token } from './helpers.ts';

const OUT = path.resolve('.tmp/interrupt-recovery');
fs.mkdirSync(OUT, { recursive: true });

async function getFreePort(): Promise<number> {
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

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/state`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
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
    },
  });
}

async function hardKill(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
}

test('crashed server reconnects and one-click resumes all interrupted sessions into their panes', async ({ page }) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-crash-'));
  const projDir = path.join(stateDir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  let srv: ChildProcess | null = startServer(port, stateDir);

  try {
    await waitForServer(base);
    const postJson = async (p: string, body: unknown) => {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${p} -> ${res.status}: ${await res.text()}`);
      return res.json() as Promise<any>;
    };

    const project = await postJson('/api/projects', { name: token('crash'), path: projDir });
    const left = await postJson('/api/tasks', { projectId: project.id, title: '左屏会话', agent: 'fake', prompt: 'hello left', cols: 100, rows: 30 });
    const right = await postJson('/api/tasks', { projectId: project.id, title: '右屏会话', agent: 'fake', prompt: 'hello right', cols: 100, rows: 30 });
    // Blank session with no prompt submitted (resumable === false): must not inflate the banner count or crash batch resume.
    const blank = await postJson('/api/tasks', { projectId: project.id, title: '空白会话', agent: 'fake', prompt: '', cols: 100, rows: 30 });

    await page.goto(base);
    await expect(row(page, left.session.id)).toHaveAttribute('data-status', 'needs_you');
    await expect(row(page, right.session.id)).toHaveAttribute('data-status', 'needs_you');
    await expect(row(page, blank.session.id)).toHaveAttribute('data-status', 'idle');

    // Arrange left & right sessions in dual layout.
    await page.getByTestId('layout-2').click();
    await pane(page, 0).click();
    await row(page, left.session.id).click();
    await pane(page, 1).click();
    await row(page, right.session.id).click();
    await expect(pane(page, 0)).toHaveAttribute('data-session-id', left.session.id);
    await expect(pane(page, 1)).toHaveAttribute('data-session-id', right.session.id);

    // Simulate an abrupt server crash (e.g. process died) while the WebView page stays open, then watchdog restarts it.
    await hardKill(srv);
    srv = null;
    await expect(page.getByTestId('conn-banner')).toBeVisible();

    srv = startServer(port, stateDir);
    await waitForServer(base);

    // WebSocket auto-reconnects without closing the app, and shows the 2 resumable interrupted sessions.
    await expect(page.getByTestId('conn-banner')).toHaveCount(0, { timeout: 15_000 });
    const banner = page.getByTestId('interrupted-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('上次服务停止前有 2 个会话仍在运行');
    await page.screenshot({ path: path.join(OUT, 'interrupted-banner.png') });

    // One-click resume restores both conversations right back into pane 0 and pane 1.
    await page.getByTestId('resume-interrupted-btn').click();
    await expect(banner).toHaveCount(0);

    const newLeftSid = await pane(page, 0).getAttribute('data-session-id');
    const newRightSid = await pane(page, 1).getAttribute('data-session-id');
    expect(newLeftSid).toBeTruthy();
    expect(newRightSid).toBeTruthy();
    expect(newLeftSid).not.toBe(left.session.id);
    expect(newRightSid).not.toBe(right.session.id);

    await expect(row(page, newLeftSid!)).toHaveAttribute('data-status', 'idle');
    await expect(row(page, newRightSid!)).toHaveAttribute('data-status', 'idle');
    await expect.poll(() => termText(page, newLeftSid!)).toContain(`RESUMED fake-${left.session.id}`);
    await expect.poll(() => termText(page, newRightSid!)).toContain(`RESUMED fake-${right.session.id}`);
    await page.screenshot({ path: path.join(OUT, 'resumed-dual-panes.png') });

    // Second crash -> clicking 忽略 clears the interrupted banner and persists across page reloads.
    await hardKill(srv);
    srv = startServer(port, stateDir);
    await waitForServer(base);
    await expect(page.getByTestId('conn-banner')).toHaveCount(0, { timeout: 15_000 });
    await expect(banner).toContainText('上次服务停止前有 2 个会话仍在运行');
    await page.getByTestId('dismiss-interrupted-btn').click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(banner).toHaveCount(0);
  } finally {
    await hardKill(srv);
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
