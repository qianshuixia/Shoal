import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangedFile, ChangeStatus, DiffPayload, FileListResult, FilePayload, FsCreateResult, FsDeleteResult, FsPasteResult, FsRenameResult, GitInfo, OpenMode, Project, ProjectChanges, TreeEntry, TreeListing, WriteFileResult,
} from '../../shared/protocol.ts';
import { CodeEditor, type JumpTarget } from './Editor.tsx';
import { MarkdownPreview } from './MarkdownPreview.tsx';
import { RawPreview, formatBytes } from './RawPreview.tsx';
import { rawPreviewOf } from '../../shared/protocol.ts';
import {
  ContextMenu, NamePromptDialog, contextMenuPointForElement, copyText, isContextMenuKey, isMacClient, joinProjectPath,
  type ContextMenuEntry, type ContextMenuState, type FsClipboardItem, type FsMutationEvent, type NamePromptConfig,
} from './ContextMenu.tsx';

export type InspectorTab = 'changes' | 'files';

export interface InspectOpenRequest {
  projectId: string;
  tab: InspectorTab;
  filePath?: string;
  line?: number;
  col?: number;
  seq: number;
}

export interface InspectorProps {
  project: Project | undefined;
  projects: Project[];
  git: GitInfo | null;
  watchRev: number;
  openRequest: InspectOpenRequest | null;
  fsClipboard: FsClipboardItem | null;
  onSetFsClipboard: (item: FsClipboardItem | null) => void;
  fsMutation: FsMutationEvent | null;
  dirtyGuardRef?: React.MutableRefObject<((pid: string, pathPrefix: string) => boolean) | null>;
  canSendToTerminal: boolean;
  onSendPathToTerminal: (rawPath: string) => void;
  onSelectProject: (projectId: string) => void;
  onClose: () => void;
  onNotice: (msg: string) => void;
}

interface ProjectViewMem {
  tab: InspectorTab;
  changeFile: string | null;
  treeFile: string | null;
  expanded: Set<string>;
}

const isMarkdownPath = (p: string): boolean => /\.(md|mdx|markdown)$/i.test(p);

const STATUS_TITLE: Record<ChangeStatus, string> = {
  M: '已修改',
  A: '已暂存新增',
  D: '已删除',
  R: '已重命名',
  U: '合并冲突',
  '?': '未跟踪新文件',
};

function splitDirBase(posixPath: string): { dir: string; base: string } {
  const idx = posixPath.lastIndexOf('/');
  return idx === -1 ? { dir: '', base: posixPath } : { dir: posixPath.slice(0, idx), base: posixPath.slice(idx + 1) };
}

function ancestorDirs(posixPath: string): string[] {
  const parts = posixPath.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

// Lightweight fuzzy match score for Ctrl+P file search (higher is better, -1 = no match).
function scorePath(candidate: string, query: string): number {
  if (!query) return 1;
  const lowC = candidate.toLowerCase();
  const lowQ = query.toLowerCase();
  const base = splitDirBase(lowC).base;
  if (base === lowQ) return 1000;
  if (base.startsWith(lowQ)) return 800 - base.length;
  const baseIdx = base.indexOf(lowQ);
  if (baseIdx !== -1) return 600 - baseIdx * 5 - base.length;
  const fullIdx = lowC.indexOf(lowQ);
  if (fullIdx !== -1) return 400 - fullIdx * 2;
  // Subsequence match
  let qi = 0;
  for (let ci = 0; ci < lowC.length && qi < lowQ.length; ci++) {
    if (lowC[ci] === lowQ[qi]) qi++;
  }
  return qi === lowQ.length ? 100 - lowC.length : -1;
}

const CHANGE_VIRTUAL_THRESHOLD = 100;
const CHANGE_ROW_REM = 2.25;
const CHANGE_OVERSCAN = 16;
const TREE_VIRTUAL_THRESHOLD = 150;
const TREE_ROW_REM = 1.5625;
const TREE_OVERSCAN = 16;
const AUTO_PICK_LIMIT = 500;

interface VirtualSlice {
  startIdx: number;
  endIdx: number;
  topPad: number;
  bottomPad: number;
}

function computeVirtualSlice(total: number, scrollTop: number, height: number, rowRem: number, remPx: number, overscan: number): VirtualSlice {
  const rowPx = rowRem * remPx;
  const totalHeight = total * rowPx;
  const clampedScroll = Math.min(scrollTop, Math.max(0, totalHeight - height));
  const startIdx = Math.max(0, Math.floor(clampedScroll / rowPx) - overscan);
  const visibleCount = Math.ceil(height / rowPx) + overscan * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);
  return {
    startIdx,
    endIdx,
    topPad: startIdx * rowPx,
    bottomPad: Math.max(0, (total - endIdx) * rowPx),
  };
}

function useVirtualContainer(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [scrollTop, setScrollTop] = useState(0);
  const [metrics, setMetrics] = useState({ height: 500, remPx: 16 });

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const height = el.clientHeight || 500;
      setMetrics((prev) => (prev.height === height && prev.remPx === remPx ? prev : { height, remPx }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, enabled]);

  return { scrollTop, setScrollTop, height: metrics.height, remPx: metrics.remPx };
}

export function Inspector({
  project, projects, git, watchRev, openRequest, fsClipboard, onSetFsClipboard, fsMutation, dirtyGuardRef, canSendToTerminal, onSendPathToTerminal, onSelectProject, onClose, onNotice,
}: InspectorProps) {
  const memRef = useRef<Map<string, ProjectViewMem>>(new Map());
  const rootRef = useRef<HTMLElement>(null);
  const changeListRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<InspectorTab>(() => (git && git.dirty > 0 ? 'changes' : 'files'));
  const [sideOpen, setSideOpen] = useState(true);

  // Changes tab state
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesGit, setChangesGit] = useState<GitInfo | null>(null);
  const [changesLoadedFor, setChangesLoadedFor] = useState<string>('');
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesTruncated, setChangesTruncated] = useState(false);
  const [changesStale, setChangesStale] = useState(false);
  const [changeFilter, setChangeFilter] = useState('');
  const [changePath, setChangePath] = useState<string | null>(null);
  const [changeMode, setChangeMode] = useState<'diff' | 'edit'>('diff');
  const [diffData, setDiffData] = useState<DiffPayload | null>(null);

  // Files tab state
  const [treeMap, setTreeMap] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FilePayload | null>(null);
  const [mdMode, setMdMode] = useState<'preview' | 'source'>('preview');

  // Shared active text editing & optimistic concurrency state
  const [draft, setDraft] = useState('');
  const [savedText, setSavedText] = useState('');
  const [loadedMtime, setLoadedMtime] = useState<number | null>(null);
  const [externalRev, setExternalRev] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [jump, setJump] = useState<JumpTarget | null>(null);

  // Context menu & name prompt modal (new file/folder, rename)
  const [ctxMenu, setCtxMenu] = useState<(ContextMenuState & { targetKey: string }) | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePromptConfig | null>(null);
  const pendingScrollPathRef = useRef<string | null>(null);
  const handledFsMutationSeqRef = useRef(0);

  // Ctrl+P quick file finder
  const [finderOpen, setFinderOpen] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [finderLoading, setFinderLoading] = useState(false);
  const [finderQuery, setFinderQuery] = useState('');
  const [finderIdx, setFinderIdx] = useState(0);
  const pendingEnterRef = useRef(false);
  const finderQueryRef = useRef('');
  finderQueryRef.current = finderQuery;

  const projectId = project?.id ?? '';
  const activePath = tab === 'changes' ? changePath : filePath;
  const isEditingText = useMemo(() => {
    if (!activePath) return false;
    if (tab === 'changes') return !!diffData && !diffData.binary && !diffData.tooLarge && !diffData.isDirectory && diffData.status !== 'D';
    return fileData?.kind === 'text';
  }, [activePath, tab, diffData, fileData]);
  const isDirty = isEditingText && draft !== savedText;

  // Build preview URLs from the loaded payload's own path and mtime, so src, kind and the shown file can never disagree
  // while a new selection is still loading.
  const rawSrcOf = (relPath: string, mtimeMs: number | null | undefined) =>
    `/api/projects/${encodeURIComponent(projectId ?? '')}/raw?path=${encodeURIComponent(relPath)}&t=${mtimeMs ?? 0}`;
  const diffPreview = diffData ? rawPreviewOf(diffData.path) : null;
  const diffRawSrc = diffData ? rawSrcOf(diffData.path, diffData.mtimeMs) : '';
  const fileRawSrc = fileData ? rawSrcOf(fileData.path, fileData.mtimeMs) : '';

  const liveRef = useRef({ projectId, tab, activePath, isDirty, loadedMtime, changeMode, mdMode });
  liveRef.current = { projectId, tab, activePath, isDirty, loadedMtime, changeMode, mdMode };
  const gitRef = useRef(git);
  gitRef.current = git;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const openRequestRef = useRef(openRequest);
  openRequestRef.current = openRequest;

  const changesReqRef = useRef<{ seq: number; ctrl: AbortController | null }>({ seq: 0, ctrl: null });
  const docReqSeqRef = useRef(0);
  const lastChangesFetchedRef = useRef<{ pid: string; gitJson: string; at: number } | null>(null);
  const changesRequestedForRef = useRef('');
  const treeLoadedRootForRef = useRef('');
  const treeStaleRef = useRef(false);
  const initReqSeqRef = useRef(0);

  useEffect(() => () => {
    changesReqRef.current.ctrl?.abort();
  }, []);

  const confirmDiscardDraft = useCallback((): boolean => {
    if (!liveRef.current.isDirty) return true;
    return confirm('当前打开的文件有未保存修改，确定放弃这些修改吗？');
  }, []);

  useEffect(() => {
    if (!dirtyGuardRef) return;
    dirtyGuardRef.current = (pid: string, pathPrefix: string) => {
      const s = liveRef.current;
      if (!s.isDirty || s.projectId !== pid || !s.activePath) return true;
      if (s.activePath === pathPrefix || s.activePath.startsWith(`${pathPrefix}/`)) {
        return confirmDiscardDraft();
      }
      return true;
    };
    return () => {
      dirtyGuardRef.current = null;
    };
  }, [dirtyGuardRef, confirmDiscardDraft]);

  // Fetch changes list for a project with single-flight abort & race protection
  const fetchChanges = useCallback(async (pid: string, autoPick = false, force = false) => {
    if (!pid) return;
    if (!force && lastChangesFetchedRef.current?.pid === pid) {
      const sameRecentGit = JSON.stringify(gitRef.current ?? null) === lastChangesFetchedRef.current.gitJson;
      if (sameRecentGit && Date.now() - lastChangesFetchedRef.current.at < 800) {
        return;
      }
    }
    changesRequestedForRef.current = pid;
    setChangesStale(false);
    setChangesError(null);

    changesReqRef.current.ctrl?.abort();
    const ctrl = new AbortController();
    const seq = ++changesReqRef.current.seq;
    changesReqRef.current.ctrl = ctrl;

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/changes`, { signal: ctrl.signal });
      if (seq !== changesReqRef.current.seq || liveRef.current.projectId !== pid) return;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setChangesError(err.error ?? `读取改动失败 (${res.status})`);
        return;
      }
      const json = (await res.json()) as ProjectChanges;
      if (seq !== changesReqRef.current.seq || liveRef.current.projectId !== pid) return;

      lastChangesFetchedRef.current = { pid, gitJson: JSON.stringify(json.git), at: Date.now() };
      setChanges(json.files);
      setChangesGit(json.git);
      setChangesTruncated(!!json.truncated);
      setChangesLoadedFor(pid);
      setChangesError(null);
      if (autoPick) {
        setChangePath((prev) => {
          if (prev && json.files.some((f) => f.path === prev)) return prev;
          if (json.files.length > AUTO_PICK_LIMIT) return null;
          return json.files[0]?.path ?? null;
        });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if (seq !== changesReqRef.current.seq || liveRef.current.projectId !== pid) return;
      setChangesError((e as Error).message || '读取改动失败');
    }
  }, []);

  // Fetch one directory level for the file tree
  const fetchTreeDir = useCallback(async (pid: string, dirPosix: string) => {
    if (!pid) return;
    if (dirPosix === '') {
      treeLoadedRootForRef.current = pid;
      treeStaleRef.current = false;
    }
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/tree?path=${encodeURIComponent(dirPosix)}`);
      if (!res.ok) return;
      const json = (await res.json()) as TreeListing;
      if (liveRef.current.projectId !== pid) return;
      setTreeMap((prev) => ({ ...prev, [dirPosix]: json.entries }));
    } catch {
      // ignore
    }
  }, []);

  // Load diff payload for a changed file
  const loadDiffFile = useCallback(async (pid: string, relPath: string, silent = false) => {
    if (!pid || !relPath) return;
    const seq = ++docReqSeqRef.current;
    if (!silent) setLoadingDoc(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/diff?path=${encodeURIComponent(relPath)}`);
      if (seq !== docReqSeqRef.current || liveRef.current.projectId !== pid) return;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (!silent) onNotice(err.error ?? `读取对比失败 (${res.status})`);
        return;
      }
      const json = (await res.json()) as DiffPayload;
      if (seq !== docReqSeqRef.current || liveRef.current.projectId !== pid) return;
      setDiffData(json);
      setSavedText(json.head);
      setDraft(json.head);
      setLoadedMtime(json.mtimeMs);
      setConflict(false);
      if (silent) setExternalRev((n) => n + 1);
    } finally {
      if (!silent && seq === docReqSeqRef.current) setLoadingDoc(false);
    }
  }, [onNotice]);

  // Load file payload for the Files tab
  const loadTreeFile = useCallback(async (pid: string, relPath: string, silent = false) => {
    if (!pid || !relPath) return;
    const seq = ++docReqSeqRef.current;
    if (!silent) setLoadingDoc(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/file?path=${encodeURIComponent(relPath)}`);
      if (seq !== docReqSeqRef.current || liveRef.current.projectId !== pid) return;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (!silent) onNotice(err.error ?? `读取文件失败 (${res.status})`);
        return;
      }
      const json = (await res.json()) as FilePayload;
      if (seq !== docReqSeqRef.current || liveRef.current.projectId !== pid) return;
      setFileData(json);
      const text = json.kind === 'text' ? (json.content ?? '') : '';
      setSavedText(text);
      setDraft(text);
      setLoadedMtime(json.mtimeMs);
      setConflict(false);
      if (silent) setExternalRev((n) => n + 1);
    } finally {
      if (!silent && seq === docReqSeqRef.current) setLoadingDoc(false);
    }
  }, [onNotice]);

  // Initialize / restore state when switching projects (lazy-loads only the active tab)
  const prevProjectRef = useRef<string>('');
  useEffect(() => {
    if (!projectId) {
      prevProjectRef.current = '';
      changesReqRef.current.ctrl?.abort();
      changesRequestedForRef.current = '';
      treeLoadedRootForRef.current = '';
      setChanges([]);
      setChangesGit(null);
      setChangesLoadedFor('');
      setChangesError(null);
      setChangesTruncated(false);
      setChangesStale(false);
      setChangeFilter('');
      setChangePath(null);
      setDiffData(null);
      setTreeMap({});
      setFilePath(null);
      setFileData(null);
      setConflict(false);
      return;
    }
    if (prevProjectRef.current === projectId) return;
    prevProjectRef.current = projectId;

    const saved = memRef.current.get(projectId);
    const req = openRequestRef.current;
    const reqMatches = !!req && req.seq !== handledReqSeq.current && req.projectId === projectId;
    initReqSeqRef.current = reqMatches ? req.seq : 0;

    const curGit = gitRef.current;
    const defaultTab: InspectorTab = reqMatches
      ? req.tab
      : saved
        ? saved.tab
        : (curGit && curGit.dirty > 0 ? 'changes' : 'files');

    const initExpanded = saved?.expanded ?? new Set<string>();
    setTab(defaultTab);
    setChangePath(saved?.changeFile ?? null);
    setFilePath(saved?.treeFile ?? null);
    setExpanded(initExpanded);
    setChanges([]);
    setChangesGit(null);
    setChangesLoadedFor('');
    setChangesError(null);
    setChangesTruncated(false);
    setChangesStale(false);
    setChangeFilter('');
    setDiffData(null);
    setFileData(null);
    setDraft('');
    setSavedText('');
    setLoadedMtime(null);
    setConflict(false);
    setTreeMap({});
    setFinderOpen(false);
    setAllFiles([]);
    if (changeListRef.current) changeListRef.current.scrollTop = 0;
    if (treeScrollRef.current) treeScrollRef.current.scrollTop = 0;

    if (defaultTab === 'changes') {
      treeLoadedRootForRef.current = '';
      treeStaleRef.current = true;
      const willAutoPick = !(reqMatches && req.filePath) && !saved?.changeFile;
      void fetchChanges(projectId, willAutoPick, true);
    } else {
      changesRequestedForRef.current = '';
      setChangesStale(true);
      void fetchTreeDir(projectId, '');
      for (const dir of initExpanded) void fetchTreeDir(projectId, dir);
    }
  }, [projectId, fetchChanges, fetchTreeDir]);

  // Lazy-refresh target tab when switching between Changes and Files
  useEffect(() => {
    if (!projectId) return;
    if (tab === 'changes') {
      if (changesStale || (changesLoadedFor !== projectId && changesRequestedForRef.current !== projectId)) {
        void fetchChanges(projectId, !changePath, true);
      }
    } else if (treeStaleRef.current || treeLoadedRootForRef.current !== projectId) {
      void fetchTreeDir(projectId, '');
      for (const d of expandedRef.current) void fetchTreeDir(projectId, d);
    }
  }, [tab, projectId, changesStale, changesLoadedFor, changePath, fetchChanges, fetchTreeDir]);

  // Persist current project's memory after initialization has run for projectId.
  useEffect(() => {
    if (!projectId || prevProjectRef.current !== projectId) return;
    memRef.current.set(projectId, {
      tab,
      changeFile: changePath,
      treeFile: filePath,
      expanded,
    });
  }, [projectId, tab, changePath, filePath, expanded]);

  // Handle explicit openRequest (from sidebar BranchChip or terminal file:line link)
  const handledReqSeq = useRef(0);
  useEffect(() => {
    if (!openRequest || openRequest.seq === handledReqSeq.current) return;
    if (openRequest.projectId !== projectId) return;
    handledReqSeq.current = openRequest.seq;
    const sameCommitInit = initReqSeqRef.current === openRequest.seq;
    initReqSeqRef.current = 0;

    setTab(openRequest.tab);
    if (openRequest.tab === 'changes') {
      if (!sameCommitInit) void fetchChanges(projectId, !openRequest.filePath, true);
      if (openRequest.filePath) {
        setChangePath(openRequest.filePath);
        setChangeMode(openRequest.line ? 'edit' : 'diff');
      }
    } else {
      if (!sameCommitInit && (treeStaleRef.current || treeLoadedRootForRef.current !== projectId)) {
        void fetchTreeDir(projectId, '');
      }
      if (openRequest.filePath) {
        const rel = openRequest.filePath;
        setFilePath(rel);
        if (isMarkdownPath(rel) && openRequest.line) {
          setMdMode('source');
        } else if (isMarkdownPath(rel)) {
          setMdMode('preview');
        }
        const dirs = ancestorDirs(rel);
        if (dirs.length > 0) {
          setExpanded((prev) => {
            const next = new Set(prev);
            for (const d of dirs) next.add(d);
            return next;
          });
          for (const d of dirs) void fetchTreeDir(projectId, d);
        }
      }
    }
    if (openRequest.line) {
      setJump({ line: openRequest.line, col: openRequest.col, seq: openRequest.seq });
    }
  }, [openRequest, projectId, fetchChanges, fetchTreeDir]);

  // Load active document only when the active tab's selected path actually changes (updating an inactive tab's path must never wipe the active draft).
  useEffect(() => {
    if (!projectId) return;
    if (tab === 'changes') {
      if (activePath) void loadDiffFile(projectId, activePath, false);
      else setDiffData(null);
    } else {
      if (activePath) void loadTreeFile(projectId, activePath, false);
      else setFileData(null);
    }
  }, [projectId, tab, activePath, loadDiffFile, loadTreeFile]);

  // Check if disk mtime changed externally (Agent edit, terminal command, etc.)
  const checkExternalUpdate = useCallback(async () => {
    const s = liveRef.current;
    if (!s.projectId || !s.activePath) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(s.projectId)}/file?path=${encodeURIComponent(s.activePath)}&stat=1`);
      if (!res.ok) return;
      const stat = (await res.json()) as FilePayload;
      if (liveRef.current.projectId !== s.projectId || liveRef.current.activePath !== s.activePath) return;
      const prevMtime = liveRef.current.loadedMtime;
      const changed = (prevMtime === null && stat.mtimeMs !== null)
        || (prevMtime !== null && stat.mtimeMs === null)
        || (prevMtime !== null && stat.mtimeMs !== null && Math.abs(stat.mtimeMs - prevMtime) > 2);
      if (!changed) return;

      if (liveRef.current.isDirty) {
        // User has unsaved edits: NEVER overwrite draft! Show conflict banner.
        setConflict(true);
      } else {
        // Clean view: hot-reload silently so user immediately sees Agent's changes.
        if (liveRef.current.tab === 'changes') void loadDiffFile(s.projectId, s.activePath, true);
        else void loadTreeFile(s.projectId, s.activePath, true);
      }
    } catch {
      // ignore
    }
  }, [loadDiffFile, loadTreeFile]);

  // Refresh active tab only when watchRev bumps (WS snapshot / review / active-project git), window focuses, or 2.5s active-file poll
  useEffect(() => {
    if (!projectId || watchRev === 0) return;
    if (liveRef.current.tab === 'changes') {
      void fetchChanges(projectId, false, false);
      treeStaleRef.current = true;
    } else {
      void fetchTreeDir(projectId, '');
      for (const d of expandedRef.current) void fetchTreeDir(projectId, d);
      setChangesStale(true);
    }
    void checkExternalUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchRev]);

  useEffect(() => {
    if (!projectId) return;
    const onFocus = () => {
      if (liveRef.current.tab === 'changes') {
        void fetchChanges(projectId, false, false);
        treeStaleRef.current = true;
      } else {
        void fetchTreeDir(projectId, '');
        for (const d of expandedRef.current) void fetchTreeDir(projectId, d);
        setChangesStale(true);
      }
      void checkExternalUpdate();
    };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => void checkExternalUpdate(), 2500);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [projectId, fetchChanges, fetchTreeDir, checkExternalUpdate]);

  // Save file (with optimistic mtime lock unless force=true)
  const saveCurrent = useCallback(async (force = false) => {
    if (!projectId || !activePath || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: activePath,
          content: draft,
          expectedMtimeMs: loadedMtime,
          force,
        }),
      });
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      const json = (await res.json().catch(() => ({}))) as WriteFileResult & { error?: string };
      if (!res.ok) {
        onNotice(json.error ?? `保存失败 (${res.status})`);
        return;
      }
      setSavedText(draft);
      setLoadedMtime(json.mtimeMs);
      setConflict(false);
      // Refresh active tab & mark inactive tab stale
      if (tab === 'changes') {
        void fetchChanges(projectId, false, true);
        treeStaleRef.current = true;
        void loadDiffFile(projectId, activePath, true);
      } else {
        void fetchTreeDir(projectId, splitDirBase(activePath).dir);
        setChangesStale(true);
      }
    } catch (e) {
      onNotice(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [projectId, activePath, saving, draft, loadedMtime, tab, fetchChanges, fetchTreeDir, loadDiffFile, onNotice]);

  // Discard single file uncommitted changes
  const discardSingle = async (item: ChangedFile) => {
    if (!projectId) return;
    const msg = item.status === '?'
      ? `确定删除未跟踪的新文件「${item.path}」吗？删除后无法恢复。`
      : `确定放弃「${item.path}」的未提交改动并还原到 HEAD 吗？`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: item.path }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        onNotice(json.error ?? `放弃改动失败 (${res.status})`);
        return;
      }
      if (changePath === item.path) {
        setChangePath(null);
        setDiffData(null);
        setDraft('');
        setSavedText('');
        setConflict(false);
      }
      await fetchChanges(projectId, true, true);
      treeStaleRef.current = true;
    } catch (e) {
      onNotice(`放弃改动失败：${(e as Error).message}`);
    }
  };

  // Open file or directory in external editor / Explorer
  const openInSystem = useCallback(async (relPosix: string, mode: OpenMode = 'default') => {
    if (!project) return;
    const target = relPosix ? joinProjectPath(project.path, relPosix) : project.path;
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, mode }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        onNotice(json.error ?? `打开失败 (${res.status})`);
      }
    } catch (e) {
      onNotice(`打开失败：${(e as Error).message}`);
    }
  }, [project, onNotice]);

  // Open current file (or project folder) in external editor (VS Code)
  const openExternal = () => openInSystem(activePath ?? '', 'default');

  const refreshTreeDirs = useCallback((pid: string, dirs: string[]) => {
    const uniq = new Set(dirs);
    for (const d of uniq) void fetchTreeDir(pid, d);
    if (liveRef.current.tab === 'changes') void fetchChanges(pid, false, true);
    else setChangesStale(true);
  }, [fetchTreeDir, fetchChanges]);

  const copyPathValue = useCallback(async (text: string, label: string) => {
    const ok = await copyText(text);
    onNotice(ok ? `已复制${label}` : `复制${label}失败`);
  }, [onNotice]);

  const copyEntry = useCallback((relPosix: string, kind: 'file' | 'dir', mode: 'copy' | 'cut') => {
    if (!projectId) return;
    const name = splitDirBase(relPosix).base;
    onSetFsClipboard({ mode, projectId, path: relPosix, name, kind });
    if (mode === 'copy') {
      void fetch('/api/clipboard/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, path: relPosix }),
      }).catch(() => {});
    }
    onNotice(`${mode === 'copy' ? '已复制' : '已剪切'}「${name}」`);
  }, [projectId, onSetFsClipboard, onNotice]);

  const applyPathMutation = useCallback((
    targetPid: string,
    oldPath: string,
    newPath: string | null,
    extraRefreshDirs: string[] = [],
  ) => {
    const matches = (p: string | null) => !!p && (p === oldPath || p.startsWith(`${oldPath}/`));
    const remap = (p: string | null): string | null => {
      if (!p) return p;
      if (!matches(p)) return p;
      if (newPath === null) return null;
      return p === oldPath ? newPath : `${newPath}${p.slice(oldPath.length)}`;
    };

    // Always synchronize remembered state for non-active projects too.
    const saved = memRef.current.get(targetPid);
    if (saved) {
      const nextExp = new Set<string>();
      for (const d of saved.expanded) {
        const mapped = remap(d);
        if (mapped) nextExp.add(mapped);
      }
      memRef.current.set(targetPid, {
        ...saved,
        changeFile: remap(saved.changeFile),
        treeFile: remap(saved.treeFile),
        expanded: nextExp,
      });
    }

    if (liveRef.current.projectId !== targetPid) return;

    const activeAffected = matches(liveRef.current.activePath);
    if (newPath === null) {
      if (matches(filePath)) {
        setFilePath(null);
        setFileData(null);
      }
      if (matches(changePath)) {
        setChangePath(null);
        setDiffData(null);
      }
      if (activeAffected) {
        setDraft('');
        setSavedText('');
        setConflict(false);
      }
    } else {
      setFilePath((p) => remap(p));
      setChangePath((p) => remap(p));
    }

    const dirsToReload = new Set<string>(extraRefreshDirs);
    dirsToReload.add(splitDirBase(oldPath).dir);
    if (newPath !== null) dirsToReload.add(splitDirBase(newPath).dir);

    const nextExpanded = new Set<string>();
    for (const d of expandedRef.current) {
      const mapped = remap(d);
      if (mapped) {
        nextExpanded.add(mapped);
        if (matches(d)) dirsToReload.add(mapped);
      }
    }
    for (const d of extraRefreshDirs) {
      if (d) nextExpanded.add(d);
    }
    setExpanded(nextExpanded);

    // Drop stale treeMap cache entries under oldPath before reloading remapped directories.
    setTreeMap((prev) => {
      const next: Record<string, TreeEntry[]> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!matches(k)) next[k] = v;
      }
      return next;
    });
    refreshTreeDirs(targetPid, [...dirsToReload]);
  }, [filePath, changePath, refreshTreeDirs]);

  // Synchronize source/target Inspector state when a sidebar project context-menu paste/move completes.
  useEffect(() => {
    if (!fsMutation || fsMutation.seq === handledFsMutationSeqRef.current) return;
    handledFsMutationSeqRef.current = fsMutation.seq;
    if (fsMutation.kind === 'move' && fsMutation.sourceProjectId && fsMutation.sourcePath) {
      const sameProject = fsMutation.sourceProjectId === fsMutation.targetProjectId;
      applyPathMutation(
        fsMutation.sourceProjectId,
        fsMutation.sourcePath,
        sameProject ? (fsMutation.movedTo ?? fsMutation.sourcePath) : null,
        sameProject ? [fsMutation.targetDir] : [],
      );
      if (!sameProject && liveRef.current.projectId === fsMutation.targetProjectId) {
        refreshTreeDirs(fsMutation.targetProjectId, [fsMutation.targetDir]);
      }
    } else if (liveRef.current.projectId === fsMutation.targetProjectId) {
      refreshTreeDirs(fsMutation.targetProjectId, [fsMutation.targetDir]);
    }
  }, [fsMutation, applyPathMutation, refreshTreeDirs]);

  const pasteIntoDir = useCallback(async (targetDir: string, source: 'internal' | 'system') => {
    if (!projectId || !project) return;
    try {
      let body: Record<string, unknown>;
      let wasCut = false;
      let cutSourceProjectId = '';
      let cutSourcePath = '';
      if (source === 'internal' && fsClipboard) {
        wasCut = fsClipboard.mode === 'cut';
        cutSourceProjectId = fsClipboard.projectId;
        cutSourcePath = fsClipboard.path;
        if (wasCut && cutSourceProjectId === projectId && activePath
          && (activePath === cutSourcePath || activePath.startsWith(`${cutSourcePath}/`))) {
          if (!confirmDiscardDraft()) return;
        }
        body = {
          mode: fsClipboard.mode,
          targetDir,
          sourceProjectId: fsClipboard.projectId,
          sourcePath: fsClipboard.path,
        };
      } else {
        const clipRes = await fetch('/api/clipboard/files');
        const clipJson = (await clipRes.json().catch(() => ({}))) as { paths?: string[]; error?: string };
        const externalPaths = clipRes.ok && Array.isArray(clipJson.paths) ? clipJson.paths : [];
        if (externalPaths.length === 0) {
          onNotice('剪贴板中没有可粘贴的文件');
          return;
        }
        body = { mode: 'copy', targetDir, externalPaths };
      }

      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/fs/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as FsPasteResult & { error?: string };
      if (!res.ok) {
        onNotice(json.error ?? `粘贴失败 (${res.status})`);
        return;
      }
      if (wasCut) {
        onSetFsClipboard(null);
        if (!json.skipped) {
          const sameProj = cutSourceProjectId === projectId;
          applyPathMutation(
            cutSourceProjectId,
            cutSourcePath,
            sameProj ? (json.paths[0] ?? cutSourcePath) : null,
            sameProj ? [targetDir] : [],
          );
          if (!sameProj) {
            if (targetDir) setExpanded((prev) => new Set(prev).add(targetDir));
            refreshTreeDirs(projectId, [targetDir]);
          }
        }
      } else {
        if (targetDir) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.add(targetDir);
            return next;
          });
        }
        refreshTreeDirs(projectId, [targetDir]);
      }
      if (json.skipped) {
        onNotice('文件已在当前目录，未移动');
      } else if (json.paths.length === 1) {
        onNotice(`${wasCut ? '已移动' : '已粘贴'}「${splitDirBase(json.paths[0]).base}」`);
      } else {
        onNotice(`已粘贴 ${json.paths.length} 个项目`);
      }
    } catch (e) {
      onNotice(`粘贴失败：${(e as Error).message}`);
    }
  }, [projectId, project, fsClipboard, activePath, confirmDiscardDraft, onSetFsClipboard, applyPathMutation, refreshTreeDirs, onNotice]);

  const promptCreate = useCallback((parentDir: string, kind: 'file' | 'dir') => {
    if (!projectId) return;
    if (kind === 'file' && !confirmDiscardDraft()) return;
    const isDir = kind === 'dir';
    setNamePrompt({
      title: isDir ? '新建文件夹' : '新建文件',
      label: parentDir ? `在 ${parentDir}/ 中创建` : '在项目根目录创建',
      placeholder: isDir ? '例如 components' : '例如 notes.md',
      initialValue: '',
      submitLabel: '创建',
      onSubmit: async (name) => {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/fs/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parentDir, name, kind }),
        });
        const json = (await res.json().catch(() => ({}))) as FsCreateResult & { error?: string };
        if (!res.ok) return json.error ?? `创建失败 (${res.status})`;
        if (parentDir) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.add(parentDir);
            return next;
          });
        }
        refreshTreeDirs(projectId, [parentDir]);
        if (kind === 'file') {
          pendingScrollPathRef.current = json.path;
          setTab('files');
          setFilePath(json.path);
          if (isMarkdownPath(json.path)) setMdMode('source');
        }
        onNotice(`已创建${isDir ? '文件夹' : '文件'}「${name}」`);
        return null;
      },
    });
  }, [projectId, confirmDiscardDraft, refreshTreeDirs, onNotice]);

  const promptRename = useCallback((relPosix: string, kind: 'file' | 'dir') => {
    if (!projectId) return;
    const affectsOpen = activePath === relPosix || (!!activePath && activePath.startsWith(`${relPosix}/`));
    if (affectsOpen && !confirmDiscardDraft()) return;
    const { dir: parentDir, base } = splitDirBase(relPosix);
    setNamePrompt({
      title: kind === 'dir' ? '重命名文件夹' : '重命名文件',
      label: `原路径：${relPosix}`,
      initialValue: base,
      submitLabel: '重命名',
      selectStem: kind === 'file',
      onSubmit: async (newName) => {
        if (newName === base) return null;
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/fs/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: relPosix, newName }),
        });
        const json = (await res.json().catch(() => ({}))) as FsRenameResult & { error?: string };
        if (!res.ok) return json.error ?? `重命名失败 (${res.status})`;
        applyPathMutation(projectId, json.oldPath, json.newPath, [parentDir]);
        if (fsClipboard && fsClipboard.projectId === projectId && (fsClipboard.path === json.oldPath || fsClipboard.path.startsWith(`${json.oldPath}/`))) {
          onSetFsClipboard(null);
        }
        onNotice(`已重命名为「${newName}」`);
        return null;
      },
    });
  }, [projectId, activePath, confirmDiscardDraft, fsClipboard, onSetFsClipboard, applyPathMutation, onNotice]);

  const deleteEntry = useCallback(async (relPosix: string, kind: 'file' | 'dir') => {
    if (!projectId) return;
    const affectsActive = !!activePath && (activePath === relPosix || activePath.startsWith(`${relPosix}/`));
    if (affectsActive && !confirmDiscardDraft()) return;
    const msg = kind === 'dir'
      ? `确定删除文件夹「${relPosix}」及其全部内容吗？删除后无法恢复。`
      : `确定删除文件「${relPosix}」吗？删除后无法恢复。`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/fs/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: relPosix }),
      });
      const json = (await res.json().catch(() => ({}))) as FsDeleteResult & { error?: string };
      if (!res.ok) {
        onNotice(json.error ?? `删除失败 (${res.status})`);
        return;
      }
      applyPathMutation(projectId, relPosix, null, [splitDirBase(relPosix).dir]);
      if (fsClipboard && fsClipboard.projectId === projectId
        && (fsClipboard.path === relPosix || fsClipboard.path.startsWith(`${relPosix}/`))) {
        onSetFsClipboard(null);
      }
      onNotice(`已删除「${splitDirBase(relPosix).base}」`);
    } catch (e) {
      onNotice(`删除失败：${(e as Error).message}`);
    }
  }, [projectId, activePath, confirmDiscardDraft, fsClipboard, onSetFsClipboard, applyPathMutation, onNotice]);

  // Open Ctrl+P quick file finder
  const openFinder = useCallback(async () => {
    if (!projectId) return;
    setFinderOpen(true);
    setFinderQuery('');
    setFinderIdx(0);
    setFinderLoading(true);
    pendingEnterRef.current = false;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
      if (!res.ok) return;
      const json = (await res.json()) as FileListResult;
      if (liveRef.current.projectId !== projectId) return;
      setAllFiles(json.files);
      if (pendingEnterRef.current) {
        pendingEnterRef.current = false;
        const q = finderQueryRef.current.trim();
        const best = !q
          ? json.files[0]
          : json.files
              .map((f) => ({ f, s: scorePath(f, q) }))
              .filter((x) => x.s >= 0)
              .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f))[0]?.f;
        if (best) {
          setFinderOpen(false);
          setTab('files');
          setFilePath(best);
          if (isMarkdownPath(best)) setMdMode('preview');
        }
      }
    } catch {
      // ignore
    } finally {
      setFinderLoading(false);
    }
  }, [projectId]);

  const filteredFiles = useMemo(() => {
    const q = finderQuery.trim();
    if (!q) return allFiles.slice(0, 60);
    return allFiles
      .map((f) => ({ f, s: scorePath(f, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f))
      .slice(0, 60)
      .map((x) => x.f);
  }, [allFiles, finderQuery]);

  const pickFileFromTreeOrFinder = useCallback((relPosix: string, line?: number, scrollIntoView = false) => {
    if (relPosix !== filePath && !confirmDiscardDraft()) return;
    setFinderOpen(false);
    if (scrollIntoView) pendingScrollPathRef.current = relPosix;
    setTab('files');
    setFilePath(relPosix);
    if (isMarkdownPath(relPosix)) {
      setMdMode(line ? 'source' : 'preview');
    }
    const dirs = ancestorDirs(relPosix);
    if (dirs.length > 0 && projectId) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const d of dirs) next.add(d);
        return next;
      });
      for (const d of dirs) void fetchTreeDir(projectId, d);
    }
    if (line) setJump({ line, seq: Date.now() });
  }, [filePath, confirmDiscardDraft, projectId, fetchTreeDir]);

  // Ctrl+P shortcut inside Inspector (or global when Inspector is open and focus is not inside terminal? Spec: when focused inside Inspector, plus button)
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      e.stopPropagation();
      void openFinder();
    }
  };

  const toggleDir = (dirPosix: string) => {
    const willOpen = !expanded.has(dirPosix);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPosix)) next.delete(dirPosix);
      else next.add(dirPosix);
      return next;
    });
    if (willOpen && projectId) void fetchTreeDir(projectId, dirPosix);
  };

  const revealFileLabel = isMacClient() ? '在访达中显示' : '在文件资源管理器中显示';
  const revealDirLabel = isMacClient() ? '在访达中打开' : '在文件资源管理器中打开';
  const buildPasteEntries = (targetDir: string, hint?: string): ContextMenuEntry[] => (
    fsClipboard
      ? [
        {
          id: 'paste',
          label: `${fsClipboard.mode === 'cut' ? '粘贴并移动' : '粘贴'}「${fsClipboard.name}」`,
          hint,
          onSelect: () => void pasteIntoDir(targetDir, 'internal'),
        },
        {
          id: 'paste-system',
          label: '粘贴系统剪贴板文件',
          hint,
          onSelect: () => void pasteIntoDir(targetDir, 'system'),
        },
      ]
      : [
        {
          id: 'paste-system',
          label: '粘贴系统剪贴板文件',
          hint,
          onSelect: () => void pasteIntoDir(targetDir, 'system'),
        },
      ]
  );

  const openTreeEntryMenuAt = (x: number, y: number, entry: TreeEntry) => {
    if (!project) return;
    const isDir = entry.kind === 'dir';
    const absPath = joinProjectPath(project.path, entry.path);
    const pasteTargetDir = isDir ? entry.path : splitDirBase(entry.path).dir;
    const items: ContextMenuEntry[] = [
      ...(isDir ? [
        { id: 'new-file', label: '新建文件…', onSelect: () => promptCreate(entry.path, 'file') },
        { id: 'new-dir', label: '新建文件夹…', onSelect: () => promptCreate(entry.path, 'dir') },
        { kind: 'sep' as const },
      ] : []),
      { id: 'copy', label: '复制', onSelect: () => copyEntry(entry.path, entry.kind, 'copy') },
      { id: 'cut', label: '剪切', onSelect: () => copyEntry(entry.path, entry.kind, 'cut') },
      ...buildPasteEntries(pasteTargetDir, isDir ? undefined : '当前目录'),
      { kind: 'sep' },
      { id: 'copy-abs-path', label: '复制绝对路径', onSelect: () => void copyPathValue(absPath, '绝对路径') },
      { id: 'copy-rel-path', label: '复制相对路径', onSelect: () => void copyPathValue(entry.path, '相对路径') },
      {
        id: 'send-to-term',
        label: '发送路径到当前终端',
        disabled: !canSendToTerminal,
        onSelect: () => onSendPathToTerminal(entry.path),
      },
      { kind: 'sep' },
      { id: 'reveal', label: isDir ? revealDirLabel : revealFileLabel, onSelect: () => void openInSystem(entry.path, 'reveal') },
      { id: 'open-editor', label: '在外部编辑器中打开', onSelect: () => void openInSystem(entry.path, 'editor') },
      { kind: 'sep' },
      { id: 'rename', label: '重命名…', onSelect: () => promptRename(entry.path, entry.kind) },
      { id: 'delete', label: '删除', danger: true, onSelect: () => void deleteEntry(entry.path, entry.kind) },
    ];
    setCtxMenu({ x, y, items, targetKey: `tree:${entry.path}` });
  };

  const openTreeEntryMenu = (e: React.MouseEvent, entry: TreeEntry) => {
    e.preventDefault();
    e.stopPropagation();
    openTreeEntryMenuAt(e.clientX, e.clientY, entry);
  };

  const openTreeRootMenu = (e: React.MouseEvent) => {
    if (!project) return;
    if ((e.target as Element | null)?.closest('.tree-row, .tree-search-bar')) return;
    e.preventDefault();
    const items: ContextMenuEntry[] = [
      { id: 'new-file', label: '新建文件…', onSelect: () => promptCreate('', 'file') },
      { id: 'new-dir', label: '新建文件夹…', onSelect: () => promptCreate('', 'dir') },
      ...buildPasteEntries(''),
      { kind: 'sep' },
      { id: 'copy-abs-path', label: '复制项目路径', onSelect: () => void copyPathValue(project.path, '项目路径') },
      { id: 'reveal', label: revealDirLabel, onSelect: () => void openInSystem('', 'reveal') },
      { id: 'open-editor', label: '在外部编辑器中打开', onSelect: () => void openInSystem('', 'editor') },
      { kind: 'sep' },
      { id: 'refresh', label: '刷新文件树', onSelect: manualRefresh },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items, targetKey: 'tree-root' });
  };

  const openChangeEntryMenuAt = (x: number, y: number, item: ChangedFile) => {
    if (!project) return;
    const deleted = item.status === 'D';
    const absPath = joinProjectPath(project.path, item.path);
    const parentDir = splitDirBase(item.path).dir;
    const items: ContextMenuEntry[] = [
      ...(!deleted ? [
        { id: 'locate-tree', label: '在文件树中定位', onSelect: () => pickFileFromTreeOrFinder(item.path, undefined, true) },
        { id: 'copy', label: '复制', onSelect: () => copyEntry(item.path, 'file', 'copy') },
        { kind: 'sep' as const },
      ] : []),
      { id: 'copy-abs-path', label: '复制绝对路径', onSelect: () => void copyPathValue(absPath, '绝对路径') },
      { id: 'copy-rel-path', label: '复制相对路径', onSelect: () => void copyPathValue(item.path, '相对路径') },
      {
        id: 'send-to-term',
        label: '发送路径到当前终端',
        disabled: !canSendToTerminal,
        onSelect: () => onSendPathToTerminal(item.path),
      },
      { kind: 'sep' },
      {
        id: 'reveal',
        label: deleted ? (isMacClient() ? '在访达中打开所在目录' : '在文件资源管理器中打开所在目录') : revealFileLabel,
        onSelect: () => void openInSystem(deleted ? parentDir : item.path, 'reveal'),
      },
      ...(!deleted ? [
        { id: 'open-editor', label: '在外部编辑器中打开', onSelect: () => void openInSystem(item.path, 'editor') },
      ] : []),
      { kind: 'sep' },
      {
        id: 'discard',
        label: item.status === '?' ? '删除未跟踪文件' : '放弃未提交改动',
        danger: true,
        onSelect: () => void discardSingle(item),
      },
    ];
    setCtxMenu({ x, y, items, targetKey: `change:${item.path}` });
  };

  const openChangeEntryMenu = (e: React.MouseEvent, item: ChangedFile) => {
    e.preventDefault();
    e.stopPropagation();
    openChangeEntryMenuAt(e.clientX, e.clientY, item);
  };

  const openFilebarMenu = (e: React.MouseEvent) => {
    if (!project || !activePath) return;
    e.preventDefault();
    e.stopPropagation();
    const absPath = joinProjectPath(project.path, activePath);
    const missing = (tab === 'changes' && diffData?.status === 'D') || (tab === 'files' && fileData?.kind === 'missing');
    const parentDir = splitDirBase(activePath).dir;
    const items: ContextMenuEntry[] = [
      ...(!missing ? [
        { id: 'copy', label: '复制', onSelect: () => copyEntry(activePath, 'file', 'copy') },
        { kind: 'sep' as const },
      ] : []),
      { id: 'copy-abs-path', label: '复制绝对路径', onSelect: () => void copyPathValue(absPath, '绝对路径') },
      { id: 'copy-rel-path', label: '复制相对路径', onSelect: () => void copyPathValue(activePath, '相对路径') },
      {
        id: 'send-to-term',
        label: '发送路径到当前终端',
        disabled: !canSendToTerminal,
        onSelect: () => onSendPathToTerminal(activePath),
      },
      { kind: 'sep' },
      {
        id: 'reveal',
        label: missing ? (isMacClient() ? '在访达中打开所在目录' : '在文件资源管理器中打开所在目录') : revealFileLabel,
        onSelect: () => void openInSystem(missing ? parentDir : activePath, 'reveal'),
      },
      ...(!missing ? [
        { id: 'open-editor', label: '在外部编辑器中打开', onSelect: () => void openInSystem(activePath, 'editor') },
        { kind: 'sep' as const },
        { id: 'rename', label: '重命名…', onSelect: () => promptRename(activePath, 'file') },
        { id: 'delete', label: '删除', danger: true, onSelect: () => void deleteEntry(activePath, 'file') },
      ] : []),
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items, targetKey: 'filebar' });
  };

  const manualRefresh = () => {
    if (!projectId) return;
    if (tab === 'changes') {
      void fetchChanges(projectId, false, true);
      treeStaleRef.current = true;
    } else {
      void fetchTreeDir(projectId, '');
      for (const d of expanded) void fetchTreeDir(projectId, d);
      setChangesStale(true);
    }
    if (activePath && !isDirty) {
      if (tab === 'changes') void loadDiffFile(projectId, activePath, true);
      else void loadTreeFile(projectId, activePath, true);
    } else {
      void checkExternalUpdate();
    }
  };

  const isChangesReady = changesLoadedFor === projectId && !changesError;
  const dirtyCount = isChangesReady && !changesStale
    ? (changesGit?.dirty ?? changes.length)
    : (git?.dirty ?? (isChangesReady ? (changesGit?.dirty ?? changes.length) : 0));
  const branchLabel = (git ?? changesGit)?.branch;

  const filteredChanges = useMemo(() => {
    const q = changeFilter.trim().toLowerCase();
    if (!q) return changes;
    return changes.filter((item) => item.path.toLowerCase().includes(q) || (item.origPath && item.origPath.toLowerCase().includes(q)));
  }, [changes, changeFilter]);

  const showChangeList = isChangesReady && !changesError && changesGit !== null && changes.length > 0;
  const isVirtualChanges = showChangeList && filteredChanges.length > CHANGE_VIRTUAL_THRESHOLD;
  const changeVirt = useVirtualContainer(changeListRef, tab === 'changes' && isVirtualChanges);
  const { setScrollTop: setChangeScrollTop } = changeVirt;

  useEffect(() => {
    setChangeScrollTop(0);
    if (changeListRef.current) changeListRef.current.scrollTop = 0;
  }, [changeFilter, projectId, tab, setChangeScrollTop]);

  const changeSlice = useMemo(
    () => (isVirtualChanges
      ? computeVirtualSlice(filteredChanges.length, changeVirt.scrollTop, changeVirt.height, CHANGE_ROW_REM, changeVirt.remPx, CHANGE_OVERSCAN)
      : { startIdx: 0, endIdx: filteredChanges.length, topPad: 0, bottomPad: 0 }),
    [isVirtualChanges, filteredChanges.length, changeVirt.scrollTop, changeVirt.height, changeVirt.remPx],
  );
  const visibleChanges = useMemo(
    () => filteredChanges.slice(changeSlice.startIdx, changeSlice.endIdx),
    [filteredChanges, changeSlice.startIdx, changeSlice.endIdx],
  );

  const flatTreeRows = useMemo(() => {
    const out: Array<{ entry: TreeEntry; depth: number }> = [];
    const walk = (dirPosix: string, depth: number) => {
      if (depth > 64) return;
      const list = treeMap[dirPosix];
      if (!list) return;
      for (const entry of list) {
        out.push({ entry, depth });
        if (entry.kind === 'dir' && expanded.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };
    walk('', 0);
    return out;
  }, [treeMap, expanded]);

  const rootTreeEntries = treeMap[''];
  const isVirtualTree = !!rootTreeEntries?.length && flatTreeRows.length > TREE_VIRTUAL_THRESHOLD;
  const treeVirt = useVirtualContainer(treeScrollRef, tab === 'files' && isVirtualTree);
  const { setScrollTop: setTreeScrollTop } = treeVirt;

  useEffect(() => {
    if (pendingScrollPathRef.current && tab === 'files') return;
    setTreeScrollTop(0);
    if (treeScrollRef.current) treeScrollRef.current.scrollTop = 0;
  }, [projectId, tab, setTreeScrollTop]);

  // Scroll the file tree to bring a located/created entry into view (works for both plain and virtualized trees).
  useEffect(() => {
    const target = pendingScrollPathRef.current;
    if (!target || tab !== 'files') return;
    const idx = flatTreeRows.findIndex((r) => r.entry.path === target);
    if (idx === -1) return;
    pendingScrollPathRef.current = null;
    const scroller = treeScrollRef.current;
    if (!scroller) return;
    const rowPx = TREE_ROW_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const desiredTop = Math.max(0, idx * rowPx - Math.max(0, scroller.clientHeight - rowPx) / 2);
    scroller.scrollTop = desiredTop;
    setTreeScrollTop(desiredTop);
  }, [tab, flatTreeRows, setTreeScrollTop]);

  const treeSlice = useMemo(
    () => (isVirtualTree
      ? computeVirtualSlice(flatTreeRows.length, treeVirt.scrollTop, treeVirt.height, TREE_ROW_REM, treeVirt.remPx, TREE_OVERSCAN)
      : { startIdx: 0, endIdx: flatTreeRows.length, topPad: 0, bottomPad: 0 }),
    [isVirtualTree, flatTreeRows.length, treeVirt.scrollTop, treeVirt.height, treeVirt.remPx],
  );
  const visibleTreeRows = useMemo(
    () => flatTreeRows.slice(treeSlice.startIdx, treeSlice.endIdx),
    [flatTreeRows, treeSlice.startIdx, treeSlice.endIdx],
  );

  return (
    <section
      className="inspector"
      ref={rootRef}
      tabIndex={-1}
      data-testid="inspector"
      data-project-id={projectId}
      onKeyDown={onPanelKeyDown}
    >
      <header className="insp-header">
        <button
          type="button"
          className={`icon-btn ${sideOpen ? 'on' : ''}`}
          data-testid="insp-toggle-side"
          title={sideOpen ? '收起文件栏' : '展开文件栏'}
          onClick={() => setSideOpen((v) => !v)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <path d="M6 2.5v11" />
          </svg>
        </button>

        <span className="seg insp-tabs" role="tablist" aria-label="检视面板">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            className={`ghost seg-btn ${tab === 'changes' ? 'on' : ''}`}
            data-testid="insp-tab-changes"
            onClick={() => {
              if (tab === 'changes') return;
              if (!confirmDiscardDraft()) return;
              setTab('changes');
            }}
          >
            变更{dirtyCount > 0 && <span className="insp-count" data-testid="insp-dirty-count">{dirtyCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            className={`ghost seg-btn ${tab === 'files' ? 'on' : ''}`}
            data-testid="insp-tab-files"
            onClick={() => {
              if (tab === 'files') return;
              if (!confirmDiscardDraft()) return;
              setTab('files');
            }}
          >
            文件
          </button>
        </span>

        {projects.length > 0 && (
          <select
            className="insp-project-select"
            data-testid="insp-project-select"
            data-private=""
            aria-label="当前检视项目"
            value={projectId}
            onChange={(e) => {
              const nextId = e.target.value;
              if (nextId !== projectId && confirmDiscardDraft()) onSelectProject(nextId);
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {branchLabel && (
          <span className="insp-branch" data-private="" title={`分支 ${branchLabel}`}>
            {branchLabel}
          </span>
        )}

        <div className="insp-head-actions">
          {tab === 'files' && project && (
            <button
              type="button"
              className="icon-btn"
              data-testid="insp-quick-find"
              title="快速搜索文件（Ctrl+P）"
              onClick={() => void openFinder()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25" />
                <path d="M10.25 10.25L13.5 13.5" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            data-testid="insp-refresh"
            title="刷新状态与文件内容"
            disabled={!project}
            onClick={manualRefresh}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13 8a5 5 0 1 1-1.4-3.5M13 3v2.8h-2.8" />
            </svg>
          </button>
          <button
            type="button"
            className="ghost insp-ext-btn"
            data-testid="insp-open-external"
            title="在外部编辑器（VS Code）、系统默认程序（图片、音视频、PDF）或资源管理器中打开"
            disabled={!project}
            onClick={() => void openExternal()}
          >
            外部打开
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="insp-close"
            aria-label="关闭文件面板"
            title="关闭变更与文件面板（Alt+E）"
            onClick={() => {
              if (confirmDiscardDraft()) onClose();
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        </div>
      </header>

      {!project ? (
        <div className="insp-empty">
          <div>还没有可查看的项目</div>
          <div className="pane-empty-hint">先在左侧新建或选择一个项目</div>
        </div>
      ) : (
        <div className="insp-body">
          {sideOpen && (
            <aside className="insp-side" data-testid="insp-side">
              {tab === 'changes' ? (
                changesError ? (
                  <div className="insp-empty-hint" data-testid="insp-changes-error">
                    <div>{changesError}</div>
                    <button
                      type="button"
                      className="ghost insp-retry-btn"
                      data-testid="insp-retry"
                      onClick={() => void fetchChanges(projectId, !changePath, true)}
                    >
                      重试
                    </button>
                  </div>
                ) : !isChangesReady ? (
                  <div className="insp-empty-hint" data-testid="insp-loading-hint">正在检查工作区改动…</div>
                ) : changesGit === null ? (
                  <div className="insp-empty-hint">当前目录不是 Git 仓库，可切到「文件」标签浏览编辑。</div>
                ) : changes.length === 0 ? (
                  <div className="insp-empty-hint" data-testid="insp-clean-hint">工作区干净，没有未提交的改动。</div>
                ) : (
                  <>
                    {(changes.length >= 15 || changeFilter !== '') && (
                      <div className="change-filter-bar">
                        <input
                          type="text"
                          className="change-filter-input"
                          data-testid="change-filter-input"
                          placeholder="过滤路径…"
                          value={changeFilter}
                          onChange={(e) => setChangeFilter(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape' && changeFilter) {
                              e.stopPropagation();
                              setChangeFilter('');
                            }
                          }}
                        />
                        {changeFilter && (
                          <button
                            type="button"
                            className="icon-btn change-filter-clear"
                            title="清空过滤"
                            onClick={() => setChangeFilter('')}
                          >
                            ×
                          </button>
                        )}
                        <span className="change-filter-count">
                          {changeFilter ? `${filteredChanges.length}/${changes.length}` : changes.length}
                        </span>
                      </div>
                    )}
                    {changesTruncated && (
                      <div className="insp-trunc-hint" data-testid="insp-trunc-hint">
                        改动过多，仅展示前 {changes.length} 项（可输入路径过滤）
                      </div>
                    )}
                    {filteredChanges.length === 0 ? (
                      <div className="insp-empty-hint">没有匹配「{changeFilter}」的改动</div>
                    ) : (
                      <div
                        ref={changeListRef}
                        className={`insp-change-list${isVirtualChanges ? ' is-virtual' : ''}`}
                        data-testid="insp-change-list"
                        onScroll={isVirtualChanges ? (e) => changeVirt.setScrollTop(e.currentTarget.scrollTop) : undefined}
                      >
                        {changeSlice.topPad > 0 && <div style={{ height: changeSlice.topPad, flex: 'none' }} aria-hidden="true" />}
                        {visibleChanges.map((item) => {
                          const { dir, base } = splitDirBase(item.path);
                          const on = changePath === item.path;
                          return (
                            <div
                              key={item.path}
                              className={`change-row ${on ? 'on' : ''} ${ctxMenu?.targetKey === `change:${item.path}` ? 'ctx-active' : ''}`}
                              tabIndex={0}
                              data-testid="change-entry"
                              data-path={item.path}
                              data-status={item.status}
                              onContextMenu={(e) => openChangeEntryMenu(e, item)}
                              onKeyDown={(e) => {
                                if (isContextMenuKey(e)) {
                                  e.preventDefault();
                                  const pt = contextMenuPointForElement(e.currentTarget);
                                  openChangeEntryMenuAt(pt.x, pt.y, item);
                                }
                              }}
                              onClick={() => {
                                if (changePath === item.path) return;
                                if (!confirmDiscardDraft()) return;
                                setChangePath(item.path);
                                setChangeMode('diff');
                              }}
                            >
                              <span className={`git-badge st-${item.status === '?' ? 'U2' : item.status}`} title={STATUS_TITLE[item.status]}>
                                {item.status}
                              </span>
                              <span className="change-names" data-private="" title={item.origPath ? `${item.origPath} → ${item.path}` : item.path}>
                                <span className="change-base">{base}</span>
                                {dir && <span className="change-dir">{dir}</span>}
                              </span>
                              <span className="change-numstat">
                                {item.added !== null && item.added > 0 && <span className="num-add">+{item.added}</span>}
                                {item.deleted !== null && item.deleted > 0 && <span className="num-del">-{item.deleted}</span>}
                              </span>
                              <button
                                type="button"
                                className="icon-btn change-discard"
                                data-testid="discard-file"
                                title={item.status === '?' ? '删除未跟踪文件' : '放弃未提交改动并还原到 HEAD'}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void discardSingle(item);
                                }}
                              >
                                <svg viewBox="0 0 16 16" aria-hidden="true">
                                  <path d="M4.5 6.5H10a3 3 0 1 1 0 6H7M6.5 4L4 6.5 6.5 9" />
                                </svg>
                              </button>
                            </div>
                          );
                        })}
                        {changeSlice.bottomPad > 0 && <div style={{ height: changeSlice.bottomPad, flex: 'none' }} aria-hidden="true" />}
                      </div>
                    )}
                  </>
                )
              ) : (
                <div className="insp-tree" data-testid="insp-tree" onContextMenu={openTreeRootMenu}>
                  <button type="button" className="tree-search-bar" data-testid="tree-search-trigger" onClick={() => void openFinder()}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="7" cy="7" r="4.25" />
                      <path d="M10.25 10.25L13.5 13.5" />
                    </svg>
                    <span>搜索文件…</span>
                    <kbd>Ctrl+P</kbd>
                  </button>
                  {!rootTreeEntries ? (
                    <div className="insp-empty-hint">读取目录中…</div>
                  ) : rootTreeEntries.length === 0 ? (
                    <div className="insp-empty-hint">空目录</div>
                  ) : (
                    <div
                      ref={treeScrollRef}
                      className="tree-scroll"
                      onScroll={isVirtualTree ? (e) => treeVirt.setScrollTop(e.currentTarget.scrollTop) : undefined}
                    >
                      {treeSlice.topPad > 0 && <div style={{ height: treeSlice.topPad }} aria-hidden="true" />}
                      {visibleTreeRows.map(({ entry, depth }) => {
                        const isOpen = entry.kind === 'dir' && expanded.has(entry.path);
                        const isSelected = entry.kind === 'file' && filePath === entry.path;
                        const isCut = fsClipboard?.mode === 'cut' && fsClipboard.projectId === projectId && fsClipboard.path === entry.path;
                        const isCtx = ctxMenu?.targetKey === `tree:${entry.path}`;
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            className={`tree-row ${entry.kind} ${isSelected ? 'on' : ''} ${entry.ignored ? 'ignored' : ''} ${isCut ? 'is-cut' : ''} ${isCtx ? 'ctx-active' : ''}`}
                            style={{ paddingLeft: `${0.5 + depth * 0.8125}rem` }}
                            data-testid="tree-entry"
                            data-path={entry.path}
                            data-kind={entry.kind}
                            onContextMenu={(e) => openTreeEntryMenu(e, entry)}
                            onKeyDown={(e) => {
                              if (isContextMenuKey(e)) {
                                e.preventDefault();
                                const pt = contextMenuPointForElement(e.currentTarget);
                                openTreeEntryMenuAt(pt.x, pt.y, entry);
                              }
                            }}
                            onClick={() => (entry.kind === 'dir' ? toggleDir(entry.path) : pickFileFromTreeOrFinder(entry.path))}
                          >
                            {entry.kind === 'dir' ? (
                              <svg className={`tree-chev ${isOpen ? 'open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M6 4l4 4-4 4" />
                              </svg>
                            ) : (
                              <span className="tree-file-dot" />
                            )}
                            <span className="tree-name" data-private="">{entry.name}</span>
                            {entry.gitStatus && (
                              <span className={`git-badge st-${entry.gitStatus === '?' ? 'U2' : entry.gitStatus}`} title={STATUS_TITLE[entry.gitStatus]}>
                                {entry.gitStatus}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {treeSlice.bottomPad > 0 && <div style={{ height: treeSlice.bottomPad }} aria-hidden="true" />}
                    </div>
                  )}
                </div>
              )}
            </aside>
          )}

          <div className="insp-main" data-testid="insp-main">
            {activePath ? (
              <>
                <div className="insp-filebar" data-testid="insp-filebar">
                  <span
                    className={`insp-filepath ${ctxMenu?.targetKey === 'filebar' ? 'ctx-active' : ''}`}
                    data-testid="insp-filepath"
                    data-private=""
                    title={activePath}
                    onContextMenu={openFilebarMenu}
                  >
                    {activePath}
                  </span>
                  {isDirty && <span className="unsaved-dot" data-testid="unsaved-dot" title="有未保存的修改">● 未保存</span>}

                  <div className="insp-filebar-right">
                    {tab === 'changes' && diffData && !diffData.binary && !diffData.tooLarge && !diffData.isDirectory && diffData.status !== 'D' && (
                      <span className="seg" role="radiogroup" aria-label="变更视图">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={changeMode === 'diff'}
                          className={`ghost seg-btn ${changeMode === 'diff' ? 'on' : ''}`}
                          data-testid="mode-diff"
                          onClick={() => {
                            if (changeMode === 'diff') return;
                            if (isDirty && !confirm('切换回对比视图前尚未保存，未保存内容仍会保留在编辑草稿中。切回对比视图会展示已保存磁盘版本，确定切换吗？')) return;
                            setChangeMode('diff');
                          }}
                        >
                          对比
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={changeMode === 'edit'}
                          className={`ghost seg-btn ${changeMode === 'edit' ? 'on' : ''}`}
                          data-testid="mode-edit"
                          onClick={() => setChangeMode('edit')}
                        >
                          编辑
                        </button>
                      </span>
                    )}

                    {tab === 'files' && fileData?.kind === 'text' && isMarkdownPath(activePath) && (
                      <span className="seg" role="radiogroup" aria-label="Markdown 视图">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={mdMode === 'preview'}
                          className={`ghost seg-btn ${mdMode === 'preview' ? 'on' : ''}`}
                          data-testid="md-mode-preview"
                          onClick={() => setMdMode('preview')}
                        >
                          预览
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={mdMode === 'source'}
                          className={`ghost seg-btn ${mdMode === 'source' ? 'on' : ''}`}
                          data-testid="md-mode-source"
                          onClick={() => setMdMode('source')}
                        >
                          源码
                        </button>
                      </span>
                    )}

                    {((tab === 'changes' && changeMode === 'edit' && diffData && !diffData.binary && !diffData.tooLarge && !diffData.isDirectory && diffData.status !== 'D')
                      || (tab === 'files' && fileData?.kind === 'text' && (!isMarkdownPath(activePath) || mdMode === 'source'))) && (
                      <button
                        type="button"
                        className={isDirty ? 'primary save-btn' : 'ghost save-btn'}
                        data-testid="save-file"
                        disabled={!isDirty || saving}
                        title="保存到磁盘（Ctrl+S）"
                        onClick={() => void saveCurrent(false)}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    )}
                  </div>
                </div>

                {conflict && (
                  <div className="insp-conflict" data-testid="insp-conflict" role="alert">
                    <span>磁盘上的文件已被外部（如 Agent）更新，尚未覆盖你的修改。</span>
                    <div className="insp-conflict-actions">
                      <button
                        type="button"
                        data-testid="conflict-reload"
                        onClick={() => {
                          if (tab === 'changes') void loadDiffFile(projectId, activePath, true);
                          else void loadTreeFile(projectId, activePath, true);
                        }}
                      >
                        重新加载磁盘版本
                      </button>
                      <button
                        type="button"
                        className="primary"
                        data-testid="conflict-overwrite"
                        onClick={() => void saveCurrent(true)}
                      >
                        保留并覆盖
                      </button>
                    </div>
                  </div>
                )}

                <div className="insp-viewport">
                  {loadingDoc ? (
                    <div className="insp-placeholder">正在加载…</div>
                  ) : tab === 'changes' ? (
                    !diffData ? (
                      <div className="insp-placeholder">选择左侧改动文件查看对比</div>
                    ) : diffData.isDirectory ? (
                      <div className="insp-placeholder" data-testid="guard-directory">
                        <div>该项是子目录或嵌套 Git 仓库，不支持文本对比。</div>
                        <button type="button" onClick={() => void openExternal()}>在外部打开</button>
                      </div>
                    ) : diffPreview && diffData.status !== 'D' && (diffData.binary || diffData.tooLarge) ? (
                      <RawPreview
                        key={diffRawSrc}
                        kind={diffPreview.kind}
                        src={diffRawSrc}
                        path={diffData.path}
                        size={diffData.size}
                        onOpenExternal={() => void openExternal()}
                      />
                    ) : diffData.tooLarge ? (
                      <div className="insp-placeholder" data-testid="guard-too-large">
                        <div>文件体积较大（{formatBytes(diffData.size)}），为保证流畅不在面板内渲染对比。</div>
                        <button type="button" onClick={() => void openExternal()}>在外部编辑器打开</button>
                      </div>
                    ) : diffData.binary ? (
                      <div className="insp-placeholder" data-testid="guard-binary">
                        <div>二进制文件（{formatBytes(diffData.size)}），不支持文本对比。</div>
                        <button type="button" onClick={() => void openExternal()}>在外部打开</button>
                      </div>
                    ) : changeMode === 'diff' || diffData.status === 'D' ? (
                      <CodeEditor
                        docKey={`diff:${projectId}:${activePath}:${diffData.mtimeMs ?? 0}`}
                        filePath={activePath}
                        value={diffData.head}
                        baseValue={diffData.base}
                        mode="diff"
                        readOnly
                        jump={jump}
                      />
                    ) : (
                      <CodeEditor
                        docKey={`cedit:${projectId}:${activePath}`}
                        filePath={activePath}
                        value={draft}
                        mode="edit"
                        externalRev={externalRev}
                        jump={jump}
                        onChange={setDraft}
                        onSave={() => void saveCurrent(false)}
                      />
                    )
                  ) : !fileData ? (
                    <div className="insp-placeholder">选择左侧文件查看或编辑</div>
                  ) : fileData.kind === 'missing' ? (
                    <div className="insp-placeholder" data-testid="guard-missing">文件不存在或已被移除</div>
                  ) : fileData.kind === 'image' || fileData.kind === 'video' || fileData.kind === 'audio' || fileData.kind === 'pdf' ? (
                    <RawPreview
                      key={fileRawSrc}
                      kind={fileData.kind}
                      src={fileRawSrc}
                      path={fileData.path}
                      size={fileData.size}
                      onOpenExternal={() => void openExternal()}
                    />
                  ) : fileData.kind === 'too_large' ? (
                    <div className="insp-placeholder" data-testid="guard-too-large">
                      <div>文件超过 2 MB（{formatBytes(fileData.size)}），为避免卡顿已拦截内置加载。</div>
                      <button type="button" onClick={() => void openExternal()}>在外部编辑器打开</button>
                    </div>
                  ) : fileData.kind === 'binary' ? (
                    <div className="insp-placeholder" data-testid="guard-binary">
                      <div>二进制文件（{formatBytes(fileData.size)}），不支持文本编辑。</div>
                      <button type="button" onClick={() => void openExternal()}>在外部打开</button>
                    </div>
                  ) : isMarkdownPath(activePath) && mdMode === 'preview' ? (
                    <MarkdownPreview
                      projectId={projectId}
                      filePath={activePath}
                      content={draft}
                      onOpenRelPath={(rel, line) => pickFileFromTreeOrFinder(rel, line)}
                    />
                  ) : (
                    <CodeEditor
                      docKey={`fedit:${projectId}:${activePath}`}
                      filePath={activePath}
                      value={draft}
                      mode="edit"
                      externalRev={externalRev}
                      jump={jump}
                      onChange={setDraft}
                      onSave={() => void saveCurrent(false)}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="insp-placeholder">
                {tab === 'changes'
                  ? (changesError
                    ? '改动列表读取失败，请在左侧点击重试'
                    : !isChangesReady
                      ? '正在检查工作区改动…'
                      : changes.length
                        ? (changes.length > AUTO_PICK_LIMIT
                          ? `共有 ${changes.length} 项改动（已跳过自动对比以防卡顿），请点击左侧文件或使用过滤框选择`
                          : '点击左侧改动文件查看行内对比或直接编辑')
                        : '当前项目没有未提交改动，可切到「文件」浏览代码')
                  : '从左侧目录树选择文件，或按 Ctrl+P 快速搜索文件'}
              </div>
            )}
          </div>

          {finderOpen && (
            <div className="insp-finder-backdrop" data-testid="file-finder" onClick={() => setFinderOpen(false)}>
              <div className="insp-finder" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  className="insp-finder-input"
                  data-testid="file-finder-input"
                  placeholder="输入文件名快速跳转（如 .env、App.tsx）…"
                  value={finderQuery}
                  autoFocus
                  onChange={(e) => {
                    setFinderQuery(e.target.value);
                    setFinderIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setFinderOpen(false);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setFinderIdx((i) => (filteredFiles.length ? (i + 1) % filteredFiles.length : 0));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setFinderIdx((i) => (filteredFiles.length ? (i - 1 + filteredFiles.length) % filteredFiles.length : 0));
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const chosen = filteredFiles[finderIdx];
                      if (chosen) pickFileFromTreeOrFinder(chosen);
                      else if (finderLoading) pendingEnterRef.current = true;
                    }
                  }}
                />
                <div className="insp-finder-list">
                  {filteredFiles.length === 0 ? (
                    <div className="insp-empty-hint">没有匹配的文件</div>
                  ) : (
                    filteredFiles.map((f, idx) => {
                      const { dir, base } = splitDirBase(f);
                      return (
                        <button
                          key={f}
                          type="button"
                          className={`finder-item ${idx === finderIdx ? 'on' : ''}`}
                          data-testid="file-finder-item"
                          data-path={f}
                          onMouseEnter={() => setFinderIdx(idx)}
                          onClick={() => pickFileFromTreeOrFinder(f)}
                        >
                          <span className="change-base" data-private="">{base}</span>
                          {dir && <span className="change-dir" data-private="">{dir}</span>}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <NamePromptDialog config={namePrompt} onClose={() => setNamePrompt(null)} />
    </section>
  );
}
