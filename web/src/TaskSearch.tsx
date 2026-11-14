import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SessionInfo, Task } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { STATUS_LABEL, taskActivityAt } from './util.ts';

const MAX_RESULTS = 50;

// Running tasks first, stopped ones next, archived last; most recently active first within each.
const rank = (t: Task, s?: SessionInfo) => (t.phase === 'archived' ? 2 : !s || s.status === 'exited' ? 1 : 0);

// Alt+K palette: type to filter tasks by title or project name, ↑/↓ to move, Enter to open, Esc to close.
export function TaskSearch({ tasks, projects, sessionsById, onPick, onClose }: {
  tasks: Task[];
  projects: Project[];
  sessionsById: Map<string, SessionInfo>;
  onPick(task: Task): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const session = (t: Task) => (t.sessionId ? sessionsById.get(t.sessionId) : undefined);
    return tasks
      .filter((t) => !q || t.title.toLowerCase().includes(q) || (names.get(t.projectId) ?? '').toLowerCase().includes(q))
      .map((t) => {
        const s = session(t);
        return { t, r: rank(t, s), act: taskActivityAt(t, s), started: s?.startedAt ?? 0 };
      })
      .sort((a, b) => a.r - b.r || b.act - a.act || b.started - a.started || b.t.createdAt - a.t.createdAt)
      .slice(0, MAX_RESULTS)
      .map((x) => x.t);
  }, [tasks, names, sessionsById, query]);

  useEffect(() => {
    listRef.current?.querySelector('.search-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel, results]);

  const move = (dir: number) => setSel((i) => (results.length ? (i + dir + results.length) % results.length : 0));

  return (
    <div className="overlay search-overlay" data-testid="task-search" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal" role="dialog" aria-label="搜索任务">
        <input
          autoFocus
          data-testid="task-search-input"
          placeholder="按任务标题或项目名搜索"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') {
              e.preventDefault();
              const t = results[sel];
              if (t) onPick(t);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="search-list" ref={listRef} role="listbox">
          {results.map((t, i) => {
            const s = t.sessionId ? sessionsById.get(t.sessionId) : undefined;
            const state = t.phase === 'archived' ? '已归档' : s ? STATUS_LABEL[s.status] : '已退出';
            return (
              <div
                key={t.id}
                role="option"
                aria-selected={i === sel}
                className={`search-item ${i === sel ? 'on' : ''}`}
                data-testid="task-search-item"
                data-session-id={s?.id ?? ''}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => onPick(t)}
              >
                <span className="agent-mark"><AgentIcon agent={t.agent} /></span>
                <span className="search-title" data-private="">{t.title}</span>
                <span className="search-project" data-private="">{names.get(t.projectId) ?? ''}</span>
                <span className="search-state">{state}</span>
              </div>
            );
          })}
          {!results.length && <div className="search-empty">没有匹配的任务</div>}
        </div>
      </div>
    </div>
  );
}
