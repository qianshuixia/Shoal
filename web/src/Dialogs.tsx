import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePrivacy } from './privacy.ts';
import type { AgentKind, Card, CreateProjectBody, CreateTaskBody, DirListing, ForwardBody, Project, SessionInfo, Settings, Task } from '../../shared/protocol.ts';
import { AGENT_LABEL, FORWARD_NOTE, forwardText } from '../../shared/protocol.ts';

export async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(json.error ?? `请求失败 (${res.status})`), { code: json.code });
  return json as T;
}

async function getDirs(query: string): Promise<DirListing> {
  const res = await fetch(`/api/dirs${query}`);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `请求失败 (${res.status})`);
  return json as DirListing;
}

function DirBrowser({ start, onSelect }: { start: string; onSelect(dir: string): void }) {
  const privacy = usePrivacy();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const load = (query: string) => {
    const n = ++seq.current;
    getDirs(query).then(
      (l) => { if (n === seq.current) { setListing(l); setError(''); } },
      (e) => { if (n === seq.current) setError((e as Error).message); },
    );
  };
  useEffect(() => {
    load(start.trim() ? `?path=${encodeURIComponent(start.trim())}` : '');
  }, []);

  const canUp = listing !== null && listing.path !== null; // parent null at a drive root -> drive list
  const up = () => {
    if (!listing || listing.path === null) return;
    load(listing.parent ? `?path=${encodeURIComponent(listing.parent)}` : '?drives=1');
  };

  return (
    <div className="dir-browser" data-testid="dir-browser">
      <div className="dir-bar">
        <button type="button" data-testid="dir-up" disabled={!canUp} onClick={up}>上一级</button>
        <button type="button" data-testid="dir-drives" onClick={() => load('?drives=1')}>磁盘</button>
        <span className="dir-current" data-testid="dir-current" data-private="" title={privacy ? undefined : listing?.path ?? ''}>
          {listing ? (listing.path ?? '此电脑') : ''}
        </span>
      </div>
      {error && <div className="form-error" data-testid="dir-error">{error}</div>}
      <div className="dir-list">
        {listing?.entries.map((en) => (
          <button
            type="button"
            key={en.path}
            data-testid="dir-entry"
            data-private=""
            data-path={en.path}
            onClick={() => load(`?path=${encodeURIComponent(en.path)}`)}
          >{en.name}</button>
        ))}
        {listing && listing.entries.length === 0 && <div className="dir-empty">（没有子目录）</div>}
      </div>
      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="dir-select"
          disabled={!listing || listing.path === null}
          onClick={() => listing?.path && onSelect(listing.path)}
        >选择此目录</button>
      </div>
    </div>
  );
}

function Modal({ title, testId, onClose, onSubmit, children }: {
  title: ReactNode;
  testId?: string;
  onClose(): void;
  onSubmit(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        data-testid={testId}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

const AI_TITLES_TIP = [
  '开启后，任务的第一句需求发出时，工作台先用这句话的第一行当标题，同时在后台让这个任务所用的 CLI 以 headless 方式做一次短调用，写一个更短、更概括的标题，通常十几秒内换上。',
  '· 会消耗该 agent 的少量额度：Claude 用 Haiku；Codex 和 Antigravity 用各自的默认模型、最低推理档。每个任务只调用一次。',
  '· 这次调用不计入 Token 统计。',
  '· 你自己填写或改过的标题不会被替换；生成失败或超过 60 秒时保留第一行标题。',
  '· 只对开启之后发出第一句需求的任务生效，已有任务的标题不变。',
  '默认关闭。',
].join('\n');

// Changes are saved at once; the checkbox follows the server's value (settings arrive over the WebSocket).
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setAiTitles = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await post<Settings>('/api/settings', { aiTitles: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="设置" testId="settings-dialog" onClose={onClose} onSubmit={() => {}}>
      <div className="setting-row">
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="setting-ai-titles"
            checked={settings.aiTitles}
            onChange={(e) => void setAiTitles(e.target.checked)}
          />
          用 AI 自动起任务标题
        </label>
        <span className="help">
          <button type="button" className="help-btn" data-testid="setting-ai-titles-help" aria-label="说明" aria-describedby="tip-ai-titles">?</button>
          <span role="tooltip" id="tip-ai-titles" className="help-tip" data-testid="setting-ai-titles-tip">{AI_TITLES_TIP}</span>
        </span>
      </div>
      {error && <div className="form-error" data-testid="settings-error">{error}</div>}
      <div className="actions">
        <button type="button" data-testid="settings-close" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

export function ProjectDialog({ onClose, onCreated }: { onClose(): void; onCreated(p: Project): void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const pick = (dir: string) => {
    setPath(dir);
    if (!name.trim()) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
    setBrowsing(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: CreateProjectBody = { name: name.trim(), path: path.trim() };
      onCreated(await post<Project>('/api/projects', body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="新建项目" onClose={onClose} onSubmit={submit}>
      <label>名称<input data-testid="project-name" data-private="" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>路径
        <div className="path-row">
          <input data-testid="project-path" data-private="" value={path} placeholder="G:\Workspace\xxx" onChange={(e) => setPath(e.target.value)} />
          <button type="button" data-testid="project-browse" onClick={() => setBrowsing((b) => !b)}>浏览…</button>
        </div>
      </label>
      {browsing && <DirBrowser start={path} onSelect={pick} />}
      {error && <div className="form-error" data-testid="project-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 创建</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="project-submit" disabled={busy} onClick={submit}>创建</button>
      </div>
    </Modal>
  );
}

export function TaskDialog({ projects, agents, defaultProjectId, defaultAgent, size, onClose, onCreated }: {
  projects: Project[];
  agents: AgentKind[];
  defaultProjectId: string;
  defaultAgent(projectId: string): AgentKind;
  size: { cols: number; rows: number };
  onClose(): void;
  onCreated(r: { task: Task; session: SessionInfo }): void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentKind>(() => defaultAgent(defaultProjectId));
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: CreateTaskBody = { projectId, title: title.trim() || undefined, agent, prompt: prompt.trim() || undefined, ...size };
      onCreated(await post<{ task: Task; session: SessionInfo }>('/api/tasks', body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="新建任务" onClose={onClose} onSubmit={submit}>
      <label>项目
        <select
          data-testid="task-project"
          data-private=""
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setAgent(defaultAgent(e.target.value));
          }}
        >
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label><span>标题 <span className="opt">可选</span></span>
        <input data-testid="task-title" value={title} placeholder="留空则用第一句需求作标题" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>Agent
        <select data-testid="task-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label><span>需求 <span className="opt">可选，也可以启动后在终端里输入</span></span>
        <textarea data-testid="task-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {error && <div className="form-error" data-testid="task-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 创建</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="task-submit" disabled={busy} onClick={submit}>创建</button>
      </div>
    </Modal>
  );
}

export function SwitchDialog({ task, agents, onClose, onSwitch }: {
  task: Task;
  agents: AgentKind[];
  onClose(): void;
  onSwitch(agent: AgentKind, note: string): Promise<void>; // throws on failure
}) {
  const [agent, setAgent] = useState<AgentKind>(() => agents.find((a) => a !== task.agent) ?? agents[0] ?? task.agent);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSwitch(agent, note.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={<>换 agent：<span data-private="">{task.title}</span></>} testId="switch-dialog" onClose={onClose} onSubmit={submit}>
      <label>换成
        <select data-testid="switch-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <div className="hint">由 {AGENT_LABEL[agent]} 把当前进度整理成交接卡片，在这个面板里开新会话继续；原会话会被结束。</div>
      <label><span>补充说明 <span className="opt">可选</span></span>
        <textarea data-testid="switch-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="form-error" data-testid="switch-error">{error}</div>}
      {busy && <div className="hint" data-testid="switch-pending">正在整理交接卡片…</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 换</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="switch-submit" disabled={busy} onClick={submit}>换 agent</button>
      </div>
    </Modal>
  );
}

export function ForwardDialog({ source, card, sourceAgent, projects, tasks, agents, onClose, onForward }: {
  source: Task;
  card: Card;
  sourceAgent: AgentKind;
  projects: Project[];
  tasks: Task[];
  agents: AgentKind[];
  onClose(): void;
  onForward(to: ForwardBody['to'], note: string): Promise<void>; // throws on failure
}) {
  const others = (projectId: string) =>
    tasks.filter((t) => t.projectId === projectId && t.id !== source.id && t.phase !== 'archived').sort((a, b) => a.createdAt - b.createdAt);
  const [target, setTarget] = useState(() => {
    const first = others(source.projectId)[0];
    return first ? `task:${first.id}` : `new:${source.projectId}`;
  });
  const [agent, setAgent] = useState<AgentKind>(() => (agents.includes(source.agent) ? source.agent : agents[0] ?? source.agent));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = target.startsWith('new:');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const to: ForwardBody['to'] = isNew ? { projectId: target.slice(4), agent } : { taskId: target.slice(5) };
      await onForward(to, note.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="转发这张卡片" testId="forward-dialog" onClose={onClose} onSubmit={submit}>
      <label>转发到
        <select data-testid="forward-target" data-private="" value={target} onChange={(e) => setTarget(e.target.value)}>
          {projects.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {others(p.id).map((t) => <option key={t.id} value={`task:${t.id}`}>{t.title}</option>)}
              <option value={`new:${p.id}`}>新建任务</option>
            </optgroup>
          ))}
        </select>
      </label>
      {isNew && (
        <label>Agent
          <select data-testid="forward-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      )}
      <label><span>附言 <span className="opt">可选</span></span>
        <textarea data-testid="forward-note" rows={3} value={note} placeholder={FORWARD_NOTE} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>将发送的内容
        <pre className="preview" data-testid="forward-preview" data-private="">{forwardText({ title: source.title, agent: sourceAgent }, card.body, note)}</pre>
      </label>
      {error && <div className="form-error" data-testid="forward-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 转发</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="forward-submit" disabled={busy} onClick={submit}>转发</button>
      </div>
    </Modal>
  );
}

export function FeedbackDialog({ task, onClose, onFeedback }: {
  task: Task;
  onClose(): void;
  onFeedback(text: string): Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const blank = !text.trim();

  const submit = async () => {
    if (blank || busy) return;
    setBusy(true);
    const ok = await onFeedback(text);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal title={<>新会话继续：<span data-private="">{task.title}</span></>} testId="feedback-dialog" onClose={onClose} onSubmit={() => void submit()}>
      <div className="hint">在这个面板里开新会话继续（原会话会被结束），初始消息会带上任务需求、上一轮结果和你写的要求。要接着和当前会话对话，直接在终端里打字即可。</div>
      <label>接下来要做的事
        <textarea
          data-testid="feedback-input"
          rows={4}
          value={text}
          placeholder="写下接下来要做的事…"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 开新会话</span>
        <button type="button" data-testid="feedback-cancel" onClick={onClose}>取消</button>
        <button type="button" className="primary" data-testid="feedback-new" disabled={blank || busy} onClick={() => void submit()}>开新会话</button>
      </div>
    </Modal>
  );
}
