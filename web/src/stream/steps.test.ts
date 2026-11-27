import { describe, expect, it } from 'vitest';
import type { StreamBlock, StreamToolEntry } from '../../../shared/protocol.ts';
import { buildFlow, classifyTool, formatStepSummary, summarizeStepGroup, windowFlow, type StepBlock } from './steps.ts';

const tool = (name: string, status: StreamToolEntry['status'] = 'done'): StreamToolEntry => ({
  id: `${name}-${Math.random()}`,
  name,
  summary: name,
  status,
});

const step = (id: string, tools: StreamToolEntry[], o: Partial<StepBlock> = {}): StepBlock => ({
  id,
  kind: 'step',
  tools,
  ...o,
});
const user = (id: string, extra: Partial<Extract<StreamBlock, { kind: 'user' }>> = {}): StreamBlock => ({ id, kind: 'user', text: id, ...extra });
const asst = (id: string): StreamBlock => ({ id, kind: 'assistant', text: id });

describe('classifyTool', () => {
  it('maps common CLI tool names onto read / command / edit', () => {
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('grep_search')).toBe('read');
    expect(classifyTool('Bash')).toBe('command');
    expect(classifyTool('run_command')).toBe('command');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('update_steps')).toBe('other');
  });
});

describe('summarizeStepGroup / formatStepSummary', () => {
  it('counts steps, kinds, failures and takes the longer of thinking time and wall span', () => {
    const blocks = [
      step('a', [tool('Read'), tool('Read'), tool('Bash')], { thinkingSec: 4, at: 1_000 }),
      step('b', [tool('Edit'), tool('Bash', 'error')], { thinkingSec: 3, at: 11_000 }),
    ];
    const s = summarizeStepGroup(blocks);
    expect(s).toEqual({ steps: 5, reads: 2, commands: 2, edits: 1, failed: 1, durationSec: 10 });
    expect(formatStepSummary(s)).toBe('思考与执行 · 5 步 · 读取 2 个文件 · 运行 2 次命令 · 编辑 1 处 · 1 处失败 · 10s');
  });

  it('counts a thinking-only block as one step and omits zero parts', () => {
    const s = summarizeStepGroup([step('a', [], { thinking: 'hmm' })]);
    expect(s.steps).toBe(1);
    expect(formatStepSummary(s)).toBe('思考与执行 · 1 步');
  });
});

describe('buildFlow', () => {
  it('collapses every finished step run of an OLDER turn, even a single step', () => {
    const items = buildFlow([user('u1'), step('s1', [tool('Read')]), asst('a1'), user('u2'), asst('a2')]);
    expect(items.map((i) => i.type)).toEqual(['block', 'steps', 'block', 'block', 'block']);
  });

  it('keeps a lone finished step of the latest turn expanded', () => {
    const items = buildFlow([user('u1'), step('s1', [tool('Read')]), asst('a1')]);
    expect(items.map((i) => i.type)).toEqual(['block', 'block', 'block']);
  });

  it('collapses >= 2 consecutive finished steps inside the latest turn but never the active one', () => {
    const items = buildFlow([
      user('u1'),
      step('s1', [tool('Read')]),
      step('s2', [tool('Bash')]),
      step('s3', [tool('Edit')], { active: true }),
    ]);
    expect(items.map((i) => i.type)).toEqual(['block', 'steps', 'block']);
    const group = items[1];
    expect(group.type === 'steps' && group.blocks.map((b) => b.id)).toEqual(['s1', 's2']);
    expect(items[2].type === 'block' && items[2].block.id).toBe('s3');
  });

  it('a queued (pending) user bubble does not start a new turn', () => {
    const items = buildFlow([user('u1'), step('s1', [tool('Read')]), user('q1', { pending: 'queued' })]);
    expect(items.map((i) => i.type)).toEqual(['block', 'block', 'block']);
  });

  it('keeps the flow flat and ending with the assistant reply', () => {
    const items = buildFlow([user('u1'), step('s1', []), step('s2', []), asst('a1')]);
    const last = items[items.length - 1];
    expect(last.type === 'block' && last.block.kind).toBe('assistant');
  });
});

describe('windowFlow', () => {
  const items = buildFlow(Array.from({ length: 130 }, (_, i) => asst(`a${i}`)));
  it('shows only the newest N and reports how many are hidden', () => {
    const w = windowFlow(items, 60);
    expect(w.items).toHaveLength(60);
    expect(w.hidden).toBe(70);
    expect(w.items[0].id).toBe('a70');
    expect(w.items.at(-1)?.id).toBe('a129');
  });
  it('shows everything once the limit covers the list', () => {
    expect(windowFlow(items, 180)).toEqual({ items, hidden: 0 });
  });
});
