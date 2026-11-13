import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsage, EVENTS_ROTATE_BYTES } from './usage.ts';
import type { UsageSource } from './usage.ts';
import { usageCacheHitRate, usageTotal, vendorOf } from '../shared/protocol.ts';
import type { AgentKind, Project, SessionInfo, Task } from '../shared/protocol.ts';

let dir: string;
let src: { sessions: SessionInfo[]; tasks: Task[]; projects: Project[] };
const source: UsageSource = { sessions: () => src.sessions, tasks: () => src.tasks, projects: () => src.projects };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-'));
  src = { sessions: [], tasks: [], projects: [{ id: 'p1', name: '项目一', path: dir, createdAt: 0 }] };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-01T10:00:00Z');
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const lines = (...v: unknown[]) => v.map(x => JSON.stringify(x) + '\n').join('');
const write = (name: string, text: string) => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, text);
  return f;
};
const event = (o: Record<string, unknown>) => write('events.jsonl', lines(o));
const hook = (sessionId: string, agent: AgentKind, at: number, payload: Record<string, unknown>) =>
  event({ kind: 'hook', sessionId, agent, event: 'UserPromptSubmit', at, payload });

function addTask(id: string, title: string, sessionId: string, agent: AgentKind, startedAt: number, status: SessionInfo['status'] = 'working') {
  src.tasks.push({ id, projectId: 'p1', title, titleAuto: false, prompt: '', color: '#fff', agent, sessionId, createdAt: startedAt, phase: 'active', phaseSince: startedAt });
  src.sessions.push({ id: sessionId, taskId: id, agent, nativeSessionId: null, status, statusSince: startedAt, startedAt, exitCode: null, cols: 80, rows: 24 });
}

const claudeLine = (id: string, t: number, u: Record<string, unknown>, model = 'claude-opus-5-5') =>
  ({ type: 'assistant', timestamp: iso(t), requestId: 'r-' + id, message: { id, model, usage: u } });

describe('usage', () => {
  it('counts a claude conversation once per message, including subagent files, and maps the vendor', () => {
    addTask('t1', '修登录', 's1', 'claude', T0);
    const f = write('claude/abc.jsonl', lines(
      claudeLine('m1', T0 + MIN, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } }),
      claudeLine('m1', T0 + MIN, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }), // same message, next content block
      { type: 'user', timestamp: iso(T0 + 2 * MIN), message: { content: 'hi' } },
      claudeLine('syn', T0 + 2 * MIN, { input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
    ));
    write('claude/abc/subagents/agent-1.jsonl', lines(claudeLine('m2', T0 + 3 * MIN, { input_tokens: 5, output_tokens: 7 }, 'claude-haiku-5-5')));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f, model: 'claude-opus-5-5' });

    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.total).toEqual({ input: 15, cacheWrite: 100, cacheRead: 1000, output: 57, reasoning: 20, requests: 2 });
    expect(r.byModel.map(m => [m.label, m.vendor, usageTotal(m)])).toEqual([['claude-opus-5-5', 'Anthropic', 1160], ['claude-haiku-5-5', 'Anthropic', 12]]);
    expect(r.byTask).toMatchObject([{ key: 't1', label: '修登录', project: '项目一', deleted: false, agents: ['claude'] }]);
  });

  it('normalizes codex usage: cached input is split out, token_count duplicates of records are skipped, old files fall back to token_count', () => {
    addTask('t1', '新格式', 's1', 'codex', T0);
    addTask('t2', '旧格式', 's2', 'codex', T0);
    const usage = { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 30, total_tokens: 1040 };
    const fresh = write('codex/new.jsonl', lines(
      { timestamp: iso(T0 + MIN), type: 'turn_context', payload: { turn_id: 'a', model: 'codeplan/gpt-6.1-sol' } },
      { timestamp: iso(T0 + MIN), type: 'token_usage_record', payload: { response_id: 'resp1', usage } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
    ));
    const old = write('codex/old.jsonl', lines(
      { timestamp: iso(T0 + MIN), type: 'turn_context', payload: { model: 'gpt-5' } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: null } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 1040 } } } },
      { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 1040 } } } },
      { timestamp: iso(T0 + 2 * MIN), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { total_tokens: 2080 } } } },
    ));
    hook('s1', 'codex', T0 + 10_000, { transcript_path: '\\\\?\\' + fresh, model: 'codeplan/gpt-6.1-sol' });
    hook('s2', 'codex', T0 + 10_000, { transcript_path: old });

    const r = createUsage({ stateDir: dir, source }).report(null, null);
    const byTask = Object.fromEntries(r.byTask.map(t => [t.label, t]));
    expect(byTask['新格式']).toMatchObject({ input: 200, cacheRead: 800, output: 40, reasoning: 30, requests: 1 });
    expect(byTask['旧格式']).toMatchObject({ input: 400, cacheRead: 1600, output: 80, requests: 2 });
    expect(r.byModel.map(m => [m.label, m.vendor])).toEqual([['gpt-5', 'OpenAI'], ['codeplan/gpt-6.1-sol', 'OpenAI']]);
  });

  it('takes the agy model from hooks and keeps cache reads separate from input', () => {
    addTask('t1', 'agy 任务', 's1', 'agy', T0);
    const f = write('agy/transcript_full.jsonl', lines(
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: iso(T0 + MIN), input_tokens: 300, cache_read_tokens: 2000, output_tokens: 20 },
      { step_index: 2, type: 'USER_INPUT', created_at: iso(T0 + 2 * MIN), content: 'x' },
    ));
    hook('s1', 'agy', T0 + 10_000, { transcriptPath: f, modelName: 'gemini-3.8-flash-high', conversationId: 'c1' });
    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.total).toMatchObject({ input: 300, cacheRead: 2000, output: 20, requests: 1 });
    expect(r.byVendor.map(v => v.label)).toEqual(['Google']);
  });

  it('reads only what was appended, waits for a line to be complete, and ignores turns outside the workbench run', () => {
    addTask('t1', '续写', 's1', 'claude', T0);
    const f = write('claude/c.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 1, output_tokens: 1 })));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f });
    let now = T0 + 5 * MIN;
    const u = createUsage({ stateDir: dir, source, now: () => now });
    u.scan();
    expect(u.report(null, null).total.requests).toBe(1);

    const next = JSON.stringify(claudeLine('m2', T0 + 6 * MIN, { input_tokens: 2, output_tokens: 2 }));
    write('claude/c.jsonl', next.slice(0, 20)); // the CLI is mid-write
    now += 10_000;
    expect(u.report(null, null).total.requests).toBe(1);
    write('claude/c.jsonl', next.slice(20) + '\n');
    now += 10_000;
    expect(u.report(null, null).total).toMatchObject({ input: 3, output: 3, requests: 2 });

    // The session exits; the conversation is later resumed in a plain terminal.
    event({ kind: 'exit', sessionId: 's1', agent: 'claude', exitCode: 0, at: T0 + 7 * MIN });
    src.sessions[0].status = 'exited';
    write('claude/c.jsonl', lines(claudeLine('m3', T0 + 60 * MIN, { input_tokens: 99, output_tokens: 99 })));
    now += 10_000;
    expect(u.report(null, null).total.requests).toBe(2);
  });

  it('keeps totals and the title of a deleted task across restarts, and filters by hour', () => {
    addTask('t1', '已经删掉的任务', 's1', 'claude', T0);
    const f = write('claude/d.jsonl', lines(
      claudeLine('m1', T0 + MIN, { input_tokens: 10, output_tokens: 10 }),
      claudeLine('m2', T0 + 3 * 60 * MIN, { input_tokens: 1, output_tokens: 1 }),
    ));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f });
    createUsage({ stateDir: dir, source }).scan();
    src = { sessions: [], tasks: [], projects: [] }; // task and project deleted, transcript cleaned up by the CLI
    fs.rmSync(f);

    const u = createUsage({ stateDir: dir, source });
    const all = u.report(null, null);
    expect(all.byTask).toMatchObject([{ label: '已经删掉的任务', project: '项目一', deleted: true, input: 11 }]);
    expect(all.byProject).toMatchObject([{ label: '项目一', deleted: true }]);
    expect(all.since).toBe(T0);
    expect(all.hours.map(h => h.t)).toEqual([T0, T0 + 3 * 60 * MIN]);
    expect(u.report(T0 + 60 * MIN, null).total.input).toBe(1);
    expect(u.report(T0, T0 + 60 * MIN).total.input).toBe(10);
    expect(u.report(T0 + 4 * 60 * MIN, null).total.requests).toBe(0);
  });

  it('scans a finished session once more after it settles, then skips it until it shows up again', () => {
    addTask('t1', '旧任务', 's1', 'claude', T0, 'exited');
    const f = write('claude/d.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 1, output_tokens: 1 })));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f });
    event({ kind: 'exit', sessionId: 's1', agent: 'claude', exitCode: 0, at: T0 + 5 * MIN });
    let now = T0 + 3 * 60 * MIN; // long settled already: the first scan still counts it (an upgrade or a rebuilt usage.json)
    const u = createUsage({ stateDir: dir, source, now: () => now });
    u.scan();
    expect(u.report(null, null).total.requests).toBe(1);

    // Skipped now: a line that falls inside its run is not read...
    write('claude/d.jsonl', lines(claudeLine('m2', T0 + 2 * MIN, { input_tokens: 2, output_tokens: 2 })));
    now += 10 * MIN;
    expect(u.report(null, null).total.requests).toBe(1);
    // ...until the session is active again (resumed under the same id): then the file is read on from where it stopped.
    hook('s1', 'claude', now, { transcript_path: f });
    now += 10 * MIN;
    expect(u.report(null, null).total).toMatchObject({ input: 3, requests: 2 });
  });

  it('moves a fully read events.jsonl aside once it is large and reads the new one from the start', () => {
    addTask('t1', '大日志', 's1', 'claude', T0);
    const f = write('claude/r.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 1, output_tokens: 1 })));
    hook('s1', 'claude', T0 + 10_000, { transcript_path: f, pad: 'x'.repeat(EVENTS_ROTATE_BYTES) });
    let now = T0 + 5 * MIN;
    const u = createUsage({ stateDir: dir, source, now: () => now });
    u.scan();
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(false);
    expect(fs.statSync(path.join(dir, 'events.1.jsonl')).size).toBeGreaterThan(EVENTS_ROTATE_BYTES);

    // A session known only from the new file is still found, and nothing already counted is counted twice.
    const g = write('claude/r2.jsonl', lines(claudeLine('m2', T0 + 6 * MIN, { input_tokens: 2, output_tokens: 2 })));
    hook('gone', 'claude', T0 + 5 * MIN, { transcript_path: g });
    now += 10 * MIN;
    expect(u.report(null, null).total).toMatchObject({ input: 3, requests: 2 });
    expect(createUsage({ stateDir: dir, source, now: () => now }).report(null, null).total).toMatchObject({ input: 3, requests: 2 });
  });

  it('attributes sessions known only from events.jsonl to an unknown task', () => {
    const f = write('claude/e.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 4, output_tokens: 4 })));
    hook('gone', 'claude', T0, { transcript_path: f });
    const r = createUsage({ stateDir: dir, source }).report(null, null);
    expect(r.byTask).toMatchObject([{ key: '', deleted: true, input: 4 }]);
  });

  it.each(['restart', 'retry'] as const)('keeps events recoverable when persistence fails at rotation (%s)', (recovery) => {
    const f = write('claude/recover.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 11, output_tokens: 7 })));
    hook('gone', 'claude', T0, { transcript_path: f, pad: 'x'.repeat(EVENTS_ROTATE_BYTES) });
    const blocked = path.join(dir, 'usage.json.tmp');
    fs.mkdirSync(blocked);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = createUsage({ stateDir: dir, source, now: () => T0 + 10 * MIN });
    u.scan();
    expect(errors).toHaveBeenCalled();
    expect(u.report(null, null).total.requests).toBe(1);
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'events.1.jsonl'))).toBe(false);
    fs.rmdirSync(blocked);
    const recovered = recovery === 'retry' ? u : createUsage({ stateDir: dir, source, now: () => T0 + 10 * MIN });
    recovered.scan();
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).eventsOffset).toBe(0);
    fs.rmSync(f); // no transcript left to rebuild lost totals from
    expect(createUsage({ stateDir: dir, source }).report(null, null).total).toMatchObject({ input: 11, requests: 1 });
  });

  it('retries an unchanged usage checkpoint after a failed save', () => {
    const f = write('claude/retry.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 3 })));
    hook('gone', 'claude', T0, { transcript_path: f });
    const blocked = path.join(dir, 'usage.json.tmp');
    fs.mkdirSync(blocked);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = createUsage({ stateDir: dir, source });
    u.scan();
    fs.rmdirSync(blocked);
    u.scan();
    fs.rmSync(f);
    fs.rmSync(path.join(dir, 'events.jsonl'));
    expect(createUsage({ stateDir: dir, source }).report(null, null).total.requests).toBe(1);
  });

  it('can replay the old event file after a failed rename without duplicating usage', () => {
    const f = write('claude/rename.jsonl', lines(claudeLine('m1', T0 + MIN, { input_tokens: 3 })));
    const eventsFile = hook('gone', 'claude', T0, { transcript_path: f, pad: 'x'.repeat(EVENTS_ROTATE_BYTES) });
    const rename = fs.renameSync;
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === eventsFile) throw new Error('simulated rename failure');
      rename(from, to);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    createUsage({ stateDir: dir, source }).scan();
    expect(fs.existsSync(eventsFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).eventsOffset).toBe(0);
    fail.mockRestore();
    expect(createUsage({ stateDir: dir, source }).report(null, null).total.requests).toBe(1);
    expect(fs.existsSync(eventsFile)).toBe(false);
  });

  it.each(['main', 'subagent', 'partial'] as const)('retries a settled session until its %s transcript is fully read', (failure) => {
    const body = lines(claudeLine('m1', T0 + MIN, { input_tokens: 5, output_tokens: 2 }));
    const main = write('claude/settled.jsonl', failure === 'main' ? '' : failure === 'partial' ? body.slice(0, 20) : '');
    const target = failure === 'subagent' ? write('claude/settled/subagents/agent-1.jsonl', body) : main;
    hook('gone', 'claude', T0, { transcript_path: main });
    event({ kind: 'exit', sessionId: 'gone', agent: 'claude', at: T0 + 5 * MIN });
    const open = fs.openSync;
    const fail = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (failure !== 'partial' && file === target) throw new Error('temporarily unavailable');
      return open(file, flags, mode);
    });
    const u = createUsage({ stateDir: dir, source });
    u.scan();
    expect(u.report(null, null).total.requests).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).sessions.gone.done).not.toBe(true);
    fail.mockRestore();
    if (failure !== 'subagent') write('claude/settled.jsonl', failure === 'partial' ? body.slice(20) : body);
    // Restart without new hook events: only persisted retry state can discover the recovered file.
    const restarted = createUsage({ stateDir: dir, source });
    expect(restarted.report(null, null).total).toMatchObject({ input: 5, requests: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).sessions.gone.done).toBe(true);
  });

  it('infers the vendor from the model name before the CLI', () => {
    expect(vendorOf('deepseek-v4', 'claude')).toBe('DeepSeek');
    expect(vendorOf('codeplan/gpt-6.1-sol', 'codex')).toBe('OpenAI');
    expect(vendorOf('o4-mini', 'codex')).toBe('OpenAI');
    expect(vendorOf('', 'agy')).toBe('Google');
    expect(vendorOf('my-model', 'claude')).toBe('Anthropic');
  });

  it('computes live per-task telemetry (tokens, cache hit rate, and tok/s speed) and survives restart', () => {
    // Use local today timestamps relative to T0 and set `now` to T0 + 10m so todayStart aligns.
    const d0 = new Date(T0);
    d0.setHours(0, 0, 0, 0);
    const nowAt = d0.getTime() + 12 * 3_600_000;
    addTask('t1', '测速度', 's1', 'claude', nowAt - 60_000);
    const cf = write('claude/speed.jsonl', lines(
      { type: 'user', timestamp: iso(nowAt - 10_000), message: { content: 'go' } },
      claudeLine('m1', nowAt - 8_000, { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 200 }),
      { type: 'user', timestamp: iso(nowAt - 6_000), message: { content: 'next' } },
      claudeLine('m2', nowAt - 4_000, { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 400 }),
    ));
    hook('s1', 'claude', nowAt - 55_000, { transcript_path: cf });

    addTask('t2', 'agy 速度', 's2', 'agy', nowAt - 60_000);
    const af = write('agy/speed.jsonl', lines(
      { step_index: 1, type: 'USER_INPUT', created_at: iso(nowAt - 2_000), content: 'hi' },
      // Same-second response clamps to 1s so coarse 1s timestamps never explode to Infinity.
      { step_index: 2, type: 'PLANNER_RESPONSE', created_at: iso(nowAt - 2_000), input_tokens: 50, cache_read_tokens: 450, output_tokens: 120 },
    ));
    hook('s2', 'agy', nowAt - 55_000, { transcriptPath: af, modelName: 'gemini-4-carbon-medium', conversationId: 'c2' });

    const tel = createUsage({ stateDir: dir, source, now: () => nowAt }).telemetry();
    expect(tel.byTask.t1).toMatchObject({ input: 200, cacheRead: 1800, output: 600, requests: 2, tps: 150 });
    expect(usageCacheHitRate(tel.byTask.t1)).toBeCloseTo(0.9, 4);
    expect(tel.byTask.t2).toMatchObject({ input: 50, cacheRead: 450, output: 120, requests: 1, tps: 120 });
    expect(tel.today).toMatchObject({ input: 250, cacheRead: 2250, output: 720, requests: 3, tps: 120 });

    const restarted = createUsage({ stateDir: dir, source, now: () => nowAt }).telemetry();
    expect(restarted.byTask.t1.tps).toBe(150);
    expect(restarted.today.requests).toBe(3);
  });
});
