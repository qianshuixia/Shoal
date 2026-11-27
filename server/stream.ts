import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentKind, Card, PromptView, SessionActivity, SessionInfo, SessionStreamState,
  StreamBlock, StreamSubagent, StreamSubagentStatus, StreamSubagentStep, StreamTodoItem, StreamTodoStatus, StreamToolEntry, Task,
} from '../shared/protocol.ts';
import {
  composeLiveTail, dedupeLiveAnswer, extractPtyLiveFromLines, extractPtyPromptDraft, extractPtyPromptState,
  parsePtySubagentLine,
} from '../shared/ptyLive.ts';
import { FALLBACK_CARD_SKEW_MS, PENDING_TRANSCRIPT_ADVANCE_MS, PENDING_USER_CLOCK_SKEW_MS, feedbackMatchesUserText } from '../shared/textMatch.ts';
import { resolveLiveTranscript, summarizeToolCall, unquoteArg } from './activity.ts';
import { readPrompt } from './prompt.ts';
import type { PendingUserInput } from './sessions.ts';
import { cleanAgyUserInput } from './transcript.ts';
import { readTranscriptRaw } from './stream/incrementalReader.ts';
import type { TranscriptRead } from './stream/incrementalReader.ts';

export { composeLiveTail, dedupeLiveAnswer, extractPtyLiveFromLines, extractPtyPromptDraft, extractPtyPromptState, parsePtySubagentLine };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const MAX_BLOCK_TEXT = 64_000;
const MAX_THINKING_TEXT = 24_000;
const SUBAGENT_TAIL_BYTES = 64 * 1024;
const MAX_VISIBLE_SUBAGENTS = 8;
const TRANSCRIPT_POLL_MS = 120;
const PROMPT_POLL_MS = 350;

const SKIP_USER_PREFIX = ['<command-', '<local-command', '<system-reminder>'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_RECEIPT_RE = /^Created the following subagent:\s*(\{[\s\S]*\})\s*$/i;
const SYSTEM_SENDER_RE = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const SYSTEM_CONTENT_RE = /\bcontent=([\s\S]+)$/;

const cap = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…\n（内容过长已截断）` : s;

function clipSummary(raw: string, max = 96): string {
  const first = raw
    .replace(/<\/?SYSTEM_MESSAGE>/gi, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^#+\s+/, '').replace(/[*_`]/g, '').trim())
    .find(Boolean) ?? '';
  const oneLine = first.replace(/\s+/g, ' ').trim();
  const cps = [...oneLine];
  return cps.length > max ? cps.slice(0, max).join('') + '…' : oneLine;
}

function unquoteObj(raw: unknown): Obj {
  const u = isObj(raw) ? raw : unquoteArg(raw);
  if (!isObj(u)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(u)) out[k] = unquoteArg(v);
  return out;
}

const isUnc = (file: string) => /^[\\/]{2}/.test(file);
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function agyBrainRoot(): string {
  return path.resolve(process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain');
}

function checkedChildPath(file: string): string | undefined {
  const brain = agyBrainRoot();
  if (isUnc(brain) || isUnc(file) || !path.isAbsolute(file)) return undefined;
  try {
    const root = fs.realpathSync.native(brain);
    if (isUnc(root)) return undefined;
    const logicalRoot = inside(brain, file) ? brain : root;
    if (!inside(logicalRoot, file)) return undefined;
    const segments = path.relative(logicalRoot, file).split(path.sep);
    let resolved = root;
    for (const segment of segments) {
      const next = path.join(resolved, segment);
      if (fs.lstatSync(next).isSymbolicLink()) return undefined;
      resolved = fs.realpathSync.native(next);
      if (isUnc(resolved) || !inside(root, resolved)) return undefined;
    }
    if (!fs.lstatSync(resolved).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function resolveAgySubagentTranscript(convId: string): string | undefined {
  if (!UUID_RE.test(convId)) return undefined;
  const logsDir = path.join(agyBrainRoot(), convId, '.system_generated', 'logs');
  return checkedChildPath(path.join(logsDir, 'transcript.jsonl')) ?? checkedChildPath(path.join(logsDir, 'transcript_full.jsonl'));
}

function openChildTranscript(file: string): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    const checked = checkedChildPath(file);
    if (actual.isFile() && checked) {
      const expected = fs.statSync(checked, { bigint: true });
      if (expected.isFile() && actual.dev === expected.dev && actual.ino === expected.ino) return fd;
    }
    throw new Error('Invalid subagent transcript');
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readTailText(file: string, maxBytes = SUBAGENT_TAIL_BYTES): string | null {
  try {
    const fd = openChildTranscript(file);
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= 0) return '';
      if (size <= maxBytes) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        return buf.toString('utf8');
      }
      const start = size - maxBytes;
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, start);
      const text = buf.toString('utf8');
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

interface SubagentTailInfo {
  model?: string;
  summary?: string;
  stepCount: number;
  recentSteps: StreamSubagentStep[];
  files: string[];
  updatedAt?: number;
  filePath: string;
}

const SUBAGENT_TAIL_CACHE_MAX = 64;
const subagentTailCache = new Map<string, { sig: string; info: SubagentTailInfo }>();

function readHeadText(file: string, maxBytes = 4096): string {
  try {
    const fd = openChildTranscript(file);
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      if (len <= 0) return '';
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readAgySubagentTail(convId: string, logPath?: string): SubagentTailInfo | null {
  if (!UUID_RE.test(convId)) return null;
  const file = resolveAgySubagentTranscript(convId) ?? (logPath && checkedChildPath(logPath));
  if (!file) return null;
  let sig = '';
  try {
    const st = fs.statSync(file);
    sig = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
  const cached = subagentTailCache.get(file);
  if (cached && cached.sig === sig) {
    return {
      ...cached.info,
      recentSteps: cached.info.recentSteps.map(s => ({ ...s, ...(s.files ? { files: [...s.files] } : {}) })),
      files: [...cached.info.files],
    };
  }
  const raw = readTailText(file);
  if (raw === null) return null;

  let model: string | undefined;
  let stepCount = 0;
  let maxStepIdx = 0;
  let latestThinking = '';
  let latestContent = '';
  let updatedAt: number | undefined;
  const recentSteps: StreamSubagentStep[] = [];
  const filesWritten: string[] = [];
  const filesRead: string[] = [];
  const seenKeys = new Set<string>();

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try { v = JSON.parse(t); } catch { continue; }
    if (!isObj(v)) continue;

    const type = str(v.type);
    const stepIdx = typeof v.step_index === 'number' ? v.step_index : -1;
    const status = str(v.status).toUpperCase();
    const at = parseMs(v.created_at);
    if (at) updatedAt = Math.max(updatedAt ?? 0, at);
    if (str(v.model)) model = str(v.model);
    if (stepIdx > maxStepIdx) maxStepIdx = stepIdx;

    if (type === 'SYSTEM_MESSAGE') {
      // A new turn was dispatched to this subagent: drop previous round's settled summary while it thinks.
      latestThinking = '';
      latestContent = '';
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      if (stepIdx >= 0) {
        const key = `${stepIdx}:PR`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      for (const s of recentSteps) if (s.status === 'running') s.status = 'done';
      const th = str(v.thinking).trim();
      const ct = str(v.content).trim();
      if (th) latestThinking = clipSummary(th, 96);
      if (ct) latestContent = clipSummary(ct, 96);
      const calls = Array.isArray(v.tool_calls) ? v.tool_calls.filter(isObj) : [];
      if (calls.length > 0) {
        for (const c of calls) {
          const parsed = summarizeToolCall(str(c.name) || 'tool', c.args);
          stepCount++;
          filesRead.push(...parsed.filesRead);
          filesWritten.push(...parsed.filesWritten);
          recentSteps.push({
            summary: parsed.summary,
            status: 'running',
            detail: toolDetail(str(c.name) || 'tool', c.args),
            files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
          });
          if (recentSteps.length > 6) recentSteps.shift();
        }
      } else {
        stepCount++;
      }
    } else if (type === 'GENERIC') {
      if (status === 'RUNNING' || status === 'PENDING') continue;
      if (stepIdx >= 0) {
        const key = `${stepIdx}:G`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      const running = recentSteps.find(s => s.status === 'running');
      if (running) running.status = status === 'ERROR' || status === 'FAILED' ? 'error' : 'done';
    }
  }

  const runningStep = recentSteps.find(s => s.status === 'running');
  const summary = runningStep?.summary || latestThinking || latestContent || recentSteps.at(-1)?.summary || undefined;
  const files = (mergeUniqueFiles(filesWritten, filesRead) ?? []).slice(0, 6);
  const info: SubagentTailInfo = {
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    stepCount: Math.max(stepCount, maxStepIdx > 0 ? Math.ceil(maxStepIdx / 2) : 0),
    recentSteps,
    files,
    ...(updatedAt ? { updatedAt } : {}),
    filePath: file,
  };
  subagentTailCache.set(file, { sig, info });
  if (subagentTailCache.size > SUBAGENT_TAIL_CACHE_MAX) {
    const oldest = subagentTailCache.keys().next().value;
    if (oldest) subagentTailCache.delete(oldest);
  }
  return {
    ...info,
    recentSteps: info.recentSteps.map(s => ({ ...s, ...(s.files ? { files: [...s.files] } : {}) })),
    files: [...info.files],
  };
}

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

export interface SubagentHookState {
  conversationId: string;
  status: StreamSubagentStatus;
  model?: string;
  transcriptPath?: string;
  updatedAt: number;
  hookAt: number;
  eventRank: number;
  initialNumSteps?: number;
}

interface RawSubagent extends StreamSubagent {
  logPath?: string;
  turnIdx: number;
  lastDispatchAt?: number;
  repliedAt?: number;
  replySummary?: string;
}

export interface ParsedTranscriptStream {
  blocks: StreamBlock[];
  todos: StreamTodoItem[];
  subagents: StreamSubagent[];
}

function createTranscriptParser(agent: AgentKind, keyPrefix: string) {
  const blocks: StreamBlock[] = [];
  let latestTodos: StreamTodoItem[] = [];
  const toolIndex = new Map<string, { step: Extract<StreamBlock, { kind: 'step' }>; entry: StreamToolEntry }>();
  const rawSubagents: RawSubagent[] = [];
  const subagentsById = new Map<string, RawSubagent>();
  const pendingAgySpawns: Array<{
    sub: RawSubagent;
    entry: StreamToolEntry;
    step?: Extract<StreamBlock, { kind: 'step' }>;
    callId: string;
    promptNeedle: string;
  }> = [];
  const unresolvedAgyReceipts = new Map<string, { convId: string; at?: number; failed: boolean; candidates: typeof pendingAgySpawns }>();
  let userTurnIdx = 0;
  let recordOffset = 0;
  let recordId = '';
  let recordToolSeq = 0;
  let lastEventAt: number | undefined;
  let pendingCodexThinking = '';
  let pendingCodexAt: number | undefined;
  const seenAgyKeys = new Set<string>();

  const nextId = (kind: string) => `${keyPrefix}-${kind}-${recordId}${kind === 'tool' ? `-${recordToolSeq++}` : ''}`;
  const registerSubagent = (sub: RawSubagent) => {
    const key = sub.id.toLowerCase();
    const existing = subagentsById.get(key);
    if (existing) {
      Object.assign(existing, sub);
      return existing;
    }
    rawSubagents.push(sub);
    subagentsById.set(key, sub);
    return sub;
  };
  const lookupSubagent = (id: string): RawSubagent | undefined => subagentsById.get(id.toLowerCase());

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

  const markToolEntry = (target: { step: Extract<StreamBlock, { kind: 'step' }>; entry: StreamToolEntry }, failed: boolean) => {
    target.entry.status = failed ? 'error' : 'done';
    if (target.step.tools.every(t => t.status !== 'running')) target.step.active = false;
  };

  function bindAgySpawn(index: number, convId: string, failed: boolean, at?: number): boolean {
    if (index < 0 || lookupSubagent(convId)) return false;
    const [spawned] = pendingAgySpawns.splice(index, 1);
    subagentsById.delete(spawned.sub.id.toLowerCase());
    spawned.sub.id = spawned.entry.subagentId = convId;
    if (failed) spawned.sub.status = 'error';
    if (at) spawned.sub.updatedAt = at;
    subagentsById.set(convId.toLowerCase(), spawned.sub);
    if (spawned.step) markToolEntry({ step: spawned.step, entry: spawned.entry }, failed);
    return true;
  }

  function resolvePendingReceipts(hooks?: ReadonlyMap<string, SubagentHookState>): boolean {
    let changed = false;
    for (const [id, receipt] of unresolvedAgyReceipts) {
      const candidates = receipt.candidates.filter(spawn => pendingAgySpawns.includes(spawn));
      if (!candidates.length || lookupSubagent(id)) {
        unresolvedAgyReceipts.delete(id);
        continue;
      }
      const hinted = hooks?.get(id)?.transcriptPath;
      const childFile = resolveAgySubagentTranscript(receipt.convId) ?? (hinted && checkedChildPath(hinted));
      if (!childFile) continue;
      const head = readHeadText(childFile).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
      const matching = candidates.filter(spawn => {
        const needle = spawn.promptNeedle.slice(0, 48);
        return needle.length >= 8 && head.includes(needle)
          || !!spawn.sub.role && spawn.sub.role.length >= 4 && head.includes(spawn.sub.role);
      });
      if (matching.length === 1 && bindAgySpawn(pendingAgySpawns.indexOf(matching[0]), receipt.convId, receipt.failed, receipt.at)) {
        unresolvedAgyReceipts.delete(id);
        changed = true;
      }
    }
    return changed;
  }

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
        userTurnIdx++;
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

    if (type === 'SYSTEM_MESSAGE') {
      const content = str(v.content);
      const sender = SYSTEM_SENDER_RE.exec(content)?.[1];
      if (sender) {
        const sub = lookupSubagent(sender);
        if (sub) {
          sub.status = 'done';
          sub.repliedAt = at ?? sub.updatedAt ?? Date.now();
          if (at) sub.updatedAt = at;
          const bodyMatch = SYSTEM_CONTENT_RE.exec(content);
          const snippet = clipSummary(bodyMatch ? bodyMatch[1] : content, 96);
          if (snippet) sub.replySummary = snippet;
        }
      }
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
        const shortName = rawName.replace(/^mcp_[^_]+_/, '').split(':').pop() ?? rawName;
        const todoUpdate = extractTodosFromToolCall(rawName, c.args);
        if (todoUpdate) latestTodos = todoUpdate;
        const parsed = summarizeToolCall(rawName, c.args);
        const callId = str(c.id) || `agy-${stepIdx}-${idx}`;
        const entry: StreamToolEntry = {
          id: callId,
          name: rawName,
          summary: todoUpdate ? todoToolSummary(todoUpdate) : parsed.summary,
          detail: todoUpdate ? undefined : toolDetail(rawName, c.args),
          status: 'running',
          files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
        };

        if (shortName === 'invoke_subagent') {
          const a = unquoteObj(c.args);
          const typeName = str(a.TypeName || a.typeName).trim();
          const role = str(a.Role || a.role).trim();
          const mArg = str(a.Model || a.model).trim();
          const tempId = `${keyPrefix}-sub-${stepIdx >= 0 ? stepIdx : recordId}-${idx}`;
          const name = typeName || role || 'subagent';
          const sub = registerSubagent({
            id: tempId,
            kind: 'subagent',
            name,
            ...(role && role !== name ? { role } : {}),
            ...(mArg && mArg !== 'inherit' ? { model: mArg } : model ? { model } : {}),
            status: 'running',
            startedAt: at,
            updatedAt: at,
            lastDispatchAt: at,
            turnIdx: userTurnIdx,
          });
          const promptNeedle = str(a.Prompt || a.prompt).replace(/\s+/g, ' ').trim().slice(0, 80);
          entry.subagentId = sub.id;
          pendingAgySpawns.push({ sub, entry, callId, promptNeedle });
        } else if (shortName === 'swarm') {
          const a = unquoteObj(c.args);
          const act = str(a.action).toLowerCase();
          if (act === 'add') {
            const base = str(a.name).trim() || 'worker';
            const mArg = str(a.model).trim() || model;
            const brief = clipSummary(str(a.brief), 56) || undefined;
            const tasksList = Array.isArray(a.tasks) ? a.tasks : null;
            const nVal = typeof a.n === 'number' && Number.isFinite(a.n) && a.n > 1 ? Math.min(12, Math.floor(a.n)) : 1;
            const names = tasksList && tasksList.length > 0
              ? tasksList.map((_, i) => `${base}-${i + 1}`)
              : nVal > 1
                ? Array.from({ length: nVal }, (_, i) => `${base}-${i + 1}`)
                : [base];
            names.forEach((nm, i) => {
              const sid = `swarm:${nm}`;
              const taskRole = tasksList && typeof tasksList[i] === 'string' ? clipSummary(tasksList[i], 56) : brief;
              registerSubagent({
                id: sid,
                kind: 'swarm',
                name: nm,
                ...(taskRole ? { role: taskRole } : {}),
                ...(mArg ? { model: mArg } : {}),
                status: 'running',
                startedAt: at,
                updatedAt: at,
                lastDispatchAt: at,
                turnIdx: userTurnIdx,
              });
              if (i === 0) entry.subagentId = sid;
            });
          } else if (act === 'kill') {
            const nm = str(a.name).trim();
            if (nm) {
              const sub = lookupSubagent(`swarm:${nm}`) ?? rawSubagents.find(s => s.kind === 'swarm' && s.name === nm);
              if (sub) {
                sub.status = 'done';
                if (at) sub.updatedAt = at;
              }
            }
          }
        } else if (shortName === 'manage_subagents') {
          const a = unquoteObj(c.args);
          const act = str(a.Action || a.action).toLowerCase();
          if (act === 'kill_all') {
            for (const s of rawSubagents) {
              if (s.kind === 'subagent' && s.status === 'running') {
                s.status = 'done';
                if (at) s.updatedAt = at;
              }
            }
          } else if (act === 'kill') {
            const ids = Array.isArray(a.ConversationIds) ? a.ConversationIds : [];
            for (const rawId of ids) {
              const sub = typeof rawId === 'string' ? lookupSubagent(rawId) : undefined;
              if (sub) {
                sub.status = 'done';
                if (at) sub.updatedAt = at;
              }
            }
          }
        } else if (shortName === 'send_message') {
          const a = unquoteObj(c.args);
          const recipient = str(a.Recipient || a.recipient).trim();
          const sub = recipient ? lookupSubagent(recipient) : undefined;
          if (sub) {
            sub.status = 'running';
            sub.lastDispatchAt = at ?? Date.now();
            if (at) sub.updatedAt = at;
            sub.turnIdx = userTurnIdx;
            delete sub.repliedAt;
            delete sub.replySummary;
            entry.subagentId = sub.id;
          }
        }

        return entry;
      });
      const thinkingSec = calcThinkingSec(lastEventAt, at);
      if (thinking || tools.length > 0) {
        const stepBlock: Extract<StreamBlock, { kind: 'step' }> = {
          id: stepIdx >= 0 ? `${keyPrefix}-agy-step-${stepIdx}` : nextId('step'),
          kind: 'step',
          ...(thinking ? { thinking: cap(thinking, MAX_THINKING_TEXT) } : {}),
          ...(thinkingSec ? { thinkingSec } : {}),
          tools,
          model,
          at,
          active: tools.length > 0,
        };
        blocks.push(stepBlock);
        for (const t of tools) toolIndex.set(t.id, { step: stepBlock, entry: t });
        for (const p of pendingAgySpawns) {
          if (!p.step && tools.includes(p.entry)) p.step = stepBlock;
        }
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
      const explicitCallId = (str(v.tool_call_id) || str(v.call_id)).trim();
      if (stepIdx >= 0) {
        const key = `${stepIdx}:GENERIC:FINAL:${explicitCallId || recordOffset}`;
        if (seenAgyKeys.has(key)) return;
        seenAgyKeys.add(key);
      }
      const failed = status === 'ERROR' || status === 'FAILED';
      const content = str(v.content);
      let matchedTool = explicitCallId ? toolIndex.get(explicitCallId) : undefined;
      const byCall = explicitCallId ? pendingAgySpawns.findIndex(p => p.callId === explicitCallId) : -1;
      const receipt = pendingAgySpawns.length ? SUBAGENT_RECEIPT_RE.exec(content.trim())?.[1] : undefined;
      let convId = '';
      if (pendingAgySpawns.length && (byCall >= 0 || !explicitCallId && receipt)) {
        try {
          const data: unknown = JSON.parse(receipt ?? content);
          if (isObj(data) && UUID_RE.test(str(data.conversationId))) convId = str(data.conversationId);
        } catch { /* Not a structured spawn receipt. */ }
      }
      if (convId && pendingAgySpawns.length > 0) {
        const matchIdx = byCall >= 0 ? byCall : pendingAgySpawns.length === 1 ? 0 : -1;
        if (matchIdx >= 0) bindAgySpawn(matchIdx, convId, failed, at);
        else if (unresolvedAgyReceipts.size < 24) {
          unresolvedAgyReceipts.set(convId.toLowerCase(), { convId, at, failed, candidates: [...pendingAgySpawns] });
          resolvePendingReceipts();
        }
        if (at) lastEventAt = at;
        return;
      } else if (failed && byCall >= 0) {
        const [spawned] = pendingAgySpawns.splice(byCall, 1);
        spawned.sub.status = 'error';
        if (at) spawned.sub.updatedAt = at;
        if (spawned.step) matchedTool = { step: spawned.step, entry: spawned.entry };
      }
      if (matchedTool) markToolEntry(matchedTool, failed);
      else if (!explicitCallId && !receipt) markNextRunningTool(failed);
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
            const sub = id ? lookupSubagent(id) : undefined;
            if (sub) {
              const resText = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.filter(isObj).map(x => str(x.text)).filter(Boolean).join('\n')
                  : '';
              const isAsyncLaunch = !b.is_error && /async agent launched|running in the background/i.test(resText);
              if (!isAsyncLaunch) {
                sub.status = b.is_error === true ? 'error' : 'done';
                if (at) sub.updatedAt = at;
                const snippet = clipSummary(resText, 96);
                if (snippet) sub.replySummary = snippet;
              }
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
          userTurnIdx++;
          blocks.push({ id: nextId('u'), kind: 'user', text: cap(text, MAX_BLOCK_TEXT), at });
        }
      } else if (typeof content === 'string') {
        const text = content.trim();
        if (text && !SKIP_USER_PREFIX.some(p => text.startsWith(p))) {
          markLatestStepAllDone();
          userTurnIdx++;
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
          const entry: StreamToolEntry = {
            id,
            name: rawName,
            summary: todoUpdate ? todoToolSummary(todoUpdate) : parsed.summary,
            detail: todoUpdate ? undefined : toolDetail(rawName, b.input),
            status: 'running',
            files: mergeUniqueFiles(parsed.filesRead, parsed.filesWritten),
          };
          if (rawName === 'Agent' || rawName === 'Task') {
            const inp = isObj(b.input) ? b.input : {};
            const name = str(inp.subagent_type || inp.name).trim() || 'Agent';
            const role = str(inp.description).trim() || undefined;
            const mArg = str(inp.model).trim() || model;
            registerSubagent({
              id,
              kind: 'subagent',
              name,
              ...(role && role !== name ? { role } : {}),
              ...(mArg ? { model: mArg } : {}),
              status: 'running',
              startedAt: at,
              updatedAt: at,
              lastDispatchAt: at,
              turnIdx: userTurnIdx,
            });
            entry.subagentId = id;
          }
          tools.push(entry);
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
      if (rawName === 'spawn_agent') {
        const a = isObj(args) ? args : {};
        const name = str(a.agent_type || a.nickname).trim() || 'subagent';
        const role = str(a.nickname || clipSummary(str(a.message), 48)).trim() || undefined;
        registerSubagent({
          id,
          kind: 'subagent',
          name,
          ...(role && role !== name ? { role } : {}),
          ...(str(a.model) ? { model: str(a.model) } : {}),
          status: 'running',
          startedAt: at,
          updatedAt: at,
          lastDispatchAt: at,
          turnIdx: userTurnIdx,
        });
        entry.subagentId = id;
      } else if (rawName === 'close_agent') {
        const a = isObj(args) ? args : {};
        const targetId = str(a.id || a.agent_id).trim();
        const sub = targetId ? lookupSubagent(targetId) : undefined;
        if (sub) {
          sub.status = 'done';
          if (at) sub.updatedAt = at;
        }
      }
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
      const sub = id ? lookupSubagent(id) : undefined;
      if (sub && typeof p.output === 'string') {
        try {
          const outObj = JSON.parse(p.output) as unknown;
          if (isObj(outObj) && typeof outObj.agent_id === 'string' && outObj.agent_id) {
            subagentsById.set(outObj.agent_id.toLowerCase(), sub);
          }
        } catch { /* ignore */ }
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
        userTurnIdx++;
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
    if (v.type === 'PLANNER_RESPONSE' || v.type === 'GENERIC' || v.type === 'USER_INPUT' || v.type === 'SYSTEM_MESSAGE') {
      applyAgy(v);
      return;
    }
    const role = str(v.role);
    const text = str(v.text).trim();
    const thinking = str(v.thinking).trim();
    const at = parseMs(v.at);
    if (role === 'user' && text) {
      markLatestStepAllDone();
      userTurnIdx++;
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

  const each = agent === 'claude' ? applyClaude : agent === 'codex' ? applyCodex : agent === 'agy' ? applyAgy : applyFake;
  return {
    append(raw: string, offset = 0) {
      for (const line of raw.split('\n')) {
        recordOffset = offset;
        offset += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!isObj(parsed)) continue;
        const payload = isObj(parsed.payload) ? parsed.payload : {};
        const sourceId = str(parsed.uuid) || str(parsed.id) || str(payload.id) || str(payload.call_id);
        recordId = sourceId ? `event-${sourceId}` : `byte-${recordOffset}`;
        recordToolSeq = 0;
        each(parsed);
      }
    },
    resolvePendingReceipts,
    snapshot: (): ParsedParentCache => ({ blocks, todos: latestTodos, rawSubagents, lastUserTurnIdx: userTurnIdx }),
  };
}

function parseStreamDataInternal(agent: AgentKind, raw: string, keyPrefix = 's', tail?: TranscriptRead['tail']): ParsedParentCache {
  const parser = createTranscriptParser(agent, keyPrefix);
  parser.append(raw);
  if (tail) parser.append(tail.raw, tail.offset);
  return parser.snapshot();
}

function finalizeSubagent(raw: RawSubagent, working: boolean): StreamSubagent {
  const status: StreamSubagentStatus = !working && raw.status === 'running' ? 'done' : raw.status;
  const recentSteps = raw.recentSteps?.map(s => ({
    ...s,
    status: !working && s.status === 'running' ? 'done' : s.status,
  }));
  const summary = status === 'done' && raw.replySummary ? raw.replySummary : raw.summary || raw.replySummary;
  return {
    id: raw.id,
    kind: raw.kind,
    name: raw.name,
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    status,
    ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(raw.stepCount ? { stepCount: raw.stepCount } : {}),
    ...(recentSteps && recentSteps.length > 0 ? { recentSteps } : {}),
    ...(raw.files && raw.files.length > 0 ? { files: raw.files } : {}),
  };
}

// Parses a CLI transcript (JSONL) into rich video-style blocks + latest live todo checklist + subagents.
export function parseStreamData(agent: AgentKind, raw: string, keyPrefix = 's'): ParsedTranscriptStream {
  const res = parseStreamDataInternal(agent, raw, keyPrefix);
  const kept = res.rawSubagents
    .filter(s => s.status === 'running' || s.turnIdx === res.lastUserTurnIdx)
    .slice(-MAX_VISIBLE_SUBAGENTS)
    .map(s => finalizeSubagent(s, true));
  return { blocks: res.blocks, todos: res.todos, subagents: kept };
}

export function parseStreamBlocks(agent: AgentKind, raw: string, keyPrefix = 's'): StreamBlock[] {
  return parseStreamData(agent, raw, keyPrefix).blocks;
}

interface ParsedParentCache {
  blocks: StreamBlock[];
  todos: StreamTodoItem[];
  rawSubagents: RawSubagent[];
  lastUserTurnIdx: number;
  truncated?: boolean;
}

function appendPendingUserBlocks(
  blocks: StreamBlock[],
  parsedBlocks: StreamBlock[],
  session: SessionInfo | undefined,
  taskCards: Card[],
  pendingInputs?: PendingUserInput[],
): void {
  const parsedUsers = parsedBlocks.filter(
    (b): b is Extract<StreamBlock, { kind: 'user' }> => b.kind === 'user',
  );
  let latestTranscriptAt: number | undefined;
  let latestUserAt: number | undefined;
  for (const b of parsedBlocks) {
    if (b.kind !== 'card' && typeof b.at === 'number') {
      if (latestTranscriptAt === undefined || b.at > latestTranscriptAt) latestTranscriptAt = b.at;
      if (b.kind === 'user' && (latestUserAt === undefined || b.at > latestUserAt)) latestUserAt = b.at;
    }
  }

  // Live runtime path: use SessionManager's exact queue + recently delivered human inputs so stale feedback cards
  // from earlier turns NEVER resurrect at the bottom after later terminal inputs or delegation forwards.
  if (pendingInputs !== undefined) {
    if (pendingInputs.length === 0 || session?.status === 'exited') return;
    let lastAssistantIdx = -1;
    for (let i = parsedBlocks.length - 1; i >= 0; i--) {
      if (parsedBlocks[i].kind === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    const trailingUntimestampedUsers = parsedBlocks
      .slice(lastAssistantIdx + 1)
      .filter((b): b is Extract<StreamBlock, { kind: 'user' }> => b.kind === 'user' && b.at === undefined);
    const consumedUntimestamped = new Set<number>();

    for (const item of pendingInputs) {
      const pendingBlock: StreamBlock = {
        id: `pending-${item.id}`, kind: 'user', text: cap(item.text, MAX_BLOCK_TEXT), at: item.at,
        pending: item.state, pendingId: item.id, ...(item.reason && { pendingReason: item.reason }),
      };
      if (item.state !== 'sending') {
        blocks.push(pendingBlock);
        continue;
      }
      // `state === 'sending'`: check whether CLI already finished this turn or already flushed USER_INPUT.
      if (session && session.status !== 'working' && session.statusSince > item.at) continue;
      const landedTimestamped = parsedUsers.some(
        u => typeof u.at === 'number' && u.at >= item.at - PENDING_USER_CLOCK_SKEW_MS && (
          feedbackMatchesUserText(item.text, u.text) ||
          (latestTranscriptAt !== undefined && latestTranscriptAt >= item.at + PENDING_TRANSCRIPT_ADVANCE_MS)
        ),
      );
      if (landedTimestamped) continue;

      let landedUntimestamped = false;
      for (let i = trailingUntimestampedUsers.length - 1; i >= 0; i--) {
        if (consumedUntimestamped.has(i)) continue;
        if (feedbackMatchesUserText(item.text, trailingUntimestampedUsers[i].text)) {
          consumedUntimestamped.add(i);
          landedUntimestamped = true;
          break;
        }
      }
      if (landedUntimestamped) continue;

      blocks.push(pendingBlock);
    }
    return;
  }

  // Fallback path (offline snapshot / unit tests without live SessionManager queue):
  // Match current-session feedback cards monotonically forward across ALL transcript user turns, and never
  // resurrect a card superseded by newer transcript events.
  if (session?.status === 'exited') return;
  const sessionFeedbacks = taskCards.filter(
    c => c.kind === 'feedback' && (!session || c.sessionId === session.id),
  );
  let uCursor = 0;
  let lastMatchedFbIdx = -1;
  for (let i = 0; i < sessionFeedbacks.length; i++) {
    const fb = sessionFeedbacks[i];
    let matchedIdx = -1;
    for (let j = uCursor; j < parsedUsers.length; j++) {
      if (feedbackMatchesUserText(fb.body, parsedUsers[j].text)) {
        matchedIdx = j;
        break;
      }
    }
    if (matchedIdx >= 0) {
      uCursor = matchedIdx + 1;
      lastMatchedFbIdx = i;
    } else if (uCursor > 0 && feedbackMatchesUserText(fb.body, parsedUsers[uCursor - 1].text)) {
      lastMatchedFbIdx = i;
    }
  }
  const hasQueued = (session?.queued ?? 0) > 0;
  for (const fb of sessionFeedbacks.slice(lastMatchedFbIdx + 1)) {
    if (latestUserAt !== undefined && fb.createdAt + FALLBACK_CARD_SKEW_MS < latestUserAt) continue;
    if (!hasQueued && latestTranscriptAt !== undefined && fb.createdAt + FALLBACK_CARD_SKEW_MS < latestTranscriptAt) continue;
    blocks.push({
      id: `card-${fb.id}`,
      kind: 'user',
      text: cap(fb.body, MAX_BLOCK_TEXT),
      at: fb.createdAt,
      ...(hasQueued ? { pending: 'queued' as const } : {}),
    });
  }
}

function buildStreamDataFromParsed(opts: {
  task: Task;
  session: SessionInfo | undefined;
  cards: Card[];
  parsed: ParsedParentCache;
  subagentHooks?: ReadonlyMap<string, SubagentHookState>;
  pendingInputs?: PendingUserInput[];
}): ParsedTranscriptStream & { subagentFiles: string[]; truncated?: boolean } {
  const { task, session, parsed, subagentHooks, pendingInputs } = opts;
  const taskCards = opts.cards.filter(c => c.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt);
  const agent = session?.agent ?? task.agent;
  // Clone blocks because settling non-working sessions mutates active/running flags.
  const blocks: StreamBlock[] = [];

  if (parsed.blocks.length > 0) {
    const cards = taskCards.filter(c => c.kind === 'handoff' || c.kind === 'forward');
    let cardIndex = 0;
    const appendCards = (until: number) => {
      while (cards[cardIndex]?.createdAt <= until) {
        const card = cards[cardIndex++];
        blocks.push({ id: `card-${card.id}`, kind: 'card', card });
      }
    };
    const hasTimestamps = parsed.blocks.some(b => b.kind !== 'card' && typeof b.at === 'number');
    if (!hasTimestamps) appendCards(Infinity);
    if (!parsed.blocks.some(b => b.kind === 'user') && task.prompt.trim()) {
      appendCards(task.createdAt);
      blocks.push({ id: 'prompt-0', kind: 'user', text: cap(task.prompt.trim(), MAX_BLOCK_TEXT), at: task.createdAt });
    }
    for (const b of parsed.blocks) {
      if (b.kind !== 'card' && b.at !== undefined) appendCards(b.at);
      blocks.push(b.kind === 'step' ? { ...b, tools: b.tools.map(t => ({ ...t })) } : { ...b });
    }
    appendCards(Infinity);

    appendPendingUserBlocks(blocks, parsed.blocks, session, taskCards, pendingInputs);
  } else {
    if (task.prompt.trim()) {
      blocks.push({ id: 'prompt-0', kind: 'user', text: cap(task.prompt.trim(), MAX_BLOCK_TEXT), at: task.createdAt });
    }
    for (const c of taskCards) {
      if (c.kind === 'feedback') {
        if (pendingInputs === undefined || session?.status === 'exited' || c.sessionId !== session?.id) {
          blocks.push({ id: `card-${c.id}`, kind: 'user', text: cap(c.body, MAX_BLOCK_TEXT), at: c.createdAt });
        }
      }
      else if (c.kind === 'result') blocks.push({ id: `card-${c.id}`, kind: 'assistant', text: cap(c.body, MAX_BLOCK_TEXT), at: c.createdAt });
      else blocks.push({ id: `card-${c.id}`, kind: 'card', card: c });
    }
    if (pendingInputs !== undefined) appendPendingUserBlocks(blocks, [], session, taskCards, pendingInputs);
  }

  const working = session?.status === 'working';
  if (!working) {
    for (const b of blocks) {
      if (b.kind === 'step' && b.active) {
        b.active = false;
        for (const t of b.tools) if (t.status === 'running') t.status = 'done';
      }
    }
  }

  const keptRaw: RawSubagent[] = parsed.rawSubagents
    .filter(s => s.status === 'running' || s.turnIdx === parsed.lastUserTurnIdx)
    .slice(-MAX_VISIBLE_SUBAGENTS)
    .map(s => ({ ...s }));
  const byId = new Map(keptRaw.map(s => [s.id.toLowerCase(), s]));

  if (subagentHooks && subagentHooks.size > 0) {
    for (const [key, hk] of subagentHooks) {
      const existing = byId.get(key);
      if (existing) {
        if (hk.model) existing.model = hk.model;
        if (hk.transcriptPath && !existing.logPath) existing.logPath = hk.transcriptPath;
        if (hk.hookAt >= (existing.lastDispatchAt ?? 0) && hk.hookAt >= (existing.repliedAt ?? 0)) {
          existing.status = hk.status;
        }
        existing.updatedAt = Math.max(existing.updatedAt ?? 0, hk.updatedAt);
      } else if (working && hk.status === 'running') {
        const synth: RawSubagent = {
          id: hk.conversationId,
          kind: 'subagent',
          name: 'subagent',
          ...(hk.model ? { model: hk.model } : {}),
          status: 'running',
          startedAt: hk.updatedAt,
          updatedAt: hk.updatedAt,
          logPath: hk.transcriptPath,
          turnIdx: parsed.lastUserTurnIdx,
        };
        keptRaw.push(synth);
        byId.set(key, synth);
      }
    }
  }

  // Enforce display cap BEFORE reading child transcripts on disk so I/O stays strictly bounded.
  const boundedRaw = keptRaw.slice(-MAX_VISIBLE_SUBAGENTS);
  const subagentFiles: string[] = [];
  if (agent === 'agy' || agent === 'fake') {
    for (const sub of boundedRaw) {
      if (!UUID_RE.test(sub.id) && !sub.logPath) continue;
      const tail = readAgySubagentTail(sub.id, sub.logPath);
      if (!tail) continue;
      subagentFiles.push(tail.filePath);
      if (tail.model) sub.model = tail.model;
      if (tail.summary) sub.summary = tail.summary;
      if (tail.stepCount > 0) sub.stepCount = tail.stepCount;
      if (tail.recentSteps.length > 0) sub.recentSteps = tail.recentSteps;
      if (tail.files.length > 0) sub.files = tail.files;
      if (tail.updatedAt) sub.updatedAt = Math.max(sub.updatedAt ?? 0, tail.updatedAt);
    }
  }

  const subagents = boundedRaw.map(s => finalizeSubagent(s, working));
  return { blocks, todos: parsed.todos, subagents, subagentFiles, ...(parsed.truncated && { truncated: true }) };
}

export function buildStreamData(opts: {
  task: Task;
  session: SessionInfo | undefined;
  cards: Card[];
  subagentHooks?: ReadonlyMap<string, SubagentHookState>;
  pendingInputs?: PendingUserInput[];
}): ParsedTranscriptStream & { subagentFiles: string[]; truncated?: boolean } {
  const { task, session } = opts;
  const tp = session ? resolveLiveTranscript(session, { preferFull: true }) : undefined;
  const raw = tp ? readTranscriptRaw(tp) : null;
  const parsed: ParsedParentCache = raw
    ? { ...parseStreamDataInternal(session?.agent ?? task.agent, raw.truncated ? raw.complete : raw.raw, session?.id ?? 's', raw.tail), truncated: raw.truncated }
    : { blocks: [], todos: [], rawSubagents: [], lastUserTurnIdx: 0 };
  return buildStreamDataFromParsed({ ...opts, parsed });
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
  lastParentFileSig: string;
  parentRead?: TranscriptRead;
  parentParser?: ReturnType<typeof createTranscriptParser>;
  lastSessionSig: string;
  cachedParentParsed: ParsedParentCache;
  cachedBlocks: StreamBlock[];
  cachedTodos: StreamTodoItem[];
  cachedSubagents: StreamSubagent[];
  subagentFiles: string[];
  prompt: PromptView | null;
  promptSeq: number;
  lastPromptKey: string;
  rev: number;
  lastSentJson: string;
  lastFrame: string;
  disposed: boolean;
}

export interface StreamWatcherDeps {
  getSession(sessionId: string): SessionInfo | undefined;
  getTask(taskId: string): Task | undefined;
  getCards(): Card[];
  getActivity(sessionId: string): SessionActivity | null;
  getPromptWait(sessionId: string): { info: SessionInfo; waitSeq: number; outSeq: number; replay: string | null } | null;
  getPendingInputs?(sessionId: string): PendingUserInput[];
  now?: () => number;
}

export function createStreamWatcher(deps: StreamWatcherDeps) {
  const now = deps.now ?? (() => Date.now());
  const watched = new Map<string, WatchedSession>();
  const clientSessions = new Map<StreamWatcherClient, Set<string>>();
  const subagentHooks = new Map<string, Map<string, SubagentHookState>>();
  const emptyParent = (): ParsedParentCache => ({ blocks: [], todos: [], rawSubagents: [], lastUserTurnIdx: 0 });

  const fileSig = (f: string | undefined): string => {
    if (!f) return '';
    try {
      const st = fs.statSync(f);
      return `${f}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return '';
    }
  };

  const subagentSig = (w: WatchedSession): string => {
    const parts: string[] = [];
    for (const file of w.subagentFiles) parts.push(fileSig(checkedChildPath(file)));
    const hooks = subagentHooks.get(w.sessionId);
    if (hooks) {
      for (const [k, v] of hooks) parts.push(`${k}:${v.status}:${v.updatedAt}`);
    }
    return parts.join(',');
  };

  const pendingSignature = (inputs: PendingUserInput[] | undefined) => inputs?.map(p => `${p.id}:${p.state}:${p.reason ?? ''}`).join(',') ?? '';
  const sessionSignature = (s: SessionInfo) => JSON.stringify([s.taskId, s.agent, s.status, s.statusSince, s.blocked,
    s.queued, s.transcriptPath, s.nativeSessionId, s.hasTerminalDraft]);

  const refreshBlocks = (w: WatchedSession, force = false, pendingInputs = deps.getPendingInputs?.(w.sessionId)): boolean => {
    const session = deps.getSession(w.sessionId);
    const task = session ? deps.getTask(session.taskId) : undefined;
    if (!session || !task) return false;
    const tp = resolveLiveTranscript(session, { preferFull: true });
    const parentFileSig = `${session.agent}|${fileSig(tp)}`;
    const cards = deps.getCards().filter(c => c.taskId === task.id);
    const lastCard = cards.at(-1);
    const sessionSig = `${sessionSignature(session)}|${pendingSignature(pendingInputs)}`;
    const prefix = `${parentFileSig}|${sessionSig}|${cards.length}:${lastCard?.id ?? ''}:${lastCard?.createdAt ?? 0}`;
    const sig = `${prefix}|${subagentSig(w)}`;
    w.lastSessionSig = sessionSig;
    const hooks = subagentHooks.get(w.sessionId);
    if (!force && sig === w.lastTranscriptSig && !w.parentParser?.resolvePendingReceipts(hooks)) return false;
    // Re-read and re-parse the parent transcript ONLY when the parent file itself changed, never on child-only updates.
    if (parentFileSig !== w.lastParentFileSig) {
      const previous = w.lastParentFileSig.startsWith(`${session.agent}|`) ? w.parentRead : undefined;
      const read = tp ? readTranscriptRaw(tp, previous) : null;
      if (!read) {
        w.parentRead = w.parentParser = undefined;
        w.cachedParentParsed = emptyParent();
      } else if (read.truncated) {
        w.parentRead = w.parentParser = undefined;
        w.cachedParentParsed = { ...parseStreamDataInternal(session.agent, read.complete, session.id, read.tail), truncated: true };
      } else {
        if (!read.appended || !w.parentParser) w.parentParser = createTranscriptParser(session.agent, session.id);
        w.parentParser.append(read.appended ? read.added : read.complete, read.appended && previous ? previous.size - previous.partial.length : 0);
        w.parentRead = read;
        // Some writers omit the final newline. Reuse completed records unless that last record is valid JSON.
        let finalRecord = false;
        if (read.partial.length && read.partial.at(-1) === 125) {
          try { finalRecord = isObj(JSON.parse(read.partial.toString('utf8'))); } catch { /* Incomplete write. */ }
        }
        w.cachedParentParsed = finalRecord ? parseStreamDataInternal(session.agent, read.raw, session.id) : w.parentParser.snapshot();
      }
      w.lastParentFileSig = parentFileSig;
    }
    w.parentParser?.resolvePendingReceipts(hooks);
    const built = buildStreamDataFromParsed({
      task,
      session,
      cards,
      parsed: w.cachedParentParsed,
      subagentHooks: hooks,
      pendingInputs,
    });
    w.cachedBlocks = built.blocks;
    w.cachedTodos = built.todos;
    w.cachedSubagents = built.subagents;
    w.subagentFiles = built.subagentFiles;
    w.lastTranscriptSig = `${prefix}|${subagentSig(w)}`;
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

  const buildPayload = (w: WatchedSession): Omit<SessionStreamState, 'rev'> | null => {
    const session = deps.getSession(w.sessionId);
    if (!session) return null;
    const live = composeLiveTail({
      session,
      blocks: w.cachedBlocks,
      activity: deps.getActivity(w.sessionId),
      ptyExtract: null,
      subagents: w.cachedSubagents,
      now: now(),
    });
    return {
      sessionId: session.id,
      taskId: session.taskId,
      agent: session.agent,
      blocks: w.cachedBlocks,
      ...(w.cachedParentParsed.truncated && { truncated: true }),
      ...(w.cachedTodos.length > 0 ? { todos: w.cachedTodos } : {}),
      ...(w.cachedSubagents.length > 0 ? { subagents: w.cachedSubagents } : {}),
      live,
      prompt: session.blocked ? w.prompt : null,
    };
  };

  const emitState = (w: WatchedSession, targetClient?: StreamWatcherClient) => {
    if (w.disposed || w.clients.size === 0) return;
    const next = buildPayload(w);
    if (!next) return;
    const { live, ...rest } = next;
    const liveJson = live ? JSON.stringify({ ...live, updatedAt: undefined }) : 'null';
    const stateJson = JSON.stringify(rest);
    const compareJson = `${stateJson}${liveJson}`;
    if (compareJson !== w.lastSentJson) {
      w.rev++;
      w.lastSentJson = compareJson;
      const wireLive = live ? `${liveJson.slice(0, -1)},"updatedAt":${live.updatedAt}}` : liveJson;
      w.lastFrame = `{"t":"stream","state":{"rev":${w.rev},${stateJson.slice(1, -1)},"live":${wireLive}}}`;
      for (const c of w.clients) if (c.readyState === 1) c.send(w.lastFrame);
      return;
    }
    if (targetClient?.readyState === 1) targetClient.send(w.lastFrame);
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

  let pollTimer: NodeJS.Timeout | undefined;
  let quietPolls = 0;
  let lastPromptPoll = -Infinity;
  const schedulePoll = (delay: number) => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = watched.size ? setTimeout(poll, delay) : undefined;
    pollTimer?.unref();
  };
  const resetPoll = () => {
    quietPolls = 0;
    schedulePoll(TRANSCRIPT_POLL_MS);
  };
  function poll() {
    const at = now();
    const checkPrompts = at - lastPromptPoll >= PROMPT_POLL_MS;
    if (checkPrompts) lastPromptPoll = at;
    let changed = false;
    for (const w of watched.values()) {
      const session = deps.getSession(w.sessionId);
      if (!session) continue;
      const pending = deps.getPendingInputs?.(w.sessionId);
      if (session.status !== 'exited' && refreshBlocks(w, false, pending)) {
        emitState(w);
        changed = true;
      }
      if (checkPrompts && session.blocked) refreshPrompt(w);
    }
    quietPolls = changed ? 0 : Math.min(quietPolls + 1, 6);
    schedulePoll(TRANSCRIPT_POLL_MS * (1 + Math.floor(quietPolls / 3)));
  }

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
          lastParentFileSig: '__init__',
          lastSessionSig: '',
          cachedParentParsed: { blocks: [], todos: [], rawSubagents: [], lastUserTurnIdx: 0 },
          cachedBlocks: [],
          cachedTodos: [],
          cachedSubagents: [],
          subagentFiles: [],
          prompt: null,
          promptSeq: 0,
          lastPromptKey: '',
          rev: 0,
          lastSentJson: '',
          lastFrame: '',
          disposed: false,
        };
        watched.set(sessionId, w);
      }
      w.clients.add(client);
      resetPoll();

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
      if (session.status === 'exited') subagentHooks.delete(session.id);
      const w = watched.get(session.id);
      if (!w || w.disposed) return;
      const pending = deps.getPendingInputs?.(session.id);
      const key = `${sessionSignature(session)}|${pendingSignature(pending)}`;
      if (key === w.lastSessionSig) return;
      refreshBlocks(w, false, pending);
      resetPoll();
      if (session.blocked) refreshPrompt(w);
      else clearPrompt(w);
      emitState(w);
    },

    onHook(sessionId: string) {
      const w = watched.get(sessionId);
      if (!w || w.disposed) return;
      resetPoll();
      refreshBlocks(w, true);
      emitState(w);
    },

    onSubagentHook(sessionId: string, event: string, payload: Record<string, unknown>, hookAt?: number) {
      const convId = str(payload.conversationId).trim();
      const parent = deps.getSession(sessionId);
      if (!UUID_RE.test(convId) || !parent || parent.status === 'exited') return;
      let status: StreamSubagentStatus | null = null;
      let eventRank = 0;
      if (event === 'SessionStart') {
        status = 'running';
        eventRank = 0;
      } else if (event === 'PreInvocation') {
        status = 'running';
        eventRank = 1;
      } else if (event === 'PostInvocation') {
        status = 'running';
        eventRank = 2;
      } else if (event === 'Stop' || event === 'StopFailure') {
        const hasErr = typeof payload.error === 'string' && payload.error.trim() !== '';
        const stillWaiting = !hasErr && (payload.fullyIdle === false || payload.continuationActive === true);
        status = hasErr ? 'error' : stillWaiting ? 'running' : 'done';
        eventRank = 3;
      }
      if (!status) return;
      let map = subagentHooks.get(sessionId);
      if (!map) {
        map = new Map();
        subagentHooks.set(sessionId, map);
      }
      const key = convId.toLowerCase();
      const prev = map.get(key);
      const evAt = typeof hookAt === 'number' && Number.isFinite(hookAt) && hookAt > 0 ? hookAt : now();
      const steps = typeof payload.initialNumSteps === 'number' && Number.isFinite(payload.initialNumSteps)
        ? payload.initialNumSteps
        : undefined;
      // Reject stale/out-of-order hooks so a delayed PreInvocation/PostInvocation never revives a stopped subagent.
      if (prev) {
        if (evAt < prev.hookAt) return;
        if (evAt === prev.hookAt && eventRank < prev.eventRank) return;
        if (steps !== undefined && prev.initialNumSteps !== undefined) {
          if (steps < prev.initialNumSteps) return;
          if (steps === prev.initialNumSteps && prev.status !== 'running' && status === 'running') {
            return;
          }
        }
      }
      const model = str(payload.modelName || payload.model) || prev?.model;
      const candidate = str(payload.transcriptPath || payload.transcript_path);
      const transcriptPath = (candidate && checkedChildPath(candidate) ? candidate : undefined) ?? prev?.transcriptPath;
      map.set(key, {
        conversationId: convId,
        status,
        ...(model ? { model } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        updatedAt: Math.max(prev?.updatedAt ?? 0, evAt),
        hookAt: evAt,
        eventRank,
        ...(steps !== undefined ? { initialNumSteps: steps } : prev?.initialNumSteps !== undefined ? { initialNumSteps: prev.initialNumSteps } : {}),
      });
      if (map.size > 24) {
        const oldest = map.keys().next().value;
        if (oldest) map.delete(oldest);
      }
      const w = watched.get(sessionId);
      if (w && !w.disposed) {
        resetPoll();
        refreshBlocks(w, true);
        emitState(w);
      }
    },

    knowsSubagent(sessionId: string, convId: string): boolean {
      const key = convId.toLowerCase();
      if (subagentHooks.get(sessionId)?.has(key)) return true;
      const w = watched.get(sessionId);
      return !!w?.cachedSubagents.some(s => s.id.toLowerCase() === key);
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
      subagentHooks.delete(sessionId);
      disposeWatcher(sessionId);
    },

    async snapshotFor(task: Task, session: SessionInfo | undefined): Promise<SessionStreamState> {
      const { blocks, todos, subagents, truncated } = buildStreamData({
        task,
        session,
        cards: deps.getCards(),
        subagentHooks: session ? subagentHooks.get(session.id) : undefined,
        pendingInputs: session ? deps.getPendingInputs?.(session.id) : undefined,
      });
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
            subagents,
            now: now(),
          })
        : null;
      return {
        sessionId: session?.id ?? '',
        taskId: task.id,
        agent: session?.agent ?? task.agent,
        rev: w?.rev ?? 0,
        blocks,
        ...(truncated && { truncated: true }),
        ...(todos.length > 0 ? { todos } : {}),
        ...(subagents.length > 0 ? { subagents } : {}),
        live,
        prompt,
      };
    },

    watchedCount: () => watched.size,

    close() {
      if (pollTimer) clearTimeout(pollTimer);
      for (const sid of [...watched.keys()]) disposeWatcher(sid);
      clientSessions.clear();
      subagentHooks.clear();
    },
  };
}
