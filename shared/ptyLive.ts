import type { AgentKind, LiveStreamTail, SessionActivity, SessionInfo, StreamBlock } from './protocol.ts';

export interface TermLineSample {
  startRow: number;
  text: string;
  muted?: boolean;
}

export interface PtyLiveExtract {
  thinkingText?: string;
  answerText?: string;
  spinnerText?: string;
}

const MAX_LIVE_TEXT = 16_000;

const capLive = (s: string, max = MAX_LIVE_TEXT): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

// Normalizes Markdown syntax away so PTY-rendered plain text cleanly matches committed transcript Markdown.
export function normForDedupe(s: string): string {
  return s
    .replace(/```[a-zA-Z0-9_-]*\n?/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const RULE_RE = /^[\s─━═\-]{10,}$/;
const EMBEDDED_RULE_RE = /[─━═]{10,}/;
const BRAILLE_SPINNER_RE = /^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷])(?:\s+(.*))?$/;
const STEP_PREFIX_RE = /^\d+\/\d+\s+steps?\s*·\s*/i;
const CLAUDE_SPINNER_RE = /^([✢✳✶✻✽·*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷])\s+(.+)$/;
const GENERIC_SPINNER_RE =
  /^(?:Generating|Loading|Thinking|Working|Running(?:\s+command)?|Editing(?:\s+files)?|Reading|Searching|Waiting|Planning|Processing|Analyzing|Compacting|Executing|Finishing)\b/i;
const TIP_LINE_RE = /^(?:└\s*)?Tip:\s|^(?:Use\s+\/[a-z0-9_-]+\b|Press\s+(?:ctrl\+|esc|tab|enter)\b)/i;
const AGY_STATS_RE = /^\d+(?:\.\d+)?[smhk]?\s+in\s*\|/i;
const AGY_PROMO_RE = /^┃(?:\s|$)/;
const AGY_PLACEHOLDER_PROMPT_RE = /^>\s+(?:Auto mode:|Plan mode:|Type a message|Ask anything)/i;
const AGY_TODO_LINE_RE = /^(?:⎿\s+)?[✓✔●○✗✕⊘–-]\s+\S/;
const FOOTER_NOISE_RE =
  /(esc to (cancel|interrupt|dismiss)|for shortcuts|ctrl\+o to|Tip:\s|context left|auto\s*·\s*Gemini|Gemini\s+\d|\b\d+(?:\.\d+)?\s+(?:Neon|Carbon|Hydrogen|Pro|Flash)\s*·\s*(?:low|medium|high|xhigh|max)\b|Claude\s+|Auto-accept|bypass permissions|Effort set to\b|[●○]\s+(?:Running|Editing|Loading|Working)\b)/i;
const AGY_MARKER_RE = /^[▸▾○●◆◇✓✗]\s/;
const AGY_BANNER_RE = /^(?:[▄▀█░▒▓\s]{3,}|Antigravity CLI\s|\S+@\S+\s*\()/;

function cleanSpinnerMessage(raw: string): { spinnerText?: string; thinkingText?: string } {
  const msg = raw.trim();
  if (!msg || EMBEDDED_RULE_RE.test(msg)) return {};
  const withoutSteps = msg.replace(STEP_PREFIX_RE, '').trim();
  const effective = withoutSteps || msg;
  const isGeneric = GENERIC_SPINNER_RE.test(effective) || /^\d+\/\d+\s+steps?$/i.test(effective);
  return {
    spinnerText: effective,
    ...(!isGeneric && effective.length >= 3 ? { thinkingText: effective } : {}),
  };
}

function isChromeLine(agent: AgentKind, raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  if (RULE_RE.test(t) || EMBEDDED_RULE_RE.test(t)) return true;
  if (TIP_LINE_RE.test(t) || FOOTER_NOISE_RE.test(t)) return true;
  if (agent === 'agy' && (AGY_STATS_RE.test(t) || AGY_MARKER_RE.test(t) || AGY_BANNER_RE.test(t))) return true;
  if ((agent === 'agy' || agent === 'fake') && (AGY_PROMO_RE.test(t) || AGY_PLACEHOLDER_PROMPT_RE.test(t) || AGY_TODO_LINE_RE.test(t))) return true;
  if (BRAILLE_SPINNER_RE.test(t)) return true;
  if (agent === 'claude' && CLAUDE_SPINNER_RE.test(t)) return true;
  if ((agent === 'agy' || agent === 'fake') && (t === '>' || /^>\s*$/.test(t))) return true;
  if (agent === 'claude' && (t === '❯' || /^❯\s*$/.test(t))) return true;
  if (agent === 'codex' && (t === '›' || /^›\s*$/.test(t))) return true;
  return false;
}

// Pure extractor operating on unwrapped lines from a clean live terminal buffer (browser xterm.js).
// Never scrapes alternate-screen interactive menus/pickers, and strictly filters TUI chrome, todolists & spinners.
export function extractPtyLiveFromLines(
  agent: AgentKind,
  lines: TermLineSample[],
  lastUserPrompt?: string,
  isAlternate = false,
): PtyLiveExtract {
  if (isAlternate || lines.length === 0) return {};

  // 1. Strip bottom TUI chrome (status footer, prompt box, promo banner, todolist panel, rules, tips, spinners).
  let end = lines.length;
  let spinnerText: string | undefined;
  let spinnerThinking: string | undefined;
  let scanned = 0;

  while (end > 0 && scanned < 36) {
    const raw = lines[end - 1].text;
    const t = raw.trim();
    scanned++;
    if (!t || RULE_RE.test(t) || EMBEDDED_RULE_RE.test(t) || TIP_LINE_RE.test(t) || FOOTER_NOISE_RE.test(t)) {
      end--;
      continue;
    }
    if ((agent === 'agy' || agent === 'fake') && (AGY_PROMO_RE.test(t) || AGY_PLACEHOLDER_PROMPT_RE.test(t))) {
      end--;
      continue;
    }
    // Strip agy's live todolist panel (`  ⎿  ✓ ...` / `     ● ...` / `     ○ ...`) sitting right below the spinner!
    if ((agent === 'agy' || agent === 'fake') && /^\s{2,}/.test(raw) && AGY_TODO_LINE_RE.test(t)) {
      end--;
      continue;
    }
    if ((agent === 'agy' || agent === 'fake') && (t === '>' || /^>\s*$/.test(t))) {
      end--;
      continue;
    }
    if (agent === 'claude' && (t === '❯' || /^❯\s*$/.test(t))) {
      end--;
      continue;
    }
    if (agent === 'codex' && (t === '›' || /^›\s*$/.test(t))) {
      end--;
      continue;
    }
    const braille = BRAILLE_SPINNER_RE.exec(t);
    if (braille) {
      const parsed = cleanSpinnerMessage(braille[2] ?? '');
      if (parsed.spinnerText) spinnerText = parsed.spinnerText;
      if (parsed.thinkingText) spinnerThinking = parsed.thinkingText;
      end--;
      continue;
    }
    if (agent === 'claude') {
      const cs = CLAUDE_SPINNER_RE.exec(t);
      if (cs) {
        const parsed = cleanSpinnerMessage(cs[2] ?? '');
        if (parsed.spinnerText) spinnerText = parsed.spinnerText;
        if (parsed.thinkingText) spinnerThinking = parsed.thinkingText;
        end--;
        continue;
      }
    }
    break;
  }

  const body = lines.slice(0, end);
  if (body.length === 0) {
    return {
      ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
      ...(spinnerText ? { spinnerText } : {}),
    };
  }

  const promptNorm = lastUserPrompt ? normForDedupe(lastUserPrompt) : '';
  const promptFirstLine = lastUserPrompt ? normForDedupe(lastUserPrompt.split(/\r?\n/)[0]).slice(0, 18) : '';

  if (agent === 'agy') {
    // Anchor at the latest tool/thought/stats marker or explicit user prompt line.
    let anchor = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      const t = body[i].text.trim();
      if (!t) continue;
      if (AGY_MARKER_RE.test(t) || AGY_STATS_RE.test(t) || RULE_RE.test(t) || EMBEDDED_RULE_RE.test(t) || AGY_BANNER_RE.test(t)) {
        anchor = i + 1;
        break;
      }
      if (t.startsWith('> ')) {
        const lineAfter = normForDedupe(t.slice(2));
        if (!promptFirstLine || lineAfter.includes(promptFirstLine) || (lineAfter.length >= 6 && promptNorm.startsWith(lineAfter))) {
          anchor = i + 1;
          break;
        }
      }
    }
    if (anchor < 0) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
      };
    }

    const mutedLines: string[] = [];
    const answerLines: string[] = [];
    for (const l of body.slice(anchor)) {
      const t = l.text.trim();
      if (!t) {
        if (answerLines.length > 0) answerLines.push('');
        continue;
      }
      const sp = BRAILLE_SPINNER_RE.exec(t);
      if (sp) {
        const parsed = cleanSpinnerMessage(sp[2] ?? '');
        if (parsed.spinnerText) spinnerText = parsed.spinnerText;
        if (parsed.thinkingText) spinnerThinking = parsed.thinkingText;
        continue;
      }
      if (isChromeLine('agy', l.text)) continue;
      // Skip wrapped continuation lines of the user's own multi-line prompt.
      const lineNorm = normForDedupe(t);
      if (promptNorm && lineNorm.length >= 6 && promptNorm.includes(lineNorm)) continue;
      const cleaned = l.text.replace(/^ {2}/, '');
      // Dim/muted lines while a spinner is active are live thought previews, not primary answer prose.
      if (l.muted && answerLines.length === 0) {
        mutedLines.push(cleaned.trim());
      } else {
        answerLines.push(cleaned);
      }
    }

    const thinkingText = mutedLines.join('\n').trim() || spinnerThinking;
    const answerText = answerLines.join('\n').trim();
    return {
      ...(thinkingText ? { thinkingText: capLive(thinkingText, 6_000) } : {}),
      ...(answerText ? { answerText: capLive(answerText) } : {}),
      ...(spinnerText ? { spinnerText } : {}),
    };
  }

  if (agent === 'claude') {
    let anchor = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      const t = body[i].text.trim();
      if (/^[⏺●]\s/.test(t)) {
        anchor = i;
        break;
      }
      if (/^❯\s+\S/.test(t)) {
        anchor = i + 1;
        break;
      }
    }
    if (anchor < 0 || anchor >= body.length) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
      };
    }
    const first = body[anchor].text.trim();
    if (/^[⏺●]\s+[A-Z][A-Za-z0-9_]*\(/.test(first)) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
      };
    }
    const linesOut = body
      .slice(anchor)
      .filter((l, idx) => idx === 0 || !isChromeLine('claude', l.text))
      .map((l, idx) => (idx === 0 ? l.text.trim().replace(/^[⏺●]\s+/, '') : l.text.replace(/^ {2}/, '')));
    const answerText = linesOut.join('\n').trim();
    return {
      ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
      ...(answerText ? { answerText: capLive(answerText) } : {}),
      ...(spinnerText ? { spinnerText } : {}),
    };
  }

  if (agent === 'codex') {
    let anchor = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      const t = body[i].text.trim();
      if (/^[•]\s/.test(t)) {
        anchor = i;
        break;
      }
      if (/^›\s+\S/.test(t)) {
        anchor = i + 1;
        break;
      }
    }
    if (anchor < 0 || anchor >= body.length) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
      };
    }
    const first = body[anchor].text.trim();
    if (/^•\s+(Ran|Explored|Edited|Created|Working|Thinking)\b/.test(first)) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
      };
    }
    const linesOut = body
      .slice(anchor)
      .filter((l, idx) => idx === 0 || !isChromeLine('codex', l.text))
      .map((l, idx) => (idx === 0 ? l.text.trim().replace(/^•\s+/, '') : l.text.replace(/^ {2}/, '')));
    const answerText = linesOut.join('\n').trim();
    return {
      ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
      ...(answerText ? { answerText: capLive(answerText) } : {}),
      ...(spinnerText ? { spinnerText } : {}),
    };
  }

  if (agent === 'fake') {
    let anchor = 0;
    for (let i = body.length - 1; i >= 0; i--) {
      const t = body[i].text.trim();
      if (t.startsWith('> ') || AGY_MARKER_RE.test(t)) {
        anchor = i + 1;
        break;
      }
    }
    let fakeThinking = spinnerThinking;
    const answerLines: string[] = [];
    for (const l of body.slice(anchor)) {
      const t = l.text.trim();
      if (!t || AGY_MARKER_RE.test(t) || TIP_LINE_RE.test(t) || FOOTER_NOISE_RE.test(t) || RULE_RE.test(t)) continue;
      if (t.startsWith('thinking:')) {
        fakeThinking = t.slice('thinking:'.length).trim();
        continue;
      }
      const sp = BRAILLE_SPINNER_RE.exec(t);
      if (sp) {
        const msg = (sp[2] ?? '').trim();
        if (msg && !GENERIC_SPINNER_RE.test(msg)) fakeThinking = msg;
        continue;
      }
      answerLines.push(l.text.replace(/^ {2}/, ''));
    }
    const answerText = answerLines.join('\n').trim();
    return {
      ...(fakeThinking ? { thinkingText: fakeThinking } : {}),
      ...(answerText ? { answerText: capLive(answerText) } : {}),
      ...(spinnerText ? { spinnerText } : {}),
    };
  }

  return {};
}

// Removes live PTY answer text (whole or leading lines) once the authoritative transcript has already committed
// those assistant messages, and guards against replaying previous-turn prose before the CLI echoes a new prompt.
export function dedupeLiveAnswer(answerText: string | undefined, blocks: StreamBlock[]): string | undefined {
  if (!answerText) return undefined;
  const recentCommitted: string[] = [];
  for (let i = blocks.length - 1; i >= 0 && recentCommitted.length < 6; i--) {
    const b = blocks[i];
    if (b.kind !== 'assistant') continue;
    const normCommitted = normForDedupe(b.text);
    if (normCommitted) recentCommitted.push(normCommitted);
  }
  if (recentCommitted.length === 0) return answerText;

  // 1. Strip any leading lines that were already committed as earlier assistant narration in the same turn.
  const rawLines = answerText.split('\n');
  let startIdx = 0;
  while (startIdx < rawLines.length) {
    const ln = normForDedupe(rawLines[startIdx]);
    if (!ln) {
      startIdx++;
      continue;
    }
    const alreadyCommitted = recentCommitted.some(
      (c) => c === ln || c.startsWith(ln) || (ln.length >= 10 && c.includes(ln)),
    );
    if (alreadyCommitted) startIdx++;
    else break;
  }
  const remaining = rawLines.slice(startIdx).join('\n').trim();
  if (!remaining) return undefined;

  // 2. Compare the remaining live tail against recently committed full blocks.
  const normRem = normForDedupe(remaining);
  if (!normRem) return undefined;
  for (const normCommitted of recentCommitted) {
    if (
      normCommitted === normRem ||
      normCommitted.startsWith(normRem) ||
      (normCommitted.length >= 16 && normRem.startsWith(normCommitted)) ||
      (normRem.length >= 10 && normCommitted.includes(normRem.slice(0, Math.min(48, normRem.length))))
    ) {
      return undefined;
    }
  }
  return remaining;
}

// Prevents stale thinking snippets (e.g. from an already-committed step) from repeating inside LiveTailView.
export function dedupeLiveThinking(thinkingText: string | undefined, blocks: StreamBlock[]): string | undefined {
  if (!thinkingText) return undefined;
  const normTh = normForDedupe(thinkingText);
  if (!normTh) return undefined;

  let checked = 0;
  for (let i = blocks.length - 1; i >= 0 && checked < 3; i--) {
    const b = blocks[i];
    if (b.kind === 'step' && b.thinking) {
      checked++;
      const normStep = normForDedupe(b.thinking);
      if (normStep === normTh || normStep.startsWith(normTh) || (normTh.length >= 12 && normStep.includes(normTh.slice(0, 48)))) {
        return undefined;
      }
    } else if (b.kind === 'assistant') {
      checked++;
      const normAsst = normForDedupe(b.text);
      if (normAsst === normTh || normAsst.startsWith(normTh) || (normTh.length >= 12 && normAsst.includes(normTh.slice(0, 48)))) {
        return undefined;
      }
    }
  }
  return thinkingText;
}

export function composeLiveTail(opts: {
  session: SessionInfo;
  blocks: StreamBlock[];
  activity: SessionActivity | null;
  ptyExtract: PtyLiveExtract | null;
  now: number;
}): LiveStreamTail | null {
  const { session, blocks, activity, ptyExtract, now } = opts;
  if (session.status !== 'working') return null;
  const startedAt = activity?.turnStartedAt ?? session.statusSince ?? now;
  const answerText = dedupeLiveAnswer(ptyExtract?.answerText, blocks);
  const ptyThinking = dedupeLiveThinking(ptyExtract?.thinkingText, blocks);
  const actThinking = dedupeLiveThinking(activity?.thinkingSnippet, blocks);
  const thinkingText = ptyThinking || actThinking || undefined;
  const hasRunningStep = blocks.some(b => b.kind === 'step' && b.active);

  if (answerText) {
    return {
      phase: 'answering',
      ...(ptyThinking ? { thinkingText: ptyThinking } : {}),
      answerText,
      startedAt,
      updatedAt: now,
      source: 'pty',
    };
  }
  if (hasRunningStep || activity?.phase === 'tool' || activity?.phase === 'subagent') {
    return {
      phase: 'tool',
      ...(ptyThinking ? { thinkingText: ptyThinking } : {}),
      toolSummary: activity?.summary || '正在调用工具…',
      startedAt,
      updatedAt: now,
      source: ptyThinking ? 'pty' : 'activity',
    };
  }
  if (thinkingText || ptyExtract?.spinnerText || activity?.phase === 'thinking') {
    return {
      phase: 'thinking',
      ...(thinkingText ? { thinkingText } : {}),
      startedAt,
      updatedAt: now,
      source: ptyThinking ? 'pty' : 'activity',
    };
  }
  return {
    phase: 'preparing',
    startedAt,
    updatedAt: now,
    source: 'activity',
  };
}
