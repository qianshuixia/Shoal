import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangedFile, ChangeStatus, DiffPayload, FileListResult, FilePayload, GitInfo, Project, ProjectChanges, TreeEntry, TreeListing, WriteFileResult,
} from '../../shared/protocol.ts';
import { CodeEditor, type JumpTarget } from './Editor.tsx';
import { MarkdownPreview } from './MarkdownPreview.tsx';

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

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

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

export function Inspector({
  project, projects, git, watchRev, openRequest, onSelectProject, onClose, onNotice,
}: InspectorProps) {
  const memRef = useRef<Map<string, ProjectViewMem>>(new Map());
  const rootRef = useRef<HTMLElement>(null);

  const [tab, setTab] = useState<InspectorTab>(() => (git && git.dirty > 0 ? 'changes' : 'files'));
  const [sideOpen, setSideOpen] = useState(true);

  // Changes tab state
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesGit, setChangesGit] = useState<GitInfo | null>(null);
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
    if (tab === 'changes') return !!diffData && !diffData.binary && !diffData.tooLarge && diffData.status !== 'D';
    return fileData?.kind === 'text';
  }, [activePath, tab, diffData, fileData]);
  const isDirty = isEditingText && draft !== savedText;

  const liveRef = useRef({ projectId, tab, activePath, isDirty, loadedMtime, changeMode, mdMode });
  liveRef.current = { projectId, tab, activePath, isDirty, loadedMtime, changeMode, mdMode };

  const confirmDiscardDraft = useCallback((): boolean => {
    if (!liveRef.current.isDirty) return true;
    return confirm('当前打开的文件有未保存修改，确定放弃这些修改吗？');
  }, []);

  // Fetch changes list for a project
  const fetchChanges = useCallback(async (pid: string, autoPick = false) => {
    if (!pid) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/changes`);
      if (!res.ok) return;
      const json = (await res.json()) as ProjectChanges;
      if (liveRef.current.projectId !== pid) return;
      setChanges(json.files);
      setChangesGit(json.git);
      if (autoPick) {
        setChangePath((prev) => {
          if (prev && json.files.some((f) => f.path === prev)) return prev;
          return json.files[0]?.path ?? null;
        });
      }
    } catch {
      // ignore transient network error
    }
  }, []);

  // Fetch one directory level for the file tree
  const fetchTreeDir = useCallback(async (pid: string, dirPosix: string) => {
    if (!pid) return;
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
    if (!silent) setLoadingDoc(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/diff?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (!silent) onNotice(err.error ?? `读取对比失败 (${res.status})`);
        return;
      }
      const json = (await res.json()) as DiffPayload;
      if (liveRef.current.projectId !== pid) return;
      setDiffData(json);
      setSavedText(json.head);
      setDraft(json.head);
      setLoadedMtime(json.mtimeMs);
      setConflict(false);
      if (silent) setExternalRev((n) => n + 1);
    } finally {
      if (!silent) setLoadingDoc(false);
    }
  }, [onNotice]);

  // Load file payload for the Files tab
  const loadTreeFile = useCallback(async (pid: string, relPath: string, silent = false) => {
    if (!pid || !relPath) return;
    if (!silent) setLoadingDoc(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/file?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (!silent) onNotice(err.error ?? `读取文件失败 (${res.status})`);
        return;
      }
      const json = (await res.json()) as FilePayload;
      if (liveRef.current.projectId !== pid) return;
      setFileData(json);
      const text = json.kind === 'text' ? (json.content ?? '') : '';
      setSavedText(text);
      setDraft(text);
      setLoadedMtime(json.mtimeMs);
      setConflict(false);
      if (silent) setExternalRev((n) => n + 1);
    } finally {
      if (!silent) setLoadingDoc(false);
    }
  }, [onNotice]);

  // Initialize / restore state when switching projects
  const prevProjectRef = useRef<string>('');
  useEffect(() => {
    if (!projectId) {
      prevProjectRef.current = '';
      setChanges([]);
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
    const defaultTab: InspectorTab = saved ? saved.tab : (git && git.dirty > 0 ? 'changes' : 'files');
    setTab(defaultTab);
    setChangePath(saved?.changeFile ?? null);
    setFilePath(saved?.treeFile ?? null);
    setExpanded(saved?.expanded ?? new Set());
    setDiffData(null);
    setFileData(null);
    setDraft('');
    setSavedText('');
    setLoadedMtime(null);
    setConflict(false);
    setTreeMap({});
    setFinderOpen(false);

    void fetchChanges(projectId, !saved?.changeFile);
    void fetchTreeDir(projectId, '');
    if (saved?.expanded) {
      for (const dir of saved.expanded) void fetchTreeDir(projectId, dir);
    }
  }, [projectId, git, fetchChanges, fetchTreeDir]);

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

    setTab(openRequest.tab);
    if (openRequest.tab === 'changes') {
      void fetchChanges(projectId, !openRequest.filePath);
      if (openRequest.filePath) {
        setChangePath(openRequest.filePath);
        setChangeMode(openRequest.line ? 'edit' : 'diff');
      }
    } else if (openRequest.filePath) {
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
    if (openRequest.line) {
      setJump({ line: openRequest.line, col: openRequest.col, seq: openRequest.seq });
    }
  }, [openRequest, projectId, fetchChanges, fetchTreeDir]);

  // Load active document whenever tab or selected path changes
  useEffect(() => {
    if (!projectId) return;
    if (tab === 'changes') {
      if (changePath) void loadDiffFile(projectId, changePath, false);
      else setDiffData(null);
    } else {
      if (filePath) void loadTreeFile(projectId, filePath, false);
      else setFileData(null);
    }
  }, [projectId, tab, changePath, filePath, loadDiffFile, loadTreeFile]);

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

  // Refresh when watchRev bumps (WS git / task Stop events), window focuses, or periodic 2.5s poll while open
  useEffect(() => {
    if (!projectId) return;
    void fetchChanges(projectId, false);
    void fetchTreeDir(projectId, '');
    for (const d of expanded) void fetchTreeDir(projectId, d);
    void checkExternalUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchRev]);

  useEffect(() => {
    if (!projectId) return;
    const onFocus = () => {
      void fetchChanges(projectId, false);
      void checkExternalUpdate();
    };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => void checkExternalUpdate(), 2500);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [projectId, fetchChanges, checkExternalUpdate]);

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
      // Refresh git changes & diff base/head so diff view reflects saved file
      void fetchChanges(projectId, false);
      void fetchTreeDir(projectId, splitDirBase(activePath).dir);
      if (tab === 'changes') {
        void loadDiffFile(projectId, activePath, true);
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
      await fetchChanges(projectId, true);
      void fetchTreeDir(projectId, '');
    } catch (e) {
      onNotice(`放弃改动失败：${(e as Error).message}`);
    }
  };

  // Open current file (or project folder) in external editor (VS Code)
  const openExternal = async () => {
    if (!project) return;
    const target = activePath ? `${project.path}\\${activePath.replace(/\//g, '\\')}` : project.path;
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        onNotice(json.error ?? `打开外部编辑器失败 (${res.status})`);
      }
    } catch (e) {
      onNotice(`打开外部编辑器失败：${(e as Error).message}`);
    }
  };

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

  const pickFileFromTreeOrFinder = useCallback((relPosix: string, line?: number) => {
    if (relPosix !== filePath && !confirmDiscardDraft()) return;
    setFinderOpen(false);
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
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPosix)) {
        next.delete(dirPosix);
      } else {
        next.add(dirPosix);
        if (projectId) void fetchTreeDir(projectId, dirPosix);
      }
      return next;
    });
  };

  const manualRefresh = () => {
    if (!projectId) return;
    void fetchChanges(projectId, false);
    void fetchTreeDir(projectId, '');
    for (const d of expanded) void fetchTreeDir(projectId, d);
    if (activePath && !isDirty) {
      if (tab === 'changes') void loadDiffFile(projectId, activePath, true);
      else void loadTreeFile(projectId, activePath, true);
    } else {
      void checkExternalUpdate();
    }
  };

  const renderTreeNodes = (dirPosix: string, depth: number): React.ReactNode => {
    const list = treeMap[dirPosix];
    if (!list) {
      return depth === 0 ? <div className="insp-empty-hint">读取目录中…</div> : null;
    }
    if (list.length === 0 && depth === 0) {
      return <div className="insp-empty-hint">空目录</div>;
    }
    return list.map((entry) => {
      const isOpen = entry.kind === 'dir' && expanded.has(entry.path);
      const isSelected = entry.kind === 'file' && filePath === entry.path;
      return (
        <div key={entry.path}>
          <button
            type="button"
            className={`tree-row ${entry.kind} ${isSelected ? 'on' : ''} ${entry.ignored ? 'ignored' : ''}`}
            style={{ paddingLeft: `${0.5 + depth * 0.8125}rem` }}
            data-testid="tree-entry"
            data-path={entry.path}
            data-kind={entry.kind}
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
          {isOpen && renderTreeNodes(entry.path, depth + 1)}
        </div>
      );
    });
  };

  const dirtyCount = changes.length || git?.dirty || changesGit?.dirty || 0;
  const branchLabel = (git ?? changesGit)?.branch;

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
            title="在外部编辑器（VS Code）或资源管理器中打开"
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
                changesGit === null && git === null ? (
                  <div className="insp-empty-hint">当前目录不是 Git 仓库，可切到「文件」标签浏览编辑。</div>
                ) : changes.length === 0 ? (
                  <div className="insp-empty-hint" data-testid="insp-clean-hint">工作区干净，没有未提交的改动。</div>
                ) : (
                  <div className="insp-change-list" data-testid="insp-change-list">
                    {changes.map((item) => {
                      const { dir, base } = splitDirBase(item.path);
                      const on = changePath === item.path;
                      return (
                        <div
                          key={item.path}
                          className={`change-row ${on ? 'on' : ''}`}
                          data-testid="change-entry"
                          data-path={item.path}
                          data-status={item.status}
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
                  </div>
                )
              ) : (
                <div className="insp-tree" data-testid="insp-tree">
                  <button type="button" className="tree-search-bar" data-testid="tree-search-trigger" onClick={() => void openFinder()}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="7" cy="7" r="4.25" />
                      <path d="M10.25 10.25L13.5 13.5" />
                    </svg>
                    <span>搜索文件…</span>
                    <kbd>Ctrl+P</kbd>
                  </button>
                  <div className="tree-scroll">{renderTreeNodes('', 0)}</div>
                </div>
              )}
            </aside>
          )}

          <div className="insp-main" data-testid="insp-main">
            {activePath ? (
              <>
                <div className="insp-filebar" data-testid="insp-filebar">
                  <span className="insp-filepath" data-testid="insp-filepath" data-private="" title={activePath}>
                    {activePath}
                  </span>
                  {isDirty && <span className="unsaved-dot" data-testid="unsaved-dot" title="有未保存的修改">● 未保存</span>}

                  <div className="insp-filebar-right">
                    {tab === 'changes' && diffData && !diffData.binary && !diffData.tooLarge && diffData.status !== 'D' && (
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

                    {((tab === 'changes' && changeMode === 'edit' && diffData && !diffData.binary && !diffData.tooLarge && diffData.status !== 'D')
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
                    ) : diffData.tooLarge ? (
                      <div className="insp-placeholder" data-testid="guard-too-large">
                        <div>文件体积较大（{formatBytes(diffData.size)}），为保证流畅不在面板内渲染对比。</div>
                        <button type="button" onClick={() => void openExternal()}>在外部编辑器打开</button>
                      </div>
                    ) : diffData.binary ? (
                      /\.(png|jpg|jpeg|gif|webp|bmp|ico|svg)$/i.test(activePath) && diffData.status !== 'D' ? (
                        <div className="insp-image-wrap" data-testid="image-preview">
                          <img
                            src={`/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(activePath)}&t=${diffData.mtimeMs ?? 0}`}
                            alt={activePath}
                          />
                          <div className="insp-image-meta">{formatBytes(diffData.size)}</div>
                        </div>
                      ) : (
                        <div className="insp-placeholder" data-testid="guard-binary">
                          <div>二进制文件（{formatBytes(diffData.size)}），不支持文本对比。</div>
                          <button type="button" onClick={() => void openExternal()}>在外部打开</button>
                        </div>
                      )
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
                  ) : fileData.kind === 'image' ? (
                    <div className="insp-image-wrap" data-testid="image-preview">
                      <img
                        src={`/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(activePath)}&t=${fileData.mtimeMs ?? 0}`}
                        alt={activePath}
                      />
                      <div className="insp-image-meta">{formatBytes(fileData.size)}</div>
                    </div>
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
                  ? (changes.length ? '点击左侧改动文件查看行内对比或直接编辑' : '当前项目没有未提交改动，可切到「文件」浏览代码')
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
    </section>
  );
}
