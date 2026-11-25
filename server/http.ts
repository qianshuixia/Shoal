import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type {
  AgentKind, ArchiveStoppedResult, Card, ClientMsg, CreateProjectBody, CreateTaskBody, DirListing, FeedbackBody, FeedbackResult, ForwardBody, ForwardResult, HookBody, PeerDelegateBody, PeerDelegationActionBody, PeerSendBody, PermissionMode, Project,
  GitInfo, QuotaInfo, RenameTaskBody, ResumeInterruptedResult, ResumeResult, ResumeTaskBody, ServerMsg, SessionContext, SessionInfo, Settings, Snapshot, SwitchAgentBody, SwitchResult, Task, TaskDelegation, TaskPhase,
} from '../shared/protocol.ts';
import { DEFAULT_DELEGATION_RULES, DELEGATION_RULES_MAX, canResume, composeSessionInstructions, feedbackPrompt, forwardText, isDeepAgent, isSystemPromptText, isValidAgyModel, rawPreviewOf } from '../shared/protocol.ts';
import { createActivityTracker } from './activity.ts';
import { readPrompt } from './prompt.ts';
import { createStreamWatcher } from './stream.ts';
import { clipboardFiles, writeClipboardFiles } from './clipboard.ts';
import { autoArchiveInactiveMs, autoArchiveMs, staleTasks } from './autoarchive.ts';
import { capBody, lastReply } from './cards.ts';
import { agyResumeId, agyTranscriptFile, claudeResumeId, ROOT } from './agents.ts';
import {
  buildCliTools, delegatableAgentsFrom, effectivePermissionMode, enabledAgentsFrom, getCachedCliScan, getCliTool,
  scanCliTools, validateCliPrefsPatch, validateCustomClis,
} from './cliRegistry.ts';
import { CollabError, createCollabManager } from './collab.ts';
import { fallbackCard, generateCard, generatorPrompt, handoffPrompt, runHeadless } from './handoff.ts';
import type { HandoffInput } from './handoff.ts';
import { createQuotaStore, detectLimit, parseAgyQuota, parseClaudeRateLimits, parseStatusLineContext, readCodexQuotaInfo, readLatestCodexQuotaFromDisk } from './quota.ts';
import { findEditor, OpenError, openAction, resolveOpenTarget, runOpen } from './open.ts';
import { sendRawPreview } from './raw-stream.ts';
import { readTranscript } from './transcript.ts';
import type { EnqueueOptions, SessionManager } from './sessions.ts';
import { pickColor } from './store.ts';
import type { Store } from './store.ts';
import type { Usage } from './usage.ts';
import { titleFromPrompt, titleFromReply, titlePrompt, promptPreview } from './titles.ts';
import { gitInfo } from './git.ts';
import {
  WorkspaceError, createFsEntry, deleteFsEntry, discardFile, invalidateProjectGitCache, listAllFiles, listChanges, refreshIgnoredIndex, searchIgnoredFiles, listTree, pasteFsEntries, readDiff, readFileEntry, renameFsEntry, openRawPreview, resolveProjectPath, writeFileEntry,
} from './workspace.ts';
import { createMobileController } from './mobile.ts';
import { AgyOptimizeError, applyAgyOptimization, getAgyOptimizeStatus } from './agyOptimize.ts';

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
  mobilePort?: number;
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
  // Live prompt context occupancy per session: merged from statusLine payloads (Claude/Agy) and usage transcript scans.
  const statusLineContexts = new Map<string, SessionContext>();
  const lastBroadcastContexts = new Map<string, string>();

  function currentContexts(): Record<string, SessionContext> {
    const out: Record<string, SessionContext> = { ...cfg.usage.contexts() };
    const liveIds = new Set(sessions.list().map(s => s.id));
    for (const [sid, ctx] of statusLineContexts) {
      if (!liveIds.has(sid)) {
        statusLineContexts.delete(sid);
        continue;
      }
      const existing = out[sid];
      if (!existing || ctx.updatedAt >= existing.updatedAt) {
        out[sid] = { ...existing, ...ctx, turns: ctx.turns ?? existing?.turns };
      }
    }
    return out;
  }

  function broadcastContextUpdates() {
    if (!clients.size) return;
    const merged = currentContexts();
    for (const [sid, ctx] of Object.entries(merged)) {
      const json = JSON.stringify(ctx);
      if (lastBroadcastContexts.get(sid) !== json) {
        lastBroadcastContexts.set(sid, json);
        broadcast({ t: 'context', sessionId: sid, context: ctx });
      }
    }
    for (const sid of [...lastBroadcastContexts.keys()]) {
      if (!merged[sid]) {
        lastBroadcastContexts.delete(sid);
        broadcast({ t: 'context', sessionId: sid, context: null });
      }
    }
  }

  function refreshCodexQuota(allowDiskFallback = false): QuotaInfo | null {
    const codexSessions = sessions.list()
      .filter(s => s.agent === 'codex' && s.transcriptPath)
      .sort((a, b) => b.statusSince - a.statusSince);
    for (const s of codexSessions) {
      const parsed = readCodexQuotaInfo(s.transcriptPath!);
      if (parsed) {
        const info = quota.set('codex', parsed.windows, Date.now(), { plan: parsed.plan, source: 'rollout' });
        if (info) broadcast({ t: 'quota', agent: 'codex', quota: info });
        return info ?? quota.all().codex ?? null;
      }
    }
    if (allowDiskFallback && !process.env.VITEST && currentAgents().includes('codex')) {
      const parsed = readLatestCodexQuotaFromDisk();
      if (parsed) {
        const info = quota.set('codex', parsed.windows, Date.now(), { plan: parsed.plan, source: 'rollout' });
        if (info) broadcast({ t: 'quota', agent: 'codex', quota: info });
        return info ?? quota.all().codex ?? null;
      }
    }
    return quota.all().codex ?? null;
  }

  function observeQuota(body: HookBody): void {
    const session = sessions.list().find(s => s.id === body.sessionId);
    if (!session) return;
    let windows = null;
    let meta: { plan?: string; source?: QuotaInfo['source'] } | undefined;
    if (body.event === 'RateLimits') {
      const p = body.payload as Record<string, unknown> | null;
      if (session.agent === 'agy') {
        windows = parseAgyQuota(p?.quota, body.at);
        meta = { plan: 'Google', source: 'statusline' };
      } else if (session.agent === 'claude' || session.agent === 'fake') {
        windows = p?.quota ? parseAgyQuota(p.quota, body.at) : parseClaudeRateLimits(p?.rate_limits);
        meta = { source: 'statusline' };
      }
      const ctx = parseStatusLineContext(session.agent, p, body.at);
      if (ctx) {
        statusLineContexts.set(session.id, ctx);
        broadcastContextUpdates();
      }
    } else if (body.event === 'Stop' && session.agent === 'codex' && session.transcriptPath) {
      const parsed = readCodexQuotaInfo(session.transcriptPath);
      if (parsed) {
        windows = parsed.windows;
        meta = { plan: parsed.plan, source: 'rollout' };
      }
    }
    const info = windows && quota.set(session.agent, windows, undefined, meta);
    if (info) broadcast({ t: 'quota', agent: session.agent, quota: info });
  }

  const currentCliTools = () => buildCliTools(store.settings());
  const currentAgents = () => enabledAgentsFrom(store.settings());
  const currentDelegatableAgents = () => delegatableAgentsFrom(store.settings());

  const snapshot = (): Snapshot => {
    const telemetry = cfg.usage.telemetry();
    lastTelemetryJson = JSON.stringify(telemetry);
    const context = currentContexts();
    lastBroadcastContexts.clear();
    for (const [sid, ctx] of Object.entries(context)) lastBroadcastContexts.set(sid, JSON.stringify(ctx));
    const settings = store.settings();
    const cliTools = buildCliTools(settings);
    return {
      projects: store.projects(), tasks: store.tasks(), sessions: sessions.list(), cards: store.cards(),
      agents: enabledAgentsFrom(settings, cliTools), cliTools, settings,
      git: Object.fromEntries(gitMap), quota: quota.all(), telemetry, context, activity: activity.all(),
    };
  };

  let lastTelemetryJson = '';
  function refreshTelemetry(force = false) {
    if (!clients.size) return;
    const telemetry = cfg.usage.telemetry(force);
    const next = JSON.stringify(telemetry);
    if (next !== lastTelemetryJson) {
      lastTelemetryJson = next;
      broadcast({ t: 'telemetry', telemetry });
    }
    broadcastContextUpdates();
  }

  const sizeOnly = (saved: SessionInfo | undefined, next: SessionInfo) =>
    !!saved && JSON.stringify({ ...saved, cols: next.cols, rows: next.rows }) === JSON.stringify(next);

  let mobile: ReturnType<typeof createMobileController> | null = null;
  const clients = new Set<WebSocket>();
  const broadcast = (m: ServerMsg) => {
    const raw = JSON.stringify(m);
    for (const c of clients) if (c.readyState === 1) c.send(raw);
    mobile?.onServerMsg(m);
  };
  const streamWatcher = createStreamWatcher({
    getSession: id => sessions.list().find(s => s.id === id),
    getTask: id => store.getTask(id),
    getCards: () => store.cards(),
    getActivity: id => activity.get(id) ?? null,
    getPromptWait: id => sessions.promptWait(id),
  });
  const desktopPromptLocks = new Map<string, Promise<void>>();

  const activity = createActivityTracker({
    sessions: () => sessions.list(),
    onUpdate: (sessionId, act) => {
      broadcast({ t: 'activity', sessionId, activity: act });
      streamWatcher.onActivity(sessionId);
    },
  });
  for (const s of sessions.list()) if (s.status === 'working') activity.onSessionChange(s);

  const collab = createCollabManager({
    stateDir: cfg.stateDir,
    store,
    sessions,
    availableAgents: currentAgents,
    delegatableAgents: currentDelegatableAgents,
    createPeerTask: ({ projectId, agent, title, prompt, delegation, retitleFrom, permissionMode }) => {
      const created = createTask({ projectId, agent, title, prompt }, { delegation, permissionMode });
      if (retitleFrom) aiRetitle(created.task.id, created.task.title, retitleFrom);
      return created;
    },
    closeDelegation,
    deliverToTask: ({ targetTask, project, text, system, onDelivered, cardMeta }) => {
      const prev = targetTask.sessionId ? sessions.list().find(s => s.id === targetTask.sessionId) : undefined;
      const msg = '目标任务没有可续接的对话，无法投递协作消息';
      const { task: next, session } = pasteIntoTask(
        targetTask, project, prev, text, {},
        { phase: 'active', phaseSince: Date.now() },
        { noSession: msg, noConversation: msg },
        { system, onDelivered },
      );
      const card = addCard(next, session.id, 'forward', text, cardMeta);
      return { task: next, session, card };
    },
  });

  sessions.subscribe(m => {
    if (m.t === 'session') {
      // A terminal resize changes only cols/rows: not worth rewriting state.json for (the next real change saves them too).
      const saved = store.getSession(m.session.id);
      if (!sizeOnly(saved, m.session)) store.saveSession(m.session);
      activity.onSessionChange(m.session);
      streamWatcher.onSessionChange(m.session);
      broadcast(m);
      // Typing a follow-up in the terminal takes the task out of 待验收 / 已通过 / 已归档.
      const task = store.getTask(m.session.taskId);
      if (task && task.sessionId === m.session.id) {
        if (m.session.status === 'working' && task.phase !== 'active') setPhase(task, 'active');
        else if (saved?.status !== m.session.status) collab.syncProjectPeers(task.projectId);
        if (task.delegation && m.session.blocked) collab.onChildBlocked(task, m.session);
      }
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
    collab.syncProjectPeers(project.id);
    broadcast({ t: 'project', project });
    void refreshGit(project.id);
    return project;
  }

  function saveAttachment(ext: string, data: Buffer): { path: string; name: string } {
    const dir = path.join(cfg.stateDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return { path: path.resolve(file), name };
  }

  function resolveAttachments(list: unknown): string[] {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new HttpError(400, '附件列表无效');
    const dir = path.resolve(cfg.stateDir, 'attachments');
    const out: string[] = [];
    for (const raw of list) {
      if (typeof raw !== 'string') throw new HttpError(400, '附件文件名无效');
      const name = path.basename(raw.trim());
      if (!/^\d+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/i.test(name)) {
        throw new HttpError(400, '附件文件名无效');
      }
      const full = path.resolve(dir, name);
      if (!full.startsWith(dir + path.sep) || !fs.existsSync(full)) {
        throw new HttpError(400, '附件图片不存在');
      }
      out.push(/\s/.test(full) ? `"${full}"` : full);
    }
    return out;
  }

  // Standing instructions for a new session (delegation rules + optional rich-output chart hints); delegated child tasks or generic CLIs never get them.
  function delegationInstructions(task: Pick<Task, 'delegation' | 'agent'>): string | undefined {
    if (task.delegation || !isDeepAgent(task.agent)) return undefined;
    const settings = store.settings();
    return composeSessionInstructions({
      host: task.agent,
      available: currentDelegatableAgents(),
      autoDelegate: settings.autoDelegate !== false,
      rules: settings.delegationRules ?? DEFAULT_DELEGATION_RULES,
      richOutputHints: settings.richOutputHints !== false,
    });
  }

  // Resolves the effective permission mode for a task spawn:
  // - Explicit mode from caller (e.g. parent -> child delegation / peer spawn) wins.
  // - Delegated child tasks inherit their parent's live session (or parent task's) permission mode.
  // - Normal root tasks read the target CLI's current global permission setting (default 'full').
  function resolveTaskPermissionMode(task: Pick<Task, 'agent' | 'delegation' | 'permissionMode'>, explicit?: PermissionMode): PermissionMode {
    if (explicit) return explicit;
    if (task.delegation) {
      const parent = store.getTask(task.delegation.parentTaskId);
      const parentSession = parent?.sessionId ? sessions.list().find(s => s.id === parent.sessionId) : undefined;
      if (parentSession?.permissionMode) return parentSession.permissionMode;
      if (parent?.permissionMode) return parent.permissionMode;
      if (task.permissionMode) return task.permissionMode;
    }
    return effectivePermissionMode(task.agent, store.settings().cliPrefs);
  }

  // `extra.delegation` and `extra.permissionMode` come only from internal collab callers, never from the HTTP body.
  function createTask(b: Record<string, unknown>, extra?: { delegation?: TaskDelegation; permissionMode?: PermissionMode }) {
    const body = b as Partial<CreateTaskBody>;
    const project = typeof body.projectId === 'string' ? store.getProject(body.projectId) : undefined;
    if (!project) throw new HttpError(400, '项目不存在');
    const agent = body.agent as AgentKind;
    if (!currentAgents().includes(agent)) throw new HttpError(400, `智能体不可用：${String(body.agent)}`);
    if (body.model !== undefined && (typeof body.model !== 'string' || !isValidAgyModel(body.model))) {
      throw new HttpError(400, '模型档位无效');
    }
    const settings = store.settings();
    const rawModel = body.model !== undefined ? body.model : settings.agyModel;
    const model = agent === 'agy' && rawModel ? rawModel : undefined;
    const rawPrompt = typeof body.prompt === 'string' ? body.prompt : '';
    const files = resolveAttachments(body.attachments);
    const prompt = files.length
      ? (rawPrompt.trim() ? `${rawPrompt.trim()}\n${files.join(' ')}` : files.join(' '))
      : rawPrompt;
    const lastPrompt = extra?.delegation ? extra.delegation.brief : promptPreview(rawPrompt.trim() ? rawPrompt : prompt);
    let title = typeof body.title === 'string' ? body.title.trim() : '';
    let titleAuto = false;
    let fromPrompt = false;
    if (!title && rawPrompt.trim()) { title = titleFromPrompt(rawPrompt); fromPrompt = !!title; }
    if (!title) {
      const used = new Set(store.tasks().filter(t => t.projectId === project.id).map(t => t.title));
      let n = 1;
      while (used.has(`新任务 ${n}`)) n++;
      title = `新任务 ${n}`;
      titleAuto = true;
    }
    const now = Date.now();
    const permissionMode = resolveTaskPermissionMode({ agent, delegation: extra?.delegation }, extra?.permissionMode);
    const cliMeta = getCliTool(agent, settings);
    const task: Task = {
      id: crypto.randomUUID(), projectId: project.id, title, titleAuto, prompt, color: pickColor(store.tasks()),
      agent, ...(model && { model }), permissionMode, sessionId: null, createdAt: now,
      phase: 'active', phaseSince: now, lastActiveAt: now, ...(lastPrompt && { lastPrompt }),
      ...(extra?.delegation && { delegation: extra.delegation }),
    };
    let session;
    try {
      session = sessions.spawn({
        taskId: task.id, projectId: project.id, agent, cwd: project.path, prompt, model,
        permissionMode, cliMeta,
        instructions: delegationInstructions(task),
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
      });
    } catch (e) {
      throw new HttpError(500, `启动失败：${(e as Error).message}`);
    }
    task.sessionId = session.id;
    store.addTask(task);
    store.saveSession(session);
    collab.syncProjectPeers(project.id);
    broadcast({ t: 'task', task });
    broadcast({ t: 'session', session });
    if (fromPrompt) aiRetitle(task.id, title, rawPrompt);
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
    collab.syncProjectPeers(task.projectId);
    broadcast({ t: 'task', task });
    return task;
  }

  function setPhase(task: Task, phase: TaskPhase): Task {
    const next: Task = { ...task, phase, phaseSince: Date.now() };
    store.updateTask(next);
    collab.syncProjectPeers(next.projectId);
    broadcast({ t: 'task', task: next });
    return next;
  }

  // Ends the process of a delegated task and archives it with its outcome (the session record stays).
  function closeDelegation(task: Task, outcome: 'accepted' | 'canceled'): Task {
    if (task.sessionId) sessions.kill(task.sessionId);
    const now = Date.now();
    const next: Task = { ...task, phase: 'archived', phaseSince: now, ...(task.delegation && { delegation: { ...task.delegation, outcome, settledAt: now } }) };
    store.updateTask(next);
    collab.syncProjectPeers(next.projectId);
    broadcast({ t: 'task', task: next });
    return next;
  }

  // A main task that is archived or deleted takes its open delegated tasks with it.
  function cancelChildrenOf(parentIds: ReadonlySet<string>): void {
    if (!parentIds.size) return;
    for (const t of [...store.tasks()]) {
      if (t.delegation && t.phase !== 'archived' && parentIds.has(t.delegation.parentTaskId)) closeDelegation(t, 'canceled');
    }
  }

  // Approved tasks left alone past the limit (default 1 day), or unapproved active exited tasks untouched for 14 days,
  // with no running session, move to 已归档 (待验收 is never auto-archived).
  const archiveMs = autoArchiveMs(process.env.WORKBENCH_AUTO_ARCHIVE_DAYS);
  const archiveInactiveMs = autoArchiveInactiveMs(process.env.WORKBENCH_AUTO_ARCHIVE_INACTIVE_DAYS);
  function autoArchive() {
    if (!archiveMs && !archiveInactiveMs) return;
    const now = Date.now();
    const live = new Set(sessions.list().filter(s => s.status !== 'exited').map(s => s.id));
    const stale = staleTasks(store.tasks(), live, now, archiveMs, archiveInactiveMs);
    if (!stale.length) return;
    const updated = stale.map(t => ({ ...t, phase: 'archived' as const, phaseSince: now }));
    store.updateTasks(updated);
    for (const pid of new Set(updated.map(t => t.projectId))) collab.syncProjectPeers(pid);
    for (const task of updated) broadcast({ t: 'task', task });
    cancelChildrenOf(new Set(updated.map(t => t.id)));
  }
  autoArchive();
  for (const p of store.projects()) collab.syncProjectPeers(p.id);
  const archiveTimer = setInterval(autoArchive, 3600_000);
  archiveTimer.unref();

  function archiveStoppedTasks(projectId: string): ArchiveStoppedResult {
    const project = store.getProject(projectId);
    if (!project) throw new HttpError(404, '项目不存在');
    const now = Date.now();
    const live = new Set(sessions.list().filter(s => s.status !== 'exited').map(s => s.id));
    const targets = store.tasks().filter(
      t => t.projectId === project.id && t.phase !== 'archived' && t.phase !== 'review' && !(t.sessionId && live.has(t.sessionId)),
    );
    const updated = targets.map(t => ({ ...t, phase: 'archived' as const, phaseSince: now }));
    store.updateTasks(updated);
    collab.syncProjectPeers(project.id);
    for (const task of updated) broadcast({ t: 'task', task });
    cancelChildrenOf(new Set(updated.map(t => t.id)));
    return { tasks: updated };
  }

  // Spawns a session for the task and makes it the current one; the old session is killed and forgotten so a task never piles up dead ones.
  function replaceSession(
    task: Task, project: Project, prev: SessionInfo | undefined,
    o: { prompt: string; resume?: string; cols?: number; rows?: number }, patch: Partial<Task> = {},
  ): { task: Task; session: SessionInfo } {
    const merged = { ...task, ...patch };
    const settings = store.settings();
    const model = merged.agent === 'agy'
      ? (patch.agent && patch.agent !== task.agent ? settings.agyModel : merged.model) || undefined
      : undefined;
    const permissionMode = resolveTaskPermissionMode(merged);
    const cliMeta = getCliTool(merged.agent, settings);
    let session;
    try {
      session = sessions.spawn({
        taskId: task.id, projectId: project.id, agent: merged.agent, cwd: project.path, model,
        permissionMode, cliMeta, instructions: delegationInstructions(merged), ...o,
      });
    } catch (e) {
      throw new HttpError(500, `启动失败：${(e as Error).message}`);
    }
    if (prev) {
      collab.clearSessionState(prev.id);
      activity.onRemove(prev.id);
      streamWatcher.onRemoveSession(prev.id);
      sessions.remove(prev.id);
      store.removeSession(prev.id);
    }
    const next: Task = { ...merged, ...(model ? { model } : {}), permissionMode, sessionId: session.id, lastActiveAt: session.startedAt };
    if (merged.agent !== 'agy') delete next.model;
    store.updateTask(next);
    store.saveSession(session);
    collab.syncProjectPeers(project.id);
    broadcast({ t: 'task', task: next });
    broadcast({ t: 'session', session });
    return { task: next, session };
  }

  // Native session id to reopen for an exited session, if its conversation still exists.
  function resumableNative(prev: SessionInfo | undefined): string | undefined {
    if (!prev || !isDeepAgent(prev.agent)) return undefined;
    const native = canResume(prev) ? prev.nativeSessionId! : undefined;
    if (native && prev.agent === 'claude') return claudeResumeId(native, prev.transcriptPath);
    if (native && prev.agent === 'agy') return agyResumeId(native, prev.transcriptPath);
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
    if (!currentAgents().includes(task.agent)) throw new HttpError(400, `智能体不可用：${task.agent}`);
    const prev = task.sessionId ? sessions.list().find(s => s.id === task.sessionId) : undefined;
    if (prev && prev.status !== 'exited') throw new HttpError(409, '会话还在运行');
    const native = body.fresh === true ? undefined : resumableNative(prev);
    if (body.fresh !== true && native === undefined) throw new HttpError(409, '上次会话没有对话记录', 'no-conversation');
    const { task: next, session } = replaceSession(task, project, prev, {
      prompt: '', resume: native,
      cols: typeof body.cols === 'number' ? body.cols : undefined,
      rows: typeof body.rows === 'number' ? body.rows : undefined,
    });
    return { task: next, session, resumed: native !== undefined, ...(prev && { replacedSessionId: prev.id }) };
  }

  function dismissInterrupted() {
    const cleared = sessions.clearInterrupted();
    store.saveSessions(cleared);
    for (const session of cleared) broadcast({ t: 'session', session });
    return { ok: true };
  }

  function resumeInterrupted(b: Record<string, unknown>): ResumeInterruptedResult {
    const cols = typeof b.cols === 'number' ? b.cols : undefined;
    const rows = typeof b.rows === 'number' ? b.rows : undefined;
    const byId = new Map(sessions.list().map(s => [s.id, s]));
    const avail = new Set(currentAgents());
    const candidates = store.tasks()
      .filter(t => {
        if (t.phase === 'archived' || !t.sessionId) return false;
        const s = byId.get(t.sessionId);
        return !!s && s.status === 'exited' && s.interrupted === true;
      })
      .sort((a, b) => (a.lastActiveAt ?? a.createdAt) - (b.lastActiveAt ?? b.createdAt));

    const resumed: ResumeResult[] = [];
    let skipped = 0;
    for (const task of candidates) {
      const prev = task.sessionId ? byId.get(task.sessionId) : undefined;
      const project = store.getProject(task.projectId);
      const native = prev && project && avail.has(task.agent) ? resumableNative(prev) : undefined;
      if (!prev || !project || !native) {
        skipped++;
        continue;
      }
      try {
        const r = replaceSession(task, project, prev, { prompt: '', resume: native, cols, rows });
        resumed.push({ task: r.task, session: r.session, resumed: true, replacedSessionId: prev.id });
      } catch {
        skipped++;
      }
    }
    const cleared = sessions.clearInterrupted();
    store.saveSessions(cleared);
    for (const session of cleared) broadcast({ t: 'session', session });
    return { resumed, skipped };
  }

  function addCard(task: Task, sessionId: string, kind: Card['kind'], text: string, meta?: Card['meta']): Card {
    const card: Card = { id: crypto.randomUUID(), taskId: task.id, sessionId, kind, body: capBody(text), createdAt: Date.now(), ...(meta && { meta }) };
    store.addCard(card);
    broadcast({ t: 'card', card });
    streamWatcher.onTaskChange(task.id);
    return card;
  }

  // Pastes text into the task's current session, queued until it is idle; an exited session is reopened first.
  function pasteIntoTask(
    task: Task, project: Project, prev: SessionInfo | undefined, text: string, size: { cols?: number; rows?: number }, patch: Partial<Task>,
    errors: { noSession: string; noConversation: string },
    enqueueOpts?: EnqueueOptions,
  ): { task: Task; session: SessionInfo } {
    if (!prev) throw new HttpError(400, errors.noSession);
    const system = enqueueOpts?.system === true;
    if (prev.status !== 'exited') {
      const next: Task = system ? { ...task, ...patch } : { ...task, ...patch, lastActiveAt: Date.now() };
      store.updateTask(next);
      broadcast({ t: 'task', task: next });
      sessions.enqueue(prev.id, text, enqueueOpts);
      return { task: next, session: prev };
    }
    const native = resumableNative(prev);
    if (!native) throw new HttpError(400, errors.noConversation);
    const r = replaceSession(task, project, prev, { prompt: '', resume: native, ...size }, patch);
    sessions.enqueue(r.session.id, text, enqueueOpts);
    return r;
  }

  function feedback(id: string, b: Record<string, unknown>): FeedbackResult {
    const body = b as Partial<FeedbackBody>;
    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    const files = resolveAttachments(body.attachments);
    if (!rawText && !files.length) throw new HttpError(400, '反馈不能为空');
    const text = files.length ? (rawText ? `${rawText}\n${files.join(' ')}` : files.join(' ')) : rawText;
    if (body.mode !== 'new' && body.mode !== 'same') throw new HttpError(400, '反馈方式无效');
    const task = store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    const project = store.getProject(task.projectId);
    if (!project) throw new HttpError(400, '项目不存在');
    if (!currentAgents().includes(task.agent)) throw new HttpError(400, `智能体不可用：${task.agent}`);
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
    if (!currentAgents().includes(agent)) throw new HttpError(400, `智能体不可用：${String(body.agent)}`);
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
      const generated = await generateCard(agent, generatorPrompt(input), { cwd: project.path, stateDir: cfg.stateDir, available: currentAgents() });
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
    const replyBack = body.replyBack === true;
    const sourceAgent = sessions.list().find(s => s.id === card.sessionId)?.agent ?? source.agent;
    const text = forwardText(
      { title: source.title, agent: sourceAgent },
      card.body,
      typeof body.note === 'string' ? body.note : undefined,
      { replyBack },
    );
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
      if (!currentAgents().includes(target.agent)) throw new HttpError(400, `智能体不可用：${target.agent}`);
      const prev = target.sessionId ? sessions.list().find(s => s.id === target.sessionId) : undefined;
      const msg = '目标任务没有可续接的对话，请转发到新任务';
      let obligationId: string | undefined;
      let boundSessionId = prev?.id ?? '';
      ({ task, session } = pasteIntoTask(
        target, project, prev, text, size,
        { phase: 'active', phaseSince: Date.now() },
        { noSession: msg, noConversation: msg },
        replyBack
          ? {
              system: true,
              onDelivered: () => {
                const sid = store.getTask(target.id)?.sessionId ?? boundSessionId;
                if (sid) collab.onSystemDelivered(sid, 1, obligationId);
              },
            }
          : undefined,
      ));
      boundSessionId = session.id;
      if (replyBack) {
        obligationId = collab.registerReplyBack({
          targetTaskId: task.id,
          targetSessionId: session.id,
          sourceTaskId: source.id,
          hop: 1,
          immediateArm: false,
        });
      }
    } else if (to && typeof to.projectId === 'string') {
      ({ task, session } = createTask({ projectId: to.projectId, agent: to.agent, prompt: text, title: [...`转发：${source.title}`].slice(0, 80).join(''), ...size }));
      if (replyBack) {
        collab.seedSessionHop(session.id, 1);
        collab.registerReplyBack({
          targetTaskId: task.id,
          targetSessionId: session.id,
          sourceTaskId: source.id,
          hop: 1,
          immediateArm: true,
        });
      }
    } else {
      throw new HttpError(400, '没有指定转发目标');
    }
    const saved = addCard(task, session.id, 'forward', text, {
      sourceTaskId: source.id,
      sourceCardId: card.id,
      ...(replyBack && { replyBack: true }),
    });
    return { task, session, card: saved, ...(replyBack && { replyBack: true }) };
  }

  // A finished turn becomes a result card and moves the task to 待验收.
  function onStop(body: HookBody) {
    const session = sessions.list().find(s => s.id === body.sessionId);
    const task = session ? store.getTask(session.taskId) : undefined;
    if (!session || !task || task.sessionId !== session.id) return;
    const p = (body.payload ?? {}) as Record<string, unknown>;
    if (detectLimit(session.agent, 'Stop', p)) {
      collab.onPrimaryStop({ task, session, replyText: '', canceledOrLimit: true });
      return; // out of quota, not a result
    }
    const replyText = lastReply(session.agent, body.payload);
    const card = addCard(task, session.id, 'result', replyText ?? '（没有拿到这一轮的最后回复，请看终端）');
    setPhase(task, 'review');
    const canceled = typeof p.error === 'string' && p.error.trim() !== '';
    collab.onPrimaryStop({
      task,
      session,
      replyText: replyText ?? card.body,
      resultCardId: card.id,
      canceledOrLimit: canceled,
    });
    void refreshGit(task.projectId); // the turn probably changed files
  }

  // The latest prompt of the task's current session (second line under the title) and user-initiated turn recency.
  function updateLastPrompt(body: HookBody, userTurn: boolean) {
    const p = (body.payload ?? {}) as Record<string, unknown>;
    const text = body.event === 'UserPromptSubmit' ? p.prompt : body.event === 'PreInvocation' ? p.lastUserInput : undefined;
    const preview = typeof text === 'string' && !text.trimStart().startsWith('/') && !isSystemPromptText(text) ? promptPreview(text) : '';
    if (!preview && !userTurn) return;
    const session = sessions.list().find(s => s.id === body.sessionId);
    const old = session ? store.getTask(session.taskId) : undefined;
    if (!old || old.sessionId !== body.sessionId) return;
    // A delegated task's launch prompt opens with the same boilerplate for every task: keep showing its brief.
    if (old.delegation && typeof text === 'string' && text.trim() === old.prompt.trim()) return;
    const nextPreview = preview || old.lastPrompt;
    const nextActive = userTurn ? Date.now() : old.lastActiveAt;
    if (nextPreview === old.lastPrompt && nextActive === old.lastActiveAt) return;
    const task: Task = {
      ...old,
      ...(nextPreview !== undefined && { lastPrompt: nextPreview }),
      ...(nextActive !== undefined && { lastActiveAt: nextActive }),
    };
    store.updateTask(task);
    broadcast({ t: 'task', task });
  }

  // The first-line title is already showing; a short headless call of the task's agent writes a better one.
  // Applied only if the title is still the one we set (the user has not renamed the task meanwhile).
  function aiRetitle(taskId: string, shown: string, text: string): void {
    if (!store.settings().aiTitles) return;
    const task = store.getTask(taskId);
    const project = task ? store.getProject(task.projectId) : undefined;
    if (!task || !project || !isDeepAgent(task.agent) || task.agent === 'agy') return;
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
    if (typeof text !== 'string' || text.trimStart().startsWith('/') || isSystemPromptText(text)) return;
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
      if (process.platform !== 'win32') {
        // No drive letters: the root, plus mounted volumes on macOS.
        entries.push({ name: '/', path: '/' });
        if (process.platform === 'darwin') {
          try {
            for (const d of fs.readdirSync('/Volumes', { withFileTypes: true })) {
              const full = `/Volumes/${d.name}`;
              let ok = d.isDirectory();
              // The boot volume is listed as a symlink to /.
              if (!ok && d.isSymbolicLink()) { try { ok = fs.statSync(full).isDirectory(); } catch { /* skip */ } }
              if (ok) entries.push({ name: d.name, path: full });
            }
          } catch { /* no /Volumes */ }
        }
        return { path: null, parent: null, entries };
      }
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

  // A link clicked in a terminal or context menu: opens the file in the editor / Explorer, never executes it.
  function openTarget(b: Record<string, unknown>): { action: string; path: string } {
    if (typeof b.target !== 'string') throw new HttpError(400, '缺少链接');
    const mode = b.mode === undefined ? 'default' : b.mode;
    if (mode !== 'default' && mode !== 'reveal' && mode !== 'editor') {
      throw new HttpError(400, '无效的打开方式');
    }
    try {
      const resolved = resolveOpenTarget(b.target);
      const action = openAction(resolved, fs.statSync(resolved.path).isDirectory(), findEditor(), process.platform, mode);
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
    if (method !== 'GET' && method !== 'HEAD') sessions.markDesktopActive();
    if (method === 'POST' && pathname === '/api/attachments') {
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[type];
      if (!ext) throw new HttpError(415, '只支持 PNG、JPEG、GIF、WebP 图片');
      const data = await readBuffer(req, MAX_ATTACHMENT);
      if (data.length === 0) throw new HttpError(400, '图片内容为空');
      return send(res, 200, saveAttachment(ext, data));
    }
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '需要 application/json');
      body = parseJson(await readBody(req, method === 'PUT' ? MAX_FILE_BODY : MAX_BODY));
    }
    if (method === 'GET' && pathname === '/api/mobile/admin/status') return send(res, 200, mobile!.adminStatus());
    if (method === 'POST' && pathname === '/api/mobile/admin/config') return send(res, 200, await mobile!.updateConfig(body));
    if (method === 'POST' && pathname === '/api/mobile/admin/pair/start') return send(res, 200, mobile!.startPairing());
    if (method === 'POST' && pathname === '/api/mobile/admin/pair/approve') return send(res, 200, mobile!.approvePairing(body));
    if (method === 'POST' && pathname === '/api/mobile/admin/pair/cancel') return send(res, 200, mobile!.cancelPairing());
    if (method === 'POST' && pathname === '/api/mobile/admin/devices/revoke-all') return send(res, 200, mobile!.revokeAllDevices());
    if (method === 'POST' && pathname === '/api/mobile/admin/notify/test') return send(res, 200, await mobile!.sendTestNotification());
    const mobDev = pathname.match(/^\/api\/mobile\/admin\/devices\/([^/]+)$/);
    if (method === 'DELETE' && mobDev) return send(res, 200, mobile!.revokeDevice(decodeURIComponent(mobDev[1])));
    if (method === 'GET' && pathname === '/api/state') return send(res, 200, snapshot());
    if (method === 'POST' && pathname === '/api/shutdown' && cfg.onShutdown) {
      send(res, 202, { pid: process.pid });
      return void setImmediate(cfg.onShutdown);
    }
    if (method === 'GET' && pathname === '/api/clipboard/files') {
      try {
        return send(res, 200, { paths: await clipboardFiles() });
      } catch (e) {
        throw new HttpError(500, (e as Error).message);
      }
    }
    if (method === 'POST' && pathname === '/api/clipboard/files') {
      const pid = typeof body.projectId === 'string' ? body.projectId : '';
      const rel = typeof body.path === 'string' ? body.path : '';
      const project = store.getProject(pid);
      if (!project) throw new HttpError(404, '项目不存在');
      const resolved = resolveProjectPath(project.path, rel, { allowRoot: true, preserveSpaces: true });
      if (!fs.existsSync(resolved.absPath)) throw new HttpError(404, `文件或目录不存在：${resolved.relPosix || project.name}`);
      try {
        await writeClipboardFiles([resolved.absPath]);
        return send(res, 200, { ok: true, path: resolved.absPath });
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
    if (method === 'POST' && pathname === '/api/quota/refresh') {
      refreshCodexQuota(true);
      refreshTelemetry(true);
      return send(res, 200, { quota: quota.all(), context: currentContexts() });
    }
    if (method === 'POST' && pathname === '/api/open') return send(res, 200, openTarget(body));
    if (method === 'GET' && pathname === '/api/clis') return send(res, 200, getCachedCliScan(store.settings()));
    if (method === 'POST' && pathname === '/api/clis/scan') {
      const scanned = await scanCliTools(store.settings());
      broadcast({ t: 'clis', agents: scanned.agents, cliTools: scanned.cliTools });
      return send(res, 200, scanned);
    }
    if (method === 'POST' && pathname === '/api/settings') {
      if (body.aiTitles !== undefined && typeof body.aiTitles !== 'boolean') throw new HttpError(400, '设置值无效');
      if (body.closeAction !== undefined && body.closeAction !== 'tray' && body.closeAction !== 'quit') throw new HttpError(400, '设置值无效');
      if (body.autoDelegate !== undefined && typeof body.autoDelegate !== 'boolean') throw new HttpError(400, '设置值无效');
      if (body.richOutputHints !== undefined && typeof body.richOutputHints !== 'boolean') throw new HttpError(400, '设置值无效');
      if (body.delegationRules !== undefined && body.delegationRules !== null) {
        if (typeof body.delegationRules !== 'string') throw new HttpError(400, '设置值无效');
        if ([...body.delegationRules].length > DELEGATION_RULES_MAX) throw new HttpError(400, `分工规则过长（上限 ${DELEGATION_RULES_MAX} 字）`);
      }
      if (body.agyModel !== undefined && (typeof body.agyModel !== 'string' || !isValidAgyModel(body.agyModel))) {
        throw new HttpError(400, '设置值无效');
      }
      let nextCliPrefsPatch: ReturnType<typeof validateCliPrefsPatch> | undefined;
      let nextCustomClis: ReturnType<typeof validateCustomClis> | undefined;
      try {
        if (body.cliPrefs !== undefined && body.cliPrefs !== null) {
          nextCliPrefsPatch = validateCliPrefsPatch(body.cliPrefs);
        }
        if (body.customClis !== undefined && body.customClis !== null) {
          nextCustomClis = validateCustomClis(body.customClis);
        }
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const settings: Settings = {
        ...store.settings(),
        ...(typeof body.aiTitles === 'boolean' ? { aiTitles: body.aiTitles } : {}),
        ...(body.closeAction === 'tray' || body.closeAction === 'quit' ? { closeAction: body.closeAction } : {}),
        ...(typeof body.autoDelegate === 'boolean' ? { autoDelegate: body.autoDelegate } : {}),
        ...(typeof body.richOutputHints === 'boolean' ? { richOutputHints: body.richOutputHints } : {}),
      };
      if (typeof body.delegationRules === 'string') settings.delegationRules = body.delegationRules;
      else if (body.delegationRules === null) delete settings.delegationRules;
      if (typeof body.agyModel === 'string') {
        if (body.agyModel) settings.agyModel = body.agyModel;
        else delete settings.agyModel;
      }
      let clisChanged = false;
      if (body.cliPrefs === null) {
        delete settings.cliPrefs;
        clisChanged = true;
      } else if (nextCliPrefsPatch) {
        const merged = { ...(settings.cliPrefs ?? {}) };
        for (const [k, pref] of Object.entries(nextCliPrefsPatch)) {
          merged[k] = { ...(merged[k] ?? {}), ...pref };
        }
        settings.cliPrefs = merged;
        clisChanged = true;
      }
      if (body.customClis === null) {
        delete settings.customClis;
        clisChanged = true;
      } else if (nextCustomClis !== undefined) {
        if (nextCustomClis.length > 0) settings.customClis = nextCustomClis;
        else delete settings.customClis;
        // Clean up prefs for deleted custom CLIs? Keep or prune only non-builtin missing ids safely.
        clisChanged = true;
      }
      store.setSettings(settings);
      broadcast({ t: 'settings', settings });
      if (clisChanged) {
        const cliTools = currentCliTools();
        broadcast({ t: 'clis', agents: enabledAgentsFrom(settings, cliTools), cliTools });
      }
      return send(res, 200, settings);
    }
    if (method === 'GET' && pathname === '/api/agy/optimize') return send(res, 200, getAgyOptimizeStatus());
    if (method === 'POST' && pathname === '/api/agy/optimize') {
      try {
        return send(res, 200, applyAgyOptimization());
      } catch (e) {
        if (e instanceof AgyOptimizeError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    if (method === 'POST' && pathname === '/api/projects') return send(res, 200, createProject(body));
    if (method === 'POST' && pathname === '/api/tasks') return send(res, 200, createTask(body));
    if (method === 'POST' && pathname === '/api/sessions/resume-interrupted') return send(res, 200, resumeInterrupted(body));
    if (method === 'POST' && pathname === '/api/sessions/dismiss-interrupted') return send(res, 200, dismissInterrupted());
    const pas = pathname.match(/^\/api\/projects\/([^/]+)\/archive-stopped$/);
    if (method === 'POST' && pas) return send(res, 200, archiveStoppedTasks(decodeURIComponent(pas[1])));
    const safeDecode = (seg: string) => {
      try { return decodeURIComponent(seg); } catch { throw new HttpError(400, '路径参数编码无效'); }
    };
    const st = pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
    if (method === 'GET' && st) {
      const task = store.getTask(safeDecode(st[1]));
      if (!task) throw new HttpError(404, '任务不存在');
      const session = task.sessionId ? sessions.list().find(s => s.id === task.sessionId) : undefined;
      return send(res, 200, await streamWatcher.snapshotFor(task, session));
    }
    const pa = pathname.match(/^\/api\/tasks\/([^/]+)\/prompt-answer$/);
    if (method === 'POST' && pa) {
      const taskId = safeDecode(pa[1]);
      const task = store.getTask(taskId);
      if (!task) throw new HttpError(404, '任务不存在');
      const sessionId = task.sessionId;
      if (!sessionId) throw new HttpError(409, '已在别处处理', 'stale');
      const { fingerprint, data, waitSeq } = body;
      if (typeof fingerprint !== 'string' || typeof data !== 'string') throw new HttpError(400, '缺少 fingerprint 或 data');
      const read = async () => {
        const w = sessions.promptWait(sessionId);
        if (!w) return null;
        const view = await readPrompt(w.info, w.waitSeq, w.replay, t => t);
        return view ? { view, waitSeq: w.waitSeq, outSeq: w.outSeq } : null;
      };
      const prev = desktopPromptLocks.get(sessionId) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await read();
          if (!r || r.view.fingerprint !== fingerprint) {
            if (r && r.waitSeq === waitSeq && sessions.promptWait(sessionId)?.waitSeq === waitSeq) {
              throw new HttpError(409, '画面已变化，请看清后重新确认', 'changed');
            }
            throw new HttpError(409, '已在别处处理', 'stale');
          }
          if (!r.view.keys.some(k => k.data === data)) throw new HttpError(400, '这个按键不在当前提示的选项里');
          if (store.getTask(taskId)?.sessionId !== sessionId) throw new HttpError(409, '已在别处处理', 'stale');
          const answered = sessions.answerPrompt(sessionId, r.waitSeq, r.outSeq, data);
          if (answered === 'ok') return;
          if (answered === 'stale') throw new HttpError(409, '已在别处处理', 'stale');
        }
        throw new HttpError(409, '终端正在刷新，请稍后重试', 'redrawing');
      });
      desktopPromptLocks.set(sessionId, run);
      try {
        await run;
      } finally {
        if (desktopPromptLocks.get(sessionId) === run) desktopPromptLocks.delete(sessionId);
      }
      return send(res, 200, { ok: true });
    }
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
      if (act[2] === 'archive' && task.delegation && task.phase !== 'archived') {
        const closed = closeDelegation(task, 'canceled');
        cancelChildrenOf(new Set([task.id]));
        return send(res, 200, closed);
      }
      if (act[2] === 'archive' && task.sessionId) sessions.kill(task.sessionId);
      let base = task;
      if (act[2] === 'unarchive' && task.delegation) {
        const { outcome: _o, settledAt: _s, ...open } = task.delegation;
        base = { ...task, delegation: open };
      }
      const moved = setPhase(base, act[2] === 'approve' ? 'approved' : act[2] === 'archive' ? 'archived' : 'active');
      if (act[2] === 'archive') cancelChildrenOf(new Set([task.id]));
      return send(res, 200, moved);
    }
    const m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && m) return send(res, 200, renameTask(m[1], body));
    if (method === 'DELETE' && m) {
      const task = store.getTask(m[1]);
      if (!task) throw new HttpError(404, '任务不存在');
      cfg.usage.scan(); // records which task its sessions belonged to before they are dropped
      cancelChildrenOf(new Set([task.id]));
      if (task.sessionId) {
        collab.clearSessionState(task.sessionId);
        activity.onRemove(task.sessionId);
        streamWatcher.onRemoveSession(task.sessionId);
        sessions.remove(task.sessionId);
      }
      store.removeTask(task.id);
      collab.removeTaskSnapshot(task.projectId, task.id);
      broadcast({ t: 'task-removed', id: task.id });
      return send(res, 200, { ok: true });
    }
    const pw = pathname.match(/^\/api\/projects\/([^/]+)\/(changes|diff|tree|files|ignored-files|file|raw|discard)$/);
    if (pw) {
      const project = store.getProject(decodeURIComponent(pw[1]));
      if (!project) throw new HttpError(404, '项目不存在');
      const sub = pw[2];
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (method === 'GET' && sub === 'changes') {
        const changes = await listChanges(project.path);
        if ((changes.git !== null || !gitMap.has(project.id)) && !sameGit(gitMap.get(project.id), changes.git)) {
          gitMap.set(project.id, changes.git);
          broadcast({ t: 'git', projectId: project.id, git: changes.git });
        }
        return send(res, 200, changes);
      }
      if (method === 'GET' && sub === 'diff') return send(res, 200, await readDiff(project.path, q.get('path') ?? ''));
      if (method === 'GET' && sub === 'tree') return send(res, 200, await listTree(project.path, q.get('path') ?? ''));
      if (method === 'GET' && sub === 'files') {
        refreshIgnoredIndex(project.path); // the finder just opened: re-index gitignored files while the user types
        return send(res, 200, await listAllFiles(project.path));
      }
      if (method === 'GET' && sub === 'ignored-files') return send(res, 200, await searchIgnoredFiles(project.path, q.get('q') ?? ''));
      if (method === 'GET' && sub === 'file') return send(res, 200, readFileEntry(project.path, q.get('path') ?? '', q.get('stat') === '1'));
      if (method === 'GET' && sub === 'raw') {
        sendRawPreview(req, res, openRawPreview(project.path, q.get('path') ?? ''), '[raw]');
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
    const pfs = pathname.match(/^\/api\/projects\/([^/]+)\/fs\/(create|rename|delete|paste)$/);
    if (pfs) {
      if (method !== 'POST') throw new HttpError(405, '请求方法不支持');
      const project = store.getProject(decodeURIComponent(pfs[1]));
      if (!project) throw new HttpError(404, '项目不存在');
      const op = pfs[2];
      if (op === 'create') {
        const created = createFsEntry(project.path, body);
        void refreshGit(project.id);
        return send(res, 200, created);
      }
      if (op === 'rename') {
        const renamed = renameFsEntry(project.path, body);
        void refreshGit(project.id);
        return send(res, 200, renamed);
      }
      if (op === 'delete') {
        const deleted = deleteFsEntry(project.path, body);
        void refreshGit(project.id);
        return send(res, 200, deleted);
      }
      const pasted = await pasteFsEntries(project.path, body, (srcId) => store.getProject(srcId)?.path ?? null);
      void refreshGit(project.id);
      if (typeof body.sourceProjectId === 'string' && body.sourceProjectId !== project.id && body.mode === 'cut') {
        void refreshGit(body.sourceProjectId);
      }
      return send(res, 200, pasted);
    }
    const pm = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === 'DELETE' && pm) {
      const project = store.getProject(pm[1]);
      if (!project) throw new HttpError(404, '项目不存在');
      cfg.usage.scan(); // records which project / task its sessions belonged to before they are dropped
      const mine = store.tasks().filter(t => t.projectId === project.id);
      for (const t of mine) {
        if (t.sessionId) {
          collab.clearSessionState(t.sessionId);
          activity.onRemove(t.sessionId);
          streamWatcher.onRemoveSession(t.sessionId);
          sessions.remove(t.sessionId);
        }
      }
      store.removeProject(project.id);
      collab.removeProjectCollab(project.id);
      gitMap.delete(project.id);
      for (const t of mine) broadcast({ t: 'task-removed', id: t.id });
      broadcast({ t: 'project-removed', id: project.id });
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname === '/api/dirs') return send(res, 200, listDirs(new URL(req.url ?? '/', 'http://x').searchParams));
    throw new HttpError(404, '未找到接口');
  }

  async function handlePeer(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    if (req.headers.origin !== undefined) throw new HttpError(403, 'CLI 内部协作接口禁止跨源浏览器访问');
    const rawAuth = req.headers.authorization ?? '';
    const bearer = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7).trim() : '';
    const caller = sessions.resolvePeerToken(bearer);
    if (!caller) throw new HttpError(401, '无效或已过期的协作会话令牌');
    if (!isDeepAgent(caller.session.agent)) throw new HttpError(403, '仅深度适配 CLI 可调用协作接口');
    if (caller.subagentWait) throw new HttpError(403, 'Antigravity 子代理等待期间禁止发起对外协作请求');

    const method = req.method ?? 'GET';
    if (method === 'GET' && pathname === '/api/peer/peers') {
      return send(res, 200, collab.listPeers(caller.session.id));
    }
    if (method === 'POST' && pathname === '/api/peer/send') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '需要 application/json');
      const body = parseJson(await readBody(req)) as unknown as PeerSendBody;
      return send(res, 200, collab.sendPeer(caller.session.id, body));
    }
    if (method === 'GET' && pathname === '/api/peer/delegations') {
      return send(res, 200, collab.listDelegations(caller.session.id));
    }
    const delegationPost = pathname.match(/^\/api\/peer\/(delegate|rework|done|cancel)$/);
    if (method === 'POST' && delegationPost) {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '需要 application/json');
      const body = parseJson(await readBody(req)) as unknown;
      const sid = caller.session.id;
      switch (delegationPost[1]) {
        case 'delegate': return send(res, 200, collab.delegate(sid, body as PeerDelegateBody));
        case 'rework': return send(res, 200, collab.rework(sid, body as PeerDelegationActionBody));
        case 'done': return send(res, 200, collab.settle(sid, body as PeerDelegationActionBody, 'accepted'));
        default: return send(res, 200, collab.settle(sid, body as PeerDelegationActionBody, 'canceled'));
      }
    }
    throw new HttpError(404, '未找到协作接口');
  }

  async function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const got = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${cfg.token}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'unauthorized');
    const b = parseJson(await readBody(req)) as Partial<HookBody>;
    if (typeof b.sessionId !== 'string' || typeof b.event !== 'string') throw new HttpError(400, 'bad hook body');
    const hookBody = b as HookBody;
    const hookRes = sessions.hook(hookBody);
    let needTelemetry = false;
    if (hookRes) { // unknown sessions are logged and ignored
      const latest = sessions.list().find(s => s.id === hookBody.sessionId);
      if (latest) {
        activity.onHook(latest, hookBody.event, (hookBody.payload ?? {}) as Record<string, unknown>, {
          intermediateStop: hookRes.intermediateStop,
        });
        streamWatcher.onHook(latest.id);
      }
      if (!hookRes.intermediateStop) {
        observeQuota(hookBody);
        if (!hookRes.systemInjected) {
          autoRename(hookBody);
          updateLastPrompt(hookBody, hookRes.userTurn);
        }
        if (hookBody.event === 'UserPromptSubmit' || hookBody.event === 'PreInvocation') {
          collab.onPromptStart(hookBody.sessionId, hookRes.systemInjected === true);
        }
        if (hookBody.event === 'Stop') onStop(hookBody);
        else if (hookBody.event === 'StopFailure') {
          const task = latest ? store.getTask(latest.taskId) : undefined;
          if (latest && task && task.sessionId === latest.id) {
            collab.onPrimaryStop({ task, session: latest, replyText: '', canceledOrLimit: true });
          }
        }
        if (hookBody.event === 'Stop' || hookBody.event === 'PostInvocation') needTelemetry = true;
      }
    }
    send(res, 204);
    if (needTelemetry) setImmediate(() => refreshTelemetry(true));
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

  mobile = createMobileController({
    distDir: DIST,
    mainPort: cfg.port,
    mobilePort: cfg.mobilePort,
    stateDir: cfg.stateDir,
    store,
    sessions,
    activity,
    availableAgents: currentAgents,
    snapshot,
    createTask,
    renameTask,
    resumeTask,
    feedback,
    switchAgent,
    forward,
    setTaskPhase: (task, phase) => setPhase(task, phase),
    saveAttachment,
    async listChanges(projectId) {
      const project = store.getProject(projectId);
      if (!project) throw new HttpError(404, '项目不存在');
      invalidateProjectGitCache(project.path);
      const changes = await listChanges(project.path);
      if ((changes.git !== null || !gitMap.has(project.id)) && !sameGit(gitMap.get(project.id), changes.git)) {
        gitMap.set(project.id, changes.git);
        broadcast({ t: 'git', projectId: project.id, git: changes.git });
      }
      return changes;
    },
    readDiff(projectId, relPath) {
      const project = store.getProject(projectId);
      if (!project) throw new HttpError(404, '项目不存在');
      return readDiff(project.path, relPath);
    },
    openRawPreview(projectId, relPath) {
      const project = store.getProject(projectId);
      if (!project) throw new HttpError(404, '项目不存在');
      // The phone UI only previews images; keep paired devices from pulling video/audio/PDF bytes they never display.
      if (rawPreviewOf(relPath)?.kind !== 'image') throw new HttpError(415, '手机端只支持预览图片');
      return openRawPreview(project.path, relPath);
    },
    forwardHttpError(err) {
      if (err instanceof HttpError) return { status: err.status, message: err.message, code: err.code };
      if (err instanceof WorkspaceError || err instanceof CollabError) return { status: err.status, message: err.message };
      return null;
    },
  });

  // DNS rebinding: a foreign page re-pointed at 127.0.0.1 sends same-origin GETs without Origin, but its Host is foreign.
  const hosts = new Set([...allowed].map(o => new URL(o).host));

  const server = http.createServer((req, res) => {
    const run = async () => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {
        throw new HttpError(400, '请求 URL 无效');
      }
      if (!hosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Host 不被允许');
      if (pathname === '/hook') return handleHook(req, res);
      if (pathname.startsWith('/api/peer/')) return handlePeer(req, res, pathname);
      if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      throw new HttpError(404, 'not found');
    };
    run().catch(e => {
      if (res.headersSent) return;
      const mobErr = mobile?.forwardMobileError(e);
      if (mobErr) {
        send(res, mobErr.status, { error: mobErr.message, ...(mobErr.code && { code: mobErr.code }) });
        return;
      }
      if (e instanceof HttpError || e instanceof WorkspaceError || e instanceof CollabError) {
        const extra = e instanceof HttpError ? { ...(e.code && { code: e.code }), ...e.extra } : {};
        send(res, e.status, { error: e.message, ...extra });
      } else {
        console.error('[http]', e);
        send(res, 500, { error: '服务器内部错误' });
      }
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;

  // Poll git, live usage, and transcript activity only while somebody is looking; unref so timers never keep the process alive.
  const gitTimer = setInterval(() => { if (clients.size) void refreshAllGit(); }, 10_000);
  gitTimer.unref();
  const usageTimer = setInterval(() => {
    if (clients.size && sessions.list().some(s => s.status === 'working')) refreshTelemetry();
  }, 4_000);
  usageTimer.unref();
  const activityTimer = setInterval(() => {
    if (clients.size && activity.hasActive()) activity.tick();
  }, 750);
  activityTimer.unref();
  server.on('close', () => {
    clearInterval(archiveTimer);
    clearInterval(gitTimer);
    clearInterval(usageTimer);
    clearInterval(activityTimer);
    streamWatcher.close();
    void mobile?.close();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
      } catch { /* ignore */ }
      return;
    }
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
    if (activity.hasActive()) activity.tick();
    void refreshAllGit(); // fill in (or freshen) git state for a client that just opened
    const dropWs = () => {
      clients.delete(ws);
      streamWatcher.unwatchClient(ws);
    };
    ws.on('close', dropWs);
    ws.on('error', dropWs);
    ws.send(JSON.stringify({ t: 'snapshot', state: snapshot() } satisfies ServerMsg));
    for (const r of sessions.replays()) ws.send(JSON.stringify({ t: 'replay', id: r.id, d: r.d } satisfies ServerMsg));
    ws.on('message', raw => {
      let m: ClientMsg;
      try { m = JSON.parse(raw.toString()) as ClientMsg; } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'in' && typeof m.id === 'string' && typeof m.d === 'string') sessions.input(m.id, m.d);
      else if (m.t === 'resize' && typeof m.id === 'string') sessions.resize(m.id, Number(m.cols), Number(m.rows));
      else if (m.t === 'watch-stream' && typeof m.id === 'string') streamWatcher.watch(ws, m.id);
      else if (m.t === 'unwatch-stream' && typeof m.id === 'string') streamWatcher.unwatch(ws, m.id);
      else if (m.t === 'want-replay' && typeof m.id === 'string' && !sessions.hasLiveBuffer(m.id)) {
        ws.send(JSON.stringify({ t: 'replay', id: m.id, d: sessions.replayOf(m.id) ?? '' } satisfies ServerMsg));
      }
    });
  });

  return { server, wss, mobile };
}
