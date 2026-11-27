import type { Card, ConversationItem, SessionActivity, SessionInfo, Task, TaskConversationResponse } from '../shared/protocol.ts';
import { feedbackMatchesUserText } from '../shared/textMatch.ts';
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
  const turns = tp ? readTranscript(session?.agent ?? task.agent, tp) : [];
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

    // Optimistically show only genuinely pending feedback cards for the active session.
    // Walk session feedback cards monotonically against ALL transcript user turns so an earlier feedback
    // never resurrects at the bottom after a later Terminal message or delegation forward.
    if (session?.status !== 'exited') {
      const sessionFeedbacks = taskCards.filter(
        c => c.kind === 'feedback' && (!session || c.sessionId === session.id),
      );
      const userTurns = turns.filter(t => t.role === 'user');
      let uCursor = 0;
      let lastMatchedFbIdx = -1;
      for (let i = 0; i < sessionFeedbacks.length; i++) {
        const fb = sessionFeedbacks[i];
        let matchedIdx = -1;
        for (let j = uCursor; j < userTurns.length; j++) {
          if (feedbackMatchesUserText(fb.body, userTurns[j].text)) {
            matchedIdx = j;
            break;
          }
        }
        if (matchedIdx >= 0) {
          uCursor = matchedIdx + 1;
          lastMatchedFbIdx = i;
        } else if (uCursor > 0 && feedbackMatchesUserText(fb.body, userTurns[uCursor - 1].text)) {
          lastMatchedFbIdx = i;
        }
      }
      const pending = sessionFeedbacks.slice(lastMatchedFbIdx + 1);
      for (const fb of pending) {
        items.push({ id: `card-${fb.id}`, kind: 'user', text: capText(fb.body) });
      }
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
