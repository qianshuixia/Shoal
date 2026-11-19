import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity, SessionInfo } from '../shared/protocol.ts';
import { AGY_MODELS, isValidAgyModel } from '../shared/protocol.ts';
import { createActivityTracker, summarizeToolCall, unquoteArg } from './activity.ts';
import { buildLaunch } from './agents.ts';
import { createApp } from './http.ts';
import { SessionManager } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('activity parser & tracker', () => {
  it('unwraps double-encoded Antigravity tool call args without mangling plain strings', () => {
    expect(unquoteArg('"执行全量单元测试"')).toBe('执行全量单元测试');
    expect(unquoteArg('120')).toBe(120);
    expect(unquoteArg('true')).toBe(true);
    expect(unquoteArg('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
    expect(unquoteArg('plain text')).toBe('plain text');
    expect(unquoteArg('"unterminated')).toBe('"unterminated');
  });

  it('summarizes native, MCP fast-tools, and subagent calls with Chinese summaries and file tracking', () => {
    const cmd = summarizeToolCall('default_api:run_command', {
      CommandLine: '"npm test"',
      toolSummary: '"运行服务端单元测试"',
    });
    expect(cmd.summary).toBe('运行服务端单元测试');
    expect(cmd.subagent).toBe(false);

    const edit = summarizeToolCall('default_api:edit_file', {
      Path: '"G:\\\\Workspace\\\\agent-workbench\\\\server\\\\http.ts"',
    });
    expect(edit.summary).toContain('http.ts');
    expect(edit.filesWritten).toEqual(['G:\\Workspace\\agent-workbench\\server\\http.ts']);

    const mcpBatch = summarizeToolCall('mcp_fast-tools_read_files_batch', {
      paths: '["G:/a/one.ts","G:/a/two.ts"]',
    });
    expect(mcpBatch.summary).toContain('2');
    expect(mcpBatch.filesRead).toEqual(['G:/a/one.ts', 'G:/a/two.ts']);

    const sub = summarizeToolCall('default_api:invoke_subagent', {
      TypeName: '"gemini-reviewer"',
      Role: '"独立代码审查"',
    });
    expect(sub.subagent).toBe(true);
    expect(sub.summary).toContain('独立代码审查');
  });

  it('tails partial UTF-8 JSONL chunks safely and tracks full Antigravity turn lifecycle', () => {
    const dir = makeTmp('wb-act-');
    const tp = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tp, '');

    let clock = 1_700_000_000_000;
    const updates: Array<{ id: string; act: SessionActivity | null }> = [];
    const session: SessionInfo = {
      id: 's-agy-1',
      taskId: 't-1',
      agent: 'agy',
      nativeSessionId: '3e094825-a325-49af-8a9f-63ff0ed9e694',
      status: 'working',
      statusSince: clock,
      startedAt: clock - 1000,
      exitCode: null,
      cols: 120,
      rows: 36,
      transcriptPath: tp,
    };

    const tracker = createActivityTracker({
      sessions: () => [session],
      onUpdate: (id, act) => updates.push({ id, act }),
      now: () => clock,
    });

    tracker.onHook(session, 'PreInvocation', { modelName: 'gemini-pro-orchestrator' });
    expect(tracker.get(session.id)?.model).toBe('gemini-pro-orchestrator');
    expect(tracker.get(session.id)?.phase).toBe('thinking');

    // Write a multi-byte Chinese JSON line split right through the middle of a 3-byte UTF-8 character without newline.
    clock += 2_000;
    const stepLine = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(clock).toISOString(),
      content: '先并行读取协议与路由文件…',
      tool_calls: [
        { name: 'default_api:read_file', args: { Path: '"G:/repo/shared/protocol.ts"' } },
        { name: 'default_api:edit_file', args: { Path: '"G:/repo/server/http.ts"' } },
      ],
    }) + '\n';
    const buf = Buffer.from(stepLine, 'utf8');
    const splitIdx = buf.indexOf(Buffer.from('协议', 'utf8')) + 1; // mid-character split!
    fs.appendFileSync(tp, buf.subarray(0, splitIdx));
    tracker.tick();
    // Incomplete line must NOT advance offset or corrupt state.
    expect(tracker.get(session.id)?.stepCount).toBe(0);

    // Append remainder of the line -> parsed cleanly!
    fs.appendFileSync(tp, buf.subarray(splitIdx));
    clock += 500;
    tracker.tick();
    const afterPlan = tracker.get(session.id)!;
    expect(afterPlan.phase).toBe('tool');
    expect(afterPlan.stepCount).toBe(2);
    expect(afterPlan.summary).toContain('并行调用 2 个工具');
    expect(afterPlan.thinkingSnippet).toBe('先并行读取协议与路由文件…');
    expect(afterPlan.filesRead).toEqual(['G:/repo/shared/protocol.ts']);
    expect(afterPlan.filesWritten).toEqual(['G:/repo/server/http.ts']);
    expect(afterPlan.lastProgressAt).toBe(clock);

    // First tool returns -> 1 tool (`edit_file` on http.ts) still running, so its specific summary is surfaced.
    clock += 1_000;
    fs.appendFileSync(tp, JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE' }) + '\n');
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('tool');
    expect(tracker.get(session.id)?.summary).toBe('修改 http.ts');

    // Second tool returns -> back to thinking for next planner turn.
    clock += 1_000;
    fs.appendFileSync(tp, JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE' }) + '\n');
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('thinking');
    expect(tracker.get(session.id)?.summary).toBe('工具已返回，正在推理下一步…');

    // Intermediate stop waiting on async subagent keeps session tracked in `subagent` phase.
    clock += 1_000;
    tracker.onHook(session, 'Stop', { fullyIdle: false }, { intermediateStop: true });
    expect(tracker.get(session.id)?.phase).toBe('subagent');
    expect(tracker.get(session.id)?.summary).toBe('等待子代理或后台任务完成…');

    // Stream error record surfaces error phase.
    clock += 1_000;
    fs.appendFileSync(tp, JSON.stringify({ step_index: 4, type: 'ERROR_MESSAGE', content: 'The stream was interrupted' }) + '\n');
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('error');
    expect(tracker.get(session.id)?.summary).toContain('The stream was interrupted');

    // Terminal Stop clears activity and broadcasts null.
    session.status = 'needs_you';
    tracker.onHook(session, 'Stop', { fullyIdle: true });
    expect(tracker.get(session.id)).toBeUndefined();
    expect(updates.at(-1)).toEqual({ id: session.id, act: null });
  });

  it('preserves Turn-1 EOF across multi-turn sessions, tracks >10 parallel tools, wakes from subagent, and resets on truncation', () => {
    const dir = makeTmp('wb-act-multiturn-');
    const tp = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tp, '');

    let clock = 1_700_000_100_000;
    const session: SessionInfo = {
      id: 's-agy-multi',
      taskId: 't-multi',
      agent: 'agy',
      nativeSessionId: 'multi-turn-uuid',
      status: 'working',
      statusSince: clock,
      startedAt: clock - 1000,
      exitCode: null,
      cols: 120,
      rows: 36,
      transcriptPath: tp,
    };

    const tracker = createActivityTracker({
      sessions: () => [session],
      onUpdate: () => {},
      now: () => clock,
    });

    // Turn 1: writes steps 1..2, then finishes with Stop.
    tracker.onHook(session, 'PreInvocation', { modelName: 'gemini-pro-orchestrator' });
    fs.appendFileSync(
      tp,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'default_api:invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"终审"' } }],
      }) + '\n',
    );
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('subagent');
    expect(tracker.get(session.id)?.stepCount).toBe(1);

    // Sync subagent GENERIC returns -> phase transitions from 'subagent' back to 'thinking'.
    fs.appendFileSync(tp, JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE' }) + '\n');
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('thinking');

    // Async subagent intermediateStop -> PreInvocation wakes main session back to 'thinking'.
    tracker.onHook(session, 'Stop', { fullyIdle: false }, { intermediateStop: true });
    expect(tracker.get(session.id)?.phase).toBe('subagent');
    clock += 1_000;
    tracker.onHook(session, 'PreInvocation', { modelName: 'gemini-pro-orchestrator' });
    expect(tracker.get(session.id)?.phase).toBe('thinking');

    // Terminal Stop ends Turn 1.
    session.status = 'needs_you';
    tracker.onHook(session, 'Stop', { fullyIdle: true });
    expect(tracker.get(session.id)).toBeUndefined();

    // Turn 2 starts: PreInvocation arrives BEFORE Turn 2 USER_INPUT flushes to disk -> must NOT replay Turn 1!
    clock += 5_000;
    session.status = 'working';
    session.statusSince = clock;
    tracker.onHook(session, 'PreInvocation', { modelName: 'gemini-pro-orchestrator' });
    expect(tracker.get(session.id)?.stepCount).toBe(0);
    expect(tracker.get(session.id)?.phase).toBe('thinking');

    // > 10 parallel tool calls (12 tools > MAX_RECENT_STEPS=10) stay in 'tool' until all 12 complete.
    const twelveCalls = Array.from({ length: 12 }, (_, i) => ({
      name: 'default_api:read_file',
      args: { Path: `"G:/repo/f${i}.ts"` },
    }));
    fs.appendFileSync(
      tp,
      JSON.stringify({ step_index: 10, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: twelveCalls }) + '\n',
    );
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('tool');
    expect(tracker.get(session.id)?.stepCount).toBe(12);

    for (let i = 0; i < 10; i++) {
      fs.appendFileSync(tp, JSON.stringify({ step_index: 11 + i, type: 'GENERIC', status: 'DONE' }) + '\n');
    }
    tracker.tick();
    // 2 tools still pending even though recentSteps ring buffer only holds 10 items!
    expect(tracker.get(session.id)?.phase).toBe('tool');
    expect(tracker.get(session.id)?.summary).toContain('剩余 2 个并行工具');

    fs.appendFileSync(tp, JSON.stringify({ step_index: 21, type: 'GENERIC', status: 'DONE' }) + '\n');
    fs.appendFileSync(tp, JSON.stringify({ step_index: 22, type: 'GENERIC', status: 'DONE' }) + '\n');
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('thinking');

    // File truncation resets seenKeys so fresh step_index: 1 parses cleanly.
    fs.writeFileSync(
      tp,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'default_api:list_dir', args: { DirectoryPath: '"G:/repo"' } }],
      }) + '\n',
    );
    tracker.tick();
    expect(tracker.get(session.id)?.phase).toBe('tool');
    expect(tracker.get(session.id)?.summary).toBe('浏览目录 repo');
  });
});

describe('Antigravity model tier selection & API validation', () => {
  it('excludes deprecated gemini-3.8-flash* models and passes --model only when configured', () => {
    expect(AGY_MODELS.some(m => m.slug.includes('3.8-flash'))).toBe(false);
    expect(isValidAgyModel('')).toBe(true);
    expect(isValidAgyModel('gemini-pro-orchestrator')).toBe(true);
    expect(isValidAgyModel('gemini-4-hydrogen-medium')).toBe(true);
    expect(isValidAgyModel('gemini-3.8-flash-high')).toBe(false);

    const stateDir = makeTmp('wb-agy-launch-');
    const withOrchestrator = buildLaunch({
      agent: 'agy',
      sessionId: 'sid-1',
      prompt: '检查性能',
      stateDir,
      model: 'gemini-pro-orchestrator',
    });
    expect(withOrchestrator.args).toContain('--model');
    expect(withOrchestrator.args[withOrchestrator.args.indexOf('--model') + 1]).toBe('gemini-pro-orchestrator');

    const defaultCli = buildLaunch({
      agent: 'agy',
      sessionId: 'sid-2',
      prompt: '检查性能',
      stateDir,
    });
    expect(defaultCli.args).not.toContain('--model');
  });

  it('persists default agyModel in settings, applies it to new agy tasks, and rejects invalid slugs', async () => {
    const root = makeTmp('wb-agy-http-');
    const stateDir = path.join(root, 'state');
    const projDir = path.join(root, 'proj');
    const fakeLocalAppData = path.join(root, 'localappdata');
    const fakeAgyBin = path.join(fakeLocalAppData, 'agy', 'bin');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(fakeAgyBin, { recursive: true });
    fs.writeFileSync(path.join(fakeAgyBin, 'agy.exe'), 'stub');
    vi.stubEnv('LOCALAPPDATA', fakeLocalAppData);
    if (process.platform !== 'win32') {
      // POSIX finds agy on PATH, not under LOCALAPPDATA.
      fs.writeFileSync(path.join(fakeAgyBin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${fakeAgyBin}${path.delimiter}${process.env.PATH ?? ''}`);
    }

    const spawns: Array<{ args: string[] }> = [];
    vi.spyOn(pty, 'spawn').mockImplementation(((_file: string, args: string[] | string) => {
      spawns.push({ args: Array.isArray(args) ? args : [args] });
      return {
        pid: 5000 + spawns.length, cols: 120, rows: 36, process: 'agy', handleFlowControl: false,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {},
      } as unknown as pty.IPty;
    }) as typeof pty.spawn);

    const net = await import('node:net');
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(err => (err ? reject(err) : resolve(p)));
      });
    });

    const token = 'test-token';
    const store = createFileStore(path.join(stateDir, 'state.json'));
    const sessions = new SessionManager({ port: freePort, token, stateDir });
    const usage = createUsage({ stateDir, source: store });
    const app = createApp({ port: freePort, token, store, sessions, stateDir, usage });
    await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${freePort}`;
    const api = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: res.status === 204 ? null : await res.json() };
    };

    try {
      const badSetting = await api('POST', '/api/settings', { agyModel: 'gemini-3.8-flash-tiered' });
      expect(badSetting.status).toBe(400);

      const okSetting = await api('POST', '/api/settings', { agyModel: 'gemini-pro-orchestrator' });
      expect(okSetting.status).toBe(200);
      expect(okSetting.json.agyModel).toBe('gemini-pro-orchestrator');

      const proj = (await api('POST', '/api/projects', { name: 'Demo', path: projDir })).json;

      const badTask = await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', model: 'gemini-3.8-flash' });
      expect(badTask.status).toBe(400);

      // Omitted model inherits settings.agyModel ('gemini-pro-orchestrator').
      const inherited = await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', prompt: 'hello' });
      expect(inherited.status).toBe(200);
      expect(inherited.json.task.model).toBe('gemini-pro-orchestrator');
      expect(spawns[0].args).toContain('gemini-pro-orchestrator');

      // Explicit '' overrides back to CLI global settings.json (no --model flag).
      const explicitDefault = await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', model: '', prompt: 'world' });
      expect(explicitDefault.status).toBe(200);
      expect(explicitDefault.json.task.model).toBeUndefined();
      expect(spawns[1].args).not.toContain('--model');
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
    }
  });
});
