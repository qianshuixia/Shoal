import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivityPhase, ActivityStep, AgentKind, SessionActivity, SessionInfo } from '../shared/protocol.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const MAX_RECENT_STEPS = 10;
const MAX_FILES = 16;
const INITIAL_TAIL_WINDOW = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cut = (s: string, max: number) => {
  const clean = s.replace(/\s+/g, ' ').trim();
  const cps = [...clean];
  return cps.length > max ? cps.slice(0, max).join('') + '…' : clean;
};

const baseOf = (p: string) => {
  const norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return norm.split('/').pop() || norm;
};

// Antigravity CLI serializes values inside `tool_calls[].args` as JSON-encoded strings (e.g. `"\"检索配置\""`).
// Unwraps one layer of JSON stringification while leaving plain strings untouched.
export function unquoteArg(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return v;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('{') && t.endsWith('}')) ||
    (t.startsWith('[') && t.endsWith(']')) ||
    t === 'true' || t === 'false' || t === 'null' ||
    /^-?\d+(?:\.\d+)?$/.test(t)
  ) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

function unquoteArgs(raw: unknown): Obj {
  if (!isObj(raw)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) out[k] = unquoteArg(v);
  return out;
}

// Resolves the live transcript file for a session.
// By default prefers compact `transcript.jsonl` (~70% smaller, flushed immediately on PLANNER_RESPONSE and GENERIC)
// for lightweight activity polling. Pass `{ preferFull: true }` for rich conversation rendering so long assistant
// replies and tables are never cut off with `<truncated N bytes>`.
export function resolveLiveTranscript(
  session: Pick<SessionInfo, 'agent' | 'nativeSessionId' | 'transcriptPath'>,
  opts?: { preferFull?: boolean },
): string | undefined {
  const tp = session.transcriptPath ? path.resolve(session.transcriptPath.replace(/^\\\\\?\\/, '')) : undefined;
  if (session.agent !== 'agy') {
    return tp && fs.existsSync(tp) ? tp : undefined;
  }
  const preferFull = !!opts?.preferFull;
  const order = preferFull ? ['transcript_full.jsonl', 'transcript.jsonl'] : ['transcript.jsonl', 'transcript_full.jsonl'];
  if (tp) {
    const dir = path.dirname(tp);
    for (const name of order) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (fs.existsSync(tp)) return tp;
  }
  const id = session.nativeSessionId;
  if (id && UUID_RE.test(id)) {
    const logsDir = path.join(
      process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'),
      'brain', id, '.system_generated', 'logs',
    );
    for (const name of order) {
      const f = path.join(logsDir, name);
      if (fs.existsSync(f)) return f;
    }
  }
  return undefined;
}

export interface ParsedToolSummary {
  summary: string;
  detail: string;
  subagent: boolean;
  filesRead: string[];
  filesWritten: string[];
}

export function summarizeToolCall(rawName: string, rawArgs: unknown): ParsedToolSummary {
  const args = unquoteArgs(rawArgs);
  const shortName = rawName.replace(/^mcp_[^_]+_/, '').split(':').pop() ?? rawName;
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  const addRead = (p: unknown) => { if (typeof p === 'string' && p.trim()) filesRead.push(p.trim()); };
  const addWrite = (p: unknown) => { if (typeof p === 'string' && p.trim()) filesWritten.push(p.trim()); };

  const explicit = str(args.toolSummary) || str(args.Description) || str(args.description);

  switch (shortName) {
    case 'read_file':
    case 'Read': {
      const p = str(args.Path || args.file_path || args.path);
      addRead(p);
      return { summary: p ? `读取 ${baseOf(p)}` : '读取文件', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'read_files_batch': {
      const list = Array.isArray(args.files) ? args.files : Array.isArray(args.paths) ? args.paths : [];
      for (const it of list) {
        if (typeof it === 'string') addRead(it);
        else if (isObj(it)) addRead(it.path || it.Path);
      }
      const n = filesRead.length || list.length;
      const first = filesRead[0] ? `（${baseOf(filesRead[0])} 等）` : '';
      return { summary: `批量读取 ${n} 个文件${first}`, detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'Edit':
    case 'MultiEdit': {
      const p = str(args.Path || args.TargetFile || args.file_path || args.path);
      addWrite(p);
      return { summary: p ? `修改 ${baseOf(p)}` : '修改文件', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'write_file':
    case 'write_to_file':
    case 'Write': {
      const p = str(args.Path || args.TargetFile || args.file_path || args.path);
      addWrite(p);
      return { summary: p ? `写入 ${baseOf(p)}` : '写入文件', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'grep_search':
    case 'fast_search':
    case 'Grep': {
      const q = str(args.Query || args.query || args.pattern);
      return { summary: q ? `搜索「${cut(q, 24)}」` : '搜索代码', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'find_by_name':
    case 'fast_glob':
    case 'Glob': {
      const pat = str(args.Pattern || args.pattern);
      return { summary: pat ? `查找文件 ${cut(pat, 24)}` : '查找文件', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'list_dir':
    case 'fast_tree': {
      const dir = str(args.DirectoryPath || args.path);
      return { summary: dir ? `浏览目录 ${baseOf(dir)}` : '浏览目录树', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'run_command':
    case 'Bash':
    case 'exec_command':
    case 'shell': {
      if (explicit) return { summary: cut(explicit, 42), detail: rawName, subagent: false, filesRead, filesWritten };
      const cmd = str(args.CommandLine || args.command || args.cmd);
      return { summary: cmd ? `执行命令：${cut(cmd, 28)}` : '执行终端命令', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    case 'invoke_subagent':
    case 'Agent':
    case 'Task': {
      const role = str(args.Role || args.description || args.TypeName || args.subagent_type);
      return { summary: role ? `子代理：${cut(role, 32)}` : '调用子代理', detail: rawName, subagent: true, filesRead, filesWritten };
    }
    case 'swarm':
    case 'swarm_wait': {
      if (shortName === 'swarm_wait') return { summary: '等待 Swarm 成员汇报…', detail: rawName, subagent: true, filesRead, filesWritten };
      const act = str(args.action);
      const name = str(args.name);
      return {
        summary: `Swarm ${act || '协作'}${name ? ` (${name})` : ''}`,
        detail: rawName,
        subagent: act === 'add',
        filesRead,
        filesWritten,
      };
    }
    case 'search_web':
    case 'WebSearch': {
      const q = str(args.query);
      return { summary: q ? `检索网页「${cut(q, 24)}」` : '检索网页', detail: rawName, subagent: false, filesRead, filesWritten };
    }
    default: {
      if (explicit) return { summary: cut(explicit, 42), detail: rawName, subagent: false, filesRead, filesWritten };
      return { summary: `调用 ${cut(shortName, 30)}`, detail: rawName, subagent: false, filesRead, filesWritten };
    }
  }
}

// Reads complete UTF-8 lines appended after `offset`, holding back any partial trailing line without '\n'.
function readNewLines(file: string, offset: number): { lines: string[]; next: number; truncated: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let truncated = false;
    if (size < offset) {
      offset = 0;
      truncated = true;
    }
    if (size === offset) return { lines: [], next: offset, truncated };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) return { lines: [], next: offset, truncated };
    const text = buf.subarray(0, nl + 1).toString('utf8');
    return { lines: text.split('\n'), next: offset + nl + 1, truncated };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function safeFileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function initialOffsetFor(file: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= INITIAL_TAIL_WINDOW) return 0;
    const start = size - INITIAL_TAIL_WINDOW;
    const probe = Buffer.alloc(Math.min(4096, size - start));
    const n = fs.readSync(fd, probe, 0, probe.length, start);
    const nl = probe.subarray(0, n).indexOf(0x0a);
    return nl >= 0 ? start + nl + 1 : start;
  } catch {
    return 0;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

interface TrackedSession {
  state: SessionActivity;
  file?: string;
  offset: number;
  pendingTools: number;
  seenKeys: Set<string>;
  lastBroadcastJson: string;
}

const addUnique = (arr: string[], items: string[], cap: number) => {
  for (const raw of items) {
    const clean = raw.replace(/^\\\\\?\\/, '');
    const existing = arr.indexOf(clean);
    if (existing >= 0) arr.splice(existing, 1);
    arr.push(clean);
    if (arr.length > cap) arr.shift();
  }
};

const pushStep = (arr: ActivityStep[], step: ActivityStep) => {
  arr.push(step);
  if (arr.length > MAX_RECENT_STEPS) arr.shift();
};

const resetForNewUserTurn = (t: TrackedSession, at: number) => {
  const st = t.state;
  t.pendingTools = 0;
  st.stepCount = 0;
  st.recentSteps = [];
  st.filesRead = [];
  st.filesWritten = [];
  delete st.thinkingSnippet;
  st.phase = 'thinking';
  st.summary = '正在分析需求与规划…';
  st.lastProgressAt = Math.max(st.lastProgressAt, at);
};

function applyAgyRecord(v: Obj, tracked: TrackedSession, nowMs: number) {
  const st = tracked.state;
  const type = str(v.type);
  const stepIdx = typeof v.step_index === 'number' ? v.step_index : -1;
  const status = str(v.status);
  if (stepIdx >= 0) {
    const key = `${stepIdx}:${type}:${status}`;
    if (tracked.seenKeys.has(key)) return;
    tracked.seenKeys.add(key);
  }
  const createdMs = Date.parse(str(v.created_at));
  const obsAt = Number.isFinite(createdMs) ? Math.max(st.turnStartedAt, Math.min(nowMs, createdMs)) : nowMs;
  if (str(v.model)) st.model = str(v.model);

  if (type === 'USER_INPUT' && v.source === 'USER_EXPLICIT') {
    resetForNewUserTurn(tracked, nowMs);
    return;
  }

  if (type === 'PLANNER_RESPONSE') {
    st.lastProgressAt = nowMs;
    const content = str(v.content).trim();
    const thinking = str(v.thinking).trim();
    if (content) st.thinkingSnippet = cut(content.split(/\r?\n/).find(l => l.trim()) ?? content, 140);
    else if (thinking) st.thinkingSnippet = cut(thinking.split(/\r?\n/).find(l => l.trim()) ?? thinking, 140);

    for (const s of st.recentSteps) if (s.status === 'running') s.status = 'done';

    const calls = Array.isArray(v.tool_calls) ? v.tool_calls.filter(isObj) : [];
    tracked.pendingTools = calls.length;
    if (calls.length > 0) {
      const parsed = calls.map(c => summarizeToolCall(str(c.name), c.args));
      let anySubagent = false;
      for (const p of parsed) {
        if (p.subagent) anySubagent = true;
        addUnique(st.filesRead, p.filesRead, MAX_FILES);
        addUnique(st.filesWritten, p.filesWritten, MAX_FILES);
        st.stepCount++;
        pushStep(st.recentSteps, { at: obsAt, kind: 'tool', summary: p.summary, detail: p.detail, status: 'running' });
      }
      st.phase = anySubagent ? 'subagent' : 'tool';
      st.summary = parsed.length === 1
        ? parsed[0].summary
        : `并行调用 ${parsed.length} 个工具：${cut(parsed[0].summary, 24)} 等`;
    } else {
      st.stepCount++;
      st.phase = 'thinking';
      const line = content ? cut(content.split(/\r?\n/).find(l => l.trim()) ?? content, 42) : '生成回复内容…';
      st.summary = line;
      pushStep(st.recentSteps, { at: obsAt, kind: 'plan', summary: line, status: 'done' });
    }
    return;
  }

  if (type === 'GENERIC') {
    st.lastProgressAt = nowMs;
    if (tracked.pendingTools > 0) tracked.pendingTools--;
    const running = st.recentSteps.find(s => s.kind === 'tool' && s.status === 'running');
    if (running) running.status = status === 'ERROR' ? 'error' : 'done';
    const stillRunning = st.recentSteps.filter(s => s.kind === 'tool' && s.status === 'running');
    if (tracked.pendingTools > 0) {
      st.summary = tracked.pendingTools === 1 && stillRunning[0]
        ? stillRunning[0].summary
        : `剩余 ${tracked.pendingTools} 个并行工具${stillRunning[0] ? `：${cut(stillRunning[0].summary, 24)}` : ''}`;
    } else {
      for (const s of stillRunning) s.status = status === 'ERROR' ? 'error' : 'done';
      if (st.phase === 'tool' || st.phase === 'subagent') {
        st.phase = 'thinking';
        st.summary = '工具已返回，正在推理下一步…';
      }
    }
    return;
  }

  if (type === 'CHECKPOINT') {
    st.lastProgressAt = nowMs;
    st.phase = 'compacting';
    st.summary = '正在压缩长上下文检查点…';
    pushStep(st.recentSteps, { at: obsAt, kind: 'note', summary: st.summary, status: 'done' });
    return;
  }

  if (type === 'ERROR_MESSAGE') {
    st.lastProgressAt = nowMs;
    st.phase = 'error';
    const errText = cut(str(v.content) || '流连接或请求异常', 42);
    st.summary = `异常恢复中：${errText}`;
    pushStep(st.recentSteps, { at: obsAt, kind: 'error', summary: st.summary, status: 'error' });
  }
}

function applyClaudeRecord(v: Obj, tracked: TrackedSession, nowMs: number) {
  if (v.isSidechain === true) return;
  const st = tracked.state;
  const msg = isObj(v.message) ? v.message : {};
  const content = msg.content;
  if (v.type === 'user') {
    const hasToolResult = Array.isArray(content) && content.some(b => isObj(b) && b.type === 'tool_result');
    if (hasToolResult) {
      st.lastProgressAt = nowMs;
      tracked.pendingTools = 0;
      for (const s of st.recentSteps) if (s.status === 'running') s.status = 'done';
      if (st.phase === 'tool' || st.phase === 'subagent') {
        st.phase = 'thinking';
        st.summary = '工具已返回，正在推理下一步…';
      }
    } else if (v.isMeta !== true) {
      resetForNewUserTurn(tracked, nowMs);
    }
    return;
  }
  if (v.type === 'assistant' && Array.isArray(content)) {
    st.lastProgressAt = nowMs;
    if (str(msg.model)) st.model = str(msg.model);
    for (const s of st.recentSteps) if (s.status === 'running') s.status = 'done';
    const tools = content.filter((b): b is Obj => isObj(b) && b.type === 'tool_use');
    const texts = content.filter((b): b is Obj => isObj(b) && b.type === 'text' && Boolean(str(b.text).trim()));
    if (texts.length) st.thinkingSnippet = cut(str(texts.at(-1)!.text), 140);
    tracked.pendingTools = tools.length;
    if (tools.length) {
      const parsed = tools.map(t => summarizeToolCall(str(t.name), t.input));
      for (const p of parsed) {
        addUnique(st.filesRead, p.filesRead, MAX_FILES);
        addUnique(st.filesWritten, p.filesWritten, MAX_FILES);
        st.stepCount++;
        pushStep(st.recentSteps, { at: nowMs, kind: 'tool', summary: p.summary, detail: p.detail, status: 'running' });
      }
      st.phase = parsed.some(p => p.subagent) ? 'subagent' : 'tool';
      st.summary = parsed.length === 1 ? parsed[0].summary : `并行调用 ${parsed.length} 个工具：${cut(parsed[0].summary, 24)} 等`;
    } else if (texts.length) {
      st.phase = 'thinking';
      st.summary = cut(str(texts.at(-1)!.text), 42);
    }
  }
}

function applyCodexRecord(v: Obj, tracked: TrackedSession, nowMs: number) {
  const st = tracked.state;
  const p = isObj(v.payload) ? v.payload : null;
  if (v.type === 'turn_context' && p && str(p.model)) {
    st.model = str(p.model);
    return;
  }
  if (v.type === 'event_msg' && p && p.type === 'user_message') {
    resetForNewUserTurn(tracked, nowMs);
    return;
  }
  if (v.type !== 'response_item' || !p) return;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    st.lastProgressAt = nowMs;
    tracked.pendingTools++;
    for (const s of st.recentSteps) if (s.status === 'running') s.status = 'done';
    let parsedArgs: unknown = {};
    if (typeof p.arguments === 'string') {
      try { parsedArgs = JSON.parse(p.arguments); } catch { parsedArgs = { cmd: p.arguments }; }
    } else if (typeof p.input === 'string') {
      parsedArgs = { cmd: p.input };
    }
    const info = summarizeToolCall(str(p.name), parsedArgs);
    addUnique(st.filesRead, info.filesRead, MAX_FILES);
    addUnique(st.filesWritten, info.filesWritten, MAX_FILES);
    st.stepCount++;
    st.phase = info.subagent ? 'subagent' : 'tool';
    st.summary = info.summary;
    pushStep(st.recentSteps, { at: nowMs, kind: 'tool', summary: info.summary, detail: info.detail, status: 'running' });
  } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    st.lastProgressAt = nowMs;
    if (tracked.pendingTools > 0) tracked.pendingTools--;
    for (const s of st.recentSteps) if (s.status === 'running') s.status = 'done';
    if (tracked.pendingTools === 0 && (st.phase === 'tool' || st.phase === 'subagent')) {
      st.phase = 'thinking';
      st.summary = '工具已返回，正在推理下一步…';
    }
  } else if (p.type === 'message' && p.role === 'assistant') {
    st.lastProgressAt = nowMs;
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b): b is Obj => isObj(b) && b.type === 'output_text')
      .map(b => str(b.text)).join('').trim();
    if (text) {
      st.thinkingSnippet = cut(text, 140);
      st.phase = 'thinking';
      st.summary = cut(text, 42);
    }
  }
}

export interface ActivityTracker {
  all(): Record<string, SessionActivity>;
  get(sessionId: string): SessionActivity | undefined;
  hasActive(): boolean;
  onSessionChange(session: SessionInfo): void;
  onHook(session: SessionInfo, event: string, payload: Record<string, unknown>, opts?: { intermediateStop?: boolean }): void;
  onRemove(sessionId: string): void;
  tick(): void;
}

export function createActivityTracker(opts: {
  sessions: () => SessionInfo[];
  onUpdate: (sessionId: string, activity: SessionActivity | null) => void;
  now?: () => number;
}): ActivityTracker {
  const now = opts.now ?? Date.now;
  const map = new Map<string, TrackedSession>();
  const lastEndOffsets = new Map<string, { file: string; offset: number }>();

  const cloneActivity = (st: SessionActivity): SessionActivity => ({
    ...st,
    recentSteps: st.recentSteps.map(s => ({ ...s })),
    filesRead: [...st.filesRead],
    filesWritten: [...st.filesWritten],
  });

  const emitIfChanged = (t: TrackedSession) => {
    const json = JSON.stringify(t.state);
    if (json === t.lastBroadcastJson) return;
    t.lastBroadcastJson = json;
    opts.onUpdate(t.state.sessionId, cloneActivity(t.state));
  };

  const resolveStartOffset = (sessionId: string, file: string): number => {
    const prev = lastEndOffsets.get(sessionId);
    if (prev && prev.file === file) {
      const sz = safeFileSize(file);
      if (sz >= prev.offset) return prev.offset;
    }
    return initialOffsetFor(file);
  };

  const ensureWorking = (session: SessionInfo): TrackedSession => {
    let t = map.get(session.id);
    const tNow = now();
    if (!t) {
      const turnStart = session.status === 'working' && session.statusSince > 0 ? Math.min(tNow, session.statusSince) : tNow;
      t = {
        state: {
          sessionId: session.id,
          turnStartedAt: turnStart,
          lastProgressAt: tNow,
          phase: 'thinking',
          summary: '正在分析需求与规划…',
          stepCount: 0,
          recentSteps: [],
          filesRead: [],
          filesWritten: [],
        },
        offset: 0,
        pendingTools: 0,
        seenKeys: new Set(),
        lastBroadcastJson: '',
      };
      map.set(session.id, t);
    }
    const resolved = resolveLiveTranscript(session);
    if (resolved && resolved !== t.file) {
      t.file = resolved;
      t.offset = resolveStartOffset(session.id, resolved);
      t.seenKeys.clear();
    }
    return t;
  };

  const pollOne = (session: SessionInfo, t: TrackedSession) => {
    const resolved = resolveLiveTranscript(session);
    if (resolved && resolved !== t.file) {
      t.file = resolved;
      t.offset = resolveStartOffset(session.id, resolved);
      t.seenKeys.clear();
    }
    if (!t.file) return;
    const chunk = readNewLines(t.file, t.offset);
    if (!chunk) return;
    if (chunk.truncated) {
      t.seenKeys.clear();
      t.pendingTools = 0;
    }
    if (chunk.next === t.offset && !chunk.truncated) return;
    t.offset = chunk.next;
    lastEndOffsets.set(session.id, { file: t.file, offset: t.offset });
    const tNow = now();
    for (const rawLine of chunk.lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!isObj(obj)) continue;
      if (session.agent === 'agy' || session.agent === 'fake') applyAgyRecord(obj, t, tNow);
      else if (session.agent === 'claude') applyClaudeRecord(obj, t, tNow);
      else if (session.agent === 'codex') applyCodexRecord(obj, t, tNow);
    }
  };

  const drop = (sessionId: string, forgetOffset = false) => {
    const existing = map.get(sessionId);
    if (forgetOffset) {
      lastEndOffsets.delete(sessionId);
    } else if (existing?.file) {
      lastEndOffsets.set(sessionId, {
        file: existing.file,
        offset: Math.max(existing.offset, safeFileSize(existing.file)),
      });
    }
    if (!map.delete(sessionId)) return;
    opts.onUpdate(sessionId, null);
  };

  return {
    all() {
      const out: Record<string, SessionActivity> = {};
      for (const [id, t] of map) out[id] = cloneActivity(t.state);
      return out;
    },
    get(sessionId: string) {
      const t = map.get(sessionId);
      return t ? cloneActivity(t.state) : undefined;
    },
    hasActive: () => map.size > 0,
    onSessionChange(session: SessionInfo) {
      if (session.status !== 'working') {
        drop(session.id);
        return;
      }
      if (session.agent === 'fake' && !session.transcriptPath) return;
      const t = ensureWorking(session);
      pollOne(session, t);
      emitIfChanged(t);
    },
    onHook(session: SessionInfo, event: string, payload: Record<string, unknown>, hookOpts?: { intermediateStop?: boolean }) {
      if (event === 'RateLimits') return;
      if (event === 'Stop' && !hookOpts?.intermediateStop) {
        const resolved = resolveLiveTranscript(session);
        if (resolved) {
          lastEndOffsets.set(session.id, { file: resolved, offset: safeFileSize(resolved) });
        }
        drop(session.id);
        return;
      }
      if (session.status !== 'working' && event !== 'PreInvocation' && event !== 'UserPromptSubmit' && !hookOpts?.intermediateStop) {
        return;
      }
      const t = ensureWorking(session);
      const tNow = now();
      const model = str(session.agent === 'agy' ? payload.modelName : payload.model);
      if (model) t.state.model = model;

      if (hookOpts?.intermediateStop) {
        t.state.lastProgressAt = tNow;
        t.state.phase = 'subagent';
        t.state.summary = '等待子代理或后台任务完成…';
        pollOne(session, t);
        emitIfChanged(t);
        return;
      }

      if (event === 'UserPromptSubmit') {
        t.state.turnStartedAt = tNow;
        resetForNewUserTurn(t, tNow);
      } else if (event === 'PreInvocation') {
        t.state.lastProgressAt = tNow;
        t.state.phase = 'thinking';
        t.state.summary = t.state.stepCount > 0 ? '正在推理下一步…' : '正在分析需求与规划…';
      } else if (event === 'PostInvocation') {
        t.state.lastProgressAt = tNow;
      }

      pollOne(session, t);
      emitIfChanged(t);
    },
    onRemove(sessionId: string) {
      drop(sessionId, true);
    },
    tick() {
      const byId = new Map(opts.sessions().map(s => [s.id, s]));
      for (const [id, t] of [...map.entries()]) {
        const s = byId.get(id);
        if (!s || s.status !== 'working') {
          drop(id);
          continue;
        }
        pollOne(s, t);
        emitIfChanged(t);
      }
    },
  };
}
