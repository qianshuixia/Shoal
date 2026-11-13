import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  AgentKind, Card, CreateTaskBody, FeedbackBody, FeedbackResult, FilePayload, ForwardBody, ForwardResult, GitInfo, Project, ResumeResult, ServerMsg, SessionInfo, Settings, Snapshot, SwitchResult, Task,
} from '../../shared/protocol.ts';
import { AGENT_LABEL, DEFAULT_SETTINGS, canResume } from '../../shared/protocol.ts';
import { connect } from './ws.ts';
import { disposeExcept, dispose, fitEntry, focusOnly, forgetSentSizes, isInspectKey, isJumpKey, isNewTaskKey, isPaneKey, isSearchKey, replay, zoomKey, setTermFileLinkHandler, setTermNotice, setTermScale, sizeOf, termFontSize, termText, writeOut } from './terms.ts';
import { Pane, SESSION_DRAG_TYPE } from './Pane.tsx';
import { Inspector, type InspectOpenRequest, type InspectorTab } from './Inspector.tsx';
import { matchProjectFileLink } from './linkParse.ts';
import { setPrivacy, usePrivacy } from './privacy.ts';
import { FeedbackDialog, ForwardDialog, ProjectDialog, SettingsDialog, SwitchDialog, TaskDialog, post } from './Dialogs.tsx';
import { EditableTitle, PencilIcon, QuotaPill, StatusTag, TelemetryPill } from './bits.tsx';
import { AgentIcon } from './agentIcons.tsx';
import { liveWindows, QUOTA_AGENTS } from './quota.ts';
import { StatsView } from './Stats.tsx';
import { TaskSearch } from './TaskSearch.tsx';

type PaneSessions = [string | null, string | null];
type LayoutMode = 1 | 2 | 'inspect';
type Dialog = 'project' | 'task' | 'switch' | 'forward' | 'feedback' | 'search' | 'settings' | null;
type SideFilter = 'active' | 'all';
type View = 'work' | 'stats';

const paneCount = (l: LayoutMode): 1 | 2 => (l === 2 ? 2 : 1);

declare global {
  interface Window {
    __wbTermText?: (sessionId: string) => string;
    __wbTermFontSize?: (sessionId: string) => number | null;
    __wbTermSize?: (sessionId: string) => { cols: number; rows: number } | null;
  }
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

const COLLAPSED_KEY = 'wb.collapsed';
const ARCHIVE_OPEN_KEY = 'wb.archiveOpen';
const FILTER_KEY = 'wb.sideFilter';
const loadFilter = (): SideFilter => (localStorage.getItem(FILTER_KEY) === 'active' ? 'active' : 'all');
function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

// Sidebar project order: ids the user arranged by dragging; projects not listed (new ones) follow in their original order.
const ORDER_KEY = 'wb.projectOrder';
const PROJECT_DRAG_TYPE = 'application/x-wb-project';
function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function sortProjects(projects: Project[], order: string[]): Project[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (p: Project) => rank.get(p.id) ?? order.length;
  return projects.map((p, i) => ({ p, i })).sort((a, b) => at(a.p) - at(b.p) || a.i - b.i).map((x) => x.p);
}

// Whole-UI zoom in percent: the root font size (all sizes are rem) and the terminal font follow it.
const SCALE_KEY = 'wb.scale';
const SCALE_MIN = 80;
const SCALE_MAX = 150;
const SCALE_STEP = 5;
function loadScale(): number {
  const v = Number(localStorage.getItem(SCALE_KEY));
  return Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX ? Math.round(v / 5) * 5 : 100;
}

// Sidebar width in rem (so it follows the zoom), dragged on its right edge; double-click resets.
const SIDE_KEY = 'wb.sideWidth';
const SIDE_DEFAULT = 17;
const SIDE_MIN = 13;
const SIDE_MAX = 32;
const clampSide = (v: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(v * 4) / 4));
function loadSide(): number {
  const v = Number(localStorage.getItem(SIDE_KEY));
  return Number.isFinite(v) && v > 0 ? clampSide(v) : SIDE_DEFAULT;
}

// Right Inspector width share in percent of the main work area (28%..68%), double-click resets to 50%.
const INSPECT_SPLIT_KEY = 'wb.inspectSplit';
const INSPECT_SPLIT_DEFAULT = 50;
const INSPECT_SPLIT_MIN = 28;
const INSPECT_SPLIT_MAX = 68;
const clampInspectSplit = (v: number) => Math.min(INSPECT_SPLIT_MAX, Math.max(INSPECT_SPLIT_MIN, Math.round(v * 2) / 2));
function loadInspectSplit(): number {
  const v = Number(localStorage.getItem(INSPECT_SPLIT_KEY));
  return Number.isFinite(v) && v > 0 ? clampInspectSplit(v) : INSPECT_SPLIT_DEFAULT;
}

// Sessions that want the user, oldest first: asked a question (需要你, task still active) / finished a task (待验收).
const needsList = (d: Snapshot): string[] => {
  const phase = new Map(d.tasks.map((t) => [t.id, t.phase]));
  return d.sessions
    .filter((s) => s.status === 'needs_you' && phase.get(s.taskId) === 'active')
    .sort((a, b) => a.statusSince - b.statusSince)
    .map((s) => s.id);
};
const reviewList = (d: Snapshot): string[] => {
  const ids = new Set(d.sessions.map((s) => s.id));
  return d.tasks
    .filter((t) => t.phase === 'review' && t.sessionId && ids.has(t.sessionId))
    .sort((a, b) => a.phaseSince - b.phaseSince)
    .map((t) => t.sessionId!);
};

// The agent last used in the project, so quick-create repeats what you just did.
function defaultAgentFor(d: Snapshot, projectId: string): AgentKind {
  const agents = d.agents as AgentKind[];
  const last = d.tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && agents.includes(last.agent)) return last.agent;
  return agents.includes('claude') ? 'claude' : (agents[0] ?? 'claude');
}

export function App() {
  const [data, setData] = useState<Snapshot>({ projects: [], tasks: [], sessions: [], cards: [], agents: [], settings: DEFAULT_SETTINGS, git: {}, quota: {} });
  const [panes, setPanes] = useState<PaneSessions>([null, null]);
  const [focusedPane, setFocusedPane] = useState(0);
  const [layout, setLayout] = useState<LayoutMode>(1);
  const [inspectSplit, setInspectSplit] = useState(loadInspectSplit);
  const [pinnedInspectProjectId, setPinnedInspectProjectId] = useState<string | null>(null);
  const [inspectReq, setInspectReq] = useState<InspectOpenRequest | null>(null);
  const [inspectWatchRev, setInspectWatchRev] = useState(0);
  const inspectSeqRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogTarget, setDialogTarget] = useState(''); // task id (switch) or card id (forward) the open dialog is about
  const [now, setNow] = useState(Date.now());
  const [focusTick, setFocusTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>('work');
  const [scale, setScale] = useState(loadScale);
  const zoomBy = (dir: 1 | -1) => setScale((v) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, v + dir * SCALE_STEP)));
  const privacy = usePrivacy();
  const [order, setOrder] = useState(loadOrder);
  const [sideW, setSideW] = useState(loadSide);
  const [filter, setFilter] = useState<SideFilter>(loadFilter);
  const [archiveOpen, setArchiveOpen] = useState(() => localStorage.getItem(ARCHIVE_OPEN_KEY) === '1');

  // Latest state for handlers registered once (WebSocket, window listeners).
  const live = useRef({ data, panes, focusedPane, layout, dialog });
  live.current = { data, panes, focusedPane, layout, dialog };

  const sessionsById = new Map(data.sessions.map((s) => [s.id, s]));
  const tasksById = new Map(data.tasks.map((t) => [t.id, t]));
  const projectsById = new Map(data.projects.map((p) => [p.id, p]));

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(SIDE_KEY, String(sideW));
  }, [sideW]);

  useEffect(() => {
    localStorage.setItem(INSPECT_SPLIT_KEY, String(inspectSplit));
  }, [inspectSplit]);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, filter);
  }, [filter]);

  useEffect(() => {
    localStorage.setItem(ARCHIVE_OPEN_KEY, archiveOpen ? '1' : '0');
  }, [archiveOpen]);

  useLayoutEffect(() => {
    document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
    setTermScale(scale / 100);
    localStorage.setItem(SCALE_KEY, String(scale));
  }, [scale]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // No pane given (sidebar click, jumps): a session already on screen just gets the focus, nothing moves.
  // A given pane (drag and drop) takes the session, swapping with the other pane if it showed it.
  const showSession = useCallback((id: string, pane?: number) => {
    const s = live.current;
    const count = paneCount(s.layout);
    const shown = s.panes.slice(0, count).indexOf(id);
    const target = pane ?? (shown !== -1 ? shown : count === 2 ? s.focusedPane : 0);
    setPanes((p) => {
      const next: PaneSessions = [...p];
      const other = 1 - target;
      if (next[other] === id) next[other] = next[target]; // never the same session in two panes
      next[target] = id;
      return next;
    });
    setFocusedPane(target);
    setPinnedInspectProjectId(null);
    setView('work');
    setFocusTick((n) => n + 1);
    // Reveal the row if its project is folded.
    const { data: d } = live.current;
    const projectId = d.tasks.find((t) => t.id === d.sessions.find((s) => s.id === id)?.taskId)?.projectId;
    if (projectId) setCollapsed((c) => (c.has(projectId) ? new Set([...c].filter((x) => x !== projectId)) : c));
  }, []);

  const needsYou = needsList(data);
  const reviewing = reviewList(data);
  // "(3) Shoal" in the tab / taskbar; the desktop shell also flashes the taskbar button when the number grows.
  const waitingCount = needsYou.length + reviewing.length;
  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) Shoal` : 'Shoal';
  }, [waitingCount]);

  // Opens the next session of the list after the focused one (the first if the focused one is not in it).
  const cycle = useCallback((pick: (d: Snapshot) => string[]) => {
    const { data: d, panes: p, focusedPane: f } = live.current;
    const list = pick(d);
    if (!list.length) return;
    const i = list.indexOf(p[f] ?? '');
    showSession(list[i === -1 ? 0 : (i + 1) % list.length]);
  }, [showSession]);
  const jumpNeeds = useCallback(() => cycle(needsList), [cycle]);
  const jumpReview = useCallback(() => cycle(reviewList), [cycle]);
  const jump = useCallback(() => cycle((d) => [...needsList(d), ...reviewList(d)]), [cycle]);

  const addCreated = useCallback(({ task, session }: { task: Task; session: SessionInfo }) => {
    setData((d) => ({ ...d, tasks: upsert(d.tasks, task), sessions: upsert(d.sessions, session) }));
    showSession(session.id);
  }, [showSession]);

  const focusedSessionOf = (s: typeof live.current) => s.panes[s.layout === 2 ? s.focusedPane : 0];

  // One click / one key: new task in the project, title filled in later from the first prompt.
  const quickCreate = useCallback(async (projectId: string, agent: AgentKind) => {
    const body: CreateTaskBody = { projectId, agent, ...(sizeOf(focusedSessionOf(live.current)) ?? { cols: 120, rows: 36 }) };
    try {
      addCreated(await post<{ task: Task; session: SessionInfo }>('/api/tasks', body));
    } catch (e) {
      setNotice(`新建任务失败：${(e as Error).message}`);
    }
  }, [addCreated]);

  const removeTaskLocal = useCallback((taskId: string) => {
    const gone = live.current.data.sessions.filter((s) => s.taskId === taskId).map((s) => s.id);
    gone.forEach(dispose);
    setData((d) => ({
      ...d,
      tasks: d.tasks.filter((t) => t.id !== taskId),
      sessions: d.sessions.filter((s) => s.taskId !== taskId),
      cards: d.cards.filter((c) => c.taskId !== taskId),
    }));
    setPanes((p) => [gone.includes(p[0] ?? '') ? null : p[0], gone.includes(p[1] ?? '') ? null : p[1]]);
  }, []);

  // The server already sent task-removed for each task; sweep any leftovers to be safe.
  const removeProjectLocal = useCallback((projectId: string) => {
    live.current.data.tasks.filter((t) => t.projectId === projectId).forEach((t) => removeTaskLocal(t.id));
    setData((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== projectId) }));
    setCollapsed((c) => (c.has(projectId) ? new Set([...c].filter((x) => x !== projectId)) : c));
  }, [removeTaskLocal]);

  const onMsg = useCallback((msg: ServerMsg) => {
    switch (msg.t) {
      case 'snapshot': {
        const ids = new Set(msg.state.sessions.map((s) => s.id));
        disposeExcept(ids);
        setData(msg.state);
        setPanes((p) => {
          const next: PaneSessions = [p[0] && ids.has(p[0]) ? p[0] : null, p[1] && ids.has(p[1]) ? p[1] : null];
          if (!next[0] && !next[1]) {
            const latest = msg.state.sessions.filter((s) => s.status !== 'exited').sort((a, b) => b.startedAt - a.startedAt)[0];
            if (latest) next[live.current.layout === 2 ? live.current.focusedPane : 0] = latest.id;
          }
          return next;
        });
        setFocusTick((n) => n + 1);
        break;
      }
      case 'project':
        setData((d) => ({ ...d, projects: upsert(d.projects, msg.project) }));
        break;
      case 'task':
        setData((d) => ({ ...d, tasks: upsert(d.tasks, msg.task) }));
        setInspectWatchRev((n) => n + 1);
        break;
      case 'task-removed':
        removeTaskLocal(msg.id);
        break;
      case 'project-removed':
        removeProjectLocal(msg.id);
        break;
      case 'settings':
        setData((d) => ({ ...d, settings: msg.settings }));
        break;
      case 'git':
        setData((d) => ({ ...d, git: { ...d.git, [msg.projectId]: msg.git } }));
        setInspectWatchRev((n) => n + 1);
        break;
      case 'quota':
        setData((d) => ({ ...d, quota: { ...d.quota, [msg.agent]: msg.quota } }));
        break;
      case 'telemetry':
        setData((d) => ({ ...d, telemetry: msg.telemetry }));
        break;
      case 'card':
        setData((d) => ({ ...d, cards: upsert(d.cards, msg.card) }));
        break;
      case 'session':
        setData((d) => ({ ...d, sessions: upsert(d.sessions, msg.session) }));
        break;
      case 'replay':
        replay(msg.id, msg.d);
        break;
      case 'out':
        writeOut(msg.id, msg.d);
        break;
    }
  }, [removeTaskLocal, removeProjectLocal]);

  useEffect(
    () =>
      connect({
        onMsg,
        onOpen: () => {
          setConnected(true);
          forgetSentSizes();
          live.current.panes.forEach((id) => id && fitEntry(id));
        },
        onClose: () => setConnected(false),
      }),
    [onMsg],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const switchLayout = useCallback((next: LayoutMode, focusTerminal = true) => {
    const s = live.current;
    if (s.layout === 2 && next !== 2) {
      setPanes([s.panes[s.focusedPane], null]);
      setFocusedPane(0);
    }
    setLayout(next);
    if (focusTerminal) setFocusTick((n) => n + 1);
  }, []);

  const openInspectorAt = useCallback((projectId: string, tab: InspectorTab, filePath?: string, line?: number, col?: number) => {
    setView('work');
    setPinnedInspectProjectId(projectId);
    switchLayout('inspect', !line);
    const seq = ++inspectSeqRef.current;
    setInspectReq({ projectId, tab, filePath, line, col, seq });
  }, [switchLayout]);

  useEffect(() => {
    window.__wbTermText = termText;
    window.__wbTermFontSize = termFontSize;
    window.__wbTermSize = sizeOf;
    setTermNotice(setNotice);
    setTermFileLinkHandler(async (uri: string) => {
      const match = matchProjectFileLink(uri, live.current.data.projects);
      if (!match) return false;
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(match.project.id)}/file?path=${encodeURIComponent(match.relPosix)}&stat=1`);
        if (!res.ok) return false;
        const stat = (await res.json()) as FilePayload;
        if (stat.kind !== 'text' && stat.kind !== 'image') return false;
        openInspectorAt(match.project.id, 'files', match.relPosix, match.line, match.col);
        return true;
      } catch {
        return false;
      }
    });
    const onKey = (e: KeyboardEvent) => {
      const zoom = zoomKey(e);
      const inTerm = e.target instanceof Element && !!e.target.closest('.xterm');
      if (zoom !== null && !(zoom === -1 && inTerm)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'keydown') zoom ? zoomBy(zoom) : setScale(100);
        return;
      }
      const paneKey = isPaneKey(e);
      const isSearch = isSearchKey(e);
      const isJump = isJumpKey(e);
      const isNew = isNewTaskKey(e);
      const isInspect = isInspectKey(e);
      if (paneKey === null && !isSearch && !isJump && !isNew && !isInspect) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type !== 'keydown' || e.repeat) return;
      if (isInspect) {
        const s = live.current;
        if (!s.dialog) {
          setView('work');
          switchLayout(s.layout === 'inspect' ? 1 : 'inspect');
        }
        return;
      }
      if (paneKey !== null) {
        const s = live.current;
        if (s.layout === 2 && !s.dialog) {
          setFocusedPane(paneKey);
          setFocusTick((n) => n + 1);
        }
        return;
      }
      if (isSearch) {
        const s = live.current;
        if (s.dialog === 'search') setDialog(null);
        else if (!s.dialog) setDialog('search');
        return;
      }
      if (isJump) return jump();
      const s = live.current;
      if (s.dialog) return;
      const sid = focusedSessionOf(s);
      const projectId = s.data.tasks.find((t) => t.id === s.data.sessions.find((x) => x.id === sid)?.taskId)?.projectId
        ?? s.data.projects[0]?.id;
      if (projectId) void quickCreate(projectId, defaultAgentFor(s.data, projectId));
    };
    window.addEventListener('keydown', onKey, true);
    // Ctrl+wheel zooms the whole UI anywhere, terminals included (they never see it).
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    const onUnload = (e: BeforeUnloadEvent) => {
      if (live.current.data.sessions.some((s) => s.status !== 'exited')) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      setTermFileLinkHandler(null);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [jump, quickCreate, switchLayout, openInspectorAt]);

  // Focus after Pane attaches its terminal, before the browser paints the new session.
  useLayoutEffect(() => {
    if (dialog) return;
    focusOnly(view === 'work' ? panes[layout === 2 ? focusedPane : 0] : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, focusedPane, dialog, focusTick, view]);

  // Hidden terminals skip fitting; refit once the workbench is shown again (the zoom may have changed meanwhile).
  useEffect(() => {
    if (view !== 'work') return;
    const raf = requestAnimationFrame(() => live.current.panes.forEach((id) => id && fitEntry(id)));
    return () => cancelAnimationFrame(raf);
  }, [view]);

  // ×: an archived task is deleted for good; any other is archived and its session process ended (resumable after 恢复).
  const removeTask = async (task: Task) => {
    if (task.phase !== 'archived') {
      const status = task.sessionId ? live.current.data.sessions.find((s) => s.id === task.sessionId)?.status : undefined;
      if (status === 'working' && !confirm(`「${task.title}」还在工作，归档会结束会话进程。确定归档吗？`)) return;
      return setPhase(task, 'archive');
    }
    if (!confirm(`永久删除任务「${task.title}」？结果卡片和反馈记录会一起删除。`)) return;
    const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    if (res.ok) removeTaskLocal(task.id);
    else setNotice(`删除失败 (${res.status})`);
  };

  const removeProject = async (project: Project) => {
    const { tasks, sessions } = live.current.data;
    const mine = tasks.filter((t) => t.projectId === project.id);
    const ids = new Set(mine.map((t) => t.id));
    const running = sessions.filter((s) => ids.has(s.taskId) && s.status !== 'exited').length;
    const ok = confirm(
      `从工作台移除项目「${project.name}」？\n其中 ${mine.length} 个任务会一起移除${running ? `，${running} 个正在运行的会话会被结束` : ''}。\n项目目录、对话记录和 Token 统计不会删除；之后可以用「新建项目」重新添加。`,
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      if (res.ok) removeProjectLocal(project.id);
      else setNotice(`移除失败 (${res.status})`);
    } catch {
      setNotice('移除失败 (网络错误)');
    }
  };

  const renameTask = async (task: Task, title: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const json = (await res.json().catch(() => ({}))) as Task & { error?: string };
    if (res.ok) setData((d) => ({ ...d, tasks: upsert(d.tasks, json) }));
    else setNotice(json.error ?? `重命名失败 (${res.status})`);
  };

  // New session for an exited task, reopening its last conversation unless fresh; it takes the old session's pane.
  const resumeTask = async (task: Task, fresh = false) => {
    const s = live.current;
    const old = task.sessionId;
    const pane = old ? s.panes.slice(0, paneCount(s.layout)).indexOf(old) : -1;
    const size = sizeOf(old) ?? sizeOf(focusedSessionOf(s)) ?? { cols: 120, rows: 36 };
    try {
      const r = await post<ResumeResult>(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { fresh, ...size });
      // The server drops the replaced session; do the same here.
      setData((d) => ({ ...d, tasks: upsert(d.tasks, r.task), sessions: upsert(d.sessions.filter((x) => x.id !== old), r.session) }));
      showSession(r.session.id, pane === -1 ? undefined : pane);
      if (old) dispose(old);
    } catch (e) {
      if ((e as { code?: string }).code === 'no-conversation') {
        if (confirm(`任务「${task.title}」上次的会话找不到可续接的对话记录。\n新开会话会替换面板里这个会话的终端内容。\n要新开会话吗？`)) void resumeTask(task, true);
        return;
      }
      setNotice(`续接失败：${(e as Error).message}`);
    }
  };

  const setPhase = async (task: Task, action: 'approve' | 'archive' | 'unarchive') => {
    try {
      const t = await post<Task>(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {});
      setData((d) => ({ ...d, tasks: upsert(d.tasks, t) }));
    } catch (e) {
      setNotice(`${{ approve: '通过', archive: '归档', unarchive: '恢复' }[action]}失败：${(e as Error).message}`);
    }
  };

  // Search palette result: archived tasks are restored first, then the session is shown like a sidebar click.
  const openFound = async (task: Task) => {
    setDialog(null);
    setFocusTick((n) => n + 1);
    if (task.phase === 'archived') await setPhase(task, 'unarchive');
    if (task.sessionId) showSession(task.sessionId);
    else setNotice(`任务「${task.title}」没有会话`);
  };

  // Feedback on a finished task. A new session takes the old one's pane, like resume; true = sent.
  const sendFeedback = async (task: Task, text: string, mode: FeedbackBody['mode']): Promise<boolean> => {
    const s = live.current;
    const old = task.sessionId;
    const pane = old ? s.panes.slice(0, paneCount(s.layout)).indexOf(old) : -1;
    const size = sizeOf(old) ?? sizeOf(focusedSessionOf(s)) ?? { cols: 120, rows: 36 };
    try {
      const r = await post<FeedbackResult>(`/api/tasks/${encodeURIComponent(task.id)}/feedback`, { text, mode, ...size });
      const replaced = !!old && r.session.id !== old;
      setData((d) => ({
        ...d,
        tasks: upsert(d.tasks, r.task),
        sessions: upsert(replaced ? d.sessions.filter((x) => x.id !== old) : d.sessions, r.session),
        cards: upsert(d.cards, r.card),
      }));
      if (r.session.id !== old) {
        showSession(r.session.id, pane === -1 ? undefined : pane);
        if (old) dispose(old);
      }
      return true;
    } catch (e) {
      setNotice(`反馈失败：${(e as Error).message}`);
      return false;
    }
  };

  // Replaces the task's session with one on another agent, in the same pane. Throws so the dialog can show the error.
  const switchAgent = async (task: Task, agent: AgentKind, note: string) => {
    const s = live.current;
    const old = task.sessionId;
    const pane = old ? s.panes.slice(0, paneCount(s.layout)).indexOf(old) : -1;
    const size = sizeOf(old) ?? sizeOf(focusedSessionOf(s)) ?? { cols: 120, rows: 36 };
    const r = await post<SwitchResult>(`/api/tasks/${encodeURIComponent(task.id)}/switch`, { agent, note: note || undefined, ...size });
    setData((d) => ({
      ...d,
      tasks: upsert(d.tasks, r.task),
      sessions: upsert(d.sessions.filter((x) => x.id !== old), r.session),
      cards: upsert(d.cards, r.card),
    }));
    showSession(r.session.id, pane === -1 ? undefined : pane);
    if (old) dispose(old);
    setDialog(null);
    if (!r.generated) setNotice('交接卡片自动整理失败，已按记录摘录');
  };

  // Sends a card to another task (queued if it is busy) or to a new one. Throws so the dialog can show the error.
  const forward = async (card: Card, to: ForwardBody['to'], note: string) => {
    const s = live.current;
    const target = 'taskId' in to ? s.data.tasks.find((t) => t.id === to.taskId) : undefined;
    const old = target?.sessionId ?? null;
    const pane = old ? s.panes.slice(0, paneCount(s.layout)).indexOf(old) : -1;
    const size = sizeOf(old) ?? sizeOf(focusedSessionOf(s)) ?? { cols: 120, rows: 36 };
    const r = await post<ForwardResult>(`/api/cards/${encodeURIComponent(card.id)}/forward`, { to, note: note || undefined, ...size });
    const replaced = !!old && r.session.id !== old;
    setData((d) => ({
      ...d,
      tasks: upsert(d.tasks, r.task),
      sessions: upsert(replaced ? d.sessions.filter((x) => x.id !== old) : d.sessions, r.session),
      cards: upsert(d.cards, r.card),
    }));
    if (replaced) {
      if (pane !== -1) showSession(r.session.id, pane);
      dispose(old);
    }
    setDialog(null);
    const waiting = !!r.session.queued && r.session.status === 'working';
    setNotice(!target ? `已转发到新任务「${r.task.title}」`
      : waiting ? `已转发到「${r.task.title}」，它还在工作，消息排队中，空闲后自动发送`
      : `已转发到「${r.task.title}」`);
  };

  const toggleProject = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const focusedSessionId = panes[layout === 2 ? focusedPane : 0];
  const focusedTaskId = focusedSessionId ? sessionsById.get(focusedSessionId)?.taskId : undefined;
  const focusedProjectId = focusedTaskId ? tasksById.get(focusedTaskId)?.projectId : undefined;
  const visibleIds = panes.slice(0, paneCount(layout));
  const sortedProjects = sortProjects(data.projects, order);
  const activeInspectProject = (pinnedInspectProjectId ? projectsById.get(pinnedInspectProjectId) : undefined)
    ?? (focusedProjectId ? projectsById.get(focusedProjectId) : undefined)
    ?? sortedProjects[0];
  // Moves one project next to another; the saved order is the full current list, so deleted ids drop out.
  const reorderProject = (dragged: string, target: string, after: boolean) => {
    if (dragged === target) return;
    const ids = sortedProjects.map((p) => p.id).filter((id) => id !== dragged);
    const i = ids.indexOf(target);
    if (i === -1 || !sortedProjects.some((p) => p.id === dragged)) return;
    ids.splice(after ? i + 1 : i, 0, dragged);
    setOrder(ids);
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  };
  const forwardCard = dialog === 'forward' ? data.cards.find((c) => c.id === dialogTarget) : undefined;
  const forwardSource = forwardCard ? tasksById.get(forwardCard.taskId) : undefined;

  return (
    <div className={`app ${privacy ? 'privacy' : ''}`} style={{ '--side-w': `${sideW}rem` } as CSSProperties}>
      {!connected && <div className="banner" data-testid="conn-banner">连接断开，正在重连…</div>}
      {connected && notice && <div className="banner" data-testid="notice" onClick={() => setNotice('')}>{notice}</div>}
      <header className="topbar">
        <span className="app-name">Shoal</span>
        <span className="view-tabs" role="tablist" aria-label="视图">
          <button role="tab" aria-selected={view === 'work'} className={`view-tab ${view === 'work' ? 'on' : ''}`} data-testid="tab-work" onClick={() => setView('work')}>
            工作台
          </button>
          <button role="tab" aria-selected={view === 'stats'} className={`view-tab ${view === 'stats' ? 'on' : ''}`} data-testid="tab-stats" onClick={() => setView('stats')}>
            Token 统计
          </button>
        </span>
        <button
          className={`needs ${needsYou.length ? 'on' : ''}`}
          data-testid="needs-you"
          disabled={!needsYou.length}
          title="跳到等你最久的会话。Alt+` 在“需要你”和“待验收”里依次跳"
          onClick={jumpNeeds}
        >
          <span className="needs-dot" />需要你 <span data-testid="needs-you-count">{needsYou.length}</span>
        </button>
        <button
          className={`needs review ${reviewing.length ? 'on' : ''}`}
          data-testid="review-queue"
          disabled={!reviewing.length}
          title="跳到等你验收最久的任务。Alt+` 在“需要你”和“待验收”里依次跳"
          onClick={jumpReview}
        >
          <span className="needs-dot" />待验收 <span data-testid="review-count">{reviewing.length}</span>
        </button>
        {QUOTA_AGENTS.map((a) => {
          const q = data.quota[a];
          const ws = liveWindows(q, now);
          if (!q || !ws.length) return null;
          return <QuotaPill key={a} agent={a} quota={q} windows={ws} now={now} />;
        })}
        {data.telemetry?.today && (
          <TelemetryPill
            counts={data.telemetry.today}
            tps={(focusedTaskId ? data.telemetry.byTask[focusedTaskId]?.tps : null) ?? data.telemetry.today.tps}
            label="今日用量统计（点击查看详情）"
            testId="top-telemetry"
            onClick={() => setView(view === 'stats' ? 'work' : 'stats')}
          />
        )}
        <div className="top-right">
          {/* Stepper, not a slider: the slider's rem width changed under the cursor while dragging. */}
          <div className="zoom" title="界面缩放，每次 5%：Ctrl+滚轮、Ctrl+= / Ctrl+-（终端里的 Ctrl+- 留给 CLI），Ctrl+0 恢复 100%；也可以点 −/+" onWheel={(e) => e.deltaY && zoomBy(e.deltaY < 0 ? 1 : -1)}>
            <button className="ghost zoom-step" data-testid="zoom-out" aria-label="缩小" disabled={scale <= SCALE_MIN} onClick={() => zoomBy(-1)}>−</button>
            <button className="ghost zoom-val" data-testid="zoom-value" aria-label="恢复 100%" onClick={() => setScale(100)}>{scale}%</button>
            <button className="ghost zoom-step" data-testid="zoom-in" aria-label="放大" disabled={scale >= SCALE_MAX} onClick={() => zoomBy(1)}>+</button>
          </div>
          <button
            className={`ghost privacy-btn ${privacy ? 'on' : ''}`}
            data-testid="privacy-toggle"
            aria-pressed={privacy}
            title="隐私模式：给项目名、任务标题、路径和摘要打码，方便截图分享"
            onClick={() => setPrivacy(!privacy)}
          >隐私</button>
          <span className="seg" role="radiogroup" aria-label="布局">
            {([
              [1, '单屏', '单屏'],
              [2, '双屏', '双屏：左右两屏，点屏幕或 Alt+1 / Alt+2 切换左右屏'],
              ['inspect', '文件', '变更与文件面板（Alt+E）：右侧审阅 Git 改动、浏览与编辑项目文件'],
            ] as const).map(([m, label, tip]) => (
              <button
                key={String(m)}
                role="radio"
                aria-checked={layout === m}
                className={`ghost seg-btn ${layout === m ? 'on' : ''}`}
                data-testid={`layout-${m}`}
                disabled={view !== 'work'}
                title={tip}
                onClick={() => layout !== m && switchLayout(m)}
              >
                <span className={`layout-icon l${m}`} />{label}
              </button>
            ))}
          </span>
          <button className="icon-btn" data-testid="settings-btn" aria-label="设置" title="设置" onClick={() => setDialog('settings')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2.5M7.5 11.5H14" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" />
            </svg>
          </button>
        </div>
      </header>
      <aside className="sidebar" hidden={view !== 'work'}>
        <div
          className="side-resizer"
          data-testid="side-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={sideW}
          title="拖动调整侧边栏宽度，双击恢复默认"
          onDoubleClick={() => setSideW(SIDE_DEFAULT)}
          onPointerDown={(e) => {
            e.preventDefault();
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const left = el.parentElement!.getBoundingClientRect().left;
            const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const move = (ev: PointerEvent) => setSideW(clampSide((ev.clientX - left) / remPx));
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
              el.removeEventListener('pointercancel', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
          }}
        />
        <div className="side-head">
          {/* The filter takes the place of the old 项目 label: the head was too crowded for both. */}
          <span className="seg side-filter" role="radiogroup" aria-label="任务筛选">
            {([['active', '活跃'], ['all', '全部']] as const).map(([k, label]) => (
              <button
                key={k}
                role="radio"
                aria-checked={filter === k}
                className={`ghost seg-btn ${filter === k ? 'on' : ''}`}
                data-testid={`filter-${k}`}
                title={k === 'active' ? '隐藏已退出的任务（待验收的保留）' : '显示所有任务'}
                onClick={() => setFilter(k)}
              >{label}</button>
            ))}
          </span>
          <button className="icon-btn" data-testid="search-btn" aria-label="搜索任务" title="搜索任务（Alt+K）" onClick={() => setDialog('search')}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5" /></svg>
          </button>
          <button className="ghost" data-testid="new-project-btn" onClick={() => setDialog('project')}>新建项目</button>
          <button className="ghost" data-testid="new-task-btn" title="新建任务（Alt+N：在当前项目用上次的 agent 直接新建）" disabled={!data.projects.length} onClick={() => setDialog('task')}>新建任务</button>
        </div>
        <div className="side-list">
          {!data.projects.length && (
            <div className="side-empty">
              还没有项目。<button className="link" onClick={() => setDialog('project')}>选一个目录</button>开始。
            </div>
          )}
          {sortedProjects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              tasks={data.tasks.filter((t) => t.projectId === project.id && t.phase !== 'archived').sort((a, b) => a.createdAt - b.createdAt)}
              sessionsById={sessionsById}
              visibleIds={visibleIds}
              focusedId={focusedSessionId}
              now={now}
              filter={filter}
              onShowAll={() => setFilter('all')}
              collapsed={collapsed.has(project.id)}
              agents={data.agents as AgentKind[]}
              defaultAgent={defaultAgentFor(data, project.id)}
              git={data.git[project.id] ?? null}
              onInspectChanges={() => openInspectorAt(project.id, 'changes')}
              onToggle={() => toggleProject(project.id)}
              onReorder={reorderProject}
              onQuick={(agent) => void quickCreate(project.id, agent)}
              onOpen={(id) => showSession(id)}
              onRemove={removeTask}
              onRemoveProject={() => void removeProject(project)}
              onRename={renameTask}
              onResume={(task) => void resumeTask(task)}
            />
          ))}
          <ArchiveSection
            projects={sortedProjects}
            tasks={data.tasks.filter((t) => t.phase === 'archived')}
            sessionsById={sessionsById}
            visibleIds={visibleIds}
            focusedId={focusedSessionId}
            now={now}
            open={archiveOpen}
            onToggle={() => setArchiveOpen((v) => !v)}
            onOpen={(id) => showSession(id)}
            onRemove={removeTask}
            onRename={renameTask}
            onUnarchive={(task) => void setPhase(task, 'unarchive')}
          />
        </div>
      </aside>
      <main
        className={`main layout-${layout}`}
        style={layout === 'inspect' ? ({ '--inspect-w': `${inspectSplit}%` } as CSSProperties) : undefined}
        hidden={view !== 'work'}
      >
        {([0, 1] as const).slice(0, paneCount(layout)).map((i) => {
          const id = panes[i];
          const session = id ? sessionsById.get(id) : undefined;
          const task = session ? tasksById.get(session.taskId) : undefined;
          const paneAgent = task?.agent ?? session?.agent;
          const card = task ? data.cards.filter((c) => c.taskId === task.id && c.kind === 'result').at(-1) : undefined;
          return (
            <Pane
              key={i}
              index={i}
              sessionId={id}
              session={session}
              task={task}
              project={task ? projectsById.get(task.projectId) : undefined}
              focused={layout === 2 && focusedPane === i}
              dual={layout === 2}
              now={now}
              quota={paneAgent ? data.quota[paneAgent] : undefined}
              metrics={task ? data.telemetry?.byTask[task.id] : undefined}
              onFocus={() => {
                if (layout === 2 && focusedPane !== i) setFocusedPane(i);
                else if (layout === 'inspect') setFocusTick((n) => n + 1);
              }}
              onRename={(title) => task && renameTask(task, title)}
              onResume={(fresh) => task && void resumeTask(task, fresh)}
              card={card}
              onApprove={() => task && void setPhase(task, 'approve')}
              onFeedback={() => {
                if (!task) return;
                setDialogTarget(task.id);
                setDialog('feedback');
              }}
              onSwitch={() => {
                if (!task) return;
                setDialogTarget(task.id);
                setDialog('switch');
              }}
              onForward={() => {
                if (!card) return;
                setDialogTarget(card.id);
                setDialog('forward');
              }}
              handoff={task ? data.cards.filter((c) => c.taskId === task.id && c.kind === 'handoff').at(-1) : undefined}
              onDropSession={layout === 2 ? (sid) => showSession(sid, i) : undefined}
            />
          );
        })}
        {layout === 'inspect' && (
          <>
            <div
              className="inspect-resizer"
              data-testid="inspect-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={inspectSplit}
              title="拖动调整变更/文件面板宽度，双击恢复对半"
              onDoubleClick={() => setInspectSplit(INSPECT_SPLIT_DEFAULT)}
              onPointerDown={(e) => {
                e.preventDefault();
                const el = e.currentTarget;
                el.setPointerCapture(e.pointerId);
                const mainRect = el.parentElement!.getBoundingClientRect();
                const move = (ev: PointerEvent) => {
                  const pct = ((mainRect.right - ev.clientX) / mainRect.width) * 100;
                  setInspectSplit(clampInspectSplit(pct));
                };
                const up = () => {
                  el.removeEventListener('pointermove', move);
                  el.removeEventListener('pointerup', up);
                  el.removeEventListener('pointercancel', up);
                };
                el.addEventListener('pointermove', move);
                el.addEventListener('pointerup', up);
                el.addEventListener('pointercancel', up);
              }}
            />
            <Inspector
              project={activeInspectProject}
              projects={sortedProjects}
              git={activeInspectProject ? (data.git[activeInspectProject.id] ?? null) : null}
              watchRev={inspectWatchRev}
              openRequest={inspectReq}
              onSelectProject={(pid) => setPinnedInspectProjectId(pid)}
              onClose={() => switchLayout(1)}
              onNotice={setNotice}
            />
          </>
        )}
      </main>
      <StatsView visible={view === 'stats'} />
      {dialog === 'project' && (
        <ProjectDialog
          onClose={() => setDialog(null)}
          onCreated={(p: Project) => {
            setData((d) => ({ ...d, projects: upsert(d.projects, p) }));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'task' && (
        <TaskDialog
          projects={sortedProjects}
          agents={data.agents as AgentKind[]}
          defaultProjectId={focusedProjectId ?? data.projects[0]?.id ?? ''}
          defaultAgent={(pid) => defaultAgentFor(data, pid)}
          size={sizeOf(focusedSessionId) ?? { cols: 120, rows: 36 }}
          onClose={() => setDialog(null)}
          onCreated={(r) => {
            setDialog(null);
            addCreated(r);
          }}
        />
      )}
      {dialog === 'search' && (
        <TaskSearch
          tasks={data.tasks}
          projects={sortedProjects}
          sessionsById={sessionsById}
          onPick={(t) => void openFound(t)}
          onClose={() => {
            setDialog(null);
            setFocusTick((n) => n + 1);
          }}
        />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          settings={data.settings}
          onClose={() => {
            setDialog(null);
            setFocusTick((n) => n + 1);
          }}
        />
      )}
      {dialog === 'switch' && tasksById.get(dialogTarget) && (
        <SwitchDialog
          task={tasksById.get(dialogTarget)!}
          agents={data.agents as AgentKind[]}
          onClose={() => setDialog(null)}
          onSwitch={(agent, note) => switchAgent(tasksById.get(dialogTarget)!, agent, note)}
        />
      )}
      {dialog === 'forward' && forwardCard && forwardSource && (
        <ForwardDialog
          source={forwardSource}
          card={forwardCard}
          sourceAgent={sessionsById.get(forwardCard.sessionId)?.agent ?? forwardSource.agent}
          projects={data.projects}
          tasks={data.tasks}
          agents={data.agents as AgentKind[]}
          onClose={() => setDialog(null)}
          onForward={(to, note) => forward(forwardCard, to, note)}
        />
      )}
      {dialog === 'feedback' && tasksById.get(dialogTarget) && (
        <FeedbackDialog
          task={tasksById.get(dialogTarget)!}
          onClose={() => {
            setDialog(null);
            setFocusTick((n) => n + 1);
          }}
          onFeedback={(text) => sendFeedback(tasksById.get(dialogTarget)!, text, 'new')}
        />
      )}
    </div>
  );
}

// Long branch names keep their head and tail: feature prefixes and ticket suffixes are the parts that tell them apart.
const middleCut = (s: string, max = 22) => {
  const cps = [...s];
  return cps.length > max ? cps.slice(0, 10).join('') + '…' + cps.slice(-10).join('') : s;
};

function BranchChip({ git, onInspect }: { git: GitInfo; onInspect?: () => void }) {
  const title = git.detached
    ? `游离 HEAD ${git.branch}${git.dirty ? `，${git.dirty} 个文件有未提交的改动` : ''}`
    : `分支 ${git.branch}${git.dirty ? `，${git.dirty} 个文件有未提交的改动` : ''}`;
  return (
    <button
      type="button"
      className="group-branch"
      data-testid="project-branch"
      data-private=""
      title={title}
      onClick={onInspect}
    >
      <span className="branch-name">{middleCut(git.branch)}</span>
      {git.dirty > 0 && <span className="branch-dirty" data-testid="project-dirty">· {git.dirty}</span>}
    </button>
  );
}

function ProjectGroup({ project, tasks, sessionsById, visibleIds, focusedId, now, filter, onShowAll, collapsed, agents, defaultAgent, git, onInspectChanges, onToggle, onReorder, onQuick, onOpen, onRemove, onRemoveProject, onRename, onResume }: {
  project: Project;
  tasks: Task[];
  sessionsById: Map<string, SessionInfo>;
  visibleIds: (string | null)[];
  focusedId: string | null; // session in the focused pane
  now: number;
  filter: SideFilter;
  onShowAll(): void;
  collapsed: boolean;
  agents: AgentKind[];
  defaultAgent: AgentKind;
  git: GitInfo | null;
  onInspectChanges(): void;
  onToggle(): void;
  onReorder(dragged: string, target: string, after: boolean): void;
  onQuick(agent: AgentKind): void;
  onOpen(sessionId: string): void;
  onRemove(task: Task): void;
  onRemoveProject(): void;
  onRename(task: Task, title: string): void;
  onResume(task: Task): void;
}) {
  const privacy = usePrivacy();
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<'before' | 'after' | null>(null); // insertion line while another project is dragged over
  const [menu, setMenu] = useState(false);
  const waiting = tasks.filter((t) => t.phase === 'active' && t.sessionId && sessionsById.get(t.sessionId)?.status === 'needs_you').length;
  const reviewing = tasks.filter((t) => t.phase === 'review').length;
  const working = tasks.filter((t) => t.phase === 'active' && t.sessionId && sessionsById.get(t.sessionId)?.status === 'working').length;
  // Running tasks first, then approved (done, session still open), stopped last; creation order within each.
  // Status changes inside a band (working / needs you / review) never move a row under the cursor.
  const band = (t: Task) => ((t.sessionId && sessionsById.get(t.sessionId)?.status) ?? 'exited') === 'exited' ? 2 : t.phase === 'approved' ? 1 : 0;
  tasks = [...tasks].sort((a, b) => band(a) - band(b));
  // 活跃: stopped tasks are hidden, except 待验收 ones (the process ending does not settle the result).
  const stopped = (t: Task) => band(t) === 2 && t.phase !== 'review';
  const shown = filter === 'active' ? tasks.filter((t) => !stopped(t)) : tasks;
  const hidden = tasks.length - shown.length;
  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      session={task.sessionId ? sessionsById.get(task.sessionId) : undefined}
      inPane={!!task.sessionId && visibleIds.includes(task.sessionId)}
      paneFocused={!!task.sessionId && task.sessionId === focusedId}
      paneMark={task.sessionId && visibleIds.length === 2 ? (['左', '右'] as const)[visibleIds.indexOf(task.sessionId)] : undefined}
      draggable={visibleIds.length === 2}
      now={now}
      onOpen={onOpen}
      onRemove={() => onRemove(task)}
      onRename={(title) => onRename(task, title)}
      onResume={() => onResume(task)}
      onUnarchive={() => {}}
    />
  );
  return (
    <section className={`group ${dragging ? 'dragging' : ''} ${edge ? 'drop-' + edge : ''}`} data-testid="project-group" data-project-id={project.id} data-collapsed={collapsed ? 'true' : 'false'}>
      <div
        className="group-head"
        draggable
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button, .menu')) onToggle();
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect();
          setEdge(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEdge(null);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
          e.preventDefault();
          const after = edge === 'after';
          setEdge(null);
          const id = e.dataTransfer.getData(PROJECT_DRAG_TYPE);
          if (id) onReorder(id, project.id, after);
        }}
      >
        <button className="group-toggle" data-testid="project-toggle" title={privacy ? undefined : project.path} aria-expanded={!collapsed} onClick={onToggle}>
          <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
          <span className="group-name" data-private="">{project.name}</span>
        </button>
        {git && <BranchChip git={git} onInspect={onInspectChanges} />}
        {collapsed && working > 0 && <span className="group-live" data-testid="group-live">{working} 工作中</span>}
        {collapsed && waiting > 0 && <span className="group-needs" data-testid="group-needs">{waiting} 个在等你</span>}
        {collapsed && reviewing > 0 && <span className="group-review" data-testid="group-review">{reviewing} 待验收</span>}
        {collapsed && !waiting && !reviewing && <span className="group-count">{tasks.length || ''}</span>}
        <button className="icon-btn remove-project" data-testid="project-remove" title="从工作台移除项目" onClick={onRemoveProject}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8h6l.5-8M7 7v3.5M9 7v3.5" /></svg>
        </button>
        <div className="quick">
          <button
            className="icon-btn"
            data-testid="project-add-task"
            title={privacy ? undefined : `在「${project.name}」新建任务（Alt+N 在当前项目新建）`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
          </button>
          {menu && (
            <QuickMenu
              agents={agents}
              defaultAgent={defaultAgent}
              onPick={(a) => {
                setMenu(false);
                onQuick(a);
              }}
              onClose={() => setMenu(false)}
            />
          )}
        </div>
      </div>
      {!collapsed && shown.map(row)}
      {!collapsed && hidden > 0 && (
        <button className="group-hidden" data-testid="group-hidden" onClick={onShowAll}>另有 {hidden} 个已退出</button>
      )}
      {!collapsed && !tasks.length && <div className="group-empty">没有任务，点右边的 + 新建</div>}
    </section>
  );
}

// All archived tasks in one folded section at the bottom of the sidebar, grouped by project in sidebar order.
function ArchiveSection({ projects, tasks, sessionsById, visibleIds, focusedId, now, open, onToggle, onOpen, onRemove, onRename, onUnarchive }: {
  projects: Project[];
  tasks: Task[];
  sessionsById: Map<string, SessionInfo>;
  visibleIds: (string | null)[];
  focusedId: string | null;
  now: number;
  open: boolean;
  onToggle(): void;
  onOpen(sessionId: string): void;
  onRemove(task: Task): void;
  onRename(task: Task, title: string): void;
  onUnarchive(task: Task): void;
}) {
  if (!tasks.length) return null;
  return (
    <section className="archive" data-testid="archive-section">
      <button className="archived-toggle" data-testid="archived-toggle" aria-expanded={open} onClick={onToggle}>
        <svg className="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
        <span>已归档</span>
        <span className="group-count">{tasks.length}</span>
      </button>
      {open && projects.map((project) => {
        const mine = tasks.filter((t) => t.projectId === project.id).sort((a, b) => b.phaseSince - a.phaseSince);
        if (!mine.length) return null;
        return (
          <div key={project.id} className="archive-group" data-project-id={project.id}>
            <div className="archive-project" data-private="">{project.name}</div>
            {mine.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                session={task.sessionId ? sessionsById.get(task.sessionId) : undefined}
                inPane={!!task.sessionId && visibleIds.includes(task.sessionId)}
                paneFocused={!!task.sessionId && task.sessionId === focusedId}
                paneMark={task.sessionId && visibleIds.length === 2 ? (['左', '右'] as const)[visibleIds.indexOf(task.sessionId)] : undefined}
                draggable={visibleIds.length === 2}
                now={now}
                onOpen={onOpen}
                onRemove={() => onRemove(task)}
                onRename={(title) => onRename(task, title)}
                onResume={() => {}}
                onUnarchive={() => onUnarchive(task)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function QuickMenu({ agents, defaultAgent, onPick, onClose }: {
  agents: AgentKind[];
  defaultAgent: AgentKind;
  onPick(agent: AgentKind): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ordered = [defaultAgent, ...agents.filter((a) => a !== defaultAgent)].filter((a) => agents.includes(a));
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const move = (dir: number) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + dir + items.length) % items.length]?.focus();
  };
  return (
    <div
      className="menu"
      role="menu"
      ref={ref}
      data-testid="quick-menu"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Escape') onClose();
      }}
    >
      <div className="menu-label">用哪个 agent</div>
      {ordered.map((a) => (
        <button key={a} role="menuitem" data-testid="quick-agent" data-agent={a} onClick={() => onPick(a)}>
          <AgentIcon agent={a} />
          <span>{a}</span>
          {a === defaultAgent && <span className="menu-hint">上次用的<span><kbd>Alt</kbd><kbd>N</kbd></span></span>}
        </button>
      ))}
    </div>
  );
}

function TaskRow({ task, session, inPane, paneFocused, paneMark, draggable, now, onOpen, onRemove, onRename, onResume, onUnarchive }: {
  task: Task;
  session?: SessionInfo;
  inPane: boolean;
  paneFocused: boolean; // shown in the focused pane
  paneMark?: '左' | '右'; // which pane shows this task (dual layout only)
  draggable: boolean; // dual layout: the row can be dropped on a pane
  now: number;
  onOpen(sessionId: string): void;
  onRemove(): void;
  onRename(title: string): void;
  onResume(): void;
  onUnarchive(): void;
}) {
  const status = session?.status ?? 'exited';
  const glyph = rowGlyph(task, session);
  const [editing, setEditing] = useState(false);
  // The latest prompt as a second line, unless the row is closed or it only repeats the title.
  const lastPrompt = task.lastPrompt ?? '';
  const preview = task.phase !== 'archived' && status !== 'exited' && lastPrompt && !lastPrompt.startsWith(task.title.replace(/…$/, '')) ? lastPrompt : '';
  return (
    <div
      className={`task-row ${inPane ? 'in-pane' : ''} ${paneFocused ? 'pane-focused' : ''} ${preview ? 'has-preview' : ''}`}
      style={{ '--c': task.color } as CSSProperties}
      data-testid="task-row"
      data-task-id={task.id}
      data-session-id={session?.id ?? ''}
      data-status={status}
      data-phase={task.phase}
      data-limit={session?.limit ? '1' : undefined}
      draggable={draggable && !!session}
      onDragStart={(e) => {
        if (!session) return;
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => session && onOpen(session.id)}
    >
      <span className={`row-glyph g-${glyph}`} data-testid="row-glyph" data-glyph={glyph} />
      {inPane && <span className="task-swatch" data-testid="task-swatch" />}
      <EditableTitle className="task-title" title={task.title} onSave={onRename} editing={editing} onEditingChange={setEditing} />
      {paneMark && <span className="pane-mark" data-testid="pane-mark">{paneMark}</span>}
      {!!session?.queued && status !== 'exited' && (
        <span className="queued-mark" data-testid="task-queued" title="有消息排队，agent 空闲后自动发送">排队</span>
      )}
      {task.phase === 'archived' ? (
        <button
          className="resume-chip"
          data-testid="task-unarchive"
          title="移回任务列表"
          onClick={(e) => {
            e.stopPropagation();
            onUnarchive();
          }}
        >恢复</button>
      ) : status === 'exited' ? (
        <>
        {/* The process ending does not settle the result: 待验收 stays until it is approved. */}
        {task.phase === 'review' && <span className="status st-review" data-testid="status">待验收</span>}
        <button
          className="resume-chip"
          data-testid="task-resume"
          title={session && canResume(session) ? '续接上次的会话' : '上次没有对话记录，点击后可选择新开会话'}
          onClick={(e) => {
            e.stopPropagation();
            onResume();
          }}
        >续接</button>
        </>
      ) : session?.limit ? (
        <span className="status st-needs_you" data-testid="status">额度用完</span>
      ) : task.phase === 'review' ? (
        <span className="status st-review" data-testid="status">待验收</span>
      ) : task.phase === 'approved' ? (
        <span className="status st-approved" data-testid="status">已通过</span>
      ) : (
        <StatusTag status={status} since={session?.statusSince} now={now} />
      )}
      {!editing && (
        <span className="row-actions">
          <button
            className="icon-btn"
            data-testid="task-rename"
            title="改名（也可以双击标题）"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <PencilIcon />
          </button>
          <button
            className="icon-btn remove"
            data-testid="task-remove"
            title={task.phase === 'archived' ? '永久删除任务' : '归档并结束会话'}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </span>
      )}
      <span className="agent-mark" title={AGENT_LABEL[task.agent] ?? task.agent}><AgentIcon agent={task.agent} /></span>
      {preview && <span className="task-preview" data-testid="task-preview" data-private="">{preview}</span>}
    </div>
  );
}

// The state glyph at the left edge of a row, so a column of tasks can be scanned without reading the status text.
type RowGlyph = 'archived' | 'exited' | 'needs' | 'review' | 'approved' | 'working' | 'idle';
function rowGlyph(task: Task, session?: SessionInfo): RowGlyph {
  if (task.phase === 'archived') return 'archived';
  if (!session || session.status === 'exited') return task.phase === 'review' ? 'review' : 'exited';
  if (session.limit) return 'needs';
  if (task.phase === 'review') return 'review';
  if (task.phase === 'approved') return 'approved';
  if (session.status === 'needs_you') return 'needs';
  if (session.status === 'working') return 'working';
  return 'idle';
}
