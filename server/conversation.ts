import type { Card, ConversationItem, SessionActivity, SessionInfo, Task, TaskConversationResponse } from '../shared/protocol.ts';
import { agyResumeId, agyTranscriptFile } from './agents.ts';
import { readTranscript } from './transcript.ts';
import type { Turn } from './transcript.ts';

const MAX_ITEM_CHARS = 32_000;
const MAX_TOOL_LINES = 20;
const MAX_TOOL_LINE_CHARS = 160;

const capText = (s: string, max = MAX_ITEM_CHARS): string =>
  s.length > max ? `${s.slice(0, max)}…\n（内容过长已截断）` : s;

const singleLine = (s: string, max: number): string => {
  const clean = s.replace(/\s+/g, ' ').trim();
  const cps = [...clean];
  return cps.length > max ? cps.slice(0, max).join('') + '…' : clean;
};

const normCmp = (s: string): string => s.replace(/\s+/g, ' ').trim();

function resolveTranscriptPath(session: SessionInfo | undefined): string | undefined {
  if (!session) return undefined;
  if (session.agent === 'agy') {
    const healed = agyResumeId(session.nativeSessionId, session.transcriptPath);
    if (healed) {
      const f = agyTranscriptFile(healed);
      if (f) return f;
    }
  }
  return session.transcriptPath;
}

export function collapseTurns(turns: Turn[], keyPrefix = 'turn'): ConversationItem[] {
  const items: ConversationItem[] = [];
  let toolBuf: string[] = [];
  let toolGroupStart = 0;

  const flushTools = () => {
    if (!toolBuf.length) return;
    items.push({
      id: `${keyPrefix}-tools-${toolGroupStart}`,
      kind: 'tools',
      count: toolBuf.length,
      tools: toolBuf.slice(-MAX_TOOL_LINES),
    });
    toolBuf = [];
  };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'tool') {
      if (!toolBuf.length) toolGroupStart = i;
      toolBuf.push(singleLine(t.text, MAX_TOOL_LINE_CHARS) || '工具调用');
      continue;
    }
    flushTools();
    items.push({
      id: `${keyPrefix}-${i}`,
      kind: t.role,
      text: capText(t.text),
    });
  }
  flushTools();
  return items;
}

export function buildTaskConversation(opts: {
  task: Task;
  session: SessionInfo | undefined;
  cards: Card[];
  activity: SessionActivity | null;
}): TaskConversationResponse {
  const { task, session, activity } = opts;
  const taskCards = opts.cards
    .filter(c => c.taskId === task.id)
    .sort((a, b) => a.createdAt - b.createdAt);

  const tp = resolveTranscriptPath(session);
  const turns = tp ? readTranscript(session?.agent ?? task.agent, tp, session?.transcriptLeafId) : [];
  const items: ConversationItem[] = [];

  if (turns.length > 0) {
    // Keep handoff & forward cards visible ahead of the resumed/live session transcript.
    for (const c of taskCards) {
      if (c.kind === 'handoff' || c.kind === 'forward') {
        items.push({ id: `card-${c.id}`, kind: 'card', card: c });
      }
    }
    if (!turns.some(t => t.role === 'user') && task.prompt.trim()) {
      items.push({ id: 'prompt-0', kind: 'user', text: capText(task.prompt.trim()) });
    }
    items.push(...collapseTurns(turns, session?.id ?? 'turn'));

    // If a newly queued feedback card has not yet been submitted into the CLI transcript, show it optimistically.
    const lastTranscriptUser = [...turns].reverse().find(t => t.role === 'user')?.text ?? '';
    const lastFeedback = [...taskCards].reverse().find(c => c.kind === 'feedback');
    if (lastFeedback && (!lastTranscriptUser || !normCmp(lastTranscriptUser).includes(normCmp(lastFeedback.body).slice(0, 80)))) {
      items.push({ id: `card-${lastFeedback.id}`, kind: 'user', text: capText(lastFeedback.body) });
    }
  } else {
    if (task.prompt.trim()) {
      items.push({ id: 'prompt-0', kind: 'user', text: capText(task.prompt.trim()) });
    }
    for (const c of taskCards) {
      if (c.kind === 'feedback') items.push({ id: `card-${c.id}`, kind: 'user', text: capText(c.body) });
      else if (c.kind === 'result') items.push({ id: `card-${c.id}`, kind: 'assistant', text: capText(c.body) });
      else items.push({ id: `card-${c.id}`, kind: 'card', card: c });
    }
  }

  return {
    taskId: task.id,
    sessionId: session?.id ?? task.sessionId,
    agent: session?.agent ?? task.agent,
    items,
    activity,
  };
}
