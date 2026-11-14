// Contract shared by server/ and web/. Change it only together with both sides.

export type AgentKind = 'claude' | 'codex' | 'agy' | 'fake';

// starting: spawned, no hook yet. idle: the CLI reported SessionStart and sits at an empty prompt (就绪), nothing to look at.
// working: a turn is running.
// needs_you: stopped and waiting for the user (turn finished, permission prompt, Ctrl+C, startup dialog).
// exited: the PTY process is gone.
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_you' | 'exited';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

// active: being worked on (or waiting in 需要你). review: a turn finished with a result card, waiting in 待验收.
// approved: the user accepted the result (通过); stays in the list, counted in neither queue.
// archived: the user closed it (×); its session process is ended and it is hidden under 已归档.
// A turn starting in the task's session moves approved / review / archived back to active.
export type TaskPhase = 'active' | 'review' | 'approved' | 'archived';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  titleAuto: boolean; // true = title was generated and may still be replaced by the first prompt
  color: string; // CSS color, assigned by the server from TASK_COLORS
  agent: AgentKind;
  sessionId: string | null; // current session
  createdAt: number;
  phase: TaskPhase; // missing in state saved before M2: loaded as 'active'
  phaseSince: number; // ms epoch of the last phase change (待验收 sorts by it)
  lastActiveAt?: number; // ms epoch of the latest user-initiated session/turn activity (sidebar sorts by it within a band)
  lastPrompt?: string; // one-line preview of the latest prompt typed into the current session (see promptPreview); shown under the title
}

// Git state of a project directory, polled by the server. Derived: never persisted.
// branch: current branch, or the short commit id when detached. dirty: changed + untracked entries.
export interface GitInfo {
  branch: string;
  detached: boolean;
  dirty: number;
}

// ---- Project Inspector (Changes & Files) ----
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?';

export interface ChangedFile {
  path: string; // POSIX path relative to project root
  origPath?: string; // original POSIX path when renamed (status === 'R')
  status: ChangeStatus;
  added: number | null; // null for binary files or when unavailable
  deleted: number | null;
}

export interface ProjectChanges {
  git: GitInfo | null;
  files: ChangedFile[];
}

export interface TreeEntry {
  name: string;
  path: string; // POSIX path relative to project root
  kind: 'dir' | 'file';
  ignored?: boolean; // heavy build/dependency dir dimmed by default (e.g. node_modules, dist)
  gitStatus?: ChangeStatus; // dirty marker on file or folder
  size?: number;
}

export interface TreeListing {
  path: string; // '' for project root
  entries: TreeEntry[];
}

export interface FileListResult {
  files: string[]; // POSIX paths relative to project root
  truncated: boolean;
}

export type FileKind = 'text' | 'image' | 'binary' | 'too_large' | 'missing';

export interface FilePayload {
  path: string;
  kind: FileKind;
  content?: string; // omitted when statOnly=true or non-text
  size: number;
  mtimeMs: number | null;
  mime?: string;
}

export interface DiffPayload {
  path: string;
  status: ChangeStatus | null;
  base: string; // HEAD content ('' for added / untracked)
  head: string; // working tree content ('' for deleted)
  binary: boolean;
  tooLarge: boolean;
  size: number;
  mtimeMs: number | null;
}

export interface WriteFileBody {
  path: string;
  content: string;
  expectedMtimeMs?: number | null;
  force?: boolean;
}

export interface WriteFileResult {
  path: string;
  size: number;
  mtimeMs: number;
}

// result: the agent's last reply when a turn ended (Stop hook). feedback: what the user wrote back.
// handoff: card made when switching agent; sessionId is the new session that took over.
// forward: content sent over from another task; sessionId is the session that received it.
export type CardKind = 'result' | 'feedback' | 'handoff' | 'forward';

export interface Card {
  id: string;
  taskId: string;
  sessionId: string; // session the result came from / the feedback was sent to
  kind: CardKind;
  body: string; // plain text, capped at CARD_MAX chars by the server
  createdAt: number;
  meta?: { from?: AgentKind; to?: AgentKind; generated?: boolean; sourceTaskId?: string; sourceCardId?: string };
}

export const CARD_MAX = 50_000;
export const CARDS_PER_TASK = 20; // older cards of a task are dropped

export interface SessionInfo {
  id: string; // workbench session id (also WORKBENCH_SESSION_ID in the child env)
  taskId: string;
  agent: AgentKind;
  nativeSessionId: string | null; // claude uuid / codex session_id / agy conversationId
  // A prompt was submitted, so the CLI has saved a conversation that `resume` can reopen.
  // Missing on sessions persisted before this field existed: treat as resumable when nativeSessionId is set.
  resumable?: boolean;
  status: SessionStatus;
  statusSince: number; // ms epoch of the last status change
  startedAt: number;
  exitCode: number | null;
  cols: number;
  rows: number;
  queued?: number; // messages waiting to be pasted into this session (see POST /api/tasks/:id/feedback); 0/missing = none
  transcriptPath?: string; // the CLI's own conversation file, from hook payloads
  // True when the session was still running when the previous server exited, until resumed or dismissed.
  interrupted?: boolean;
  // The session ran out of quota (resetsAt: ms epoch or null); cleared when the next turn starts.
  limit?: { message: string; resetsAt: number | null; at: number };
}

// Subscription quota windows of one agent's account (claude: 5-hour and 7-day, codex: from its rollout's rate_limits,
// agy: Gemini 5-hour and weekly buckets from its statusLine quota). Per agent kind, not per session; the latest
// observation wins. Fed by the 'RateLimits' hook event (see below) and, for codex, read from the transcript on Stop.
// Persisted to <stateDir>/quota.json. Agents without data have no entry.
export interface QuotaWindow {
  label: string; // '5h' / '7d', or generic ('60m', '2d')
  usedPercent: number; // 0-100
  resetsAt: number; // ms epoch; a window whose reset has passed is stale
}
export interface QuotaInfo {
  windows: QuotaWindow[];
  at: number; // ms epoch when observed
}

// Workbench-wide settings, stored in the state file.
export interface Settings {
  aiTitles: boolean; // replace a task's first-line title with one written by a short headless call of its agent
}
export const DEFAULT_SETTINGS: Settings = { aiTitles: false };

export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  sessions: SessionInfo[];
  cards: Card[];
  agents: AgentKind[]; // agents that can be launched on this machine
  settings: Settings;
  git: Record<string, GitInfo | null>; // by project id; null = not a git repo. Derived, not stored in state.json
  quota: Partial<Record<AgentKind, QuotaInfo>>; // from <stateDir>/quota.json
  telemetry?: TelemetrySummary; // derived live token / cache / speed telemetry from usage.ts
}

// Nine muted colors that stay distinguishable on a dark background.
export const TASK_COLORS = [
  '#8baeda', '#d6998f', '#74bbac', '#c69ac2', '#92b78a',
  '#aea2d6', '#6fb8c5', '#d397a9', '#adaf78',
] as const;

// ---- REST (JSON bodies; same-origin only) ----
// GET    /api/state                      -> Snapshot
// POST   /api/projects  CreateProjectBody -> Project            (400 { error } if path is not an existing directory)
// POST   /api/tasks     CreateTaskBody    -> { task, session }  (spawns the PTY in the project path)
// PATCH  /api/tasks/:id  RenameTaskBody  -> Task              (400 { error } if empty / over 80 chars, 404 if unknown; sets titleAuto=false)
// POST   /api/tasks/:id/resume ResumeTaskBody -> ResumeResult (new session for the task; reopens the last conversation, or starts a
//                                                new one when fresh; 404 unknown task, 409 if the current session still runs,
//                                                409 { code: 'no-conversation' } if there is nothing to reopen and not fresh;
//                                                nothing changes in that case)
// POST   /api/tasks/:id/approve          -> Task              (通过: phase -> approved; 404 unknown task)
// POST   /api/tasks/:id/archive          -> Task              (×: ends the session process if live, keeping the session so it can be
//                                                resumed later; phase -> archived; 404 unknown task)
// POST   /api/tasks/:id/unarchive        -> Task              (phase -> active; 404 unknown task)
// POST   /api/tasks/:id/feedback FeedbackBody -> FeedbackResult (saves a feedback card, phase -> active, then
//          mode 'new':  replaces the current session (killed if live) with a new one whose initial prompt is
//                       feedbackPrompt(task, last result card, text);
//          mode 'same': pastes the text into the current session, queued until it is idle; an exited session is
//                       resumed first (400 if it has no conversation to reopen). 400 on empty text, 404 unknown task)
// POST   /api/tasks/:id/switch SwitchAgentBody -> SwitchResult (builds a handoff card, then replaces the current session with a new
//          one on the target agent; 400 agent unavailable, 404 unknown task, 409 already switching)
// POST   /api/cards/:id/forward ForwardBody -> ForwardResult (sends the card to another task, queued like feedback 'same', or to a new task;
//          400 empty card / same task / target has no conversation to reopen, 404 unknown card or target)
// DELETE /api/tasks/:id                   -> { ok: true }       (kills the session if live, removes the task, its sessions and cards)
// DELETE /api/projects/:id                -> { ok: true }       (removes the project and all its tasks, archived ones included, with their
//                                                sessions and cards; live sessions are killed. Disk dir, CLI transcripts and usage.json stay; 404 unknown)
// GET    /api/dirs?path=<abs>|?drives=1   -> DirListing       (subdirectories only; no params = start dir; 400 { error } if missing/unreadable)
// GET    /api/usage?from=<ms>&to=<ms>     -> UsageReport      (token usage of workbench sessions in [from, to), hour precision;
//                                                missing from/to = unbounded; rescans the CLI transcripts first)
// POST   /api/attachments  Content-Type image/png|jpeg|gif|webp, raw body -> { path }  (saves to <stateDir>/attachments, path is absolute;
//                                                415 other types, 413 over 20 MB, 400 empty body)
// POST   /api/open  { target } -> { action, path }  (a terminal link: file: URI or X:\ path, optional #L12 / :12:3 suffix; opens it in VS Code,
//                                                Explorer or the default viewer, never executes it; 400 UNC / remote host / relative / other
//                                                scheme, 404 missing file)
// GET    /api/projects/:id/changes       -> ProjectChanges   (git branch + uncommitted files with +/- line counts)
// GET    /api/projects/:id/diff?path=p   -> DiffPayload      (HEAD vs working tree text for one file; >2MB or binary flagged)
// GET    /api/projects/:id/tree?path=dir -> TreeListing      (single-level lazy directory listing with git dirty badges)
// GET    /api/projects/:id/files         -> FileListResult   (relative file paths for Ctrl+P quick search, capped at 20,000)
// GET    /api/projects/:id/file?path=p[&stat=1] -> FilePayload (text content or metadata; stat=1 omits content for fast mtime check)
// GET    /api/projects/:id/raw?path=p    -> binary stream    (image preview only, strict CSP: default-src 'none')
// PUT    /api/projects/:id/file WriteFileBody -> WriteFileResult (saves UTF-8 text; 409 { code: 'conflict', mtimeMs } on mtime mismatch)
// POST   /api/projects/:id/discard { path } -> { ok: true }  (restores tracked file to HEAD or deletes untracked file)
// POST   /hook  Authorization: Bearer <token>  HookBody -> 204  (called by hooks/notify.mjs, and by hooks/statusline.mjs with the
//                                                synthetic event 'RateLimits', payload { rate_limits } in claude's status line format
//                                                ({ five_hour?, seven_day? }, each { used_percentage: 0-100, resets_at: unix seconds })
//                                                or { quota } in agy's status line format ({ 'gemini-5h'?, 'gemini-weekly'?, ... },
//                                                each { remaining_fraction?: 0-1, reset_time?: ISO string, reset_in_seconds?: number }).
//                                                It updates the quota only: no effect on session status, log-based features or titles)

// Token counts in one shape for all CLIs. input excludes cache reads/writes; output includes reasoning (reasoning is a subset).
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number; // model responses that reported usage
}

export const usageTotal = (c: UsageCounts) => c.input + c.output + c.cacheRead + c.cacheWrite;
export const usageCacheHitRate = (c: UsageCounts): number | null => {
  const inputSide = c.input + c.cacheRead + c.cacheWrite;
  return inputSide > 0 ? c.cacheRead / inputSide : null;
};

// Live per-task / today telemetry derived from CLI transcripts.
export interface TaskMetrics extends UsageCounts {
  tps: number | null; // recent output generation speed (tokens/s)
  updatedAt: number; // ms epoch of last recorded model response
}

export interface TelemetrySummary {
  byTask: Record<string, TaskMetrics>;
  today: UsageCounts & { tps: number | null; updatedAt: number };
}

export interface UsageRow extends UsageCounts {
  key: string; // vendor / model / agent / task id / project id; '' = unknown
  label: string;
  vendor?: string; // byModel
  agents?: AgentKind[]; // byTask, byProject
  project?: string; // byTask: project name
  deleted?: boolean; // byTask, byProject: no longer in the workbench
}

export interface UsageReport {
  from: number | null;
  to: number | null;
  since: number | null; // earliest recorded hour
  scannedAt: number;
  total: UsageCounts;
  byVendor: UsageRow[]; // sorted by total, descending
  byModel: UsageRow[];
  byAgent: UsageRow[];
  byTask: UsageRow[];
  byProject: UsageRow[];
  hours: ({ t: number } & UsageCounts)[]; // hour start (ms epoch) ascending, only hours with usage
}

const VENDORS: [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|fable/, 'Anthropic'],
  [/gemini|gemma/, 'Google'],
  [/gpt|codex|^o\d|chatgpt/, 'OpenAI'],
  [/deepseek/, 'DeepSeek'],
  [/qwen/, '阿里 Qwen'],
  [/glm|zhipu/, '智谱'],
  [/kimi|moonshot/, 'Moonshot'],
  [/doubao/, '字节豆包'],
  [/minimax|abab/, 'MiniMax'],
  [/grok/, 'xAI'],
];
const AGENT_VENDOR: Record<AgentKind, string> = { claude: 'Anthropic', codex: 'OpenAI', agy: 'Google', fake: '测试' };

// Vendor from the model name (a CLI can be pointed at another vendor's model), else from the CLI.
export function vendorOf(model: string, agent: AgentKind): string {
  const m = model.toLowerCase().split('/').at(-1) ?? '';
  for (const [re, v] of VENDORS) if (re.test(m)) return v;
  return AGENT_VENDOR[agent] ?? '未知';
}

export interface DirListing {
  path: string | null; // null = drive list
  parent: string | null; // null at a drive root and for the drive list
  entries: { name: string; path: string }[];
}

export interface CreateProjectBody {
  name: string;
  path: string;
}

export interface CreateTaskBody {
  projectId: string;
  title?: string; // empty/missing: derived from prompt, else "新任务 N" (titleAuto)
  agent: AgentKind;
  prompt?: string;
  cols?: number;
  rows?: number;
}

export interface RenameTaskBody {
  title: string;
}

export interface ResumeTaskBody {
  fresh?: boolean; // true: start a new conversation instead of reopening the last one
  cols?: number;
  rows?: number;
}

export interface ResumeResult {
  task: Task;
  session: SessionInfo;
  resumed: boolean; // false: started a new conversation (asked for, or nothing to reopen)
  replacedSessionId?: string; // previous session id replaced by this resume
}

export interface ArchiveStoppedResult {
  tasks: Task[]; // tasks moved to phase 'archived'
}

export interface ResumeInterruptedResult {
  resumed: ResumeResult[];
  skipped: number; // interrupted sessions that had no conversation to reopen (cleared so they do not re-prompt)
}

export interface FeedbackBody {
  text: string;
  mode: 'new' | 'same';
  cols?: number;
  rows?: number;
}

export interface FeedbackResult {
  task: Task;
  session: SessionInfo; // the new session (mode 'new', or 'same' on an exited one) or the current one
  card: Card; // the saved feedback card
}

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', fake: 'Fake' };

export interface SwitchAgentBody {
  agent: AgentKind;
  note?: string;
  cols?: number;
  rows?: number;
}

export interface SwitchResult {
  task: Task;
  session: SessionInfo; // the new session
  card: Card; // the saved handoff card
  generated: boolean; // false: the target agent could not write the card, an excerpt of the transcript was used
}

export interface ForwardBody {
  to: { taskId: string } | { projectId: string; agent: AgentKind };
  note?: string;
  cols?: number;
  rows?: number;
}

export interface ForwardResult {
  task: Task; // the target task
  session: SessionInfo;
  card: Card; // the forward card saved on the target
}

export const FORWARD_NOTE = '下面是另一个任务的结果，供你参考。';

export function forwardText(source: { title: string; agent: AgentKind }, body: string, note?: string): string {
  return [note?.trim() || FORWARD_NOTE, '', `## 转发自任务「${source.title}」（${AGENT_LABEL[source.agent]}）`, body.trim()].join('\n');
}

// Initial prompt of the new session started by feedback mode 'new'.
export function feedbackPrompt(task: Pick<Task, 'title' | 'prompt'>, result: string | undefined, feedback: string): string {
  return [
    `继续任务「${task.title}」。上一个会话已经结束，下面是你需要的上下文。`,
    '',
    '## 任务需求',
    task.prompt.trim() || '（创建任务时没有写需求，以上一轮的结果和反馈为准）',
    '',
    '## 上一轮的结果',
    result?.trim() || '（没有记录到上一轮的结果）',
    '',
    '## 用户的反馈',
    feedback.trim(),
  ].join('\n');
}

// Whether the session's conversation can be reopened with the CLI's resume command.
export const canResume = (s: Pick<SessionInfo, 'nativeSessionId' | 'resumable'>) =>
  s.nativeSessionId !== null && s.resumable !== false;

export interface HookBody {
  sessionId: string;
  agent: string;
  event: string;
  at: number;
  payload: unknown;
}

// ---- WebSocket /ws (same-origin only) ----
export type ServerMsg =
  | { t: 'snapshot'; state: Snapshot }
  | { t: 'project'; project: Project }
  | { t: 'task'; task: Task }
  | { t: 'task-removed'; id: string } // its cards are gone too
  | { t: 'project-removed'; id: string } // sent after a task-removed for each of its tasks
  | { t: 'card'; card: Card }
  | { t: 'settings'; settings: Settings }
  | { t: 'git'; projectId: string; git: GitInfo | null } // sent only when the value changed
  | { t: 'quota'; agent: AgentKind; quota: QuotaInfo } // sent only when the windows changed
  | { t: 'telemetry'; telemetry: TelemetrySummary } // sent when token usage / cache / speed changes
  | { t: 'session'; session: SessionInfo }
  | { t: 'replay'; id: string; d: string } // buffered history, sent once per session right after snapshot
  | { t: 'out'; id: string; d: string };

export type ClientMsg =
  | { t: 'in'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number };
