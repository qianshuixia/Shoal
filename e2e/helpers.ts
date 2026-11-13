import { expect, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Project, SessionInfo, SessionStatus, Snapshot, Task } from '../shared/protocol.ts';

export const FAKE_LOG = path.resolve('.tmp/m1/fake-agent.jsonl');
export const SANDBOX = path.resolve('.tmp/m1/sandbox');

export async function state(request: APIRequestContext): Promise<Snapshot> {
  const res = await request.get('/api/state');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function removeAllTasks(request: APIRequestContext) {
  for (const t of (await state(request)).tasks) await request.delete(`/api/tasks/${t.id}`);
}

export async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  const res = await request.post('/api/projects', { data: { name, path: dir } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

export async function createFakeTask(request: APIRequestContext, projectId: string, title: string, prompt = '') {
  const res = await request.post('/api/tasks', { data: { projectId, title, agent: 'fake', prompt, cols: 120, rows: 30 } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { task: Task; session: SessionInfo };
}

export const row = (page: Page, sessionId: string) =>
  page.locator(`[data-testid="task-row"][data-session-id="${sessionId}"]`);

export const pane = (page: Page, index: number) =>
  page.locator(`[data-testid="pane"][data-pane-index="${index}"]`);

/** Opens the floating 待验收 popover of a pane and returns it. */
export async function openReview(page: Page, index = 0) {
  const p = pane(page, index);
  const pop = p.getByTestId('review-popover');
  if (!(await pop.count())) await p.getByTestId('review-toggle').click();
  await expect(pop).toBeVisible();
  return pop;
}

export async function expectStatus(page: Page, sessionId: string, status: SessionStatus, timeout = 15_000) {
  await expect(row(page, sessionId)).toHaveAttribute('data-status', status, { timeout });
}

/** Lines the fake agent received as submitted input, per workbench session id. */
export function fakeLines(sessionId: string): string[] {
  if (!fs.existsSync(FAKE_LOG)) return [];
  return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { sessionId: string; line: string })
    .filter(e => e.sessionId === sessionId).map(e => e.line);
}

export function allFakeEntries(): { sessionId: string; line: string }[] {
  if (!fs.existsSync(FAKE_LOG)) return [];
  return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export const termText = (page: Page, sessionId: string) =>
  page.evaluate(id => (window as any).__wbTermText(id) as string, sessionId);

export const token = (label: string) => `${label}-${Math.random().toString(36).slice(2, 8)}`;
