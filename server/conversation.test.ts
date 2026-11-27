import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Card, SessionInfo, Task } from '../shared/protocol.ts';
import { buildTaskConversation, collapseTurns } from './conversation.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('conversation builder', () => {
  it('collapses consecutive tool calls and caps tool lines', () => {
    const turns = [
      { role: 'user' as const, text: '修一下登录' },
      ...Array.from({ length: 25 }, (_, i) => ({ role: 'tool' as const, text: `read_file file-${i}.ts` })),
      { role: 'assistant' as const, text: '已修复。' },
    ];
    const items = collapseTurns(turns, 's1');
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ id: 's1-0', kind: 'user', text: '修一下登录' });
    expect(items[1]).toMatchObject({ id: 's1-tools-1', kind: 'tools', count: 25 });
    if (items[1].kind === 'tools') expect(items[1].tools).toHaveLength(20);
    expect(items[2]).toEqual({ id: 's1-26', kind: 'assistant', text: '已修复。' });
  });

  it('builds transcript conversation with handoff card and optimistic queued feedback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-conv-'));
    dirs.push(dir);
    const tp = path.join(dir, 'fake.jsonl');
    fs.writeFileSync(tp, [
      JSON.stringify({ role: 'user', text: '第一句需求' }),
      JSON.stringify({ role: 'assistant', text: '第一轮答复' }),
    ].join('\n'));

    const task: Task = {
      id: 't1',
      projectId: 'p1',
      title: '登录排查',
      prompt: '第一句需求',
      titleAuto: false,
      color: '#8baeda',
      agent: 'fake',
      sessionId: 's1',
      createdAt: 1000,
      phase: 'active',
      phaseSince: 1000,
    };
    const session: SessionInfo = {
      id: 's1',
      taskId: 't1',
      agent: 'fake',
      nativeSessionId: 'fake-s1',
      status: 'working',
      statusSince: 1000,
      startedAt: 1000,
      exitCode: null,
      cols: 120,
      rows: 40,
      transcriptPath: tp,
    };
    const cards: Card[] = [
      { id: 'c1', taskId: 't1', sessionId: 's1', kind: 'handoff', body: '交接内容', createdAt: 900, meta: { from: 'claude', to: 'fake' } },
      { id: 'c2', taskId: 't1', sessionId: 's1', kind: 'feedback', body: '补充看下日志', createdAt: 2000 },
    ];

    const res = buildTaskConversation({ task, session, cards, activity: null });
    expect(res.items.map(i => i.kind)).toEqual(['card', 'user', 'assistant', 'user']);
    expect(res.items[3]).toEqual({ id: 'card-c2', kind: 'user', text: '补充看下日志' });

    // Once c2 is already in the transcript followed by another terminal/forward turn, c2 must NOT reappear at the bottom!
    fs.writeFileSync(tp, [
      JSON.stringify({ role: 'user', text: '第一句需求' }),
      JSON.stringify({ role: 'assistant', text: '第一轮答复' }),
      JSON.stringify({ role: 'user', text: '补充看下日志' }),
      JSON.stringify({ role: 'assistant', text: '已看完日志' }),
      JSON.stringify({ role: 'user', text: '评审者回传结论' }),
      JSON.stringify({ role: 'assistant', text: '已处理评审意见' }),
    ].join('\n'));
    const resAfter = buildTaskConversation({ task, session: { ...session, status: 'needs_you' }, cards, activity: null });
    expect(resAfter.items.at(-1)).toMatchObject({ kind: 'assistant', text: '已处理评审意见' });
    expect(resAfter.items.filter(i => i.kind === 'user' && i.text === '补充看下日志')).toHaveLength(1);
  });

  it('falls back cleanly to task prompt and cards when no transcript exists', () => {
    const task: Task = {
      id: 't2',
      projectId: 'p1',
      title: '空记录任务',
      prompt: '初始化需求',
      titleAuto: false,
      color: '#8baeda',
      agent: 'claude',
      sessionId: null,
      createdAt: 1000,
      phase: 'review',
      phaseSince: 2000,
    };
    const cards: Card[] = [
      { id: 'c1', taskId: 't2', sessionId: 's0', kind: 'result', body: '完成初始化', createdAt: 1500 },
      { id: 'c2', taskId: 't2', sessionId: 's0', kind: 'feedback', body: '再加个测试', createdAt: 1800 },
    ];
    const res = buildTaskConversation({ task, session: undefined, cards, activity: null });
    expect(res.items).toEqual([
      { id: 'prompt-0', kind: 'user', text: '初始化需求' },
      { id: 'card-c1', kind: 'assistant', text: '完成初始化' },
      { id: 'card-c2', kind: 'user', text: '再加个测试' },
    ]);
  });
});
