import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type {
  AgentKind, Card, ClientMsg, CreateProjectBody, CreateTaskBody, DirListing, FeedbackBody, FeedbackResult, ForwardBody, ForwardResult, HookBody, Project,
  GitInfo, RenameTaskBody, ResumeResult, ResumeTaskBody, ServerMsg, SessionInfo, Settings, Snapshot, SwitchAgentBody, SwitchResult, Task, TaskPhase,
} from '../shared/protocol.ts';
import { canResume, feedbackPrompt, forwardText } from '../shared/protocol.ts';
import { clipboardFiles } from './clipboard.ts';
import { autoArchiveMs, staleApproved } from './autoarchive.ts';
import { capBody, lastReply } from './cards.ts';
import { agyResumeId, agyTranscriptFile, availableAgents, claudeResumeId, ROOT } from './agents.ts';
import { fallbackCard, generateCard, generatorPrompt, handoffPrompt, runHeadless } from './handoff.ts';
import type { HandoffInput } from './handoff.ts';
import { createQuotaStore, detectLimit, parseAgyQuota, parseClaudeRateLimits, readCodexQuota } from './quota.ts';
import { findEditor, OpenError, openAction, resolveOpenTarget, runOpen } from './open.ts';
import { readTranscript } from './transcript.ts';
import type { SessionManager } from './sessions.ts';
import { pickColor } from './store.ts';
import type { Store } from './store.ts';
import type { Usage } from './usage.ts';
import { titleFromPrompt, titleFromReply, titlePrompt, promptPreview } from './titles.ts';
import { gitInfo } from './git.ts';
import {
  WorkspaceError, discardFile, listAllFiles, listChanges, listTree, readDiff, readFileEntry, resolveRawImage, writeFileEntry,
} from './workspace.ts';

const MAX_BODY = 1024 * 1024;
const MAX_FILE_BODY = 5 * 1024 * 1024;
const DIST = path.join(ROOT, 'web', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  status: number;
  code?: string;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface AppConfig {
  port: number;
  token: string;
  store: Store;
  sessions: SessionManager;
  stateDir: string; // handoff generators write their output files here
  usage: Usage;
  onShutdown?: () => void; // POST /api/shutdown: the desktop shell quitting, same as Ctrl+C on the server
}

function readBody(req: http.IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function readBuffer(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Past the cap the rest is drained, not stored, so the 413 reaches the client instead of a reset connection.
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => (size > max ? reject(new HttpError(413, '图片过大（上限 20 MB）')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const parseJson =(raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new HttpError(400, '请求体不是有效的 JSON 对象');
};

export function createApp(cfg: AppConfig) {
  const { store, sessions } = cfg;
  const allowed = new Set([`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`]);
  if (process.env.WORKBENCH_DEV === '1') for (const o of ['http://127.0.0.1:5173', 'http://localhost:5173']) allowed.add(o);

  // Git state per project: derived, memory only. Polled while a client is watching.
  const gitMap = new Map<string, GitInfo | null>();
  const gitBusy = new Set<string>();
  const sameGit = (a: GitInfo | null | undefined, b: GitInfo | null) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
  async function refreshGit(projectId: string): Promise<void> {
    if (gitBusy.has(projectId)) return; // never overlap runs for one project
    const project = store.getProject(projectId);
    if (!project) return;
    gitBusy.add(projectId);
    try {
      const info = await gitInfo(project.path);
      if (!store.getProject(projectId)) return; // removed meanwhile
      if (sameGit(gitMap.get(projectId), info)) return;
      gitMap.set(projectId, info);
      broadcast({ t: 'git', projectId, git: info });
    } finally {
      gitBusy.delete(projectId);
    }
  }
  let gitSweepRunning = false;
  async function refreshAllGit(): Promise<void> {
    if (gitSweepRunning) return;
    gitSweepRunning = true;
    try {
      for (const p of store.projects()) await refreshGit(p.id); // one at a time: git status on big repos is not free
    } finally {
      gitSweepRunning = false;
    }
  }

  // Subscription quota per agent kind: kept in <stateDir>/quota.json, broadcast when the windows change.
  const quota = createQuotaStore(path.join(cfg.stateDir, 'quota.json'));
  function observeQuota(body: HookBody): void {
    const session = sessions.list().find(s => s.id === body.sessionId);
    if (!session) return;
    let windows = null;
    if (body.event === 'RateLimits') {
      const p = body.payload as Record<string, unknown> | null;
      if (session.agent === 'agy') windows = parseAgyQuota(p?.quota, body.at);
      else if (session.agent === 'claude' || session.agent === 'fake') windows = p?.quota ? parseAgyQuota(p.quota, body.at) : parseClaudeRateLimits(p?.rate_limits);
    } else if (body.event === 'Stop' && session.agent === 'codex' && session.transcriptPath) {
      windows = readCodexQuota(session.transcriptPath);
    }
    const info = windows && quota.set(session.agent, windows);
    if (info) broadcast({ t: 'quota', agent: session.agent, quota: info });
  }

  const snapshot = (): Snapshot => ({
    projects: store.projects(), tasks: store.tasks(), sessions: sessions.list(), cards: store.cards(), agents: availableAgents(), settings: store.settings(),
    git: Object.fromEntries(gitMap), quota: quota.all(),
  });

  const sizeOnly = (saved: SessionInfo | undefined, next: SessionInfo) =>
    !!saved && JSON.stringify({ ...saved, cols: next.cols, rows: next.rows }) === JSON.stringify(next);

  const clients = new Set<WebSocket>();
  const broadcast = (m: ServerMsg) => {
    const raw = JSON.stringify(m);
    for (const c of clients) if (c.readyState === 1) c.send(raw);
  };
  sessions.subscribe(m => {
    if (m.t === 'session') {
      // A terminal resize changes only cols/rows: not worth rewriting state.json for (the next real change saves them too).
      if (!sizeOnly(store.getSession(m.session.id), m.session)) store.saveSession(m.session);
      broadcast(m);
      // Typing a follow-up in the terminal takes the task out of 待验收 / 已通过 / 已归档.
      const task = m.session.status === 'working' ? store.getTask(m.session.taskId) : undefined;
      if (task && task.sessionId === m.session.id && task.phase !== 'active') setPhase(task, 'active');
      return;
    }
    broadcast(m);
  });

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) res.writeHead(status).end();
    else res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };

  function createProject(b: Record<string, unknown>): Project {
    const body = b as Partial<CreateProjectBody>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new HttpError(400, '项目名称不能为空');
    if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, '项目路径不能为空');
    const abs = path.resolve(body.path.trim());
    let ok = false;
    try { ok = fs.statSync(abs).isDirectory(); } catch { /* not found */ }
    if (!ok) throw new HttpError(400, `路径不是已存在的目录：${abs}`);
    const project: Project = { id: crypto.randomUUID(), name, path: abs, createdAt: Date.now() };
    store.addProject(project);
    broadcast({ t: 'project', project });
    void refreshGit(project.id);
    return project;
  }

  function createTask(b: Record<string, unknown>) {
    const body = b as Partial<CreateTaskBody>;
    const project = typeof body.projectId === 'string' ? store.getProject(body.projectId) : undefined;
    if (!project) throw new HttpError(400, '项目不存在');
    const agent = body.agent as AgentKind;
    if (!availableAgents().includes(agent)) throw new HttpError(400, `智能体不可用：${String(body.agent)}`);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const lastPrompt = promptPreview(prompt);
    let title = typeof body.title === 'string' ? body.title.trim() : '';
    let titleAuto = false;
    let fromPrompt = false;
    if (!title) { title = titleFromPrompt(prompt); fromPrompt = !!title; }
    if (!title) {
      const used = new Set(store.tasks().filter(t => t.projectId === project.id).map(t => t.title));
      let n = 1;
      while (used.has(`新任务 ${n}`)) n++;
      title = `新任务 ${n}`;
      titleAuto = true;
    }
    const task: Task = {
      id: crypto.randomUUID(), projectId: project.id, title, titleAuto, prompt, color: pickColor(store.tasks()),
      agent, sessionId: null, createdAt: Date.now(),
      phase: 'active', phaseSince: Date.now(), ...(lastPrompt && { lastPrompt }),
    };
    let session;
    try {
      session = sessions.spawn({
        taskId: task.id, agent, cwd: project.path, prompt,
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
      });
    } catch (e) {
      throw new HttpError(500, `启动失败：${(e as Error).message}`);
    }
    task.sessionId = session.id;
    store.addTask(task);
    store.saveSession(session);
    broadcast({ t: 'task', task });
    broadcast({ t: 'session', session });
    if (fromPrompt) aiRetitle(task.id, title, prompt);
    return { task, session };
  }

  function renameTask(id: string, b: Record<string, unknown>): Task {
    const body = b as Partial<RenameTaskBody>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new HttpError(400, '任务标题不能为空');
    const old = store.getTask(id);
    if (!old) throw new HttpError(404, '任务不存在');
    if ([...title].length > 80) throw new HttpError(400, '任务标题太长');
    const task: Task = { ...old, title, titleAuto: false };
    store.updateTask(task);
    broadcast({ t: 'task', task });
    return task;
  }

  function setPhase(task: Task, phase: TaskPhase): Task {
    const next: Task = { ...task, phase, phaseSince: Date.now() };
    store.updateTask(next);
    broadcast({ t: 'task', task: next });
    return next;
  }

  // Approved tasks left alone for days, with no running session, move to 已归档 (nothing to kill).
  const archiveMs = autoArchiveMs(process.env.WORKBENCH_AUTO_ARCHIVE_DAYS);
  function autoArchive() {
    if (!archiveMs) return;
    const live = new Set(sessions.list().filter(s => s.status !== 'exited').map(s => s.id));
    for (const t of staleApproved(store.tasks(), live, Date.now(), archiveMs)) setPhase(t, 'archived');
  }
  autoArchive();
  const archiveTimer = setInterval(autoArchive, 3600_000);
  archiveTimer.unref();

  // Spawns a session for the task and makes it the current one; the old session is killed and forgotten so a task never piles up dead ones.
  function replaceSession(
    task: Task, project: Project, prev: SessionInfo | undefined,
    o: { prompt: string; resume?: string; cols?: number; rows?: number }, patch: Partial<Task> = {},
  ): { task: Task; session: SessionInfo } {
    let session;
    try {
      session = sessions.spawn({ taskId: task.id, agent: { ...task, ...patch }.agent, cwd: project.path, ...o });
    } catch (e) {
      throw new HttpError(500, `启动失败：${(e as Error).message}`);
    }
    if (prev) {
      sessions.remove(prev.id);
      store.removeSession(prev.id);
    }
    const next: Task = { ...task, ...patch, sessionId: session.id };
    store.updateTask(next);
    store.saveSession(session);
    broadcast({ t: 'task', task: next });
    broadcast({ t: 'session', session });
    return { task: next, session };
  }

  // Native session id to reopen for an exited session, if its conversation still exists.
  function resumableNative(prev: SessionInfo | undefined): string | undefined {
    const native = prev && canResume(prev) ? prev.nativeSessionId! : undefined;
    if (native && prev!.agent === 'claude') return claudeResumeId(native, prev!.transcriptPath);
    if (native && prev!.agent === 'agy') return agyResumeId(native, prev!.transcriptPath);
    return native;
  }

  // New session for an existing task: reopens the last conversation unless asked for a fresh one.
  // With no conversation to reopen it refuses (409 no-conversation) instead of silently replacing the old session.
  function resumeTask(id: string, b: Record<string, unknown>): ResumeResult {
    const body = b as Partial<ResumeTaskBody>;
    const task = store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    const project = store.getProject(task.projectId);
    if (!project) throw new HttpError(400, '项目不存在');
    if (!availableAgents().includes(task.agent)) throw new HttpError(400, `智能体不可用：${task.agent}`);
    const prev = task.sessionId ? sessions.list().find(s => s.id === task.sessionId) : undefined;
    if (prev && prev.status !== 'exited') throw new HttpError(409, '会话还在运行');
    const native = body.fresh === true ? undefined : resumableNative(prev);
    if (body.fresh !== true && native === undefined) throw new HttpError(409, '上次会话没有对话记录', 'no-conversation');
    const { task: next, session } = replaceSession(task, project, prev, {
      prompt: '', resume: native,
      cols: typeof body.cols === 'number' ? body.cols : undefined,
      rows: typeof body.rows === 'number' ? body.rows : undefined,
    });
    return { task: next, session, resumed: native !== undefined };
  }

  function addCard(task: Task, sessionId: string, kind: Card['kind'], text: string, meta?: Card['meta']): Card {
    const card: Card = { id: crypto.randomUUID(), taskId: task.id, sessionId, kind, body: capBody(text), createdAt: Date.now(), ...(meta && { meta }) };
    store.addCard(card);
    broadcast({ t: 'card', card });
    return card;
  }

  // Pastes text into the task's current session, queued until it is idle; an exited session is reopened first.
  function pasteIntoTask(
    task: Task, project: Project, prev: SessionInfo | undefined, text: string, size: { cols?: number; rows?: number }, patch: Partial<Task>,
    errors: { noSession: string; noConversation: string },
  ): { task: Task; session: SessionInfo } {
    if (!prev) throw new HttpError(400, errors.noSession);
    if (prev.status !== 'exited') {
      const next: Task = { ...task, ...patch };
      store.updateTask(next);
      broadcast({ t: 'task', task: next });
      sessions.enqueue(prev.id, text);
      return { task: next, session: prev };
    }
    const native = resumableNative(prev);
    if (!native) throw new HttpError(400, errors.noConversation);
    const r = replaceSession(task, project, prev, { prompt: '', resume: native, ...size }, patch);
    sessions.enqueue(r.session.id, text);
    return r;
  }

  function feedback(id: string, b: Record<string, unknown>): FeedbackResult {
    const body = b as Partial<FeedbackBody>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '反馈不能为空');
    if (body.mode !== 'new' && body.mode !== 'same') throw new HttpError(400, '反馈方式无效');
    const task = store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    const project = store.getProject(task.projectId);
    if (!project) throw new HttpError(400, '项目不存在');
    if (!availableAgents().includes(task.agent)) throw new HttpError(400, `智能体不可用：${task.agent}`);
    const prev = task.sessionId ? sessions.list().find(s => s.id === task.sessionId) : undefined;
    const size = { cols: typeof body.cols === 'number' ? body.cols : undefined, rows: typeof body.rows === 'number' ? body.rows : undefined };
    const active = { phase: 'active' as const, phaseSince: Date.now() };
    let next: Task;
    let session: SessionInfo;
    if (body.mode === 'new') {
      const lastResult = store.cards().filter(c => c.taskId === task.id && c.kind === 'result').at(-1);
      ({ task: next, session } = replaceSession(task, project, prev, { prompt: feedbackPrompt(task, lastResult?.body, text), ...size }, active));
    } else {
      ({ task: next, session } = pasteIntoTask(task, project, prev, text, size, active, {
        noSession: '任务没有会话，请用新会话继续', noConversation: '原会话没有对话记录，请用新会话继续',
      }));
    }
    const card = addCard(next, session.id, 'feedback', text);
    return { task: next, session, card };
  }

  const switching = new Set<string>(); // task ids whose handoff card is being made

  // Makes a handoff card with the target agent (an excerpt of the transcript if that fails) and starts the target on the task.
  async function switchAgent(id: string, b: Record<string, unknown>): Promise<SwitchResult> {
    const body = b as Partial<SwitchAgentBody>;
    const agent = body.agent as AgentKind;
    if (!availableAgents().includes(agent)) throw new HttpError(400, `智能体不可用：${String(body.agent)}`);
    const first = store.getTask(id);
    if (!first) throw new HttpError(404, '任务不存在');
    const project = store.getProject(first.projectId);
    if (!project) throw new HttpError(400, '项目不存在');
    if (switching.has(id)) throw new HttpError(409, '正在换 agent');
    switching.add(id);
    try {
      const note = typeof body.note === 'string' ? body.note.trim() || undefined : undefined;
      const current = (t: Task) => (t.sessionId ? sessions.list().find(s => s.id === t.sessionId) : undefined);
      const before = current(first);
      const from = before?.agent ?? first.agent;
      const healedAgyId = from === 'agy' && before ? agyResumeId(before.nativeSessionId, before.transcriptPath) : undefined;
      const tp = (healedAgyId ? agyTranscriptFile(healedAgyId) : undefined) ?? before?.transcriptPath;
      const input: HandoffInput = {
        task: first, from, to: agent, cards: store.cards().filter(c => c.taskId === id),
        turns: tp ? readTranscript(from, tp) : [],
        transcriptPath: tp, note, limit: before?.limit,
      };
      const generated = await generateCard(agent, generatorPrompt(input), { cwd: project.path, stateDir: cfg.stateDir });
      const task = store.getTask(id);
      if (!task) throw new HttpError(404, '任务已删除');
      const prev = current(task);
      const card = generated ?? fallbackCard(input);
      const { task: next, session } = replaceSession(task, project, prev, {
        prompt: handoffPrompt(task, card, { from, transcriptPath: input.transcriptPath, note, limit: !!input.limit }),
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
      }, { agent, phase: 'active', phaseSince: Date.now() });
      const saved = addCard(next, session.id, 'handoff', card, { from, to: agent, generated: generated !== null });
      return { task: next, session, card: saved, generated: generated !== null };
    } finally {
      switching.delete(id);
    }
  }

  // Sends a card to another task (queued like feedback 'same') or to a new task.
  function forward(cardId: string, b: Record<string, unknown>): ForwardResult {
    const body = b as Partial<ForwardBody>;
    const card = store.cards().find(c => c.id === cardId);
    if (!card) throw new HttpError(404, '卡片不存在');
    if (!card.body.trim()) throw new HttpError(400, '卡片内容为空');
    const source = store.getTask(card.taskId);
    if (!source) throw new HttpError(404, '任务不存在');
    const sourceAgent = sessions.list().find(s => s.id === card.sessionId)?.agent ?? source.agent;
    const text = forwardText({ title: source.title, agent: sourceAgent }, card.body, typeof body.note === 'string' ? body.note : undefined);
    const to = body.to as Partial<{ taskId: string; projectId: string; agent: AgentKind }> | undefined;
    const size = { cols: typeof body.cols === 'number' ? body.cols : undefined, rows: typeof body.rows === 'number' ? body.rows : undefined };
    let task: Task;
    let session: SessionInfo;
    if (to && typeof to.taskId === 'string') {
      const target = store.getTask(to.taskId);
      if (!target) throw new HttpError(404, '目标任务不存在');
      if (target.id === source.id) throw new HttpError(400, '不能转发给同一个任务');
      const project = store.getProject(target.projectId);
      if (!project) throw new HttpError(400, '项目不存在');
      if (!availableAgents().includes(target.agent)) throw new HttpError(400, `智能体不可用：${target.agent}`);
      const prev = target.sessionId ? sessions.list().find(s => s.id === target.sessionId) : undefined;
      const msg = '目标任务没有可续接的对话，请转发到新任务';
      ({ task, session } = pasteIntoTask(target, project, prev, text, size, { phase: 'active', phaseSince: Date.now() }, { noSession: msg, noConversation: msg }));
    } else if (to && typeof to.projectId === 'string') {
      ({ task, session } = createTask({ projectId: to.projectId, agent: to.agent, prompt: text, title: [...`转发：${source.title}`].slice(0, 80).join(''), ...size }));
    } else {
      throw new HttpError(400, '没有指定转发目标');
    }
    const saved = addCard(task, session.id, 'forward', text, { sourceTaskId: source.id, sourceCardId: card.id });
    return { task, session, card: saved };
  }

  // A finished turn becomes a result card and moves the task to 待验收.
  function onStop(body: HookBody) {
    const session = sessions.list().find(s => s.id === body.sessionId);
    const task = session ? store.getTask(session.taskId) : undefined;
    if (!session || !task || task.sessionId !== session.id) return;
    if (detectLimit(session.agent, 'Stop', (body.payload ?? {}) as Record<string, unknown>)) return; // out of quota, not a result
    addCard(task, session.id, 'result', lastReply(session.agent, body.payload) ?? '（没有拿到这一轮的最后回复，请看终端）');
    setPhase(task, 'review');
    void refreshGit(task.projectId); // the turn probably changed files
  }

  // The latest prompt of the task's current session, as a second line under the title.
  function updateLastPrompt(body: HookBody) {
    const p = (body.payload ?? {}) as Record<string, unknown>;
    const text = body.event === 'UserPromptSubmit' ? p.prompt : body.event === 'PreInvocation' ? p.lastUserInput : undefined;
    if (typeof text !== 'string' || text.trimStart().startsWith('/')) return;
    const preview = promptPreview(text);
    if (!preview) return;
    const session = sessions.list().find(s => s.id === body.sessionId);
    const old = session ? store.getTask(session.taskId) : undefined;
    if (!old || old.sessionId !== body.sessionId || old.lastPrompt === preview) return;
    const task: Task = { ...old, lastPrompt: preview };
    store.updateTask(task);
    broadcast({ t: 'task', task });
  }

  // The first-line title is already showing; a short headless call of the task's agent writes a better one.
  // Applied only if the title is still the one we set (the user has not renamed the task meanwhile).
  function aiRetitle(taskId: string, shown: string, text: string): void {
    if (!store.settings().aiTitles) return;
    const task = store.getTask(taskId);
    const project = task ? store.getProject(task.projectId) : undefined;
    if (!task || !project) return;
    void runHeadless(task.agent, titlePrompt(text), { cwd: project.path, stateDir: cfg.stateDir, timeoutMs: 60_000, what: '生成标题' })
      .then(out => {
        const title = out ? titleFromReply(out) : '';
        if (!title) return;
        const cur = store.getTask(taskId);
        if (!cur || cur.title !== shown || title === shown) return;
        const next: Task = { ...cur, title, titleAuto: false };
        store.updateTask(next);
        broadcast({ t: 'task', task: next });
      })
      .catch(e => console.warn(`[titles] 应用标题失败：${(e as Error).message}`));
  }

  // First usable prompt of an auto-titled task becomes its title.
  function autoRename(body: HookBody) {
    const p = (body.payload ?? {}) as Record<string, unknown>;
    const text = body.event === 'UserPromptSubmit' ? p.prompt : body.event === 'PreInvocation' ? p.lastUserInput : undefined;
    if (typeof text !== 'string' || text.trimStart().startsWith('/')) return;
    const taskId = sessions.list().find(s => s.id === body.sessionId)?.taskId;
    const old = taskId ? store.getTask(taskId) : undefined;
    if (!old || !old.titleAuto) return;
    const title = titleFromPrompt(text);
    if (!title) return;
    const task: Task = { ...old, title, titleAuto: false };
    store.updateTask(task);
    broadcast({ t: 'task', task });
    aiRetitle(task.id, title, text);
  }

  function listDirs(q: URLSearchParams): DirListing {
    if (q.get('drives')) {
      const entries: DirListing['entries'] = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':';
        if (fs.existsSync(`${d}\\`)) entries.push({ name: d, path: `${d}\\` });
      }
      return { path: null, parent: null, entries };
    }
    let raw = q.get('path')?.trim();
    if (!raw) {
      const last = store.projects().reduce<Project | undefined>((a, p) => (!a || p.createdAt >= a.createdAt ? p : a), undefined);
      // The desktop app's ROOT is its install folder; start from home there, next to the checkout otherwise.
      raw = last ? path.dirname(last.path) : process.env.WORKBENCH_BUNDLED === '1' ? os.homedir() : path.dirname(ROOT);
    }
    const abs = path.resolve(raw);
    let isDir = false;
    try { isDir = fs.statSync(abs).isDirectory(); } catch { /* not found */ }
    if (!isDir) throw new HttpError(400, `目录不存在：${abs}`);
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new HttpError(400, `无法读取目录：${abs}`);
    }
    const entries: DirListing['entries'] = [];
    for (const d of dirents) {
      if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
      const full = path.join(abs, d.name);
      let ok = d.isDirectory();
      if (!ok && d.isSymbolicLink()) {
        try { ok = fs.statSync(full).isDirectory(); } catch { /* ignore */ }
      }
      if (ok) entries.push({ name: d.name, path: full });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const up = path.dirname(abs);
    return { path: abs, parent: up === abs ? null : up, entries };
  }

  // A link clicked in a terminal: opens the file in the editor / Explorer, never executes it.
  function openTarget(b: Record<string, unknown>): { action: string; path: string } {
    if (typeof b.target !== 'string') throw new HttpError(400, '缺少链接');
    try {
      const resolved = resolveOpenTarget(b.target);
      const action = openAction(resolved, fs.statSync(resolved.path).isDirectory(), findEditor());
      runOpen(action);
      return { action: action.kind, path: resolved.path };
    } catch (e) {
      if (e instanceof OpenError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) throw new HttpError(403, 'Origin 不被允许');
    const method = req.method ?? 'GET';
    if (method === 'POST' && pathname === '/api/attachments') {
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[type];
      if (!ext) throw new HttpError(415, '只支持 PNG、JPEG、GIF、WebP 图片');
      const data = await readBuffer(req, MAX_ATTACHMENT);
      if (data.length === 0) throw new HttpError(400, '图片内容为空');
      const dir = path.join(cfg.stateDir, 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
      fs.writeFileSync(file, data);
      return send(res, 200, { path: path.resolve(file) });
    }
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '需要 application/json');
      body = parseJson(await readBody(req, method === 'PUT' ? MAX_FILE_BODY : MAX_BODY));
    }
    if (method === 'GET' && pathname === '/api/state') return send(res, 200, snapshot());
    if (method === 'POST' && pathname === '/api/shutdown' && cfg.onShutdown) {
      send(res, 202);
      return void setImmediate(cfg.onShutdown);
    }
    if (method === 'GET' && pathname === '/api/clipboard/files') {
      try {
        return send(res, 200, { paths: await clipboardFiles() });
      } catch (e) {
        throw new HttpError(500, (e as Error).message);
      }
    }
    if (method === 'GET' && pathname === '/api/usage') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const at = (k: string) => {
        const v = q.get(k);
        if (v === null || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, `${k} 不是有效的时间`);
        return n;
      };
      return send(res, 200, cfg.usage.report(at('from'), at('to')));
    }
    if (method === 'POST' && pathname === '/api/open') return send(res, 200, openTarget(body));
    if (method === 'POST' && pathname === '/api/settings') {
      if (body.aiTitles !== undefined && typeof body.aiTitles !== 'boolean') throw new HttpError(400, '设置值无效');
      const settings: Settings = { ...store.settings(), ...(typeof body.aiTitles === 'boolean' ? { aiTitles: body.aiTitles } : {}) };
      store.setSettings(settings);
      broadcast({ t: 'settings', settings });
      return send(res, 200, settings);
    }
    if (method === 'POST' && pathname === '/api/projects') return send(res, 200, createProject(body));
    if (method === 'POST' && pathname === '/api/tasks') return send(res, 200, createTask(body));
    const r = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (method === 'POST' && r) return send(res, 200, resumeTask(r[1], body));
    const sw = pathname.match(/^\/api\/tasks\/([^/]+)\/switch$/);
    if (method === 'POST' && sw) return send(res, 200, await switchAgent(sw[1], body));
    const fw = pathname.match(/^\/api\/cards\/([^/]+)\/forward$/);
    if (method === 'POST' && fw) return send(res, 200, forward(fw[1], body));
    const act = pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|archive|unarchive|feedback)$/);
    if (method === 'POST' && act) {
      if (act[2] === 'feedback') return send(res, 200, feedback(act[1], body));
      const task = store.getTask(act[1]);
      if (!task) throw new HttpError(404, '任务不存在');
      if (act[2] === 'archive' && task.sessionId) sessions.kill(task.sessionId);
      return send(res, 200, setPhase(task, act[2] === 'approve' ? 'approved' : act[2] === 'archive' ? 'archived' : 'active'));
    }
    const m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && m) return send(res, 200, renameTask(m[1], body));
    if (method === 'DELETE' && m) {
      const task = store.getTask(m[1]);
      if (!task) throw new HttpError(404, '任务不存在');
      cfg.usage.scan(); // records which task its sessions belonged to before they are dropped
      if (task.sessionId) sessions.remove(task.sessionId);
      store.removeTask(task.id);
      broadcast({ t: 'task-removed', id: task.id });
      return send(res, 200, { ok: true });
    }
    const pw = pathname.match(/^\/api\/projects\/([^/]+)\/(changes|diff|tree|files|file|raw|discard)$/);
    if (pw) {
      const project = store.getProject(decodeURIComponent(pw[1]));
      if (!project) throw new HttpError(404, '项目不存在');
      const sub = pw[2];
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (method === 'GET' && sub === 'changes') {
        const changes = await listChanges(project.path);
        if (!sameGit(gitMap.get(project.id), changes.git)) {
          gitMap.set(project.id, changes.git);
          broadcast({ t: 'git', projectId: project.id, git: changes.git });
        }
        return send(res, 200, changes);
      }
      if (method === 'GET' && sub === 'diff') return send(res, 200, await readDiff(project.path, q.get('path') ?? ''));
      if (method === 'GET' && sub === 'tree') return send(res, 200, await listTree(project.path, q.get('path') ?? ''));
      if (method === 'GET' && sub === 'files') return send(res, 200, await listAllFiles(project.path));
      if (method === 'GET' && sub === 'file') return send(res, 200, readFileEntry(project.path, q.get('path') ?? '', q.get('stat') === '1'));
      if (method === 'GET' && sub === 'raw') {
        const img = resolveRawImage(project.path, q.get('path') ?? '');
        res.writeHead(200, {
          'content-type': img.mime,
          'content-length': String(img.size),
          'cache-control': 'no-cache',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
        });
        pipeline(fs.createReadStream(img.absPath), res, e => {
          if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[raw]', img.absPath, e.message);
        });
        return;
      }
      if (method === 'PUT' && sub === 'file') {
        const saved = writeFileEntry(project.path, body);
        void refreshGit(project.id);
        return send(res, 200, saved);
      }
      if (method === 'POST' && sub === 'discard') {
        await discardFile(project.path, typeof body.path === 'string' ? body.path : '');
        await refreshGit(project.id);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, '请求方法不支持');
    }
    const pm = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === 'DELETE' && pm) {
      const project = store.getProject(pm[1]);
      if (!project) throw new HttpError(404, '项目不存在');
      cfg.usage.scan(); // records which project / task its sessions belonged to before they are dropped
      const mine = store.tasks().filter(t => t.projectId === project.id);
      for (const t of mine) if (t.sessionId) sessions.remove(t.sessionId);
      store.removeProject(project.id);
      gitMap.delete(project.id);
      for (const t of mine) broadcast({ t: 'task-removed', id: t.id });
      broadcast({ t: 'project-removed', id: project.id });
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname === '/api/dirs') return send(res, 200, listDirs(new URL(req.url ?? '/', 'http://x').searchParams));
    throw new HttpError(404, '未找到接口');
  }

  async function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const got = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${cfg.token}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'unauthorized');
    const b = parseJson(await readBody(req)) as Partial<HookBody>;
    if (typeof b.sessionId !== 'string' || typeof b.event !== 'string') throw new HttpError(400, 'bad hook body');
    if (sessions.hook(b as HookBody)) { // unknown sessions are logged and ignored
      observeQuota(b as HookBody);
      autoRename(b as HookBody);
      updateLastPrompt(b as HookBody);
      if (b.event === 'Stop') onStop(b as HookBody);
    }
    send(res, 204);
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('web/dist 不存在，请先运行 npm run build');
      return;
    }
    let file = path.join(DIST, decodeURIComponent(pathname));
    const inside = file === DIST || file.startsWith(DIST + path.sep);
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(DIST, 'index.html'); // SPA fallback
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') res.end();
    // pipeline: a read error (file replaced by a rebuild mid-request) ends this response instead of crashing the server.
    else pipeline(fs.createReadStream(file), res, e => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[static]', file, e.message); });
  }

  // DNS rebinding: a foreign page re-pointed at 127.0.0.1 sends same-origin GETs without Origin, but its Host is foreign.
  const hosts = new Set([...allowed].map(o => new URL(o).host));

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const run = async () => {
      if (!hosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Host 不被允许');
      if (pathname === '/hook') return handleHook(req, res);
      if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      throw new HttpError(404, 'not found');
    };
    run().catch(e => {
      if (res.headersSent) return;
      if (e instanceof HttpError || e instanceof WorkspaceError) {
        send(res, e.status, { error: e.message, ...(e.code && { code: e.code }), ...e.extra });
      } else {
        console.error('[http]', e);
        send(res, 500, { error: '服务器内部错误' });
      }
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;

  // Poll git only while somebody is looking; unref so the timer never keeps the process alive.
  const gitTimer = setInterval(() => { if (clients.size) void refreshAllGit(); }, 10_000);
  gitTimer.unref();
  server.on('close', () => { clearInterval(archiveTimer); clearInterval(gitTimer); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const origin = req.headers.origin;
    if (pathname !== '/ws' || origin === undefined || !allowed.has(origin) || !hosts.has(req.headers.host ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    clients.add(ws);
    void refreshAllGit(); // fill in (or freshen) git state for a client that just opened
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ t: 'snapshot', state: snapshot() } satisfies ServerMsg));
    for (const r of sessions.replays()) ws.send(JSON.stringify({ t: 'replay', id: r.id, d: r.d } satisfies ServerMsg));
    ws.on('message', raw => {
      let m: ClientMsg;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.id !== 'string') return;
      if (m.t === 'in' && typeof m.d === 'string') sessions.input(m.id, m.d);
      else if (m.t === 'resize') sessions.resize(m.id, Number(m.cols), Number(m.rows));
    });
  });

  return { server, wss };
}
