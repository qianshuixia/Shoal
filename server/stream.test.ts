import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, SessionInfo, Task } from '../shared/protocol.ts';
import { dedupeLiveThinking } from '../shared/ptyLive.ts';
import {
  buildStreamBlocks,
  buildStreamData,
  composeLiveTail,
  createStreamWatcher,
  dedupeLiveAnswer,
  extractPtyLiveFromLines,
  extractPtyPromptDraft,
  extractPtyPromptState,
  extractTodosFromToolCall,
  parsePtySubagentLine,
  parseStreamBlocks,
  parseStreamData,
} from './stream.ts';

const dirs: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const jl = (...objs: unknown[]) => objs.map(o => JSON.stringify(o)).join('\n');

function childTranscriptFixture(configDir: string, id: string): string {
  vi.stubEnv('AGY_CONFIG_DIR', configDir);
  const logs = path.join(configDir, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  return path.join(logs, 'transcript.jsonl');
}

describe('parseStreamBlocks', () => {
  it('only loads child transcripts from the controlled log directory and leaves ambiguous spawns unbound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-child-scope-'));
    dirs.push(dir);
    vi.stubEnv('AGY_CONFIG_DIR', dir);
    const parent = path.join(dir, 'parent.jsonl');
    const outside = path.join(dir, 'unrelated.jsonl');
    const childId = '5970289e-205d-4a4d-8ec8-4450292bf024';
    fs.writeFileSync(outside, jl({ type: 'PLANNER_RESPONSE', content: 'Unrelated fixture' }));
    const result = { type: 'GENERIC', status: 'DONE', step_index: 2, content: 'Created the following subagent:\n' + JSON.stringify({ conversationId: childId }) };
    const launch = (id: string) => ({ id, name: 'invoke_subagent', args: { Role: id } });
    const started = { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [launch('first'), launch('second')] };
    fs.writeFileSync(parent, jl(started, result) + '\n');
    const task: Task = { id: 'parent', projectId: 'p', title: 'parent', prompt: 'start', titleAuto: false,
      color: '#fff', agent: 'agy', sessionId: 's-parent', createdAt: 1, phase: 'active', phaseSince: 1 };
    const session: SessionInfo = { id: 's-parent', taskId: task.id, agent: 'agy', nativeSessionId: null, status: 'working',
      statusSince: 1, startedAt: 1, cols: 100, rows: 30, exitCode: null, transcriptPath: parent };
    expect(buildStreamData({ task, session, cards: [] }).subagents.map(sub => sub.id)).not.toContain(childId);
    fs.writeFileSync(parent, jl(started, { ...result, tool_call_id: 'first' }) + '\n');
    const watcher = createStreamWatcher({ getSession: () => session, getTask: () => task, getCards: () => [],
      getActivity: () => null, getPromptWait: () => null });
    try {
      watcher.onSubagentHook(session.id, 'PreInvocation', { conversationId: childId, transcriptPath: outside });
      const built = buildStreamData({ task, session, cards: [] });
      expect(built.subagents).toContainEqual(expect.objectContaining({ id: childId, name: 'first' }));
      expect(built.subagentFiles).toEqual([]);
      expect(watcher.knowsSubagent(session.id, childId)).toBe(true);
      session.status = 'exited';
      watcher.onSessionChange(session);
      expect(watcher.knowsSubagent(session.id, childId)).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('refreshes a full card window in timeline order and shows failed inputs without a transcript', async () => {
    const task: Task = { id: 'cards', projectId: 'p', title: 'cards', prompt: 'start', titleAuto: false,
      color: '#fff', agent: 'fake', sessionId: 'card-session', createdAt: 1, phase: 'active', phaseSince: 1 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-card-window-'));
    dirs.push(dir);
    const tp = path.join(dir, 'parent.jsonl');
    fs.writeFileSync(tp, jl({ role: 'user', text: 'first', at: 10 }, { role: 'assistant', text: 'last', at: 100 }) + '\n');
    const session: SessionInfo = { id: 'card-session', taskId: task.id, agent: 'fake', nativeSessionId: null,
      status: 'idle', statusSince: 1, startedAt: 1, cols: 100, rows: 30, exitCode: null, transcriptPath: tp };
    const cards: Card[] = Array.from({ length: 20 }, (_, index) => ({ id: `card-${index}`, kind: 'forward', taskId: task.id,
      sessionId: session.id, createdAt: 20 + index, body: `note-${index}` }));
    const sent: string[] = [];
    const watcher = createStreamWatcher({ getSession: () => session, getTask: () => task, getCards: () => cards,
      getActivity: () => null, getPromptWait: () => null });
    try {
      watcher.watch({ readyState: 1, send: frame => sent.push(frame) }, session.id);
      expect(JSON.parse(sent[0]).state.blocks.map((block: { kind: string }) => block.kind)).toEqual(['user', ...Array(20).fill('card'), 'assistant']);
      cards.push({ ...cards.shift()!, id: 'replacement', createdAt: 50 });
      watcher.onActivity(session.id);
      expect(sent).toHaveLength(2);
      expect(JSON.parse(sent[1]).state.blocks.at(-2).card.id).toBe('replacement');
    } finally {
      watcher.close();
    }
    const missing = buildStreamData({ task, session: { ...session, transcriptPath: undefined }, cards: [], pendingInputs: [
      { id: 'failed', text: 'failed to write', at: 1, state: 'failed', reason: 'write-error' },
      { id: 'interrupted', text: 'verify in terminal', at: 2, state: 'uncertain', reason: 'interrupted' },
    ] });
    expect(missing.blocks.slice(-2)).toMatchObject([{ pendingId: 'failed', pending: 'failed', pendingReason: 'write-error' },
      { pendingId: 'interrupted', pending: 'uncertain', pendingReason: 'interrupted' }]);
  });

  it('agy: parses USER_INPUT, PLANNER_RESPONSE thinking + tools + narration, ignores GENERIC RUNNING and finishes tools per GENERIC DONE', () => {
    const raw = jl(
      {
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        created_at: '2026-11-24T01:50:00.000Z',
        content: '<USER_REQUEST>\n帮我检查环境\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-25T12:17:25+08:00.\n</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T01:50:02.000Z',
        model: 'gemini-4-neon-xhigh',
        thinking: 'Let me run uname and check macOS.',
        content: '好，我就跑一下，看看环境到底是什么情况。',
        tool_calls: [
          {
            name: 'default_api:run_command',
            args: { CommandLine: '"uname -a"', toolSummary: '"确认执行环境是不是 macOS"' },
          },
          {
            name: 'default_api:read_file',
            args: { Path: '"G:/Workspace/app/src/index.ts"' },
          },
        ],
      },
      // Real agy 1.5.x emits GENERIC RUNNING before DONE — must NOT mark tools done yet!
      { step_index: 2, type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-24T01:50:02.500Z' },
    );

    const mid = parseStreamBlocks('agy', raw, 'agy1');
    const midStep = mid[1];
    expect(midStep.kind).toBe('step');
    if (midStep.kind === 'step') {
      expect(midStep.active).toBe(true);
      expect(midStep.tools.map(t => t.status)).toEqual(['running', 'running']);
    }

    // Now first tool completes DONE, second tool still running.
    const raw2 = raw + '\n' + jl(
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T01:50:03.000Z' },
    );
    const partial = parseStreamBlocks('agy', raw2, 'agy1');
    if (partial[1].kind === 'step') {
      expect(partial[1].active).toBe(true);
      expect(partial[1].tools.map(t => t.status)).toEqual(['done', 'running']);
    }

    // Second tool completes DONE + final PLANNER_RESPONSE arrives.
    const raw3 = raw2 + '\n' + jl(
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T01:50:04.000Z' },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T01:50:06.000Z',
        model: 'gemini-4-neon-xhigh',
        thinking: 'Everything verified, write concise answer.',
        content: '### 结论\n\n环境正常。\n\n```ts\nexport const ok = true;\n```',
        tool_calls: [],
      },
    );

    const blocks = parseStreamBlocks('agy', raw3, 'agy1');
    expect(blocks.map(b => b.kind)).toEqual(['user', 'step', 'assistant', 'step', 'assistant']);
    // Stable step_index-based IDs across updates prevent React remount / animation replay.
    expect(blocks[0].id).toBe('agy1-agy-u-0');
    expect(blocks[0].kind === 'user' ? blocks[0].text : '').toBe('帮我检查环境');
    expect(blocks[1].id).toBe('agy1-agy-step-1');
    expect(blocks[2].id).toBe('agy1-agy-a-1');
    if (blocks[1].kind === 'step') {
      expect(blocks[1].active).toBe(false);
      expect(blocks[1].tools.map(t => t.status)).toEqual(['done', 'done']);
      expect(blocks[1].tools[1]).toMatchObject({ summary: '读取 index.ts', files: ['G:/Workspace/app/src/index.ts'] });
    }
  });

  it('claude: extracts thinking, tool_use, tool_result error/done status, and merges consecutive assistant texts', () => {
    const raw = jl(
      { type: 'user', timestamp: '2026-11-24T01:00:00.000Z', message: { content: '修一下登录' } },
      {
        type: 'assistant',
        timestamp: '2026-11-24T01:00:03.000Z',
        message: {
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'thinking', thinking: 'Inspect auth.ts first.' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/repo/auth.ts' } },
            { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test', description: '运行测试' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-11-24T01:00:05.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'failed' },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-11-24T01:00:07.000Z',
        message: { content: [{ type: 'text', text: '发现问题了。' }] },
      },
    );

    const blocks = parseStreamBlocks('claude', raw, 'cl1');
    expect(blocks.map(b => b.kind)).toEqual(['user', 'step', 'assistant']);
    const step = blocks[1];
    if (step.kind === 'step') {
      expect(step.active).toBe(false);
      expect(step.thinking).toBe('Inspect auth.ts first.');
      expect(step.thinkingSec).toBe(3);
      expect(step.tools.map(t => [t.summary, t.status])).toEqual([
        ['读取 auth.ts', 'done'],
        ['运行测试', 'error'],
      ]);
    }
  });

  it('codex: pairs reasoning summary with function_call and marks done on function_call_output', () => {
    const raw = jl(
      { type: 'response_item', timestamp: '2026-11-24T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看看配置' }] } },
      { type: 'response_item', timestamp: '2026-11-24T01:00:02Z', payload: { type: 'reasoning', summary: [{ text: 'Checking package.json' }] } },
      { type: 'response_item', timestamp: '2026-11-24T01:00:02Z', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"cat package.json"}' } },
      { type: 'response_item', timestamp: '2026-11-24T01:00:03Z', payload: { type: 'function_call_output', call_id: 'c1', output: '{}' } },
      { type: 'response_item', timestamp: '2026-11-24T01:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '配置正常。' }] } },
    );

    const blocks = parseStreamBlocks('codex', raw, 'cx1');
    expect(blocks.map(b => b.kind)).toEqual(['user', 'step', 'assistant']);
    const step = blocks[1];
    if (step.kind === 'step') {
      expect(step.thinking).toBe('Checking package.json');
      expect(step.active).toBe(false);
      expect(step.tools[0]).toMatchObject({ name: 'exec_command', status: 'done' });
    }
  });
});

describe('PTY live extraction & deduplication (agy 1.5.15+ regression guards)', () => {
  it('never leaks agy 1.5.15 Working spinner, Tip/Use /settings, stats header, or tool summary into answerText', () => {
    const lines = [
      { startRow: 0, text: '41.1s in | 5.2k out | 2.8k thinking', muted: true },
      { startRow: 1, text: '● 批量读取: H:\\h5-game\\src (ctrl+o to expand)', muted: false },
      { startRow: 2, text: '  先完成两份代码的差异比对。', muted: false },
      { startRow: 3, text: '83.6s in | 4.5k out | 2.2k thinking', muted: true },
      { startRow: 4, text: '● mcp-fast-tools:fastSearch(读取背景信息) (ctrl+o to expand)', muted: false },
      { startRow: 5, text: '⠼ Working...', muted: true },
      { startRow: 6, text: '  Tip: Use /settings to configure your environment.', muted: true },
      { startRow: 7, text: '  Use /settings to configure your environment.', muted: true },
      { startRow: 8, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 9, text: '>', muted: false },
      { startRow: 10, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 11, text: 'esc to cancel                       auto · Gemini 4 Neon · xhigh', muted: true },
    ];
    const ext = extractPtyLiveFromLines('agy', lines);
    expect(ext.answerText).toBeUndefined();
    expect(ext.thinkingText).toBeUndefined();
    expect(ext.spinnerText).toBe('Working...');
  });

  it('routes dim/muted live lines into thinkingText and bright lines into answerText, and ignores alternate screen', () => {
    const lines = [
      { startRow: 0, text: '83.6s in | 4.5k out | 2.2k thinking', muted: true },
      { startRow: 1, text: '● mcp-fast-tools:fastSearch(查询) (ctrl+o to expand)', muted: false },
      { startRow: 2, text: '  2. The scene file uses a text node for age verification.', muted: true },
      { startRow: 3, text: '⠋ Working...', muted: true },
      { startRow: 4, text: '  Tip: Use /settings to configure your environment.', muted: true },
    ];
    const ext = extractPtyLiveFromLines('agy', lines);
    expect(ext.thinkingText).toBe('2. The scene file uses a text node for age verification.');
    expect(ext.answerText).toBeUndefined();

    // Alternate screen (interactive picker / question form) must never be scraped.
    expect(extractPtyLiveFromLines('agy', lines, undefined, true)).toEqual({});
  });

  it('extracts bright agy streaming response cleanly without chrome', () => {
    const lines = [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> 帮我列 3 条', muted: false },
      { startRow: 2, text: '▸ Thought for 5s', muted: true },
      { startRow: 3, text: '  1. 第一条检查结果', muted: false },
      { startRow: 4, text: '  2. 第二条正在流式输出', muted: false },
      { startRow: 5, text: '⣻  Checking the remaining registry entries for backlight...', muted: true },
      { startRow: 6, text: '└ Tip: Use /help to see all commands.', muted: true },
      { startRow: 7, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 8, text: '>', muted: false },
      { startRow: 9, text: 'esc to cancel                               Gemini 4 Carbon · medium', muted: true },
    ];
    const ext = extractPtyLiveFromLines('agy', lines, '帮我列 3 条');
    expect(ext.thinkingText).toBe('Checking the remaining registry entries for backlight...');
    expect(ext.answerText).toBe('1. 第一条检查结果\n2. 第二条正在流式输出');
  });

  it('deduplicates committed Markdown answers and prevents repeating previous-step thinking in live tail', () => {
    const blocks = [
      { id: 'u1', kind: 'user' as const, text: 'hi' },
      {
        id: 'st1',
        kind: 'step' as const,
        thinking: 'The analysis of LoadingSceneController.dll revealed distinct differences.',
        tools: [],
      },
      { id: 'a1', kind: 'assistant' as const, text: '### 结论\n\n1. **第一条检查结果**\n2. `第二条`正在流式输出完成' },
    ];
    expect(dedupeLiveAnswer('结论\n1. 第一条检查结果\n2. 第二条正在流式输出', blocks)).toBeUndefined();
    expect(dedupeLiveAnswer('结论', blocks)).toBeUndefined();
    expect(dedupeLiveAnswer('全新的第三轮回复内容在这里', blocks)).toBe('全新的第三轮回复内容在这里');

    // Stale thinking snippet matching previous step must be suppressed.
    expect(dedupeLiveThinking('The analysis of LoadingSceneController.dll revealed distinct differences.', blocks)).toBeUndefined();
    expect(dedupeLiveThinking('Inspecting the remaining anti-addiction checks now.', blocks)).toBe('Inspecting the remaining anti-addiction checks now.');

    // Short previous reply ("好的") must NOT suppress a longer new reply starting with "好的，...".
    const shortBlocks = [{ id: 'a0', kind: 'assistant' as const, text: '好的' }];
    expect(dedupeLiveAnswer('好的，我现在开始逐项检查配置文件。', shortBlocks)).toBe('好的，我现在开始逐项检查配置文件。');

    // Strips leading lines already committed earlier in the turn, preserving ONLY brand-new streamed lines.
    const multiStepBlocks = [
      { id: 'a1', kind: 'assistant' as const, text: '先精读防沉迷相关源码与测试契约。' },
      { id: 'a2', kind: 'assistant' as const, text: '开始批量落地阶段一修改。' },
    ];
    expect(
      dedupeLiveAnswer('先精读防沉迷相关源码与测试契约。\n开始批量落地阶段一修改。\n最新流式生成的总结内容在这里。', multiStepBlocks),
    ).toBe('最新流式生成的总结内容在这里。');
  });

  it('strips bare braille spinner char and wrapped user prompt continuations', () => {
    const lines = [
      { startRow: 0, text: '> 第一行用户长提问内容在这里', muted: false },
      { startRow: 1, text: '  第二行用户提问续行内容在这里', muted: false },
      { startRow: 2, text: '  全新生成的助手正文', muted: false },
      { startRow: 3, text: '⣯', muted: true },
    ];
    const ext = extractPtyLiveFromLines('agy', lines, '第一行用户长提问内容在这里\n第二行用户提问续行内容在这里');
    expect(ext.answerText).toBe('全新生成的助手正文');
  });

  it('extracts live thinking headline past agy bottom todolist panel, promo banner, and wrapped footer', () => {
    const lines = [
      { startRow: 0, text: '  第 10 轮已返回，准备第 11 轮。', muted: false },
      { startRow: 1, text: '⣷  2/6 steps · Defined specifications for crossingcams.com SEO rules...', muted: true },
      { startRow: 2, text: '  ⎿  ✓ 核实已购域名与项目归档结构', muted: true },
      { startRow: 3, text: '     ✓ 归档前期调研资料到新项目目录', muted: true },
      { startRow: 4, text: '     ● 与哥飞 Agent 深度定死全站 SEO 规范', muted: false },
      { startRow: 5, text: '     ○ 撰写 PRD 与整站架构及内链方案', muted: true },
      { startRow: 6, text: ' ┃ Introducing Gemini 4 Neon', muted: false },
      { startRow: 7, text: ' ┃ esc to dismiss', muted: true },
      { startRow: 8, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 9, text: '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)', muted: true },
      { startRow: 10, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 11, text: '? for shortcuts                                      auto · Gemini', muted: true },
      { startRow: 12, text: ' 4 Neon · high', muted: true },
    ];
    const ext = extractPtyLiveFromLines('agy', lines);
    expect(ext.thinkingText).toBe('Defined specifications for crossingcams.com SEO rules...');
    expect(ext.answerText).toBeUndefined();
  });

  it('extracts latest todo checklist across agy update_steps, claude TodoWrite, and codex update_plan', () => {
    const agyTodos = extractTodosFromToolCall('default_api:update_steps', {
      steps: JSON.stringify([
        { title: '核实已购域名', status: 'done' },
        { title: '哥飞 Agent 深度定稿', status: 'in_progress' },
        { title: '三方交叉评审', status: 'pending' },
      ]),
    });
    expect(agyTodos).toEqual([
      { title: '核实已购域名', status: 'done' },
      { title: '哥飞 Agent 深度定稿', status: 'in_progress' },
      { title: '三方交叉评审', status: 'pending' },
    ]);

    const claudeTodos = extractTodosFromToolCall('TodoWrite', {
      todos: [
        { content: 'Read files', status: 'completed' },
        { content: 'Fix bug', status: 'in_progress' },
      ],
    });
    expect(claudeTodos).toEqual([
      { title: 'Read files', status: 'done' },
      { title: 'Fix bug', status: 'in_progress' },
    ]);

    const codexTodos = extractTodosFromToolCall('update_plan', {
      plan: [{ step: 'Run tests', status: 'completed' }],
    });
    expect(codexTodos).toEqual([{ title: 'Run tests', status: 'done' }]);

    const parsed = parseStreamData('agy', jl({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'update_steps', args: { steps: JSON.stringify([{ title: 'A', status: 'done' }, { title: 'B', status: 'in_progress' }]) } }],
    }));
    expect(parsed.todos).toEqual([
      { title: 'A', status: 'done' },
      { title: 'B', status: 'in_progress' },
    ]);
    if (parsed.blocks[0]?.kind === 'step') {
      expect(parsed.blocks[0].tools[0].summary).toBe('更新任务清单（已完成 1/2）');
    }
  });

  it('watches/unwatches cleanly on demand and suppresses redundant WS broadcasts when only live.updatedAt advances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-stream-dedupe-'));
    dirs.push(dir);
    const tp = path.join(dir, 'fake.jsonl');
    fs.writeFileSync(tp, JSON.stringify({ role: 'user', text: '测试去重' }) + '\n');

    const task: Task = {
      id: 't1', projectId: 'p1', title: '去重', prompt: '测试去重', titleAuto: false,
      color: '#8baeda', agent: 'fake', sessionId: 's1', createdAt: 1000, phase: 'active', phaseSince: 1000,
    };
    const session: SessionInfo = {
      id: 's1', taskId: 't1', agent: 'fake', nativeSessionId: 'fake-s1', status: 'working',
      statusSince: 1000, startedAt: 1000, exitCode: null, cols: 100, rows: 30, transcriptPath: tp,
    };
    let clock = 2000;
    const watcher = createStreamWatcher({
      getSession: id => (id === 's1' ? session : undefined),
      getTask: id => (id === 't1' ? task : undefined),
      getCards: () => [],
      getActivity: () => null,
      getPromptWait: () => null,
      now: () => (clock += 100),
    });

    const sent: string[] = [];
    const client = { readyState: 1, send: (d: string) => sent.push(d) };
    expect(watcher.watchedCount()).toBe(0);

    watcher.watch(client, 's1');
    expect(watcher.watchedCount()).toBe(1);
    expect(sent.length).toBe(1);

    // Repeated ticks with advancing clock but unchanged state must NOT rebroadcast!
    watcher.onActivity('s1');
    watcher.onSessionChange({ ...session, cols: 101 });
    watcher.onActivity('s1');
    expect(sent.length).toBe(1);

    // Once transcript updates and session stops, watcher emits clean settled state.
    fs.appendFileSync(tp, JSON.stringify({ role: 'assistant', text: '完成检查。' }) + '\n');
    session.status = 'needs_you';
    watcher.onSessionChange(session);
    const settled = JSON.parse(sent.at(-1)!);
    expect(settled.state.live).toBeNull();
    expect(settled.state.blocks.at(-1)).toMatchObject({ kind: 'assistant', text: '完成检查。' });

    watcher.unwatchClient(client);
    expect(watcher.watchedCount()).toBe(0);
    watcher.close();
  });

  it('builds preparing tail before any PTY or activity signal arrives', () => {
    const session: SessionInfo = {
      id: 's1', taskId: 't1', agent: 'agy', nativeSessionId: null, status: 'working',
      statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36,
    };
    const tail = composeLiveTail({ session, blocks: [], activity: null, ptyExtract: null, now: 1500 });
    expect(tail).toMatchObject({ phase: 'preparing', startedAt: 1000 });
    expect(buildStreamBlocks({
      task: { id: 't1', projectId: 'p1', title: 'T', prompt: '你好', titleAuto: false, color: '#fff', agent: 'agy', sessionId: 's1', createdAt: 900, phase: 'active', phaseSince: 900 },
      session,
      cards: [],
    })).toHaveLength(1);
  });

  it('prefers agy transcript_full.jsonl over truncated compact transcript.jsonl in buildStreamBlocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-stream-full-'));
    dirs.push(dir);
    const compact = path.join(dir, 'transcript.jsonl');
    const full = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(compact, jl({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '| 检查项 | 结果 |\n| --- | --- |\n| 类型检查 | <truncated 929 bytes> |',
    }) + '\n');
    fs.writeFileSync(full, jl({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: '| 检查项 | 结果 |\n| --- | --- |\n| 类型检查 | 通过（零错误） |',
    }) + '\n');

    const blocks = buildStreamBlocks({
      task: { id: 't1', projectId: 'p1', title: '完整日志', prompt: '测试', titleAuto: false, color: '#fff', agent: 'agy', sessionId: 's1', createdAt: 900, phase: 'active', phaseSince: 900 },
      session: {
        id: 's1', taskId: 't1', agent: 'agy', nativeSessionId: null, status: 'needs_you',
        statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36, transcriptPath: compact,
      },
      cards: [],
    });
    const assistant = blocks.find(b => b.kind === 'assistant');
    expect(assistant && assistant.kind === 'assistant' ? assistant.text : '').toContain('通过（零错误）');
    expect(assistant && assistant.kind === 'assistant' ? assistant.text : '').not.toContain('truncated');
  });

  it('dedupes wrapped short trailing fragments (e.g. "评审结论。") and extracts live PTY subagent footer bars', () => {
    const blocks = [
      { id: 'a1', kind: 'assistant' as const, text: '已同步补齐雷霆天罚破绽值（4 段共 28 点），正在等待回归测试与 `gemini-reviewer` 评审结论。' },
      { id: 'a2', kind: 'assistant' as const, text: '核心回归 5 项全过（`selftest` / `stage` / `numbers` / `fx1` / `rage_ult` 全部退出码 0），正在等待 `gemini-reviewer` 评审结论。' },
    ];
    // Wrapped across two terminal rows where the second row is only 5 chars ("评审结论。") — must NOT leak!
    expect(
      dedupeLiveAnswer(
        '已同步补齐雷霆天罚破绽值（4 段共 28 点），正在等待回归测试与 gemini-reviewer 评审结论。\n核心回归 5 项全过（selftest / stage / numbers / fx1 / rage_ult 全部退出码 0），正在等待 gemini-reviewer\n评审结论。',
        blocks,
      ),
    ).toBeUndefined();
    // Genuine new text appended after the wrapped committed block is preserved cleanly.
    expect(
      dedupeLiveAnswer(
        '核心回归 5 项全过（selftest / stage / numbers / fx1 / rage_ult 全部退出码 0），正在等待 gemini-reviewer\n评审结论。\n独立评审查出 1 处 P1 问题。',
        blocks,
      ),
    ).toBe('独立评审查出 1 处 P1 问题。');

    const parsedBar = parsePtySubagentLine(
      '● Agent(gemini-reviewer: E-⑧ 首领破绽节奏只读评审员) · Gemini 4 Neon   The inconsistent break dama... · 3m48s',
    );
    expect(parsedBar).toEqual({
      kind: 'subagent',
      name: 'gemini-reviewer',
      role: 'E-⑧ 首领破绽节奏只读评审员',
      model: 'Gemini 4 Neon',
      summary: 'The inconsistent break dama...',
      elapsedText: '3m48s',
      status: 'running',
    });
    // In-body tool call line with `(ctrl+o to expand)` must NOT be misclassified as a footer bar.
    expect(
      parsePtySubagentLine('● Agent(gemini-reviewer: 评审)(你是评审员...) (ctrl+o to expand)'),
    ).toBeNull();

    const lines = [
      { startRow: 0, text: '● Agent(gemini-reviewer: E-⑧ 首领破绽节奏只读评审员)(你是《千骑卷》...) (ctrl+o to expand)', muted: false },
      { startRow: 1, text: '  核心回归 5 项全过（selftest / stage / numbers / fx1 / rage_ult 全部退出码 0），正在等待 gemini-reviewer', muted: false },
      { startRow: 2, text: '  评审结论。', muted: false },
      { startRow: 3, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 4, text: '>', muted: false },
      { startRow: 5, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 6, text: '● Agent(gemini-reviewer: E-⑧ 首领破绽节奏只读评审员) · Gemini 4 Neon   The inconsistent break dama... · 3m48s', muted: false },
    ];
    const ext = extractPtyLiveFromLines('agy', lines);
    expect(ext.subagents).toHaveLength(1);
    expect(ext.subagents?.[0]).toMatchObject({ name: 'gemini-reviewer', model: 'Gemini 4 Neon', elapsedText: '3m48s' });
    const live = composeLiveTail({
      session: {
        id: 's1', taskId: 't1', agent: 'agy', nativeSessionId: null, status: 'working',
        statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36,
      },
      blocks,
      activity: null,
      ptyExtract: ext,
      now: 5000,
    });
    expect(live?.phase).toBe('subagent');
    expect(live?.answerText).toBeUndefined();
  });

  it('tracks agy invoke_subagent / swarm / send_message, child transcript tail, live hooks, claude Agent, and codex spawn_agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-stream-sub-'));
    dirs.push(dir);
    const parentTp = path.join(dir, 'transcript_full.jsonl');
    const subId = '8ba43544-b08f-42ae-8463-a1c02d1dd830';
    const childTp = childTranscriptFixture(dir, subId);
    fs.writeFileSync(childTp, jl(
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:13:20.000Z',
        model: 'gemini-4-neon-high',
        thinking: 'Checking break_dmg propagation in boss.gd and skills_db.gd.',
        tool_calls: [{ name: 'default_api:read_file', args: { Path: '"G:/game/boss.gd"' } }],
      },
    ) + '\n');
    const childUri = `file:///${childTp.replaceAll('\\', '/')}`;
    fs.writeFileSync(parentTp, jl(
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-25T13:13:00.000Z', content: '评审破绽优化' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:13:10.000Z',
        model: 'gemini-4-neon-high',
        tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"破绽只读评审"', Model: '"inherit"' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T13:13:15.000Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${subId}",\n  "logAbsoluteUri": "${childUri}"\n}`,
      },
    ) + '\n');

    const task: Task = {
      id: 't-sub', projectId: 'p1', title: '子代理', prompt: '评审破绽优化', titleAuto: false,
      color: '#8baeda', agent: 'agy', sessionId: 's-sub', createdAt: 1000, phase: 'active', phaseSince: 1000,
    };
    const session: SessionInfo = {
      id: 's-sub', taskId: 't-sub', agent: 'agy', nativeSessionId: 'dc0a34fd-5bdc-4425-9a30-cdd451d1b7a2',
      status: 'working', statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36, transcriptPath: parentTp,
    };

    const builtRunning = buildStreamData({ task, session, cards: [] });
    expect(builtRunning.subagents).toHaveLength(1);
    expect(builtRunning.subagents[0]).toMatchObject({
      id: subId,
      kind: 'subagent',
      name: 'gemini-reviewer',
      role: '破绽只读评审',
      model: 'gemini-4-neon-high',
      status: 'running',
      files: ['G:/game/boss.gd'],
    });
    expect(builtRunning.subagents[0].recentSteps?.[0]?.summary).toContain('boss.gd');
    const stepBlock = builtRunning.blocks.find(b => b.kind === 'step');
    expect(stepBlock?.kind === 'step' ? stepBlock.tools[0].subagentId : undefined).toBe(subId);

    // Live watcher reacts to subagent hooks immediately and settles when subagent replies.
    const watcher = createStreamWatcher({
      getSession: id => (id === 's-sub' ? session : undefined),
      getTask: id => (id === 't-sub' ? task : undefined),
      getCards: () => [],
      getActivity: () => null,
      getPromptWait: () => null,
    });
    const sent: string[] = [];
    const client = { readyState: 1, send: (d: string) => sent.push(d) };
    watcher.watch(client, 's-sub');
    expect(watcher.knowsSubagent('s-sub', subId)).toBe(true);

    watcher.onSubagentHook('s-sub', 'Stop', { conversationId: subId, fullyIdle: true, modelName: 'gemini-4-neon-high' });
    const afterHookStop = JSON.parse(sent.at(-1)!).state;
    expect(afterHookStop.subagents?.[0]?.status).toBe('done');

    // send_message revives subagent, then SYSTEM_MESSAGE closes it with reply summary.
    fs.appendFileSync(parentTp, jl(
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:19:00.000Z',
        tool_calls: [{ name: 'send_message', args: { Recipient: JSON.stringify(subId), Message: '"请复核"' } }],
      },
      {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-25T13:20:00.000Z',
        content: `[Message] timestamp=2026-11-25T13:20:00Z sender=${subId} content=**VERDICT: PASS** 全部闭环`,
      },
    ) + '\n');
    const afterReply = buildStreamData({ task, session, cards: [] });
    expect(afterReply.subagents[0]).toMatchObject({ status: 'done', summary: 'VERDICT: PASS 全部闭环' });

    watcher.close();

    // Claude Agent tool_use -> tool_result
    const claudeParsed = parseStreamData('claude', jl(
      { type: 'user', timestamp: '2026-11-25T13:00:00Z', message: { content: '查代码' } },
      {
        type: 'assistant',
        timestamp: '2026-11-25T13:00:01Z',
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', id: 'tu-ag', name: 'Agent', input: { subagent_type: 'Explore', description: '检索鉴权路径' } }],
        },
      },
    ));
    expect(claudeParsed.subagents).toMatchObject([{ id: 'tu-ag', name: 'Explore', role: '检索鉴权路径', status: 'running' }]);

    // Codex spawn_agent -> output -> close_agent
    const codexParsed = parseStreamData('codex', jl(
      { type: 'response_item', timestamp: '2026-11-25T13:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '并行查' }] } },
      { type: 'response_item', timestamp: '2026-11-25T13:00:01Z', payload: { type: 'function_call', call_id: 'c-sp', name: 'spawn_agent', arguments: '{"agent_type":"explorer","nickname":"auth-scan","message":"scan auth"}' } },
      { type: 'response_item', timestamp: '2026-11-25T13:00:02Z', payload: { type: 'function_call_output', call_id: 'c-sp', output: '{"agent_id":"ag-99"}' } },
    ));
    expect(codexParsed.subagents).toMatchObject([{ id: 'c-sp', name: 'explorer', role: 'auth-scan', status: 'running' }]);
  });

  it('extracts active CLI prompt drafts cleanly across agy, claude, codex, and fake without false positives on placeholders or menus', () => {
    // agy empty framed box & muted placeholder
    expect(extractPtyPromptState('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '>', muted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 3, text: '? for shortcuts                      auto · Gemini 4 Neon · xhigh', muted: true },
    ])).toEqual({ found: true, draft: null });

    expect(extractPtyPromptState('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> Auto mode: edits & safe commands auto-approved', muted: false, promptTextMuted: true },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ found: true, draft: null });

    // agy multi-line real draft & opaque [Image #1] token
    expect(extractPtyPromptDraft('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> 帮我修一下登录', muted: false, promptTextMuted: false },
      { startRow: 2, text: '  顺便加上单测', muted: false },
      { startRow: 3, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 4, text: '● Agent(gemini-reviewer: 评审) · Gemini 4 Neon   Checking... · 1m02s', muted: false },
    ])).toEqual({ text: '帮我修一下登录\n顺便加上单测', multiline: true, hasOpaqueToken: false });

    expect(extractPtyPromptDraft('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> [Image #1] 看看这个报错', muted: false, promptTextMuted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ text: '[Image #1] 看看这个报错', multiline: false, hasOpaqueToken: true });

    // claude placeholder vs real input
    expect(extractPtyPromptState('claude', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '❯\u00a0Try "fix typecheck errors"', muted: false, promptTextMuted: true },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ found: true, draft: null });

    expect(extractPtyPromptDraft('claude', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '❯\u00a0检查状态栏样式', muted: false, promptTextMuted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ text: '检查状态栏样式', multiline: false, hasOpaqueToken: false });

    // codex muted placeholder vs real input
    expect(extractPtyPromptState('codex', [
      { startRow: 0, text: '› Explain this codebase', muted: false, promptTextMuted: true },
      { startRow: 1, text: '98% context left · ? for shortcuts', muted: true },
    ])).toEqual({ found: true, draft: null });

    expect(extractPtyPromptDraft('codex', [
      { startRow: 0, text: '› refactor parser', muted: false, promptTextMuted: false },
      { startRow: 1, text: '98% context left · ? for shortcuts', muted: true },
    ])).toEqual({ text: 'refactor parser', multiline: false, hasOpaqueToken: false });

    // Interactive menu or alternate screen must NEVER be misread as a draft!
    expect(extractPtyPromptState('claude', [
      { startRow: 0, text: 'Do you want to proceed?', muted: false },
      { startRow: 1, text: '❯ 1. Yes', muted: false },
      { startRow: 2, text: '  2. No', muted: false },
    ])).toEqual({ found: false, draft: null });

    expect(extractPtyPromptState('agy', [{ startRow: 0, text: '> hello', muted: false }], true)).toEqual({
      found: false,
      draft: null,
    });

    // Codex review regressions:
    // 1. Bright user text literally saying "Type a message" (promptTextMuted === false) must NOT be ignored as placeholder!
    expect(extractPtyPromptDraft('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> Type a message', muted: false, promptTextMuted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ text: 'Type a message', multiline: false, hasOpaqueToken: false });

    // 2. Single numbered draft line inside framed composer (`> 1. Write the tests`) is user text, NOT an interactive menu!
    expect(extractPtyPromptDraft('agy', [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> 1. Write the tests', muted: false, promptTextMuted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
    ])).toEqual({ text: '1. Write the tests', multiline: false, hasOpaqueToken: false });

    // 3. Tall 20-line framed draft stays readable instead of degrading to fallback!
    const tallBox = [
      { startRow: 0, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 1, text: '> line 1', muted: false, promptTextMuted: false },
      ...Array.from({ length: 19 }, (_, i) => ({ startRow: i + 2, text: `  line ${i + 2}`, muted: false })),
      { startRow: 21, text: '────────────────────────────────────────────────────────────', muted: true },
    ];
    const tallDraft = extractPtyPromptDraft('agy', tallBox);
    expect(tallDraft?.multiline).toBe(true);
    expect(tallDraft?.text.split('\n')).toHaveLength(20);
  });

  it('guards against isolated short wrapped tail ("评审结论。"), concurrent out-of-order subagent spawns, and stale subagent hooks', () => {
    // 1. Standalone wrapped tail "评审结论。" (first half scrolled off above tool anchor) must NOT mask `subagent` phase!
    const committed = [
      { id: 'a2', kind: 'assistant' as const, text: '核心回归 5 项全过，正在等待 `gemini-reviewer` 评审结论。' },
    ];
    const loneTailLines = [
      { startRow: 0, text: '● Agent(gemini-reviewer: 评审)(审查...) (ctrl+o to expand)', muted: false },
      { startRow: 1, text: '  评审结论。', muted: false },
      { startRow: 2, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 3, text: '>', muted: false },
      { startRow: 4, text: '────────────────────────────────────────────────────────────', muted: true },
      { startRow: 5, text: '● Agent(gemini-reviewer: 评审) · Gemini 4 Neon   Checking... · 1m10s', muted: false },
    ];
    const ext = extractPtyLiveFromLines('agy', loneTailLines);
    const live = composeLiveTail({
      session: {
        id: 's-tail', taskId: 't1', agent: 'agy', nativeSessionId: null, status: 'working',
        statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36,
      },
      blocks: committed,
      activity: null,
      ptyExtract: ext,
      now: 5000,
    });
    expect(live?.phase).toBe('subagent');
    expect(live?.answerText).toBeUndefined();

    // 2. Concurrent subagents A & B where B's GENERIC completes BEFORE A's: bind by child prompt match, NOT blindly FIFO!
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-stream-race-'));
    dirs.push(dir);
    const idA = 'aaaaaaaa-1111-4111-8111-111111111111';
    const idB = 'bbbbbbbb-2222-4222-8222-222222222222';
    const tpA = childTranscriptFixture(dir, idA);
    const tpB = childTranscriptFixture(dir, idB);
    fs.writeFileSync(tpA, jl({ step_index: 0, type: 'SYSTEM_MESSAGE', content: 'content=Audit backend auth permissions in http.ts' }) + '\n');
    fs.writeFileSync(tpB, jl({ step_index: 0, type: 'SYSTEM_MESSAGE', content: 'content=Inspect frontend CSS grid overflow in styles.css' }) + '\n');
    const parentTp = path.join(dir, 'parent.jsonl');
    fs.writeFileSync(parentTp, jl(
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-25T13:00:00Z', content: '并行审查' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:00:02Z',
        tool_calls: [
          { name: 'invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"后端安全审查"', Prompt: '"Audit backend auth permissions in http.ts"' } },
          { name: 'invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"前端样式审查"', Prompt: '"Inspect frontend CSS grid overflow in styles.css"' } },
        ],
      },
      // B returns FIRST!
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T13:00:03Z',
        content: `Created the following subagent:\n{"conversationId":"${idB}","logAbsoluteUri":"file:///${tpB.replaceAll('\\', '/')}"}`,
      },
      // A returns SECOND!
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T13:00:04Z',
        content: `Created the following subagent:\n{"conversationId":"${idA}","logAbsoluteUri":"file:///${tpA.replaceAll('\\', '/')}"}`,
      },
    ) + '\n');

    const task: Task = {
      id: 't-race', projectId: 'p1', title: '并发', prompt: '并行审查', titleAuto: false,
      color: '#fff', agent: 'agy', sessionId: 's-race', createdAt: 1000, phase: 'active', phaseSince: 1000,
    };
    const session: SessionInfo = {
      id: 's-race', taskId: 't-race', agent: 'agy', nativeSessionId: 'cccccccc-3333-4333-8333-333333333333',
      status: 'working', statusSince: 1000, startedAt: 1000, exitCode: null, cols: 120, rows: 36, transcriptPath: parentTp,
    };
    const built = buildStreamData({ task, session, cards: [] });
    const subA = built.subagents.find(s => s.id === idA);
    const subB = built.subagents.find(s => s.id === idB);
    expect(subA?.role).toBe('后端安全审查');
    expect(subB?.role).toBe('前端样式审查');

    // 3. Delayed PreInvocation hook arriving AFTER Stop must NOT revive the stopped subagent!
    const watcher = createStreamWatcher({
      getSession: id => (id === 's-race' ? session : undefined),
      getTask: id => (id === 't-race' ? task : undefined),
      getCards: () => [],
      getActivity: () => null,
      getPromptWait: () => null,
    });
    const sent: string[] = [];
    const baseAt = Date.parse('2026-11-25T13:00:00Z');
    watcher.watch({ readyState: 1, send: d => sent.push(d) }, 's-race');
    watcher.onSubagentHook('s-race', 'Stop', { conversationId: idA, fullyIdle: true, initialNumSteps: 12 }, baseAt + 20_000);
    expect(JSON.parse(sent.at(-1)!).state.subagents.find((s: { id: string }) => s.id === idA)?.status).toBe('done');
    // Stale delayed PreInvocation with older hookAt must be ignored!
    watcher.onSubagentHook('s-race', 'PreInvocation', { conversationId: idA, initialNumSteps: 12 }, baseAt + 19_500);
    expect(JSON.parse(sent.at(-1)!).state.subagents.find((s: { id: string }) => s.id === idA)?.status).toBe('done');
    // Delayed PreInvocation arriving later on wall clock but with the SAME initialNumSteps must also be ignored!
    watcher.onSubagentHook('s-race', 'PreInvocation', { conversationId: idA, initialNumSteps: 12 }, baseAt + 25_000);
    expect(JSON.parse(sent.at(-1)!).state.subagents.find((s: { id: string }) => s.id === idA)?.status).toBe('done');
    // A genuinely new invocation with strictly greater initialNumSteps and newer hookAt revives it.
    watcher.onSubagentHook('s-race', 'PreInvocation', { conversationId: idA, initialNumSteps: 15 }, baseAt + 30_000);
    expect(JSON.parse(sent.at(-1)!).state.subagents.find((s: { id: string }) => s.id === idA)?.status).toBe('running');
    watcher.close();

    // 4. Out-of-order GENERIC ERROR carrying explicit tool_call_id for B must mark B (NOT A) error in BOTH tray AND timeline!
    const errRaw = jl(
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-25T13:10:00Z', content: '并行失败测试' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:10:01Z',
        tool_calls: [
          { id: 'call-A', name: 'invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"审查 A"', Prompt: '"Check A"' } },
          { id: 'call-B', name: 'invoke_subagent', args: { TypeName: '"gemini-reviewer"', Role: '"审查 B"', Prompt: '"Check B"' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'ERROR',
        tool_call_id: 'call-B',
        created_at: '2026-11-25T13:10:02Z',
        content: 'Subagent launch failed: quota exceeded',
      },
    );
    const errParsed = parseStreamData('agy', errRaw, 'err');
    expect(errParsed.subagents.find(s => s.role === '审查 A')?.status).toBe('running');
    expect(errParsed.subagents.find(s => s.role === '审查 B')?.status).toBe('error');
    const stepBlock = errParsed.blocks.find(b => b.kind === 'step');
    expect(stepBlock?.kind).toBe('step');
    if (stepBlock?.kind === 'step') {
      expect(stepBlock.active).toBe(true);
      expect(stepBlock.tools.find(t => t.id === 'call-A')?.status).toBe('running');
      expect(stepBlock.tools.find(t => t.id === 'call-B')?.status).toBe('error');
    }
  });

  it('never resurrects earlier feedback cards at the bottom after later terminal/forward turns, and renders consecutive queued messages cleanly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-stream-pending-'));
    dirs.push(dir);
    const tp = path.join(dir, 'agy.jsonl');
    const t1 = Date.parse('2026-11-25T14:07:34Z');
    const t2 = Date.parse('2026-11-25T14:29:24Z');
    const t3 = Date.parse('2026-11-25T14:29:40Z');
    fs.writeFileSync(tp, jl(
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-25T14:07:34Z', content: '<USER_REQUEST>\n对话模式支持复制 md 和视频文件\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T14:10:00Z', content: '已完成多文件粘贴支持。' },
      // Later turn came via Shoal delegation forward or Terminal typing (no feedback card created).
      { step_index: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-25T14:29:24Z', content: '<USER_REQUEST>\n评审者（Codex，第 2 轮）给出了评审结论\n</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-25T14:29:40Z', content: '虾哥，刚才已修复并关闭评审会话。' },
    ) + '\n');

    const task: Task = {
      id: 't-pend', projectId: 'p1', title: '多轮回归', prompt: '初始', titleAuto: false,
      color: '#fff', agent: 'agy', sessionId: 's-pend', createdAt: t1 - 5000, phase: 'active', phaseSince: t1 - 5000,
    };
    const session: SessionInfo = {
      id: 's-pend', taskId: 't-pend', agent: 'agy', nativeSessionId: 'dddddddd-4444-4444-8444-444444444444',
      status: 'needs_you', statusSince: t3, startedAt: t1 - 5000, exitCode: null, cols: 120, rows: 36, transcriptPath: tp,
    };
    const cards = [
      { id: 'fb1', taskId: 't-pend', sessionId: 's-pend', kind: 'feedback' as const, body: '对话模式支持复制 md 和视频文件', createdAt: t1 - 200 },
    ];

    // 1. Offline / fallback path (no pendingInputs): earlier fb1 already appeared at step 0, must NOT resurrect after step 3!
    const fallbackRes = buildStreamData({ task, session, cards });
    expect(fallbackRes.blocks.at(-1)).toMatchObject({ kind: 'assistant', text: '虾哥，刚才已修复并关闭评审会话。' });
    expect(fallbackRes.blocks.filter(b => b.kind === 'user' && b.text.includes('md 和视频'))).toHaveLength(1);

    // 2. Live runtime path with empty queue: zero resurrection!
    const liveIdleRes = buildStreamData({ task, session, cards, pendingInputs: [] });
    expect(liveIdleRes.blocks.at(-1)).toMatchObject({ kind: 'assistant', text: '虾哥，刚才已修复并关闭评审会话。' });
    expect(liveIdleRes.blocks.filter(b => b.kind === 'user')).toHaveLength(2);

    // 3. Consecutive multi-send while working: both queued messages appear in FIFO order tagged `pending: 'queued'`,
    //    even if one repeats an earlier turn's text, while a landed `sending` item deduplicates cleanly!
    const liveQueuedRes = buildStreamData({
      task,
      session: { ...session, status: 'working', statusSince: t3 + 1000, queued: 2 },
      cards,
      pendingInputs: [
        { id: 'p-1', text: '评审者（Codex，第 2 轮）给出了评审结论', at: t2, state: 'sending' },
        { id: 'p-2', text: '连续第 1 条排队消息', at: t3 + 1100, state: 'queued' },
        { id: 'p-3', text: '连续第 2 条排队消息', at: t3 + 1200, state: 'queued' },
      ],
    });
    const tail2 = liveQueuedRes.blocks.slice(-2);
    expect(tail2).toEqual([
      { id: 'pending-p-2', kind: 'user', text: '连续第 1 条排队消息', at: t3 + 1100, pending: 'queued', pendingId: 'p-2' },
      { id: 'pending-p-3', kind: 'user', text: '连续第 2 条排队消息', at: t3 + 1200, pending: 'queued', pendingId: 'p-3' },
    ]);
  });
});
