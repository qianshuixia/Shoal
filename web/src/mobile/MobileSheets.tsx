import { useEffect, useRef, useState } from 'react';
import type { AgentKind, Card, ForwardBody, Project, Task } from '../../../shared/protocol.ts';
import { agentLabel, AGY_MODELS, FORWARD_NOTE } from '../../../shared/protocol.ts';
import { mobilePatch, mobilePost, mobileUploadImage } from './api.ts';
import { clearDraft, loadDraft, NEW_TASK_DRAFT_KEY, saveDraft } from './drafts.ts';

function Sheet({ testId, title, onClose, children }: {
  testId: string;
  title: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="mob-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mob-sheet" data-testid={testId}>
        <div className="mob-task-top" style={{ justifyContent: 'space-between' }}>
          <h3>{title}</h3>
          <button type="button" className="mob-btn compact ghost" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function NewTaskSheet({
  projects,
  agents,
  defaultAgyModel,
  onCreated,
  onClose,
}: {
  projects: Project[];
  agents: AgentKind[];
  defaultAgyModel?: string;
  onCreated(taskId: string): void;
  onClose(): void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [agent, setAgent] = useState<AgentKind>(agents[0] ?? 'claude');
  const [agyModel, setAgyModel] = useState(defaultAgyModel ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState(() => loadDraft(NEW_TASK_DRAFT_KEY)?.text ?? '');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Draft of the requirement text; throttled, flushed on hide/unmount unless the task was created.
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const createdRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!createdRef.current) saveDraft(NEW_TASK_DRAFT_KEY, { text: promptRef.current, attachments: [] });
    }, 400);
    return () => clearTimeout(timer);
  }, [prompt]);
  useEffect(() => {
    const flush = () => {
      if (!createdRef.current) saveDraft(NEW_TASK_DRAFT_KEY, { text: promptRef.current, attachments: [] });
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    for (const f of Array.from(files)) {
      try {
        const name = await mobileUploadImage(f);
        setAttachments((prev) => [...prev, name]);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };

  const submit = async () => {
    if (busy || !projectId) return;
    setBusy(true);
    setError('');
    try {
      const res = await mobilePost<{ task: Task }>('/api/tasks', {
        projectId,
        agent,
        ...(agent === 'agy' && agyModel ? { model: agyModel } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        prompt: prompt.trim(),
        ...(attachments.length ? { attachments } : {}),
      });
      createdRef.current = true;
      clearDraft(NEW_TASK_DRAFT_KEY);
      onCreated(res.task.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet testId="mobile-new-task-sheet" title="新建任务" onClose={onClose}>
      <textarea
        className="mob-textarea"
        data-testid="mobile-new-task-prompt"
        autoFocus
        value={prompt}
        placeholder="描述需求…（也可以拍照或从相册附加截图）"
        onChange={(e) => setPrompt(e.target.value)}
      />

      <input
        className="mob-input"
        data-testid="mobile-new-task-title"
        value={title}
        placeholder="任务标题（可留空，自动从需求首行生成）"
        onChange={(e) => setTitle(e.target.value)}
      />

      <label className="mob-sub" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span>项目目录（仅可选电脑端已添加项目）</span>
        <select className="mob-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>

      <label className="mob-sub" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span>智能体</span>
        <select className="mob-input" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
          {agents.map((a) => (
            <option key={a} value={a}>{agentLabel(a)}</option>
          ))}
        </select>
      </label>

      {agent === 'agy' && (
        <label className="mob-sub" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>Antigravity 模型档位</span>
          <select className="mob-input" value={agyModel} onChange={(e) => setAgyModel(e.target.value)}>
            {AGY_MODELS.map((m) => (
              <option key={m.slug} value={m.slug}>{m.label}</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <label className="mob-btn compact" style={{ cursor: 'pointer' }}>
          📷 附截图
          <input
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        {attachments.map((name, idx) => (
          <span key={name} className="mob-attach-chip">
            {name}
            <button type="button" className="ghost" onClick={() => setAttachments((p) => p.filter((_, i) => i !== idx))}>×</button>
          </span>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}

      <button type="button" className="mob-btn primary" disabled={busy || !projectId || agents.length === 0} onClick={() => void submit()}>
        {busy ? '启动中…' : '创建并启动'}
      </button>
    </Sheet>
  );
}

export function SwitchAgentSheet({
  task,
  agents,
  onDone,
  onClose,
}: {
  task: Task;
  agents: AgentKind[];
  onDone(): void;
  onClose(): void;
}) {
  const candidates = agents.filter((a) => a !== task.agent);
  const [target, setTarget] = useState<AgentKind>(candidates[0] ?? agents[0] ?? task.agent);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mobilePost(`/api/tasks/${encodeURIComponent(task.id)}/switch`, {
        agent: target,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet testId="mobile-switch-sheet" title="切换智能体接力" onClose={onClose}>
      <label className="mob-sub" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span>接手智能体</span>
        <select className="mob-input" value={target} onChange={(e) => setTarget(e.target.value as AgentKind)}>
          {agents.map((a) => (
            <option key={a} value={a}>{agentLabel(a)}</option>
          ))}
        </select>
      </label>
      <textarea
        className="mob-textarea"
        value={note}
        placeholder="交接备注（可选）"
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div className="form-error">{error}</div>}
      <button type="button" className="mob-btn primary" disabled={busy || agents.length === 0} onClick={() => void submit()}>
        {busy ? '正在生成交接摘要…' : '确认换 Agent'}
      </button>
    </Sheet>
  );
}

export function ForwardSheet({
  sourceTask,
  card,
  tasks,
  agents,
  onForwarded,
  onClose,
}: {
  sourceTask: Task;
  card: Card;
  tasks: Task[];
  agents: AgentKind[];
  onForwarded(targetTaskId: string): void;
  onClose(): void;
}) {
  const peerTasks = tasks.filter((t) => t.id !== sourceTask.id && t.phase !== 'archived');
  const [mode, setMode] = useState<'existing' | 'new'>(peerTasks.length > 0 ? 'existing' : 'new');
  const [targetTaskId, setTargetTaskId] = useState(peerTasks[0]?.id ?? '');
  const [newAgent, setNewAgent] = useState<AgentKind>(agents.find((a) => a !== sourceTask.agent) ?? agents[0] ?? 'claude');
  const [note, setNote] = useState(FORWARD_NOTE);
  const [replyBack, setReplyBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: ForwardBody = {
        to: mode === 'existing' ? { taskId: targetTaskId } : { projectId: sourceTask.projectId, agent: newAgent },
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(replyBack ? { replyBack: true } : {}),
      };
      const res = await mobilePost<{ task: Task }>(`/api/cards/${encodeURIComponent(card.id)}/forward`, body);
      onForwarded(res.task.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet testId="mobile-forward-sheet" title="转发结果给另一个任务" onClose={onClose}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {peerTasks.length > 0 && (
          <button type="button" className={`mob-btn compact ${mode === 'existing' ? 'primary' : ''}`} onClick={() => setMode('existing')}>
            发给现有任务
          </button>
        )}
        <button type="button" className={`mob-btn compact ${mode === 'new' ? 'primary' : ''}`} onClick={() => setMode('new')}>
          新建任务接收
        </button>
      </div>

      {mode === 'existing' ? (
        <select className="mob-input" value={targetTaskId} onChange={(e) => setTargetTaskId(e.target.value)}>
          {peerTasks.map((t) => (
            <option key={t.id} value={t.id}>{t.title}（{agentLabel(t.agent)}）</option>
          ))}
        </select>
      ) : (
        <select className="mob-input" value={newAgent} onChange={(e) => setNewAgent(e.target.value as AgentKind)}>
          {agents.map((a) => (
            <option key={a} value={a}>{agentLabel(a)}</option>
          ))}
        </select>
      )}

      <textarea className="mob-textarea" value={note} onChange={(e) => setNote(e.target.value)} />

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={replyBack} onChange={(e) => setReplyBack(e.target.checked)} />
        对方完成后自动把结论回传给本任务
      </label>

      {error && <div className="form-error">{error}</div>}
      <button
        type="button"
        className="mob-btn primary"
        disabled={busy || (mode === 'existing' && !targetTaskId)}
        onClick={() => void submit()}
      >{busy ? '转发中…' : '确认转发'}</button>
    </Sheet>
  );
}

export function NewSessionSheet({
  task,
  onDone,
  onClose,
}: {
  task: Task;
  onDone(): void;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await mobilePost(`/api/tasks/${encodeURIComponent(task.id)}/feedback`, { text: text.trim(), mode: 'new' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet testId="mobile-new-session-sheet" title="用新会话继续此任务" onClose={onClose}>
      <div className="mob-sub" style={{ whiteSpace: 'normal' }}>
        开启新上下文窗口，并自动附带任务需求与上一轮最终结果。
      </div>
      <textarea
        className="mob-textarea"
        value={text}
        placeholder="输入下一步修改要求…"
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="form-error">{error}</div>}
      <button type="button" className="mob-btn primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
        {busy ? '正在发起…' : '开新会话并发送'}
      </button>
    </Sheet>
  );
}

export function RenameSheet({
  task,
  onDone,
  onClose,
}: {
  task: Task;
  onDone(): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await mobilePatch(`/api/tasks/${encodeURIComponent(task.id)}`, { title: title.trim() });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet testId="mobile-rename-sheet" title="重命名任务" onClose={onClose}>
      <input className="mob-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      {error && <div className="form-error">{error}</div>}
      <button type="button" className="mob-btn primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存'}
      </button>
    </Sheet>
  );
}
