import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from './store.ts';
import { CARDS_PER_TASK } from '../shared/protocol.ts';
import type { Card, SessionInfo } from '../shared/protocol.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  file = path.join(dir, 'state.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const session = (id: string, taskId: string, status: SessionInfo['status']): SessionInfo => ({
  id, taskId, agent: 'fake', nativeSessionId: 'native-' + id, status, statusSince: 1, startedAt: 1, exitCode: null, cols: 80, rows: 24,
});
const task = (id: string) => ({
  id, projectId: 'p1', title: 't', titleAuto: false, prompt: '', color: '#fff', agent: 'fake' as const, sessionId: 's-' + id, createdAt: 1,
  phase: 'active' as const, phaseSince: 1,
});
const card = (id: string, taskId: string): Card => ({ id, taskId, sessionId: 's-' + taskId, kind: 'result', body: id, createdAt: 1 });

describe('file store', () => {
  it('round-trips projects, tasks and sessions; removing a task drops its sessions', () => {
    const a = createFileStore(file);
    a.addProject({ id: 'p1', name: 'P', path: dir, createdAt: 1 });
    a.addTask(task('t1'));
    a.addTask(task('t2'));
    a.saveSession(session('s-t1', 't1', 'exited'));
    a.saveSession(session('s-t2', 't2', 'exited'));
    a.removeTask('t2');
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    const b = createFileStore(file);
    expect(b.projects()).toHaveLength(1);
    expect(b.tasks().map(t => t.id)).toEqual(['t1']);
    expect(b.sessions().map(s => s.id)).toEqual(['s-t1']);
  });

  it('marks non-exited sessions as exited + interrupted on load and keeps nativeSessionId', () => {
    const a = createFileStore(file);
    a.addTask(task('t1'));
    a.addTask(task('t2'));
    a.saveSession(session('s-t1', 't1', 'working'));
    a.saveSession(session('s-t2', 't2', 'exited'));
    const loaded = createFileStore(file).sessions();
    const s1 = loaded.find(x => x.id === 's-t1')!;
    const s2 = loaded.find(x => x.id === 's-t2')!;
    expect(s1.status).toBe('exited');
    expect(s1.interrupted).toBe(true);
    expect(s1.exitCode).toBeNull();
    expect(s1.statusSince).toBeGreaterThan(1);
    expect(s1.nativeSessionId).toBe('native-s-t1');
    expect(s2.interrupted).toBeUndefined();
  });

  it('keeps a corrupt file as state.json.corrupt-* and starts empty', () => {
    fs.writeFileSync(file, '{ not json');
    const s = createFileStore(file);
    expect(s.projects()).toEqual([]);
    const kept = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe('{ not json');
  });

  it('migrates legacy colors (case-insensitive) and missing titleAuto, writing back once', () => {
    const legacy = { ...task('t1'), color: '#4F9DFF' } as Record<string, unknown>;
    delete legacy.titleAuto;
    const other = { ...task('t2'), color: '#123456' };
    const last = { ...task('t3'), color: '#d4b106' };
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [], tasks: [legacy, other, last], sessions: [] }));
    const s = createFileStore(file);
    expect(s.getTask('t1')).toMatchObject({ color: '#8baeda', titleAuto: false });
    expect(s.getTask('t2')!.color).toBe('#123456');
    expect(s.getTask('t3')!.color).toBe('#adaf78');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.tasks.map((x: { color: string; titleAuto: boolean }) => [x.color, x.titleAuto]))
      .toEqual([['#8baeda', false], ['#123456', false], ['#adaf78', false]]);
  });

  it('cleans placeholder titles on load, keeping the original file aside', () => {
    const before = JSON.stringify({ version: 1, projects: [], sessions: [], tasks: [
      { ...task('t1'), title: '[Image #1] 偶现 战斗开…' },
      { ...task('t2'), title: '手动起的名字' },
      { ...task('t3'), title: 'C:\\Users\\Administrat…' },
    ] });
    fs.writeFileSync(file, before);
    const s = createFileStore(file);
    expect(s.tasks().map(t => t.title)).toEqual(['偶现 战斗开…', '手动起的名字', 'C:\\Users\\Administrat…']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].title).toBe('偶现 战斗开…');
    expect(fs.readFileSync(file + '.before-title-cleanup', 'utf8')).toBe(before);
    createFileStore(file); // nothing left to clean: no second backup, no rewrite needed
    expect(fs.readFileSync(file + '.before-title-cleanup', 'utf8')).toBe(before);
  });

  it('keeps the newest CARDS_PER_TASK cards per task, persists them, and drops them with the task', () => {
    const a = createFileStore(file);
    a.addTask(task('t1'));
    a.addTask(task('t2'));
    a.addCard(card('other', 't2'));
    for (let i = 0; i < CARDS_PER_TASK + 3; i++) a.addCard(card('c' + i, 't1'));
    const mine = createFileStore(file).cards().filter(c => c.taskId === 't1').map(c => c.id);
    expect(mine).toHaveLength(CARDS_PER_TASK);
    expect(mine[0]).toBe('c3');
    expect(mine.at(-1)).toBe('c' + (CARDS_PER_TASK + 2));
    expect(a.cards().filter(c => c.taskId === 't2')).toHaveLength(1);
    a.removeTask('t1');
    expect(createFileStore(file).cards().map(c => c.id)).toEqual(['other']);
  });

  it('removeProject drops only that project\'s tasks, sessions and cards, in a single save', () => {
    const a = createFileStore(file);
    a.addProject({ id: 'p1', name: 'P1', path: dir, createdAt: 1 });
    a.addProject({ id: 'p2', name: 'P2', path: dir, createdAt: 1 });
    a.addTask(task('t1'));
    a.addTask(task('t2'));
    a.addTask({ ...task('t3'), projectId: 'p2' });
    for (const id of ['t1', 't2', 't3']) {
      a.saveSession(session('s-' + id, id, 'exited'));
      a.addCard(card('c-' + id, id));
    }
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      a.removeProject('p1');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const b = createFileStore(file);
    expect(b.projects().map(p => p.id)).toEqual(['p2']);
    expect(b.tasks().map(t => t.id)).toEqual(['t3']);
    expect(b.sessions().map(s => s.id)).toEqual(['s-t3']);
    expect(b.cards().map(c => c.id)).toEqual(['c-t3']);
  });

  it('loads state saved before M2: tasks get phase active, cards default to empty, queued is dropped', () => {
    const old = { ...task('t1'), createdAt: 42 } as Record<string, unknown>;
    delete old.phase;
    delete old.phaseSince;
    const sess = { ...session('s-t1', 't1', 'exited'), queued: 2 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [], tasks: [old], sessions: [sess] }));
    const s = createFileStore(file);
    expect(s.getTask('t1')).toMatchObject({ phase: 'active', phaseSince: 42 });
    expect(s.cards()).toEqual([]);
    expect(s.sessions()[0]).not.toHaveProperty('queued');
  });

  it('settings default to aiTitles off, survive a reload, and fall back to the default for missing or invalid values', () => {
    const a = createFileStore(file);
    expect(a.settings()).toEqual({ aiTitles: false });
    a.setSettings({ aiTitles: true });
    expect(createFileStore(file).settings()).toEqual({ aiTitles: true });
    const base = { version: 1, projects: [], tasks: [], sessions: [] };
    fs.writeFileSync(file, JSON.stringify(base));
    expect(createFileStore(file).settings()).toEqual({ aiTitles: false });
    fs.writeFileSync(file, JSON.stringify({ ...base, settings: { aiTitles: 'yes' } }));
    expect(createFileStore(file).settings()).toEqual({ aiTitles: false });
  });
});
