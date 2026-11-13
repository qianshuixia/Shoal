import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Project, SessionInfo, Task, TaskMetrics, TelemetrySummary, UsageCounts, UsageReport, UsageRow } from '../shared/protocol.ts';
import { AGENT_LABEL, usageTotal, vendorOf } from '../shared/protocol.ts';

// Token usage of workbench sessions, read from the CLIs' own transcripts:
//   claude  ~/.claude/projects/<slug>/<id>.jsonl (+ <id>/subagents/*.jsonl): assistant lines' message.usage, one per message.id
//   codex   ~/.codex/sessions/**/rollout-*.jsonl: token_usage_record per response (older files: event_msg token_count),
//           model from the preceding turn_context
//   agy     ~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript_full.jsonl: PLANNER_RESPONSE per step,
//           model from the hook payload's modelName
// Which files belong to which session (and when the session ran) comes from events.jsonl and the store. Files are read
// incrementally by byte offset; per-hour totals are kept in <stateDir>/usage.json, so they survive deleted tasks and
// transcripts the CLIs clean up later.

export interface UsageSource {
  sessions(): SessionInfo[];
  tasks(): Task[];
  projects(): Project[];
}

interface SessState {
  agent: AgentKind;
  taskId?: string;
  start: number;
  lastAt: number;
  end?: number; // exit event
  done?: boolean; // finished long enough ago and scanned once since: its files are skipped until it shows up again
  files: string[];
  models: [number, string][]; // model changes reported by hooks, by time
}

interface FileState {
  offset: number;
  model?: string; // codex: model of the latest turn_context
  records?: boolean; // codex: has token_usage_record lines, so token_count events are duplicates
  lastTotal?: number; // codex token_count: cumulative total of the last counted event
  lastPromptAt?: number; // ms epoch of preceding user prompt / tool result for step speed
}

interface TaskSpeedState {
  samples: [number, number][]; // recent [outputTokens, durationMs] pairs (capped at 5)
  updatedAt: number; // ms epoch of last recorded response
}

interface UsageFile {
  version: 1;
  eventsOffset: number;
  sessions: Record<string, SessState>;
  files: Record<string, FileState>;
  seen: string[];
  tasks: Record<string, { title: string; projectId: string }>;
  projects: Record<string, string>;
  buckets: Record<string, UsageCounts>; // `${hourStart}|${agent}|${model}|${taskId}`
  taskSpeed?: Record<string, TaskSpeedState>;
}

export interface UsageHit {
  t: number;
  key?: string; // dedupe key (claude message id, codex response id, agy step)
  model?: string;
  c: UsageCounts;
  coarseTime?: boolean; // agy created_at has 1s granularity
}

const MAX_SPEED_SAMPLES = 5;
const MAX_STEP_MS = 600_000;

export function parsePromptAt(v: Obj): number | null {
  if (v.type === 'user') {
    const t = Date.parse(str(v.timestamp));
    return Number.isFinite(t) ? t : null;
  }
  const p = isObj(v.payload) ? v.payload : null;
  if (
    (v.type === 'response_item' && p && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || (p.type === 'message' && p.role === 'user'))) ||
    (v.type === 'event_msg' && p && (p.type === 'user_message' || p.type === 'task_started'))
  ) {
    const t = Date.parse(str(v.timestamp));
    return Number.isFinite(t) ? t : null;
  }
  if (v.type === 'USER_INPUT' || v.type === 'GENERIC') {
    const t = Date.parse(str(v.created_at));
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function calcTps(samples: [number, number][] | undefined): number | null {
  if (!samples?.length) return null;
  let out = 0;
  let ms = 0;
  for (const [o, d] of samples) { out += o; ms += d; }
  return ms > 0 ? Math.round((out / (ms / 1000)) * 10) / 10 : null;
}

const HOUR = 3_600_000;
const START_SLACK = 2 * 60_000; // the first hook arrives a moment after the CLI starts
const END_SLACK = 60_000;
const OPEN_END = 10 * 60_000; // session died without an exit event (server killed): last hook + this
const SETTLE = HOUR; // a session is done this long after the end of its run (owner() attributes nothing to it after that)
export const EVENTS_ROTATE_BYTES = 10 * 1024 * 1024; // events.jsonl is moved to events.1.jsonl once read past this
const SEEN_MAX = 300_000;
const SCAN_MIN_MS = 2000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const zero = (): UsageCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 });
const add = (a: UsageCounts, b: UsageCounts) => {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite;
  a.reasoning += b.reasoning; a.requests += b.requests;
};

// Codex 0.167 reports resumed transcripts as \\?\C:\...; one spelling per file.
export const normPath = (p: string) => path.resolve(p.replace(/^\\\\\?\\/, ''));

// Usage carried by one transcript line, in any of the three formats. `file` keeps per-file codex state up to date.
export function parseUsageLine(v: Obj, file: FileState, fileKey: string): UsageHit | null {
  if (v.type === 'assistant' && isObj(v.message) && isObj(v.message.usage)) {
    const m = v.message;
    const u = m.usage as Obj;
    const model = str(m.model);
    if (model === '<synthetic>') return null;
    const details = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
    const c: UsageCounts = {
      input: num(u.input_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens),
      output: num(u.output_tokens), reasoning: num(details.thinking_tokens), requests: 1,
    };
    return { t: Date.parse(str(v.timestamp)), key: str(m.id) ? `c:${str(m.id)}` : undefined, model: model || undefined, c };
  }
  const p = isObj(v.payload) ? v.payload : null;
  if (v.type === 'turn_context' && p) {
    if (str(p.model)) file.model = str(p.model);
    return null;
  }
  if (v.type === 'token_usage_record' && p && isObj(p.usage)) {
    file.records = true;
    return { t: Date.parse(str(v.timestamp)), key: str(p.response_id) ? `x:${str(p.response_id)}` : undefined, model: file.model, c: codexCounts(p.usage) };
  }
  if (v.type === 'event_msg' && p?.type === 'token_count' && !file.records && isObj(p.info) && isObj(p.info.last_token_usage)) {
    const total = isObj(p.info.total_token_usage) ? num(p.info.total_token_usage.total_tokens) : 0;
    if (total && total === file.lastTotal) return null; // repeated without a new response
    file.lastTotal = total;
    return { t: Date.parse(str(v.timestamp)), model: file.model, c: codexCounts(p.info.last_token_usage) };
  }
  if (v.type === 'PLANNER_RESPONSE' && (num(v.input_tokens) || num(v.output_tokens))) {
    // input_tokens excludes cache reads (cache_read_tokens is often larger than it).
    const c: UsageCounts = { ...zero(), input: num(v.input_tokens), cacheRead: num(v.cache_read_tokens), output: num(v.output_tokens), requests: 1 };
    return { t: Date.parse(str(v.created_at)), key: `a:${fileKey}:${String(v.step_index)}`, c, coarseTime: true };
  }
  return null;
}

// OpenAI-style usage: input_tokens includes the cached part, output_tokens includes reasoning.
function codexCounts(u: Obj): UsageCounts {
  const cached = num(u.cached_input_tokens);
  const written = num(u.cache_write_input_tokens);
  return {
    input: Math.max(0, num(u.input_tokens) - cached - written), cacheRead: cached, cacheWrite: written,
    output: num(u.output_tokens), reasoning: num(u.reasoning_output_tokens), requests: 1,
  };
}

// Complete lines appended to `file` since `offset`; restarts from 0 if the file shrank. null if it cannot be read.
function readNew(file: string, offset: number): { text: string; next: number; complete: boolean } | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) offset = 0;
    if (size === offset) return { text: '', next: offset, complete: true };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) return { text: '', next: offset, complete: false };
    return { text: buf.subarray(0, nl + 1).toString('utf8'), next: offset + nl + 1, complete: nl + 1 === buf.length };
  } catch (e) {
    console.warn(`[usage] 读取 ${file} 失败：${(e as Error).message}`);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function loadFile(file: string): UsageFile {
  const empty: UsageFile = { version: 1, eventsOffset: 0, sessions: {}, files: {}, seen: [], tasks: {}, projects: {}, buckets: {} };
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return empty; }
  try {
    const v = JSON.parse(raw);
    if (v?.version !== 1 || !isObj(v.buckets) || !isObj(v.sessions) || !isObj(v.files)) throw new Error('unexpected format');
    return { ...empty, ...v };
  } catch (e) {
    const keep = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, keep); } catch { /* keep going from empty */ }
    console.warn(`[usage] ${file} 已损坏（${(e as Error).message}），已保留为 ${keep}，重新统计`);
    return empty;
  }
}

export function createUsage(o: { stateDir: string; source: UsageSource; now?: () => number }) {
  const now = o.now ?? Date.now;
  const file = path.join(o.stateDir, 'usage.json');
  const eventsFile = path.join(o.stateDir, 'events.jsonl');
  const st = loadFile(file);
  const seen = new Set(st.seen);
  let lastScan = 0;
  let savePending = false;

  const sess = (id: string, agent: AgentKind, at: number) =>
    (st.sessions[id] ??= { agent, start: at - START_SLACK, lastAt: at, files: [], models: [] });
  const addFile = (s: SessState, p: string) => {
    const f = normPath(p);
    if (s.files.includes(f)) return;
    s.files.push(f);
    delete s.done; // a file learned late still gets read
  };

  function readEvents(): boolean {
    const r = readNew(eventsFile, st.eventsOffset);
    if (!r || r.next === st.eventsOffset) return false;
    for (const line of r.text.split('\n')) {
      if (!line) continue;
      let e: Obj;
      try { e = JSON.parse(line); } catch { continue; }
      if (!isObj(e) || typeof e.sessionId !== 'string') continue;
      const at = num(e.at) || now();
      if (e.kind === 'hook') {
        const s = sess(e.sessionId, str(e.agent) as AgentKind, at);
        s.lastAt = Math.max(s.lastAt, at);
        delete s.done;
        const p = isObj(e.payload) ? e.payload : {};
        const tp = str(p.transcript_path) || str(p.transcriptPath);
        if (tp) addFile(s, tp);
        const model = str(s.agent === 'agy' ? p.modelName : p.model);
        if (model && s.models.at(-1)?.[1] !== model) s.models.push([at, model]);
      } else if (e.kind === 'exit' && st.sessions[e.sessionId]) {
        st.sessions[e.sessionId].end = at;
        delete st.sessions[e.sessionId].done;
      }
    }
    st.eventsOffset = r.next;
    return true;
  }

  // Checkpoint all metadata before removing its source events, with offset 0 for the next file. A crash before
  // the rename then replays the old events safely; one after it starts the new file from its beginning.
  // The server appends only on this thread, so nothing can land during this synchronous checkpoint and rename.
  function rotateEvents() {
    if (st.eventsOffset < EVENTS_ROTATE_BYTES) return;
    try {
      if (fs.statSync(eventsFile).size !== st.eventsOffset) return; // a partial last line: wait for the next scan
      const offset = st.eventsOffset;
      st.eventsOffset = 0;
      if (!save()) { st.eventsOffset = offset; return; }
      try {
        fs.renameSync(eventsFile, path.join(o.stateDir, 'events.1.jsonl'));
      } catch (e) {
        st.eventsOffset = offset; // still reading the old file in this process; on disk it is safe to replay
        throw e;
      }
    } catch (e) {
      console.warn(`[usage] 无法轮转 ${eventsFile}：${(e as Error).message}`);
    }
  }

  function syncStore(): boolean {
    let changed = false;
    for (const s of o.source.sessions()) {
      const known = st.sessions[s.id];
      const x = sess(s.id, s.agent, s.startedAt + START_SLACK);
      if (!known || x.taskId !== s.taskId || x.start > s.startedAt) changed = true;
      x.taskId = s.taskId;
      x.start = Math.min(x.start, s.startedAt);
      if (s.transcriptPath) addFile(x, s.transcriptPath);
    }
    for (const t of o.source.tasks()) {
      const old = st.tasks[t.id];
      if (old?.title !== t.title || old.projectId !== t.projectId) { st.tasks[t.id] = { title: t.title, projectId: t.projectId }; changed = true; }
    }
    for (const p of o.source.projects()) if (st.projects[p.id] !== p.name) { st.projects[p.id] = p.name; changed = true; }
    return changed;
  }

  // The session whose run covers time t, latest start first.
  const runEnd = (id: string, s: SessState, live: Set<string>) =>
    s.end !== undefined ? s.end + END_SLACK : live.has(id) ? Infinity : s.lastAt + OPEN_END;

  function owner(ids: string[], t: number, live: Set<string>): [string, SessState] | null {
    let best: [string, SessState] | null = null;
    for (const id of ids) {
      const s = st.sessions[id];
      const end = runEnd(id, s, live);
      if (t >= s.start && t <= end && (!best || s.start > best[1].start)) best = [id, s];
    }
    return best;
  }

  const modelAt = (s: SessState, t: number) => {
    let m: string | undefined;
    for (const [at, name] of s.models) if (at <= t + END_SLACK || !m) m = name;
    return m;
  };

  function scanFile(f: string, ids: string[], live: Set<string>): { changed: boolean; complete: boolean } {
    const fs0 = (st.files[f] ??= { offset: 0 });
    const r = readNew(f, fs0.offset);
    if (!r) return { changed: false, complete: false };
    if (r.next === fs0.offset) return { changed: false, complete: r.complete };
    for (const line of r.text.split('\n')) {
      const relevant = line.includes('_tokens"')
        || line.includes('"turn_context"')
        || line.includes('"user"')
        || line.includes('"USER_INPUT"')
        || line.includes('"GENERIC"')
        || line.includes('"function_call_output"')
        || line.includes('"custom_tool_call_output"')
        || line.includes('"user_message"')
        || line.includes('"task_started"');
      if (!relevant) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; }
      if (!isObj(v)) continue;
      const pt = parsePromptAt(v);
      if (pt !== null) { fs0.lastPromptAt = pt; continue; }
      const hit = parseUsageLine(v, fs0, f);
      if (!hit || !Number.isFinite(hit.t) || usageTotal(hit.c) === 0) continue;
      if (hit.key && seen.has(hit.key)) continue;
      const own = owner(ids, hit.t, live);
      if (!own) continue; // outside every workbench run of this conversation (e.g. resumed in a plain terminal)
      if (hit.key) seen.add(hit.key);
      const [, s] = own;
      const model = hit.model ?? modelAt(s, hit.t) ?? '';
      const k = `${Math.floor(hit.t / HOUR) * HOUR}|${s.agent}|${model}|${s.taskId ?? ''}`;
      add((st.buckets[k] ??= zero()), hit.c);
      if (s.taskId) {
        const ts = ((st.taskSpeed ??= {})[s.taskId] ??= { samples: [], updatedAt: 0 });
        ts.updatedAt = Math.max(ts.updatedAt, hit.t);
        if (fs0.lastPromptAt !== undefined && hit.c.output >= 5) {
          const rawDt = hit.t - fs0.lastPromptAt;
          const dt = hit.coarseTime
            ? (rawDt >= 0 && rawDt <= MAX_STEP_MS ? Math.max(rawDt, 1000) : null)
            : (rawDt >= 200 && rawDt <= MAX_STEP_MS ? rawDt : null);
          if (dt !== null) {
            ts.samples.push([hit.c.output, dt]);
            if (ts.samples.length > MAX_SPEED_SAMPLES) ts.samples.shift();
          }
        }
      }
      fs0.lastPromptAt = hit.t;
    }
    fs0.offset = r.next;
    return { changed: true, complete: r.complete };
  }

  function scan() {
    lastScan = now();
    let changed = readEvents();
    if (syncStore()) changed = true;
    const live = new Set(o.source.sessions().filter(s => s.status !== 'exited').map(s => s.id));
    const byFile = new Map<string, string[]>();
    const link = (f: string, id: string) => {
      const ids = byFile.get(f) ?? [];
      if (!ids.includes(id)) ids.push(id);
      byFile.set(f, ids);
    };
    const settled: [string, SessState][] = [];
    const incomplete = new Set<string>();
    for (const [id, s] of Object.entries(st.sessions)) {
      if (live.has(id)) delete s.done;
      if (s.done) continue;
      // Only a complete scan may retire this session; unreadable files and partial lines need another attempt.
      if (now() > runEnd(id, s, live) + SETTLE) settled.push([id, s]);
      for (const f of s.files) {
        link(f, id);
        if (s.agent !== 'claude' || !f.endsWith('.jsonl')) continue;
        const sub = path.join(f.slice(0, -'.jsonl'.length), 'subagents');
        let names: string[] = [];
        try { names = fs.readdirSync(sub).filter(n => n.endsWith('.jsonl')); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') incomplete.add(id);
        }
        for (const n of names) link(path.join(sub, n), id);
      }
    }
    for (const [f, ids] of byFile) {
      const r = scanFile(f, ids, live);
      if (r.changed) changed = true;
      if (!r.complete) for (const id of ids) incomplete.add(id);
    }
    for (const [id, s] of settled) if (!incomplete.has(id)) { s.done = true; changed = true; }
    if ((changed || savePending) && !save()) return;
    rotateEvents();
  }

  function save(): boolean {
    let keep = [...seen];
    if (keep.length > SEEN_MAX) {
      keep = keep.slice(-SEEN_MAX);
      seen.clear();
      for (const k of keep) seen.add(k);
    }
    st.seen = keep;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, file);
      savePending = false;
      return true;
    } catch (e) {
      savePending = true;
      console.error(`[usage] 写入 ${file} 失败：`, (e as Error).message);
      return false;
    }
  }

  function report(from: number | null, to: number | null): UsageReport {
    if (now() - lastScan >= SCAN_MIN_MS) scan();
    const tasks = new Map(o.source.tasks().map(t => [t.id, t]));
    const projects = new Map(o.source.projects().map(p => [p.id, p]));
    const total = zero();
    const groups = { vendor: new Map<string, UsageRow>(), model: new Map<string, UsageRow>(), agent: new Map<string, UsageRow>(), task: new Map<string, UsageRow>(), project: new Map<string, UsageRow>() };
    const hours = new Map<number, { t: number } & UsageCounts>();
    let since: number | null = null;
    const row = (m: Map<string, UsageRow>, key: string, init: () => Omit<UsageRow, keyof UsageCounts | 'key'>) => {
      let r = m.get(key);
      if (!r) m.set(key, (r = { key, ...init(), ...zero() }));
      return r;
    };
    for (const [k, c] of Object.entries(st.buckets)) {
      const [h, agent0, model, taskId] = k.split('|');
      const hour = Number(h);
      const agent = agent0 as AgentKind;
      since = since === null ? hour : Math.min(since, hour);
      if ((from !== null && hour < from) || (to !== null && hour >= to)) continue;
      add(total, c);
      const vendor = vendorOf(model, agent);
      add(row(groups.vendor, vendor, () => ({ label: vendor })), c);
      add(row(groups.model, model, () => ({ label: model || '未知模型', vendor })), c);
      add(row(groups.agent, agent, () => ({ label: AGENT_LABEL[agent] ?? agent })), c);
      const live = tasks.get(taskId);
      const snap = st.tasks[taskId];
      const projectId = live?.projectId ?? snap?.projectId ?? '';
      const projectName = projects.get(projectId)?.name ?? st.projects[projectId] ?? '';
      const tr = row(groups.task, taskId, () => ({
        // Sessions seen only in events.jsonl: their task was deleted before usage.json first recorded it.
        label: live?.title ?? snap?.title ?? '已删除的任务（标题未记录）', project: projectName, deleted: !live, agents: [],
      }));
      if (!tr.agents!.includes(agent)) tr.agents!.push(agent);
      add(tr, c);
      const pr = row(groups.project, projectId, () => ({ label: projectName || '未知项目', deleted: !projects.has(projectId), agents: [] }));
      if (!pr.agents!.includes(agent)) pr.agents!.push(agent);
      add(pr, c);
      add((hours.get(hour) ?? (hours.set(hour, { t: hour, ...zero() }), hours.get(hour)!)), c);
    }
    const sorted = (m: Map<string, UsageRow>) => [...m.values()].sort((a, b) => usageTotal(b) - usageTotal(a));
    return {
      from, to, since, scannedAt: lastScan, total,
      byVendor: sorted(groups.vendor), byModel: sorted(groups.model), byAgent: sorted(groups.agent),
      byTask: sorted(groups.task), byProject: sorted(groups.project),
      hours: [...hours.values()].sort((a, b) => a.t - b.t),
    };
  }

  function telemetry(force = false): TelemetrySummary {
    if (force || now() - lastScan >= SCAN_MIN_MS) scan();
    const liveTaskIds = new Set(o.source.tasks().map(t => t.id));
    const d = new Date(now());
    d.setHours(0, 0, 0, 0);
    const todayStart = d.getTime();
    const today = { ...zero(), tps: null as number | null, updatedAt: 0 };
    const byTask: Record<string, TaskMetrics> = {};

    for (const [k, c] of Object.entries(st.buckets)) {
      const [h, , , taskId] = k.split('|');
      const hour = Number(h);
      if (hour >= todayStart) add(today, c);
      if (taskId && liveTaskIds.has(taskId)) {
        const m = (byTask[taskId] ??= { ...zero(), tps: null, updatedAt: 0 });
        add(m, c);
      }
    }

    let latestTpsAt = 0;
    for (const [taskId, ts] of Object.entries(st.taskSpeed ?? {})) {
      const tps = calcTps(ts.samples);
      if (byTask[taskId]) {
        byTask[taskId].tps = tps;
        byTask[taskId].updatedAt = ts.updatedAt;
      }
      if (ts.updatedAt >= todayStart) {
        today.updatedAt = Math.max(today.updatedAt, ts.updatedAt);
        if (tps !== null && ts.updatedAt >= latestTpsAt) {
          latestTpsAt = ts.updatedAt;
          today.tps = tps;
        }
      }
    }
    return { byTask, today };
  }

  return { scan, report, telemetry };
}

export type Usage = ReturnType<typeof createUsage>;
