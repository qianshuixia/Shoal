// Contract shared by server/ and web/. Change it only together with both sides.

export type BuiltinDeepAgent = 'claude' | 'codex' | 'agy' | 'fake';
export type AgentKind = string;
export type PermissionMode = 'full' | 'normal';
export type CliTier = 'deep' | 'generic';

export const DEEP_AGENTS = new Set<string>(['claude', 'codex', 'agy', 'fake']);
export const BUILTIN_CLI_IDS = new Set<string>([
  'claude', 'codex', 'agy', 'fake',
  'gemini', 'kimi', 'droid', 'qwen', 'opencode', 'copilot', 'cursor-agent', 'aider', 'amp', 'cline', 'goose',
]);
export const RESERVED_CLI_IDS = new Set<string>([
  ...BUILTIN_CLI_IDS,
  'all', 'none', 'default', 'constructor', 'prototype', '__proto__', 'tostring', 'valueof',
]);

export const isDeepAgent = (agent: string): boolean => DEEP_AGENTS.has(agent);

export function isValidCustomCliId(id: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(id) && !RESERVED_CLI_IDS.has(id);
}

export function parseCliArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
        cur += raw[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

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

export interface AgyModelOption {
  slug: string; // '' = follow global ~/.gemini/antigravity-cli/settings.json default
  label: string;
  desc: string;
}

// Curated Gemini 4 / Orchestrator tiers for Antigravity CLI (gemini-3.8-flash* is intentionally excluded).
export const AGY_MODELS: readonly AgyModelOption[] = [
  { slug: '', label: '跟随全局默认（settings.json）', desc: '沿用 ~/.gemini/antigravity-cli/settings.json 中的默认模型' },
  { slug: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon) · 推荐', desc: 'Carbon 顶层规划与终审 + Hydrogen 高速改码自检' },
  { slug: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)', desc: '日常维护、脚本与单测高速执行' },
  { slug: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', desc: '单模型均衡深度推理' },
  { slug: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)', desc: '复杂架构设计、隐蔽并发与安全审计' },
] as const;

export const isValidAgyModel = (slug: unknown): slug is string =>
  typeof slug === 'string' && AGY_MODELS.some(m => m.slug === slug);

export interface Task {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  titleAuto: boolean; // true = title was generated and may still be replaced by the first prompt
  color: string; // CSS color, assigned by the server from TASK_COLORS
  agent: AgentKind;
  model?: string; // optional per-task CLI model slug (currently used for agy --model <slug>)
  permissionMode?: PermissionMode; // effective permission mode of this task's session (inherited by delegated children)
  sessionId: string | null; // current session
  createdAt: number;
  phase: TaskPhase; // missing in state saved before M2: loaded as 'active'
  phaseSince: number; // ms epoch of the last phase change (待验收 sorts by it)
  lastActiveAt?: number; // ms epoch of the latest user-initiated session/turn activity (sidebar sorts by it within a band)
  lastPrompt?: string; // one-line preview of the latest prompt typed into the current session (see promptPreview); shown under the title
  delegation?: TaskDelegation; // set on a task dispatched by another task's `shoal delegate`
}

// ---- Cross-CLI delegation ----
// A delegated task belongs to the main task that dispatched it, not to that task's session or agent, so switching the
// main task's agent keeps its children. Only one level: a delegated task cannot delegate.
export interface TaskDelegation {
  parentTaskId: string; // the main task (it may have been deleted since)
  brief: string; // one-line preview of the dispatched brief
  round: number; // 1 on dispatch, +1 on every `shoal rework`
  createdAt: number;
  // Written when the delegation is closed. Read only while the task's phase is 'archived'.
  outcome?: 'accepted' | 'canceled';
  settledAt?: number; // ms epoch of the close
  mode?: 'review'; // read-only reviewer dispatched with `shoal delegate --review`; missing = executor
}

// working: running its first round. rework: running round 2 or later.
// needs_you: stopped where only the user can continue (permission or startup dialog, Ctrl+C, out of quota).
// review: a round finished and its result is waiting for the main task. failed: its process is gone without a result.
// accepted / canceled: closed, the task is archived.
export type DelegationState = 'working' | 'rework' | 'needs_you' | 'review' | 'failed' | 'accepted' | 'canceled';

export const DELEGATION_LABEL: Record<DelegationState, string> = {
  working: '执行中', rework: '返工中', needs_you: '等你处理', review: '待验收', failed: '已中断', accepted: '已通过', canceled: '已取消',
};

// Derived, never stored: null for a task that was not delegated.
export function delegationState(
  task: Pick<Task, 'phase' | 'phaseSince' | 'delegation'>,
  session: Pick<SessionInfo, 'status' | 'statusSince' | 'blocked' | 'limit'> | undefined,
): DelegationState | null {
  const d = task.delegation;
  if (!d) return null;
  if (task.phase === 'archived') return d.outcome ?? 'canceled';
  if (task.phase === 'review' || task.phase === 'approved') return 'review';
  if (!session || session.status === 'exited') return 'failed';
  if (session.blocked || session.limit) return 'needs_you';
  // A rework note puts the task back to 'active' while its session still shows the previous round's stop until the
  // note is delivered. Only a stop that came after the phase change (Ctrl+C in the child) is the user's to handle.
  if (session.status === 'needs_you' && session.statusSince >= task.phaseSince) return 'needs_you';
  return d.round > 1 ? 'rework' : 'working';
}

// Title of a delegated task for display: strips legacy '委派：' prefix and leading markdown heading hashes.
export const delegationDisplayTitle = (title: string): string =>
  title.replace(/^委派[：:]\s*/, '').replace(/^#+\s+/, '').trim() || title;

// System-injected XML messages (e.g. Claude Code background-task completion notifications) are never user prompts.
const SYSTEM_PROMPT_TAG = /^\s*<(?:task-notification|system-reminder|command-message|command-name|command-args|local-command-stdout|local-command-caveat)\b/i;

export const isSystemPromptText = (text: string): boolean => SYSTEM_PROMPT_TAG.test(text);

// Display-time sanitizer for stored prompt previews (drops legacy system XML payloads and leading markdown '# ').
export const cleanPreviewText = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed || isSystemPromptText(trimmed)) return '';
  return trimmed.replace(/^#+\s+/, '').trim();
};

// Short id the main agent uses in `shoal rework / done / cancel`: '#n' indexes shift when tasks are archived.
export const delegationHandle = (taskId: string): string => taskId.slice(0, 8);

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
  truncated?: boolean; // true when total dirty entries exceeded MAX_CHANGED_FILES
  statsSkipped?: boolean; // true when untracked/added count exceeded MAX_UNTRACKED_LINE_STAT
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

export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary' | 'too_large' | 'missing';
export type RawPreviewKind = 'image' | 'video' | 'audio' | 'pdf';

// Files the Inspector renders natively, served by GET /api/projects/:id/raw. Whether a given video or audio codec
// actually plays depends on the WebView, so the player falls back to "open externally" on a decode error.
// Never add .ts / .mts here: those are TypeScript sources, not MPEG transport streams.
const RAW_PREVIEW_TYPES: Record<string, { kind: RawPreviewKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  apng: { kind: 'image', mime: 'image/apng' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  wmv: { kind: 'video', mime: 'video/x-ms-wmv' },
  flv: { kind: 'video', mime: 'video/x-flv' },
  '3gp': { kind: 'video', mime: 'video/3gpp' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  weba: { kind: 'audio', mime: 'audio/webm' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
};

export const rawPreviewOf = (filePath: string): { kind: RawPreviewKind; mime: string } | null => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filePath)?.[1].toLowerCase();
  return ext && Object.hasOwn(RAW_PREVIEW_TYPES, ext) ? RAW_PREVIEW_TYPES[ext] : null;
};

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
  isDirectory?: boolean; // true for submodule gitlinks or untracked nested git directories
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

export type OpenMode = 'default' | 'reveal' | 'editor';

export interface FsCreateBody {
  parentDir: string; // '' for project root
  name: string;
  kind: 'file' | 'dir';
}

export interface FsCreateResult {
  path: string;
  kind: 'file' | 'dir';
}

export interface FsRenameBody {
  path: string;
  newName: string;
}

export interface FsRenameResult {
  oldPath: string;
  newPath: string;
  kind: 'file' | 'dir';
}

export interface FsDeleteBody {
  path: string;
}

export interface FsDeleteResult {
  path: string;
  kind: 'file' | 'dir';
}

export interface FsPasteBody {
  mode: 'copy' | 'cut';
  targetDir: string; // '' for project root
  sourceProjectId?: string;
  sourcePath?: string;
  externalPaths?: string[];
}

export interface FsPasteResult {
  paths: string[];
  targetDir: string;
  skipped?: boolean;
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
  meta?: {
    from?: AgentKind;
    to?: AgentKind;
    generated?: boolean;
    sourceTaskId?: string;
    sourceCardId?: string;
    replyBack?: boolean;
    isAutoReply?: boolean;
    peerHop?: number;
    // Set on a forward card written by delegation: a child's round result or blocked notice sent to the main task,
    // or the rework note sent to the child.
    delegation?: 'result' | 'rework' | 'blocked';
  };
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
  // Set while paused at an interactive CLI permission or startup folder-trust prompt.
  blocked?: 'startup' | 'permission';
  // Permission mode this session was spawned with ('full' = skip approvals, 'normal' = CLI defaults).
  permissionMode?: PermissionMode;
}

// Subscription quota windows of one agent's account (claude: 5-hour and 7-day, codex: from its rollout's rate_limits,
// agy: Gemini 5-hour and weekly buckets from its statusLine quota). Per agent kind, not per session; the latest
// observation wins. Fed by the 'RateLimits' hook event (see below) and, for codex, read from the transcript on Stop.
// Persisted to <stateDir>/quota.json. Agents without data have no entry.
export interface QuotaWindow {
  label: string; // '5h' / '7d', or generic ('60m', '2d')
  usedPercent: number; // 0-100
  resetsAt: number; // ms epoch; a window whose reset has passed is stale
  windowMinutes?: number; // rolling window duration in minutes for time-pace calculation (300 = 5h, 10080 = 7d)
  pool?: string; // logical model pool id (e.g. 'gemini', '3p', 'claude', 'codex')
  poolLabel?: string; // human-readable pool name (e.g. 'Gemini', 'Claude & GPT 共享')
  primary?: boolean; // primary pool shown in compact pills; omitted counts as true
}
export interface QuotaInfo {
  windows: QuotaWindow[];
  at: number; // ms epoch when observed
  plan?: string; // optional subscription tier/account source (e.g. 'plus', 'pro', 'Google')
  source?: 'statusline' | 'rollout' | 'transcript';
}

// Live prompt context window occupancy of one session (cached vs uncached vs remaining), derived from statusLine or transcripts.
// Never persisted to state.json; broadcast incrementally via WS.
export interface SessionContext {
  contextWindowSize: number; // max context tokens (e.g. 200_000 or 1_048_576)
  usedTokens: number; // total prompt tokens in latest turn (cached + uncached)
  cachedTokens: number; // cached prompt tokens
  uncachedTokens: number; // non-cached input tokens
  usedPercent: number; // 0-100
  cacheHitRate: number | null; // 0-1 for the latest turn
  model?: string;
  turns?: number;
  updatedAt: number;
}

export type ActivityPhase = 'thinking' | 'tool' | 'subagent' | 'compacting' | 'error';

export interface ActivityStep {
  at: number; // ms epoch when observed
  kind: 'plan' | 'tool' | 'note' | 'error';
  summary: string; // concise human-readable Chinese / tool summary
  detail?: string; // optional raw tool name or secondary context
  status?: 'running' | 'done' | 'error';
}

// Live white-box execution state for a working session, derived from lifecycle hooks and incremental transcript tailing.
// Never persisted to state.json; cleared when the session stops working or exits.
export interface SessionActivity {
  sessionId: string;
  turnStartedAt: number; // ms epoch when the current working turn began
  lastProgressAt: number; // ms epoch of the latest observable hook / transcript progress (never bumped by PTY redraws)
  phase: ActivityPhase;
  summary: string; // current one-line Chinese status shown in Pane HUD & sidebar TaskRow
  model?: string; // active model reported by hook or transcript
  stepCount: number; // steps observed in the current turn
  thinkingSnippet?: string; // latest short snippet of planner progress/thinking
  recentSteps: ActivityStep[]; // newest last, capped by server
  filesRead: string[]; // recent distinct file paths read in this turn
  filesWritten: string[]; // recent distinct file paths written/edited in this turn
}

export interface CliToolPreference {
  enabled?: boolean;
  permissionMode?: PermissionMode;
}

export interface CustomCliConfig {
  id: string; // lowercase slug (/^[a-z][a-z0-9_-]{0,31}$/), cannot collide with built-in ids
  label: string;
  command: string; // executable name on PATH or absolute file path
  normalArgs?: string[];
  fullAccessArgs?: string[];
  promptArg?: 'positional' | 'none';
}

export interface CliToolInfo {
  id: string;
  label: string;
  tier: CliTier;
  source: 'builtin' | 'custom';
  installed: boolean;
  usable: boolean;
  unusableReason?: string;
  path: string | null;
  version?: string | null;
  command: string;
  enabled: boolean;
  permissionMode: PermissionMode;
  fullAccessArgs: string[];
  normalArgs: string[];
  supportsFullAccessFlag: boolean;
  fullAccessNote?: string;
  capabilities: string[];
  limitations?: string;
  promptArg: 'positional' | 'none';
}

export interface CliScanResult {
  agents: AgentKind[];
  cliTools: CliToolInfo[];
  scannedAt: number;
}

// Workbench-wide settings, stored in the state file.
export interface Settings {
  aiTitles: boolean; // replace a task's first-line title with one written by a short headless call of its agent
  agyModel?: string; // default model slug passed to new Antigravity tasks ('' or undefined = follow global settings.json)
  // Tell Claude Code, Codex and Antigravity sessions at launch how to delegate work to another CLI with `shoal` (see
  // DELEGATION_INSTRUCTIONS). Off: `shoal` still works, but an agent only uses it when the user asks. Missing = on.
  autoDelegate?: boolean;
  // Which kind of work goes to which CLI and when to ask the other two for a joint review; appended to the standing
  // delegation instructions. undefined = the built-in DEFAULT_DELEGATION_RULES, '' = inject no rules.
  delegationRules?: string;
  // Per-CLI enablement and permission mode preferences (keyed by CLI id). Default permissionMode = 'full'.
  cliPrefs?: Record<string, CliToolPreference>;
  // User-defined custom CLIs added manually from Settings.
  customClis?: CustomCliConfig[];
}
export const DELEGATION_RULES_MAX = 4000;
// Built-in division of labor, from each vendor's own docs (Nov 2026). Names capabilities, not model versions, so it
// ages slowly; users replace it in Settings.
export const DEFAULT_DELEGATION_RULES = [
  '三个 CLI 各用各的订阅额度，按长处分工，互相补位、互相把关。下面只列各家官方资料里明确写到的长处；具体模型以各 CLI 当前设置为准。',
  '',
  '### 谁擅长什么',
  '- Claude Code：长时间、多步骤的编码和重构，终端操作，需求澄清和方案设计，代码评审，中英文写作。弱项：不能生成图片，网络安全类任务常被拦截。',
  '- Codex：复杂工程实现、数据库迁移，数学、科学计算和算法推导，大批量重复改动（选低档模型更省额度）。自带 `/review` 评审改动的能力，适合当第二评审。弱项：渗透测试、漏洞利用这类安全任务会被拒绝；默认沙箱关闭网络访问。',
  '- Antigravity：前端和 UI 实现，看懂截图、设计稿、PDF、图表和视频，超长上下文的全库通读，用内置浏览器点击、截图、验收页面，以及速度要求高的小改动。弱项：复杂终端任务和大型工程改动不如前两家稳，容易编造细节，需要有人复核。',
  '',
  '### 什么时候委派',
  '- 当前 CLI 明显不擅长、而另一家擅长时委派。例如 Claude 会话遇到设计稿还原或要在浏览器里验收页面，交给 Antigravity；任何会话遇到算法证明、数值计算或大批量同类改动，交给 Codex；Antigravity 会话遇到复杂重构或终端排障，交给 Claude Code 或 Codex。',
  '- 想要一份独立实现或换个思路时委派，比如修了两轮还没修好的 bug。',
  '- 几次工具调用就能做完的小事自己做，委派的开销比收益大。',
  '- 只能委派给上面列出的已安装 CLI；没装的就自己做，并在汇报里说明原因。',
  '- 委派只交出执行；需求理解、最终验收和向用户汇报留在本会话。同一批文件不要同时交给两个执行者改。',
  '',
  '### 什么时候评审',
  '用 `shoal delegate <agent> --review` 派出只读评审者。以下情况主动发起，不必等用户开口：',
  '- 动手前，需求或方案涉及跨模块设计、数据迁移、安全、计费、权限或公开接口。',
  '- 交付前，改动较大（例如超过约 300 行或跨多个模块），或修改的是很难回滚的东西。',
  '- 用户说「评审一下」「三方评审」「大家一起看看」。',
  '一般改动请一位评审者，挑与本会话不同家的 CLI。上面列出的高风险情况，或用户明确要求时，做三方评审。',
  '',
  '### 三方评审怎么做',
  '1. 写一份自包含的评审 brief 并存成项目内文件。内容包括：评审对象（需求、方案或 diff 范围）、背景、验收标准、要重点检查的角度、已知风险。评审者看不到本对话。',
  '2. 同时运行 `shoal delegate <另外两个 CLI> --review --file <brief>`。',
  '3. 等待期间自己先独立评审，写下自己的结论，再看对方的结论，避免被带偏。',
  '4. 对每条意见逐条裁决：认可就修改；有异议就写明依据；信息不够就补充后再请评审者确认。BLOCKING 全部解决后才能继续。',
  '5. 对评审者执行 `shoal done <id>`，然后向用户汇报三方结论、各自的分歧和最终裁决。',
  '',
  '### 额度',
  '三家都按 5 小时窗口加每周上限计量。别让一家的额度耗尽：同类工作在空闲的 CLI 之间轮换，大批量的机械改动用便宜的模型，评审 brief 写清范围，不要让评审者通读整个仓库。',
].join('\n');
export const DEFAULT_SETTINGS: Settings = { aiTitles: false, autoDelegate: true };

export interface AgyOptimizeStatus {
  optimized: boolean;
  cliSettings: {
    optimized: boolean;
    path: string;
    verbosity?: string;
    colorScheme?: string;
  };
  outputRule: {
    optimized: boolean;
    source: 'rule_file' | 'gemini_md' | 'none';
    path: string;
  };
  fastToolsMcp: {
    optimized: boolean;
    path: string;
    scriptPath?: string;
  };
  appliedChanges?: string[];
  backupsCreated?: string[];
}

export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  sessions: SessionInfo[];
  cards: Card[];
  agents: AgentKind[]; // enabled & usable agents that can be launched on this machine
  cliTools?: CliToolInfo[]; // full catalog + detected/custom CLIs for labels, badges & Settings
  settings: Settings;
  git: Record<string, GitInfo | null>; // by project id; null = not a git repo. Derived, not stored in state.json
  quota: Partial<Record<AgentKind, QuotaInfo>>; // from <stateDir>/quota.json
  telemetry?: TelemetrySummary; // derived live token / cache / speed telemetry from usage.ts
  context?: Record<string, SessionContext>; // by sessionId: live prompt context occupancy
  activity?: Record<string, SessionActivity>; // by sessionId for currently working sessions
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
// GET    /api/projects/:id/raw?path=p    -> binary stream    (rawPreviewOf types only, single-range Range support, strict CSP: default-src 'none')
// PUT    /api/projects/:id/file WriteFileBody -> WriteFileResult (saves UTF-8 text; 409 { code: 'conflict', mtimeMs } on mtime mismatch)
// POST   /api/projects/:id/discard { path } -> { ok: true }  (restores tracked file to HEAD or deletes untracked file)
// GET    /api/agy/optimize               -> AgyOptimizeStatus (read-only status of Antigravity CLI output & fast-tools optimization)
// POST   /api/agy/optimize               -> AgyOptimizeStatus (backs up existing configs to *.shoal.bak and applies non-destructive optimization; 400 on corrupt JSON)
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
const AGENT_VENDOR: Partial<Record<string, string>> = { claude: 'Anthropic', codex: 'OpenAI', agy: 'Google', fake: '测试' };

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
  model?: string; // optional CLI model slug (for agy)
  prompt?: string;
  attachments?: string[]; // basename-only attachment filenames stored in <stateDir>/attachments
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
  attachments?: string[]; // basename-only attachment filenames stored in <stateDir>/attachments
  cols?: number;
  rows?: number;
}

export interface FeedbackResult {
  task: Task;
  session: SessionInfo; // the new session (mode 'new', or 'same' on an exited one) or the current one
  card: Card; // the saved feedback card
}

export const AGENT_LABEL: Partial<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
  fake: 'Fake',
  gemini: 'Gemini CLI',
  kimi: 'Kimi Code',
  droid: 'Factory Droid',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot CLI',
  'cursor-agent': 'Cursor Agent',
  aider: 'Aider',
  amp: 'Amp',
  cline: 'Cline CLI',
  goose: 'Goose',
};

export function agentLabel(agent: AgentKind, cliTools?: readonly Pick<CliToolInfo, 'id' | 'label'>[]): string {
  const fromTools = cliTools?.find((t) => t.id === agent)?.label;
  return fromTools ?? AGENT_LABEL[agent] ?? agent;
}

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
  replyBack?: boolean;
  cols?: number;
  rows?: number;
}

export interface ForwardResult {
  task: Task; // the target task
  session: SessionInfo;
  card: Card; // the forward card saved on the target
  replyBack?: boolean;
}

export interface PeerTaskSummary {
  index: number; // 1-based '#1', '#2' within project
  id: string;
  title: string;
  agent: AgentKind;
  phase: TaskPhase;
  status: SessionStatus | 'none';
  isSelf: boolean;
  lastPrompt?: string;
  latestReplyFile?: string;
  // Set on a delegated task.
  delegation?: { parentTaskId: string; state: DelegationState; round: number };
}

export interface PeerListResult {
  projectId: string;
  projectName: string;
  selfTaskId: string;
  peersFile: string;
  tasks: PeerTaskSummary[];
}

export interface PeerSendBody {
  target: string;
  note?: string;
  stdinText?: string;
  filePath?: string;
  replyBack?: boolean;
  createIfAgent?: boolean;
}

export interface PeerSendResult {
  targetTaskId: string;
  targetTitle: string;
  targetAgent: AgentKind;
  created: boolean;
  queued: boolean;
  replyBack: boolean;
  hop: number;
}

export interface PeerDelegateBody {
  agent: string; // 'claude' | 'codex' | 'agy'
  title?: string;
  note?: string;
  stdinText?: string;
  filePath?: string;
  review?: boolean; // dispatch a read-only reviewer instead of an executor
}

export interface DelegationSummary {
  id: string;
  handle: string; // delegationHandle(id)
  title: string;
  agent: AgentKind;
  state: DelegationState;
  round: number;
  brief: string;
  status: SessionStatus | 'none';
  createdAt: number;
  mode?: 'review';
  latestReplyFile?: string;
}

export interface PeerDelegateResult {
  task: DelegationSummary;
  hop: number;
}

// The caller's delegated tasks, newest last. `parent` is set when the caller is itself a delegated task.
export interface PeerDelegationList {
  projectName: string;
  selfTaskId: string;
  parent?: { id: string; title: string };
  tasks: DelegationSummary[];
}

export interface PeerDelegationActionBody {
  target: string; // handle / task id prefix, '#n' from `shoal peers`, or a unique title fragment
  note?: string;
  stdinText?: string;
  filePath?: string;
}

export interface PeerDelegationActionResult {
  task: DelegationSummary;
  queued?: boolean; // rework only: the note waits for the child's current turn
}

// Standing instructions of every session that is not a delegated task, when Settings.autoDelegate is on. Each CLI gets
// them its own way (see buildLaunch): claude --append-system-prompt, codex developer_instructions, agy an always-on AGENTS.md.
export const DELEGATION_INSTRUCTIONS = [
  '## Shoal delegation',
  'You run inside Shoal, a workbench that hosts the Claude Code, Codex and Antigravity CLIs side by side on the user\'s own subscriptions. The `shoal` command is on PATH.',
  '- Ordinary work needs no shoal command. Work your own CLI\'s subagents can do stays with them.',
  '- Delegate to another vendor\'s CLI with `shoal delegate <claude|codex|agy>` when the user asks for it, when the user\'s instruction files route that kind of work to that agent, or when an independent implementation or review by a different model is worth a separate session. Do not switch to a different agent than the one asked for.',
  '- The child sees only your brief, not this conversation. Write it self-contained: goal, files to read, behavior that must not change, checks to run. Pass it with `--stdin` or `--file <path inside the project>`; `-m` is for a single line.',
  '- `shoal delegate <agent> --review` dispatches a read-only reviewer: it changes no files and only returns a PASS/FAIL verdict with BLOCKING / NON-BLOCKING findings. Use it for an independent review of a requirement, plan or change. A three-way review means dispatching it to both other CLIs, reviewing independently yourself, then ruling on every finding and summarizing.',
  '- After delegating, do not wait or poll. Continue other work or end your turn: the child\'s result is pasted into this session when its round finishes.',
  '- Review each result yourself. Then `shoal done <id>` accepts and closes the child, `shoal rework <id> --stdin` sends it back with specific findings, and `shoal cancel <id>` drops it. Fix small findings yourself instead of sending them back.',
  '- `shoal status` lists your delegated tasks; `shoal help` lists every command.',
  '- When the user asks about another task in this project: `shoal peers` lists them with the file holding each one\'s latest reply, `shoal send <target>` messages one, and `shoal ask <target>` also brings its reply back.',
].join('\n');

// Standing instructions plus the installed-CLI line and the user-editable division-of-labor rules.
export function composeDelegationInstructions(opts: { host: AgentKind; available: AgentKind[]; rules: string }): string {
  const rules = opts.rules.trim();
  return [
    DELEGATION_INSTRUCTIONS,
    '',
    `This session runs ${agentLabel(opts.host)}. CLIs installed in this Shoal: ${opts.available.map(a => agentLabel(a)).join(', ')}. Only these can be delegated to.`,
    ...(rules ? ['', '## 分工与评审规则（Shoal 设置，用户可修改）', rules] : []),
  ].join('\n');
}

// First prompt of a delegated task; `review` makes it a read-only reviewer.
export function delegationPrompt(parent: { title: string; agent: AgentKind }, brief: string, opts?: { review?: boolean }): string {
  if (opts?.review) {
    return [
      `你是任务「${parent.title}」（${agentLabel(parent.agent)}）请来的独立评审者。只按下面「任务」里给的评审对象和角度评审。`,
      '',
      '- 只读：不修改、创建或删除项目文件，不提交，不安装依赖，不运行会改动工作区或外部状态的命令；可以读文件、搜索、运行只读检查。',
      '- 用一条回复交付：第一行写「结论：PASS」或「结论：FAIL」，然后列 BLOCKING（必须改才能继续的问题）和 NON-BLOCKING（建议）。每条写依据（文件:行号、命令输出或来源链接），没核实的标「未验证」。这条回复会自动送回主任务，不需要你自己回传。',
      '- 需要更多信息就在回复里提问并结束本轮，主任务会补充。',
      '- 不要再把任务委派或转发给其他 agent。',
      '',
      '## 任务',
      brief.trim(),
    ].join('\n');
  }
  return [
    `你是任务「${parent.title}」（${agentLabel(parent.agent)}）委派的子任务执行者。只做下面「任务」里的事。`,
    '',
    '- 完成后用一条回复交付：做了什么、改了哪些文件、跑了哪些检查和结果、还有什么没解决。这条回复会自动送回主任务验收，不需要你自己回传。',
    '- 需求不清楚时直接在回复里提问并结束本轮，主任务会补充。',
    '- 工作目录和主任务共用：只改任务范围内的文件；除非任务明确要求，不要提交、推送或发版。',
    '- 不要再把任务委派或转发给其他 agent。',
    '',
    '## 任务',
    brief.trim(),
  ].join('\n');
}

// Pasted into the main task when a delegated task finishes a round.
export function delegationResultText(child: { id: string; title: string; agent: AgentKind; round: number; mode?: 'review' }, reply: string): string {
  const h = delegationHandle(child.id);
  if (child.mode === 'review') {
    return [
      `评审者「${child.title}」（${agentLabel(child.agent)}，第 ${child.round} 轮）给出了评审结论。它是只读的，修改由你来做。`,
      '',
      '## 评审结论',
      reply.trim() || '（没有拿到这一轮的回复，请打开子任务的终端查看）',
      '',
      '## 下一步',
      '- 逐条裁决：认可的自己修改；有异议的写明依据；BLOCKING 全部解决后再继续。',
      `- 需要它复核修改或补充意见：\`shoal rework ${h} --stdin\`，写清改了什么、请它看什么`,
      `- 评审结束：\`shoal done ${h}\``,
    ].join('\n');
  }
  return [
    `委派任务「${child.title}」（${agentLabel(child.agent)}，第 ${child.round} 轮）交付了结果，请验收。`,
    '',
    '## 结果',
    reply.trim() || '（没有拿到这一轮的回复，请打开子任务的终端查看）',
    '',
    '## 下一步',
    `- 通过并关闭：\`shoal done ${h}\``,
    `- 打回返工：\`shoal rework ${h} --stdin\`，写清具体问题；小问题直接自己改`,
    `- 放弃：\`shoal cancel ${h}\``,
    '改动在同一个工作目录里，可以用 git status / git diff 查看。',
  ].join('\n');
}

// Pasted into a delegated task by `shoal rework`.
export function delegationReworkText(parent: { title: string }, round: number, feedback: string): string {
  return [
    `主任务「${parent.title}」验收没有通过，这是第 ${round} 轮。请按下面的意见修改，完成后同样用一条回复说明改动和检查结果。`,
    '',
    '## 验收意见',
    feedback.trim(),
  ].join('\n');
}

// Pasted into the main task once per round when a delegated task stops at a dialog only the user can answer.
export function delegationBlockedText(child: { title: string; agent: AgentKind }, blocked: NonNullable<SessionInfo['blocked']>): string {
  const what = blocked === 'startup' ? '启动确认' : '权限确认';
  return `委派任务「${child.title}」（${agentLabel(child.agent)}）停在${what}提示上，需要用户到它的终端里处理，你无法代为确认。请告诉用户，然后继续其他工作。这一轮里同类提示不再重复通知。`;
}

export const FORWARD_NOTE = '下面是另一个任务的结果，供你参考。';

export function forwardText(
  source: { title: string; agent: AgentKind },
  body: string,
  note?: string,
  opts?: { replyBack?: boolean },
): string {
  const base = [note?.trim() || FORWARD_NOTE, '', `## 转发自任务「${source.title}」（${agentLabel(source.agent)}）`, body.trim()].join('\n');
  if (!opts?.replyBack) return base;
  return `${base}\n\n（注：你完成本轮回复后，工作台会自动把你的结论回传给任务「${source.title}」。）`;
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

// ---- Mobile Access, Tunnel & Notifications ----
export type MobileRouteVia = 'lan' | 'tunnel' | 'local';
export type MobileTunnelState = 'stopped' | 'starting' | 'running' | 'error';
export type MobileTunnelMode = 'named' | 'quick';

export interface MobileTunnelStatus {
  state: MobileTunnelState;
  mode: MobileTunnelMode;
  pid: number | null;
  startedAt: number | null;
  connectedEdges: number;
  quickUrl?: string;
  lastError?: string;
  binaryPath: string | null;
}

export interface PairedDeviceSummary {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  via: MobileRouteVia;
  online: boolean;
}

export interface MobilePairChallengeView {
  id: string;
  status: 'waiting_scan' | 'claimed';
  pairUrl: string;
  qrUrls: { label: string; url: string }[];
  expiresAt: number;
  deviceName?: string;
  claimedIp?: string;
  attemptsLeft: number;
}

export interface MobilePairClaimResult {
  claimId: string;
  claimSecret: string;
  code: string;
  deviceName: string;
  expiresAt: number;
}

export interface MobilePairRedeemResult {
  status: 'pending' | 'approved';
  device?: PairedDeviceSummary;
}

export interface MobileConfigView {
  enabled: boolean;
  port: number;
  lanEnabled: boolean;
  keepAwake: boolean;
  publicOrigin: string;
  tunnelEnabled: boolean;
  tunnelMode: MobileTunnelMode;
  hasTunnelToken: boolean;
  cfAccessTeamDomain: string;
  cfAccessAud: string;
  feishuEnabled: boolean;
  feishuWebhookUrlMasked: string;
  hasFeishuSecret: boolean;
  quietWhenDesktopActive: boolean;
}

export interface MobileConfigPatch {
  enabled?: boolean;
  lanEnabled?: boolean;
  keepAwake?: boolean;
  publicOrigin?: string;
  tunnelEnabled?: boolean;
  tunnelMode?: MobileTunnelMode;
  tunnelToken?: string;
  cfAccessTeamDomain?: string;
  cfAccessAud?: string;
  feishuEnabled?: boolean;
  feishuWebhookUrl?: string;
  feishuSecret?: string;
  quietWhenDesktopActive?: boolean;
}

export interface MobileAdminStatus {
  config: MobileConfigView;
  listening: boolean;
  listenHost: string;
  actualPort: number | null;
  lanUrls: string[];
  powerAwake: boolean;
  tunnel: MobileTunnelStatus;
  devices: PairedDeviceSummary[];
  activePair: MobilePairChallengeView | null;
}

export type ConversationItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tools'; count: number; tools: string[] }
  | { id: string; kind: 'card'; card: Card };

export interface TaskConversationResponse {
  taskId: string;
  sessionId: string | null;
  agent: AgentKind;
  items: ConversationItem[];
  activity: SessionActivity | null;
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
  | { t: 'clis'; agents: AgentKind[]; cliTools: CliToolInfo[] }
  | { t: 'git'; projectId: string; git: GitInfo | null } // sent only when the value changed
  | { t: 'quota'; agent: AgentKind; quota: QuotaInfo } // sent only when the windows changed
  | { t: 'telemetry'; telemetry: TelemetrySummary } // sent when token usage / cache / speed changes
  | { t: 'context'; sessionId: string; context: SessionContext | null } // live session context window update
  | { t: 'activity'; sessionId: string; activity: SessionActivity | null } // live white-box execution HUD update
  | { t: 'session'; session: SessionInfo }
  | { t: 'replay'; id: string; d: string } // buffered history, sent once per running session right after snapshot, or on 'want-replay'
  | { t: 'out'; id: string; d: string }
  | { t: 'pong'; ts: number; via: MobileRouteVia }
  | { t: 'revoked' };

export type ClientMsg =
  | { t: 'in'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'watch-term'; id: string }
  | { t: 'unwatch-term' }
  | { t: 'want-replay'; id: string } // saved output of a session that is not running (answered with 'replay', d may be '')
  | { t: 'term-key'; id: string; d: string }
  | { t: 'ping'; ts: number };
