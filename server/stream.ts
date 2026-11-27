import fs from 'node:fs';
import type {
  AgentKind, Card, PromptView, SessionActivity, SessionInfo, SessionStreamState,
  StreamBlock, StreamTodoItem, StreamTodoStatus, StreamToolEntry, Task,
} from '../shared/protocol.ts';
import { composeLiveTail, dedupeLiveAnswer, extractPtyLiveFromLines, normForDedupe } from '../shared/ptyLive.ts';
import { resolveLiveTranscript, summarizeToolCall, unquoteArg } from './activity.ts';
import { piConversation } from './piTranscript.ts';
import { readPrompt } from './prompt.ts';
import { cleanAgyUserInput } from './transcript.ts';

export { composeLiveTail, dedupeLiveAnswer, extractPtyLiveFromLines };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const FULL_READ = 4 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_BLOCK_TEXT = 64_000;
const MAX_THINKING_TEXT = 24_000;
const TRANSCRIPT_POLL_MS = 120;
const PROMPT_POLL_MS = 350;

const SKIP_USER_PREFIX = ['<command-', '<local-command', '<system-reminder>'];

const cap = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…\n（内容过长已截断）` : s;

function parseMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

function calcThinkingSec(prevAt: number | undefined, curAt: number | undefined): number | undefined {
  if (!prevAt || !curAt || curAt <= prevAt) return undefined;
  const deltaMs = curAt - prevAt;
  if (deltaMs < 400 || deltaMs > 60 * 60 * 1000) return undefined;
  return Math.max(1, Math.round(deltaMs / 1000));
}

function toolDetail(name: string, rawArgs: unknown): string | undefined {
  const args = isObj(rawArgs) ? rawArgs : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = unquoteArg(args[k]);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const val = pick('CommandLine', 'command', 'cmd', 'Path', 'TargetFile', 'file_path', 'path', 'Query', 'query', 'pattern', 'Pattern');
  if (!val) return undefined;
  const oneLine = val.replace(/\s+/g, ' ').trim();
  const cps = [...oneLine];
  const clipped = cps.length > 140 ? cps.slice(0, 140).join('') + '…' : oneLine;
  return `${name}: ${clipped}`;
}

function readTranscriptRaw(file: string, branched = false): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= FULL_READ || branched) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        return buf.toString('utf8');
      }
      const head = Buffer.alloc(HEAD_BYTES);
      fs.readSync(fd, head, 0, HEAD_BYTES, 0);
      const tail = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
      const h = head.toString('utf8');
      const t = tail.toString('utf8');
      return h.slice(0, h.lastIndexOf('\n') + 1) + t.slice(t.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function mergeUniqueFiles(a: string[], b: string[]): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...a, ...b]) {
    const clean = raw.replace(/^\\\\\?\\/, '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.length ? out : undefined;
}

function normalizeTodoStatus(raw: unknown): StreamTodoStatus {
  const s = str(raw).toLowerCase();
  if (s === 'done' || s === 'completed') return 'done';
  if (s === 'in_progress' || s === 'running' || s === 'active') return 'in_progress';
  if (s === 'skipped' || s === 'cancelled' || s === 'canceled') return 'skipped';
  if (s === 'failed' || s === 'error') return 'failed';
  return 'pending';
}

// Extracts latest live checklist items from agy (`update_steps`), Claude (`TodoWrite`), or Codex (`update_plan`).
export function extractTodosFromToolCall(rawName: string, rawArgs: unknown): StreamTodoItem[] | null {
  const shortName = rawName.replace(/^mcp_[^_]+_/, '').split(':').pop() ?? rawName;
  const unwrapped = isObj(rawArgs) ? rawArgs : unquoteArg(rawArgs);
  if (!isObj(unwrapped)) return null;

  let list: unknown = null;
  if (shortName === 'update_steps') list = unquoteArg(unwrapped.steps);
  else if (shortName === 'TodoWrite') list = unquoteArg(unwrapped.todos);
  else if (shortName === 'update_plan') list = unquoteArg(unwrapped.plan);
  else return null;

  if (!Array.isArray(list)) return null;
  const items: StreamTodoItem[] = [];
  for (const rawItem of list) {
    const item = isObj(rawItem) ? rawItem : unquoteArg(rawItem);
    if (!isObj(item)) continue;
    const title = str(item.title || item.content || item.step || item.activeForm).trim();
    if (!title) continue;
    items.push({ title, status: normalizeTodoStatus(item.status) });
  }
  return items;
}

function todoToolSummary(items: StreamTodoItem[]): string {
  if (items.length === 0) return '清空任务清单';
  const done = items.filter(i => i.status === 'done').length;
  return done > 0 ? `更新任务清单（已完成 ${done}/${items.length}）` : `更新任务清单（共 ${items.length} 项）`;
}

export interface ParsedTranscriptStream {
  blocks: StreamBlock[];
  todos: StreamTodoItem[];
}

// Parses a CLI transcript (JSONL) into rich video-style blocks + latest live todo checklist.
export function parseStreamData(agent: AgentKind, raw: string, keyPrefix = 's', leaf?: string | null): ParsedTranscriptStream {
  const blocks: StreamBlock[] = [];
  let latestTodos: StreamTodoItem[] = [];
  const toolIndex = new Map<string, { step: Extract<StreamBlock, { kind: 'step' }>; entry: StreamToolEntry }>();
  let seq = 0;
  let lastEventAt: number | undefined;
  let pendingCodexThinking = '';
  let pendingCodexAt: number | undefined;
  const seenAgyKeys = new Set<string>();

  const nextId = (kind: string) => `${keyPrefix}-${kind}-${seq++}`;

  const markLatestStepAllDone = () => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'step') {
        if (b.active) {
          b.active = false;
          for (const t of b.tools) if (t.status === 'running') t.status = 'done';
        }
        break;
      }
      if (b.kind === 'user') break;
    }
  };

  // Marks one running tool in the latest active step complete (for per-tool GENERIC DONE/ERROR records).
  const markNextRunningTool = (failed: boolean) => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'step') {
        if (b.active) {
          const running = b.tools.find(t => t.status === 'running');
          if (running) running.status = failed ? 'error' : 'done';
          if (b.tools.every(t => t.status !== 'running')) b.active = false;
        }
        break;
      }
      if (b.kind === 'user') break;
    }
  };

  const applyAgy = (v: Obj) => {
    const type = str(v.type);
    const stepIdx = typeof v.step_index === 'number'
      ? v.step_index
      : typeof v.step_index === 'string' && /^\d+$/.test(v.step_index)
        ? Number(v.step_index)
        : -1;
    const status = str(v.status).toUpperCase();
    const at = parseMs(v.created_at);
    const model = str(v.model) || undefined;

    if (type === 'USER_INPUT') {
      if (v.source !== 'USER_EXPLICIT') return;
      if (stepIdx >= 0) {
        const key = `${stepIdx}:USER_INPUT`;
        if (seenAgyKeys.has(key)) return;
        seenAgyKeys.add(key);
      }
      markLatestStepAllDone();
      const text = cleanAgyUserInput(str(v.content));
      if (text) {
        blocks.push({
          id: stepIdx >= 0 ? `${keyPrefix}-agy-u-${stepIdx}` : nextId('u'),
          kind: 'user',
          text: cap(text, MAX_BLOCK_TEXT),
          at,
        });
      }
      if (at) lastEventAt = at;
      return;
    }

    if (type === 'PLANNER_RESPONSE') {
      if (stepIdx >= 0) {
        const key = `${stepIdx}:PLANNER_RESPONSE`;
        if (seenAgyKeys.has(key)) return;
        seenAgyKeys.add(key);
      }
      markLatestStepAllDone();
      const thinking = str(v.thinking).trim();
      const content = str(v.content).trim();
      const calls = Array.isArray(v.tool_calls) ? v.tool_calls.filter(isObj) : [];
      const tools: StreamToolEntry[] = calls.map((c, idx) => {
        const rawName = str(c.name) || 'tool';
        const todoUpdate = extractTodosFromToolCall(rawName, c.args);
        if (todoUpdate) latestTodos = todoUpdate;
        const parsed = summarizeToolCall(rawName, c.args);
        const callId = str(c.id) || `agy-${stepIdx}-${idx}`;
        return {
          id: callId,
          name: rawName,
          summary: todoUpdate ? todoToolSummary(todoUpdate) : parsed.summary,
          detail: todoUpdate ? undefined : toolDetail(rawName, c.args),
          status: 'running',
          files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
        };
      });
      const thinkingSec = calcThinkingSec(lastEventAt, at);
      if (thinking || tools.length > 0) {
        blocks.push({
          id: stepIdx >= 0 ? `${keyPrefix}-agy-step-${stepIdx}` : nextId('step'),
          kind: 'step',
          ...(thinking ? { thinking: cap(thinking, MAX_THINKING_TEXT) } : {}),
          ...(thinkingSec ? { thinkingSec } : {}),
          tools,
          model,
          at,
          active: tools.length > 0,
        });
      }
      if (content) {
        blocks.push({
          id: stepIdx >= 0 ? `${keyPrefix}-agy-a-${stepIdx}` : nextId('a'),
          kind: 'assistant',
          text: cap(content, MAX_BLOCK_TEXT),
          model,
          at,
        });
      }
      if (at) lastEventAt = at;
      return;
    }

    if (type === 'GENERIC') {
      // Real agy 1.5.x writes GENERIC with status=RUNNING while a tool starts, and status=DONE/ERROR once finished.
      if (status === 'RUNNING' || status === 'PENDING') return;
      if (stepIdx >= 0) {
        const key = `${stepIdx}:GENERIC:FINAL`;
        if (seenAgyKeys.has(key)) return;
        seenAgyKeys.add(key);
      }
      markNextRunningTool(status === 'ERROR' || status === 'FAILED');
      if (at) lastEventAt = at;
    }
  };

  const applyClaude = (v: Obj) => {
    if (v.isSidechain === true) return;
    const at = parseMs(v.timestamp);
    const message = isObj(v.message) ? v.message : {};
    const content = message.content;

    if (v.type === 'user') {
      if (v.isMeta === true) return;
      if (Array.isArray(content)) {
        let sawResult = false;
        const userParts: string[] = [];
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === 'tool_result') {
            sawResult = true;
            const id = str(b.tool_use_id);
            const hit = id ? toolIndex.get(id) : undefined;
            if (hit) {
              hit.entry.status = b.is_error === true ? 'error' : 'done';
              if (hit.step.tools.every(t => t.status !== 'running')) hit.step.active = false;
            }
          } else if (b.type === 'text') {
            const t = str(b.text).trim();
            if (t && !SKIP_USER_PREFIX.some(p => t.startsWith(p))) userParts.push(t);
          }
        }
        if (sawResult && userParts.length === 0) {
          if (at) lastEventAt = at;
          return;
        }
        const text = userParts.join('\n').trim();
        if (text) {
          markLatestStepAllDone();
          blocks.push({ id: nextId('u'), kind: 'user', text: cap(text, MAX_BLOCK_TEXT), at });
        }
      } else if (typeof content === 'string') {
        const text = content.trim();
        if (text && !SKIP_USER_PREFIX.some(p => text.startsWith(p))) {
          markLatestStepAllDone();
          blocks.push({ id: nextId('u'), kind: 'user', text: cap(text, MAX_BLOCK_TEXT), at });
        }
      }
      if (at) lastEventAt = at;
      return;
    }

    if (v.type === 'assistant') {
      if (v.isApiErrorMessage === true || !Array.isArray(content)) return;
      const model = str(message.model) || undefined;
      const thinkingParts: string[] = [];
      const textParts: string[] = [];
      const tools: StreamToolEntry[] = [];

      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'thinking') {
          const th = str(b.thinking).trim();
          if (th) thinkingParts.push(th);
        } else if (b.type === 'text') {
          const t = str(b.text).trim();
          if (t) textParts.push(t);
        } else if (b.type === 'tool_use') {
          const rawName = str(b.name) || 'tool';
          const todoUpdate = extractTodosFromToolCall(rawName, b.input);
          if (todoUpdate) latestTodos = todoUpdate;
          const parsed = summarizeToolCall(rawName, b.input);
          const id = str(b.id) || nextId('tool');
          tools.push({
            id,
            name: rawName,
            summary: todoUpdate ? todoToolSummary(todoUpdate) : parsed.summary,
            detail: todoUpdate ? undefined : toolDetail(rawName, b.input),
            status: 'running',
            files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
          });
        }
      }

      const thinking = thinkingParts.join('\n\n').trim();
      const thinkingSec = calcThinkingSec(lastEventAt, at);
      if (thinking || tools.length > 0) {
        const step: Extract<StreamBlock, { kind: 'step' }> = {
          id: nextId('step'),
          kind: 'step',
          ...(thinking ? { thinking: cap(thinking, MAX_THINKING_TEXT) } : {}),
          ...(thinkingSec ? { thinkingSec } : {}),
          tools,
          model,
          at,
          active: tools.length > 0,
        };
        blocks.push(step);
        for (const entry of tools) toolIndex.set(entry.id, { step, entry });
      }
      const text = textParts.join('\n\n').trim();
      if (text) {
        const prev = blocks.at(-1);
        if (prev && prev.kind === 'assistant' && !thinking && tools.length === 0) {
          prev.text = cap(`${prev.text}\n\n${text}`, MAX_BLOCK_TEXT);
        } else {
          blocks.push({ id: nextId('a'), kind: 'assistant', text: cap(text, MAX_BLOCK_TEXT), model, at });
        }
      }
      if (at) lastEventAt = at;
    }
  };

  const applyCodex = (v: Obj) => {
    if (v.type !== 'response_item' || !isObj(v.payload)) return;
    const p = v.payload;
    const at = parseMs(v.timestamp);

    if (p.type === 'reasoning') {
      const summary = Array.isArray(p.summary)
        ? p.summary.filter(isObj).map(x => str(x.text)).filter(Boolean).join('\n')
        : str(p.summary);
      if (summary.trim()) {
        pendingCodexThinking = pendingCodexThinking ? `${pendingCodexThinking}\n${summary.trim()}` : summary.trim();
        pendingCodexAt = at ?? pendingCodexAt;
      }
      return;
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const rawName = str(p.name) || 'tool';
      let args: unknown = p.arguments ?? p.input;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* keep string */ }
      }
      const todoUpdate = extractTodosFromToolCall(rawName, args);
      if (todoUpdate) latestTodos = todoUpdate;
      const parsed = summarizeToolCall(rawName, args);
      const id = str(p.call_id) || nextId('tool');
      const entry: StreamToolEntry = {
        id,
        name: rawName,
        summary: todoUpdate ? todoToolSummary(todoUpdate) : parsed.summary,
        detail: todoUpdate ? undefined : toolDetail(rawName, args),
        status: 'running',
        files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
      };
      const prev = blocks.at(-1);
      if (prev && prev.kind === 'step' && prev.active && !pendingCodexThinking) {
        prev.tools.push(entry);
        toolIndex.set(id, { step: prev, entry });
      } else {
        const step: Extract<StreamBlock, { kind: 'step' }> = {
          id: nextId('step'),
          kind: 'step',
          ...(pendingCodexThinking ? { thinking: cap(pendingCodexThinking, MAX_THINKING_TEXT) } : {}),
          ...(calcThinkingSec(lastEventAt, at ?? pendingCodexAt) ? { thinkingSec: calcThinkingSec(lastEventAt, at ?? pendingCodexAt) } : {}),
          tools: [entry],
          at: at ?? pendingCodexAt,
          active: true,
        };
        pendingCodexThinking = '';
        pendingCodexAt = undefined;
        blocks.push(step);
        toolIndex.set(id, { step, entry });
      }
      if (at) lastEventAt = at;
      return;
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const id = str(p.call_id);
      const hit = id ? toolIndex.get(id) : undefined;
      if (hit) {
        hit.entry.status = 'done';
        if (hit.step.tools.every(t => t.status !== 'running')) hit.step.active = false;
      }
      if (at) lastEventAt = at;
      return;
    }

    if (p.type === 'message') {
      if (p.role !== 'user' && p.role !== 'assistant') return;
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter((b): b is Obj => isObj(b) && (b.type === 'input_text' || b.type === 'output_text'))
        .map(b => str(b.text)).join('').trim();
      if (!text) return;
      if (p.role === 'user') {
        if (text.startsWith('# AGENTS.md instructions') || text.startsWith('<')) return;
        markLatestStepAllDone();
        pendingCodexThinking = '';
        blocks.push({ id: nextId('u'), kind: 'user', text: cap(text, MAX_BLOCK_TEXT), at });
      } else {
        if (pendingCodexThinking) {
          blocks.push({
            id: nextId('step'),
            kind: 'step',
            thinking: cap(pendingCodexThinking, MAX_THINKING_TEXT),
            ...(calcThinkingSec(lastEventAt, at ?? pendingCodexAt) ? { thinkingSec: calcThinkingSec(lastEventAt, at ?? pendingCodexAt) } : {}),
            tools: [],
            at: at ?? pendingCodexAt,
            active: false,
          });
          pendingCodexThinking = '';
          pendingCodexAt = undefined;
        }
        blocks.push({ id: nextId('a'), kind: 'assistant', text: cap(text, MAX_BLOCK_TEXT), at });
      }
      if (at) lastEventAt = at;
    }
  };

  const applyFake = (v: Obj) => {
    if (v.type === 'PLANNER_RESPONSE' || v.type === 'GENERIC' || v.type === 'USER_INPUT') {
      applyAgy(v);
      return;
    }
    const role = str(v.role);
    const text = str(v.text).trim();
    const thinking = str(v.thinking).trim();
    const at = parseMs(v.at);
    if (role === 'user' && text) {
      markLatestStepAllDone();
      blocks.push({ id: nextId('u'), kind: 'user', text: cap(text, MAX_BLOCK_TEXT), at });
    } else if (role === 'assistant') {
      markLatestStepAllDone();
      if (thinking) {
        blocks.push({
          id: nextId('step'),
          kind: 'step',
          thinking: cap(thinking, MAX_THINKING_TEXT),
          thinkingSec: calcThinkingSec(lastEventAt, at) ?? 1,
          tools: [],
          at,
          active: false,
        });
      }
      if (text) blocks.push({ id: nextId('a'), kind: 'assistant', text: cap(text, MAX_BLOCK_TEXT), at });
    }
    if (at) lastEventAt = at;
  };

  if (agent === 'pi') {
    for (const message of piConversation(raw, leaf)) applyClaude(message);
    return { blocks, todos: latestTodos };
  }
  const each = agent === 'claude' ? applyClaude : agent === 'codex' ? applyCodex : agent === 'agy' ? applyAgy : applyFake;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (isObj(parsed)) each(parsed);
  }
  return { blocks, todos: latestTodos };
}

export function parseStreamBlocks(agent: AgentKind, raw: string, keyPrefix = 's'): StreamBlock[] {
  return parseStreamData(agent, raw, keyPrefix).blocks;
}

export function buildStreamData(opts: {
  task: Task;
  session: SessionInfo | undefined;
  cards: Card[];
}): ParsedTranscriptStream {
  const { task, session } = opts;
  const taskCards = opts.cards.filter(c => c.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt);
  const tp = session ? resolveLiveTranscript(session, { preferFull: true }) : undefined;
  const agent = session?.agent ?? task.agent;
  const raw = tp ? readTranscriptRaw(tp, agent === 'pi') : null;
  const parsed = raw ? parseStreamData(agent, raw, session?.id ?? 's', session?.transcriptLeafId) : { blocks: [], todos: [] };
  const blocks: StreamBlock[] = [];

  if (parsed.blocks.length > 0) {
    for (const c of taskCards) {
      if (c.kind === 'handoff' || c.kind === 'forward') {
        blocks.push({ id: `card-${c.id}`, kind: 'card', card: c });
      }
    }
    if (!parsed.blocks.some(b => b.kind === 'user') && task.prompt.trim()) {
      blocks.push({ id: 'prompt-0', kind: 'user', text: cap(task.prompt.trim(), MAX_BLOCK_TEXT), at: task.createdAt });
    }
    blocks.push(...parsed.blocks);

    const lastUser = [...parsed.blocks].reverse().find(b => b.kind === 'user')?.text ?? '';
    const lastFeedback = [...taskCards].reverse().find(c => c.kind === 'feedback');
    if (lastFeedback && (!lastUser || !normForDedupe(lastUser).includes(normForDedupe(lastFeedback.body).slice(0, 80)))) {
      blocks.push({ id: `card-${lastFeedback.id}`, kind: 'user', text: cap(lastFeedback.body, MAX_BLOCK_TEXT), at: lastFeedback.createdAt });
    }
  } else {
    if (task.prompt.trim()) {
      blocks.push({ id: 'prompt-0', kind: 'user', text: cap(task.prompt.trim(), MAX_BLOCK_TEXT), at: task.createdAt });
    }
    for (const c of taskCards) {
      if (c.kind === 'feedback') blocks.push({ id: `card-${c.id}`, kind: 'user', text: cap(c.body, MAX_BLOCK_TEXT), at: c.createdAt });
      else if (c.kind === 'result') blocks.push({ id: `card-${c.id}`, kind: 'assistant', text: cap(c.body, MAX_BLOCK_TEXT), at: c.createdAt });
      else blocks.push({ id: `card-${c.id}`, kind: 'card', card: c });
    }
  }

  // If the session is no longer actively working, ensure no step remains stuck with a spinning running indicator.
  if (session?.status !== 'working') {
    for (const b of blocks) {
      if (b.kind === 'step' && b.active) {
        b.active = false;
        for (const t of b.tools) if (t.status === 'running') t.status = 'done';
      }
    }
  }
  return { blocks, todos: parsed.todos };
}

export function buildStreamBlocks(opts: {
  task: Task;
  session: SessionInfo | undefined;
  cards: Card[];
}): StreamBlock[] {
  return buildStreamData(opts).blocks;
}

// ---- Lightweight On-Demand Transcript & Prompt Watcher ----
// Live PTY tail is read directly from the browser's uncorrupted live @xterm/xterm buffer (zero slice corruption,
// zero duplicate server headless terminals, zero 65ms WS full-history rebroadcasts).

export interface StreamWatcherClient {
  readyState: number;
  send(data: string): void;
}

interface WatchedSession {
  sessionId: string;
  clients: Set<StreamWatcherClient>;
  lastTranscriptSig: string;
  cachedBlocks: StreamBlock[];
  cachedTodos: StreamTodoItem[];
  prompt: PromptView | null;
  promptSeq: number;
  lastPromptKey: string;
  rev: number;
  lastSentJson: string;
  disposed: boolean;
}

export interface StreamWatcherDeps {
  getSession(sessionId: string): SessionInfo | undefined;
  getTask(taskId: string): Task | undefined;
  getCards(): Card[];
  getActivity(sessionId: string): SessionActivity | null;
  getPromptWait(sessionId: string): { info: SessionInfo; waitSeq: number; outSeq: number; replay: string | null } | null;
  now?: () => number;
}

export function createStreamWatcher(deps: StreamWatcherDeps) {
  const now = deps.now ?? (() => Date.now());
  const watched = new Map<string, WatchedSession>();
  const clientSessions = new Map<StreamWatcherClient, Set<string>>();

  const transcriptSig = (session: SessionInfo | undefined): string => {
    if (!session) return '';
    const f = resolveLiveTranscript(session, { preferFull: true });
    if (!f) return '';
    try {
      const st = fs.statSync(f);
      return `${f}:${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      return '';
    }
  };

  const refreshBlocks = (w: WatchedSession, force = false): boolean => {
    const session = deps.getSession(w.sessionId);
    const task = session ? deps.getTask(session.taskId) : undefined;
    if (!session || !task) return false;
    const sig = `${transcriptSig(session)}|${session.transcriptLeafId ?? ''}|${session.status}|${deps.getCards().filter(c => c.taskId === task.id).length}`;
    if (!force && sig === w.lastTranscriptSig) return false;
    w.lastTranscriptSig = sig;
    const built = buildStreamData({ task, session, cards: deps.getCards() });
    w.cachedBlocks = built.blocks;
    w.cachedTodos = built.todos;
    return true;
  };

  const clearPrompt = (w: WatchedSession): boolean => {
    w.promptSeq++;
    w.lastPromptKey = '';
    if (w.prompt !== null) {
      w.prompt = null;
      return true;
    }
    return false;
  };

  const refreshPrompt = (w: WatchedSession) => {
    const session = deps.getSession(w.sessionId);
    if (!session?.blocked) {
      if (clearPrompt(w)) emitState(w);
      return;
    }
    const wait = deps.getPromptWait(w.sessionId);
    if (!wait) return;
    const key = `${wait.waitSeq}:${wait.outSeq}`;
    if (key === w.lastPromptKey) return;
    w.lastPromptKey = key;
    const seq = ++w.promptSeq;
    void readPrompt(wait.info, wait.waitSeq, wait.replay, t => t)
      .then(view => {
        if (w.disposed || seq !== w.promptSeq) return;
        if (!deps.getSession(w.sessionId)?.blocked) {
          if (clearPrompt(w)) emitState(w);
          return;
        }
        w.prompt = view;
        emitState(w);
      })
      .catch(() => {
        if (w.lastPromptKey === key) w.lastPromptKey = '';
      });
  };

  const buildPayload = (w: WatchedSession): SessionStreamState | null => {
    const session = deps.getSession(w.sessionId);
    if (!session) return null;
    const live = composeLiveTail({
      session,
      blocks: w.cachedBlocks,
      activity: deps.getActivity(w.sessionId),
      ptyExtract: null,
      now: now(),
    });
    return {
      sessionId: session.id,
      taskId: session.taskId,
      agent: session.agent,
      rev: w.rev + 1,
      blocks: w.cachedBlocks,
      ...(w.cachedTodos.length > 0 ? { todos: w.cachedTodos } : {}),
      live,
      prompt: session.blocked ? w.prompt : null,
    };
  };

  const emitState = (w: WatchedSession, targetClient?: StreamWatcherClient) => {
    if (w.disposed || w.clients.size === 0) return;
    const next = buildPayload(w);
    if (!next) return;
    const compareJson = JSON.stringify({
      ...next,
      rev: 0,
      live: next.live ? { ...next.live, updatedAt: 0 } : null,
    });
    if (compareJson !== w.lastSentJson) {
      w.rev = next.rev;
      w.lastSentJson = compareJson;
      const frame = JSON.stringify({ t: 'stream', state: next });
      for (const c of w.clients) if (c.readyState === 1) c.send(frame);
      return;
    }
    if (targetClient && targetClient.readyState === 1) {
      const frame = JSON.stringify({ t: 'stream', state: { ...next, rev: w.rev } });
      targetClient.send(frame);
    }
  };

  const disposeWatcher = (sessionId: string) => {
    const w = watched.get(sessionId);
    if (!w) return;
    w.disposed = true;
    for (const c of w.clients) {
      const set = clientSessions.get(c);
      if (set) {
        set.delete(sessionId);
        if (set.size === 0) clientSessions.delete(c);
      }
    }
    w.clients.clear();
    watched.delete(sessionId);
  };

  // Light 220ms transcript & prompt stat poll only for actively watched working/blocked sessions.
  let promptTickAcc = 0;
  const pollTimer = setInterval(() => {
    if (watched.size === 0) return;
    promptTickAcc += TRANSCRIPT_POLL_MS;
    const checkPrompts = promptTickAcc >= PROMPT_POLL_MS;
    if (checkPrompts) promptTickAcc = 0;
    for (const w of watched.values()) {
      const session = deps.getSession(w.sessionId);
      if (!session) continue;
      if (session.status === 'working' && refreshBlocks(w)) emitState(w);
      if (checkPrompts && session.blocked) refreshPrompt(w);
    }
  }, TRANSCRIPT_POLL_MS);
  pollTimer.unref();

  return {
    watch(client: StreamWatcherClient, sessionId: string) {
      if (!sessionId) return;
      let set = clientSessions.get(client);
      if (!set) {
        set = new Set();
        clientSessions.set(client, set);
      }
      set.add(sessionId);

      let w = watched.get(sessionId);
      if (!w) {
        w = {
          sessionId,
          clients: new Set(),
          lastTranscriptSig: '',
          cachedBlocks: [],
          cachedTodos: [],
          prompt: null,
          promptSeq: 0,
          lastPromptKey: '',
          rev: 0,
          lastSentJson: '',
          disposed: false,
        };
        watched.set(sessionId, w);
      }
      w.clients.add(client);

      const session = deps.getSession(sessionId);
      if (session) {
        refreshBlocks(w, true);
        emitState(w, client);
        if (session.blocked) refreshPrompt(w);
      }
    },

    unwatch(client: StreamWatcherClient, sessionId: string) {
      const set = clientSessions.get(client);
      if (set) {
        set.delete(sessionId);
        if (set.size === 0) clientSessions.delete(client);
      }
      const w = watched.get(sessionId);
      if (!w) return;
      w.clients.delete(client);
      if (w.clients.size === 0) disposeWatcher(sessionId);
    },

    unwatchClient(client: StreamWatcherClient) {
      const set = clientSessions.get(client);
      if (!set) return;
      for (const sid of [...set]) {
        const w = watched.get(sid);
        if (!w) continue;
        w.clients.delete(client);
        if (w.clients.size === 0) disposeWatcher(sid);
      }
      clientSessions.delete(client);
    },

    onSessionChange(session: SessionInfo) {
      const w = watched.get(session.id);
      if (!w || w.disposed) return;
      refreshBlocks(w);
      if (session.blocked) refreshPrompt(w);
      else clearPrompt(w);
      emitState(w);
    },

    onHook(sessionId: string) {
      const w = watched.get(sessionId);
      if (!w || w.disposed) return;
      refreshBlocks(w, true);
      emitState(w);
    },

    onActivity(sessionId: string) {
      const w = watched.get(sessionId);
      if (!w || w.disposed) return;
      refreshBlocks(w);
      emitState(w);
    },

    onTaskChange(taskId: string) {
      for (const w of watched.values()) {
        const s = deps.getSession(w.sessionId);
        if (s?.taskId === taskId) {
          refreshBlocks(w, true);
          emitState(w);
        }
      }
    },

    onRemoveSession(sessionId: string) {
      disposeWatcher(sessionId);
    },

    async snapshotFor(task: Task, session: SessionInfo | undefined): Promise<SessionStreamState> {
      const { blocks, todos } = buildStreamData({ task, session, cards: deps.getCards() });
      let prompt: PromptView | null = null;
      if (session?.blocked) {
        const wait = deps.getPromptWait(session.id);
        if (wait) prompt = await readPrompt(wait.info, wait.waitSeq, wait.replay, t => t);
      }
      const w = session ? watched.get(session.id) : undefined;
      const live = session
        ? composeLiveTail({
            session,
            blocks,
            activity: deps.getActivity(session.id),
            ptyExtract: null,
            now: now(),
          })
        : null;
      return {
        sessionId: session?.id ?? '',
        taskId: task.id,
        agent: session?.agent ?? task.agent,
        rev: w?.rev ?? 0,
        blocks,
        ...(todos.length > 0 ? { todos } : {}),
        live,
        prompt,
      };
    },

    watchedCount: () => watched.size,

    close() {
      clearInterval(pollTimer);
      for (const sid of [...watched.keys()]) disposeWatcher(sid);
      clientSessions.clear();
    },
  };
}
