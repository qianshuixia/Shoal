import type { AgentKind, InteractiveKey, LiveStreamTail, SessionActivity, SessionInfo, StreamBlock, StreamSubagent } from './protocol.ts';

export interface TermLineSample {
  startRow: number;
  text: string;
  muted?: boolean;
  /** True when the text after a leading prompt glyph (`>` / `❯` / `›`) is dim/muted placeholder text. */
  promptTextMuted?: boolean;
}

export interface PtyLiveSubagent {
  kind: 'subagent' | 'swarm';
  name: string;
  role?: string;
  model?: string;
  summary?: string;
  elapsedText?: string;
  status: 'running' | 'done' | 'error';
}

export interface PtyPromptDraft {
  text: string;
  multiline: boolean;
  hasOpaqueToken: boolean;
}

export interface PtyPromptState {
  found: boolean;
  draft: PtyPromptDraft | null;
}

export interface PtyQuestionOption {
  index: number;
  number?: string;
  label: string;
  description?: string;
  recommended?: boolean;
  selected: boolean;
  checked?: boolean;
  isWriteIn?: boolean;
  isSubmit?: boolean;
  isBack?: boolean;
}

export interface PtyQuestionAction {
  id: 'prev' | 'next' | 'confirm' | 'submit' | 'skip' | 'back' | 'cancel' | 'review';
  label: string;
  keyHint: string;
  key: InteractiveKey;
}

export interface PtyInteractivePrompt {
  mode: 'select' | 'multi' | 'write-in' | 'review';
  progress?: { current: number; total: number };
  title: string;
  subtitle?: string;
  options: PtyQuestionOption[];
  selectedIndex: number;
  writeInText?: string;
  actions: PtyQuestionAction[];
  rawHint: string;
  rawLines: string[];
  fingerprint: string;
}

export interface PtyLiveExtract {
  thinkingText?: string;
  answerText?: string;
  spinnerText?: string;
  subagents?: PtyLiveSubagent[];
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
const AGY_SUBAGENT_BAR_WITH_META_RE = /^([●○◉◐◓◑◒✓✗!⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷])\s+(Agent|Swarm)\((.+)\)\s*·\s*(.+)$/;
const AGY_SUBAGENT_BAR_PLAIN_RE = /^([●○◉◐◓◑◒✓✗!⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷])\s+(Agent|Swarm)\(([^)]+)\)\s*$/;
const SUBAGENT_ELAPSED_RE = /\s*·\s*(\d+(?:h\d+m|m\d+s|m|s))\s*$/;
const MENU_OPTION_RE = /^[>❯›][\s\u00a0]+\d+[.)]\s/;
const OPAQUE_TOKEN_RE = /\[(?:Image|Pasted text|Attachment|File)\s*#?\d*[^\]]*\]/i;
const CLAUDE_PLACEHOLDER_RE = /^❯[\s\u00a0]+Try\s+"/i;
const CODEX_PLACEHOLDER_RE = /^›[\s\u00a0]+(?:Improve documentation|Summarize recent commits|Explain this codebase|Write tests|Find and fix|Ask Codex|Type a message)/i;
const PROMPT_FOOTER_EXTRA_RE = /^(?:\?\s+for\s+shortcuts|shift\+tab\b|\d+%\s+context\s+left\b|press\s+esc\b)/i;
const OUTPUT_STOP_RE = /^(?:[●⏺•▸▾✓✗]\s|reply:|FAKE AGENT\b|Allow\?|Do you (?:want|trust)\b|Press Enter\b|Hooks need review\b|Interrupted$|Escaped$|RESUMED\b)/i;

// Parses agy's live bottom subagent status line, e.g.:
// `● Agent(gemini-reviewer: E-⑧ 首领破绽节奏只读评审员) · Gemini 4 Neon   The inconsistent break dama... · 3m48s`
export function parsePtySubagentLine(raw: string): PtyLiveSubagent | null {
  const t = raw.trim();
  if (!t || t.includes('(ctrl+o') || t.includes(')(')) return null;
  const m = AGY_SUBAGENT_BAR_WITH_META_RE.exec(t) ?? AGY_SUBAGENT_BAR_PLAIN_RE.exec(t);
  if (!m) return null;
  const dot = m[1];
  const kind: 'subagent' | 'swarm' = m[2].toLowerCase() === 'swarm' ? 'swarm' : 'subagent';
  const inside = m[3].trim();
  if (!inside) return null;
  const colon = inside.indexOf(':');
  const name = colon >= 0 ? inside.slice(0, colon).trim() || inside : inside;
  const role = colon >= 0 ? inside.slice(colon + 1).trim() || undefined : undefined;

  let rest = (m[4] ?? '').trim();
  let elapsedText: string | undefined;
  const em = SUBAGENT_ELAPSED_RE.exec(rest);
  if (em) {
    elapsedText = em[1];
    rest = rest.slice(0, em.index).trim();
  }
  let model: string | undefined;
  let summary: string | undefined;
  if (rest) {
    const gapSplit = rest.split(/\s{2,}/);
    if (gapSplit.length >= 2) {
      model = gapSplit[0].trim() || undefined;
      summary = gapSplit.slice(1).join(' ').trim() || undefined;
    } else if (rest.includes(' · ')) {
      const parts = rest.split(/\s+·\s+/);
      model = parts[0].trim() || undefined;
      summary = parts.slice(1).join(' · ').trim() || undefined;
    } else if (/^(?:Gemini|Claude|GPT|o\d|Qwen|DeepSeek|Kimi)/i.test(rest)) {
      model = rest;
    } else {
      summary = rest;
    }
  }
  const status: PtyLiveSubagent['status'] = dot === '✓' ? 'done' : (dot === '✗' || dot === '!') ? 'error' : 'running';
  return {
    kind,
    name,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    ...(elapsedText ? { elapsedText } : {}),
    status,
  };
}

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

  // 1. Strip bottom TUI chrome (status footer, subagent bars, prompt box, promo banner, todolist panel, rules, tips, spinners).
  let end = lines.length;
  let spinnerText: string | undefined;
  let spinnerThinking: string | undefined;
  const subagents: PtyLiveSubagent[] = [];
  let scanned = 0;

  while (end > 0 && scanned < 36) {
    const raw = lines[end - 1].text;
    const t = raw.trim();
    scanned++;
    if (!t) {
      end--;
      continue;
    }
    const subBar = parsePtySubagentLine(t);
    if (subBar) {
      subagents.unshift(subBar);
      end--;
      continue;
    }
    if (RULE_RE.test(t) || EMBEDDED_RULE_RE.test(t) || TIP_LINE_RE.test(t) || FOOTER_NOISE_RE.test(t)) {
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

  const subPatch = subagents.length > 0 ? { subagents } : {};
  // Never leak an active interactive question/choice TUI picker into live Markdown answer prose.
  if (extractPtyInteractivePrompt(agent, lines, isAlternate)) {
    return subPatch;
  }
  const body = lines.slice(0, end);
  if (body.length === 0) {
    return {
      ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
      ...(spinnerText ? { spinnerText } : {}),
      ...subPatch,
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
        ...subPatch,
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
      ...subPatch,
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
        ...subPatch,
      };
    }
    const first = body[anchor].text.trim();
    if (/^[⏺●]\s+[A-Z][A-Za-z0-9_]*\(/.test(first)) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
        ...subPatch,
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
      ...subPatch,
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
        ...subPatch,
      };
    }
    const first = body[anchor].text.trim();
    if (/^•\s+(Ran|Explored|Edited|Created|Working|Thinking)\b/.test(first)) {
      return {
        ...(spinnerThinking ? { thinkingText: spinnerThinking } : {}),
        ...(spinnerText ? { spinnerText } : {}),
        ...subPatch,
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
      ...subPatch,
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
      ...subPatch,
    };
  }

  return subPatch;
}

function isPromptFooterLine(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  if (parsePtySubagentLine(t)) return true;
  if (FOOTER_NOISE_RE.test(t) || TIP_LINE_RE.test(t) || AGY_PROMO_RE.test(t) || PROMPT_FOOTER_EXTRA_RE.test(t)) return true;
  if (BRAILLE_SPINNER_RE.test(t)) return true;
  return false;
}

const NUMBERED_ITEM_RE = /^\s*(?:[>❯›][\s\u00a0]+)?(\d+)[.)]\s+\S/;

function isInteractiveMenuSlice(slice: TermLineSample[], inFramedBox: boolean): boolean {
  const firstNorm = slice[0].text.replace(/\u00a0/g, ' ').trimStart();
  if (!MENU_OPTION_RE.test(firstNorm)) return false;
  // Outside a framed composer box, any leading `❯ 1. ...` / `> 1. ...` is treated conservatively as a menu.
  if (!inFramedBox) return true;
  // Inside a framed composer box (`──── ... ────`), a single numbered line like `> 1. Write the tests`
  // is a real user draft unless followed by consecutive numbered menu options (`2. ...`).
  if (slice.length >= 2) {
    for (let i = 1; i < slice.length; i++) {
      const m = NUMBERED_ITEM_RE.exec(slice[i].text.replace(/\u00a0/g, ' '));
      if (m && m[1] === '2') return true;
    }
  }
  return false;
}

function parsePromptLines(
  agent: AgentKind,
  slice: TermLineSample[],
  glyph: '>' | '❯' | '›',
  inFramedBox = false,
): PtyPromptState {
  const trimmed = [...slice];
  while (trimmed.length > 0 && !trimmed[0].text.replace(/\u00a0/g, ' ').trim()) trimmed.shift();
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1].text.replace(/\u00a0/g, ' ').trim()) trimmed.pop();
  if (trimmed.length === 0) return { found: false, draft: null };

  const first = trimmed[0];
  const firstNorm = first.text.replace(/\u00a0/g, ' ').trimStart();
  if (!firstNorm.startsWith(glyph)) return { found: false, draft: null };
  if (isInteractiveMenuSlice(trimmed, inFramedBox)) return { found: false, draft: null };

  const afterGlyph = firstNorm.slice(glyph.length);
  // Real prompts are either bare glyph or glyph followed by whitespace.
  if (afterGlyph.length > 0 && afterGlyph[0] !== ' ') return { found: false, draft: null };
  const firstBody = afterGlyph.startsWith(' ') ? afterGlyph.slice(1) : afterGlyph;

  if (trimmed.length === 1) {
    if (!firstBody.trim()) return { found: true, draft: null };
    if (first.promptTextMuted === true) return { found: true, draft: null };
    // Never misclassify explicitly bright user text (`promptTextMuted === false`, e.g. user literally typing
    // "Type a message") as a muted CLI placeholder; only apply placeholder regexes when muted or style is unknown.
    if (first.promptTextMuted !== false) {
      if ((agent === 'agy' || agent === 'fake') && AGY_PLACEHOLDER_PROMPT_RE.test(firstNorm)) return { found: true, draft: null };
      if (agent === 'claude' && CLAUDE_PLACEHOLDER_RE.test(firstNorm)) return { found: true, draft: null };
      if (agent === 'codex' && CODEX_PLACEHOLDER_RE.test(firstNorm)) return { found: true, draft: null };
    }
  }

  const outLines = [
    firstBody.trimEnd(),
    ...trimmed.slice(1).map((l) => l.text.replace(/\u00a0/g, ' ').replace(/^ {2}/, '').trimEnd()),
  ];
  while (outLines.length > 0 && !outLines[outLines.length - 1].trim()) outLines.pop();
  const text = outLines.join('\n');
  if (!text.trim()) return { found: true, draft: null };
  return {
    found: true,
    draft: {
      text,
      multiline: outLines.length > 1,
      hasOpaqueToken: OPAQUE_TOKEN_RE.test(text),
    },
  };
}

// Reads the active bottom CLI composer box from a live xterm.js viewport snapshot.
// Returns `{ found: true, draft: null }` when the prompt is definitely visible and empty/placeholder-only,
// `{ found: true, draft }` when unsent user text is present, or `{ found: false, draft: null }` when obscured.
export function extractPtyPromptState(
  agent: AgentKind,
  lines: TermLineSample[],
  isAlternate = false,
): PtyPromptState {
  if (isAlternate || lines.length === 0) return { found: false, draft: null };
  const glyph: '>' | '❯' | '›' = agent === 'claude' ? '❯' : agent === 'codex' ? '›' : '>';

  // 1. Strip bottom status/shortcut/subagent footer rows beneath the input box.
  let end = lines.length;
  let scanned = 0;
  while (end > 0 && scanned < 20) {
    const raw = lines[end - 1].text;
    const t = raw.trim();
    scanned++;
    if (!t || isPromptFooterLine(raw)) {
      end--;
      continue;
    }
    break;
  }
  if (end <= 0) return { found: false, draft: null };

  // 2. Framed input box (agy & claude): bounded by two horizontal rules (`────`), supporting tall multi-line drafts.
  if (RULE_RE.test(lines[end - 1].text.trim())) {
    const bottomRule = end - 1;
    let topRule = -1;
    for (let i = bottomRule - 1; i >= Math.max(0, bottomRule - 64); i--) {
      if (RULE_RE.test(lines[i].text.trim())) {
        topRule = i;
        break;
      }
    }
    if (topRule >= 0 && topRule < bottomRule - 1) {
      const box = parsePromptLines(agent, lines.slice(topRule + 1, bottomRule), glyph, true);
      if (box.found) return box;
    }
    // Single rule directly beneath an unframed prompt: step past it for the unframed check below.
    end = bottomRule;
  }

  // 3. Unframed bottom prompt (codex `›`, fake `>`, or partially scrolled agy/claude).
  const minScan = Math.max(0, end - 24);
  for (let i = end - 1; i >= minScan; i--) {
    const norm = lines[i].text.replace(/\u00a0/g, ' ').trimStart();
    if (!norm) continue;
    if (RULE_RE.test(norm) || EMBEDDED_RULE_RE.test(norm) || AGY_STATS_RE.test(norm) || OUTPUT_STOP_RE.test(norm)) {
      break;
    }
    if (norm.startsWith(glyph)) {
      if (norm.trim() === glyph && i > minScan) {
        const prevRaw = lines[i - 1].text.replace(/\u00a0/g, ' ');
        const prevNorm = prevRaw.trimStart();
        // A bare glyph immediately beneath an indented continuation line (`  ...`) belongs to an unframed multi-line
        // draft rather than a fresh empty prompt: keep scanning upward to the real opening prompt line.
        if (/^ {2,}\S/.test(prevRaw)) continue;
        // A bare glyph immediately beneath another non-empty glyph-prefixed line (e.g. `["› first line", "› "]`)
        // is ambiguous (could be a 2-line draft whose 2nd line starts with the glyph): never misclassify as empty!
        if (prevNorm.startsWith(glyph) && prevNorm.trim() !== glyph) return { found: false, draft: null };
      }
      const slice = lines.slice(i, end).filter((l) => !RULE_RE.test(l.text.trim()));
      return parsePromptLines(agent, slice, glyph, false);
    }
  }
  return { found: false, draft: null };
}

export function extractPtyPromptDraft(
  agent: AgentKind,
  lines: TermLineSample[],
  isAlternate = false,
): PtyPromptDraft | null {
  return extractPtyPromptState(agent, lines, isAlternate).draft;
}

// ---- Live Interactive Question / Choice TUI Extractor ----
// Extracts active interactive question/choice pickers (e.g. agy `ask_question`, Claude `AskUserQuestion`,
// Codex `request_user_input`) directly from the browser's clean xterm.js viewport so Dialog mode renders a real
// interactive card instead of leaking raw TUI menus into LiveTail Markdown.

const CJK_CHAR_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const PANEL_FRAME_TOP_RE = /^\s*[╭┌][─━═]+[╮┐]\s*$/;
const PANEL_FRAME_BOTTOM_RE = /^\s*[╰└][─━═]+[╯┘]\s*$/;
const QUESTION_HEADER_RE = /^Question\s+(\d+)\s*\/\s*(\d+)\s*(?:[:：]\s*(.*))?$/i;
const PICKER_CURSOR_RE = /^(\s*)([>❯›▸▶])(?:\s+(.*)|)$/;
const NUMBERED_OPT_RE = /^(\d+)[.)]\s+(?:(?:\[([ xX✓✔])\]|([☐☑✓✔]))\s+)?(.+?)\s*$/;
const CHECKBOX_OPT_RE = /^(?:\[([ xX✓✔])\]|([☐☑✓✔]))\s+(?:(\d+)[.)]\s+)?(.+?)\s*$/;
const RECOMMENDED_PREFIX_RE = /^(?:\(Recommended\)|（推荐）|\[Recommended\])\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*(?:\(Recommended\)|（推荐）|\[Recommended\])$/i;
const WRITE_IN_LABEL_RE = /^(?:write-in\b|other\b|type\s+something\b|type\s+your\s+(?:own\s+)?answer\b|custom\s+answer\b|其他[（(]?自定义|自定义回答)/i;
const STRUCTURAL_WRITE_IN_LABEL_RE = /^(?:write-in(?:\.{3}|…)?|type\s+your\s+(?:own\s+)?answer|custom\s+answer|自定义回答)\s*[:：]?$/i;
const SUBMIT_LABEL_RE = /^(?:submit(?:\s+all|\s+answers)?|confirm\s*&?\s*submit|提交|全部提交)$/i;
const BACK_LABEL_RE = /^(?:back|go\s+back|return|返回)$/i;
const UNNUMBERED_ACTION_RE = /^(?:submit(?:\s+all|\s+answers)?|confirm(?:\s+all)?|back|go\s+back|cancel|edit|review|skip|yes\b.*|no\b.*)$/i;
const CONTINUATION_BOUNDARY_ACTION_RE = /^(?:submit(?:\s+all|\s+answers)?|confirm(?:\s+all)?|back|go\s+back|cancel)$/i;
const REVIEW_TITLE_RE = /^(?:(?:review(?:\s+(?:your\s+)?answers|\s*&\s*submit)?|summary)\b|核对|确认提交)/i;
const TAB_BAR_RE = /^(?:←\s+)?(?:[☐☑✓✔□■]\s+\S+(?:\s{2,}[☐☑✓✔□■]\s+\S+)+)(?:\s+→)?$/;
const WRITE_IN_INPUT_LINE_RE = /^(?:>\s*|›\s*|❯\s*|│\s*)(.*)$/;

interface ParsedHintBar {
  raw: string;
  hasNavigate: boolean;
  prevKey?: 'left' | 'shift+tab';
  nextKey?: 'right' | 'tab';
  hasToggle: boolean;
  hasSelect: boolean;
  hasConfirm: boolean;
  hasSubmit: boolean;
  hasSkip: boolean;
  hasBack: boolean;
  hasCancel: boolean;
  hasReview: boolean;
  hasTabNotes: boolean;
  count: number;
}

function unboxPanelLine(raw: string): string {
  const norm = raw.replace(/\u00a0/g, ' ');
  return norm.replace(/^\s*[│┃║]\s?/, '').replace(/\s?[│┃║]\s*$/, '');
}

function joinWrappedLine(prev: string, next: string): string {
  const a = prev.trimEnd();
  const b = next.trimStart();
  if (!a) return b;
  if (!b) return a;
  const lastCh = a[a.length - 1];
  const firstCh = b[0];
  if (CJK_CHAR_RE.test(lastCh) || CJK_CHAR_RE.test(firstCh)) return a + b;
  return `${a} ${b}`;
}

const HINT_GLOBAL_CHROME_RE = /\b(?:auto\s*·\s*Gemini|Gemini\s+\d|context\s+left|for\s+shortcuts|Auto-accept|bypass\s+permissions)\b/i;

function parseHintLineTokens(raw: string): ParsedHintBar | null {
  const t = raw.replace(/\u00a0/g, ' ').trim();
  if (!t || t.length > 260) return null;
  if (HINT_GLOBAL_CHROME_RE.test(t)) return null;
  // Strip leading/trailing bar separators produced when a narrow terminal hard-wraps a hint bar across lines.
  const stripped = t.replace(/^[·•|│]+\s*/, '').replace(/\s*[·•|│]+$/, '').trim();
  if (!stripped || /[.。!?;:]$/.test(stripped)) return null;

  const segments = stripped.split(/\s*(?:[·•|│]|\s{2,})\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  let hasNavigate = false;
  let prevKey: 'left' | 'shift+tab' | undefined;
  let nextKey: 'right' | 'tab' | undefined;
  let hasToggle = false;
  let hasSelect = false;
  let hasConfirm = false;
  let hasSubmit = false;
  let hasSkip = false;
  let hasBack = false;
  let hasCancel = false;
  let hasReview = false;
  let hasTabNotes = false;

  // Every segment must be a compact anchored `<key> [to] <action>` hint token — never ordinary prose sentences.
  for (const seg of segments) {
    if (seg.length > 42) return null;
    if (/^(?:(?:tab\/)?(?:↑\/↓|↓\/↑|j\/k|arrow\s*keys?)\s+(?:to\s+)?(?:navigate|move|select)|navigate\s+(?:↑\/↓|↓\/↑))$/i.test(seg)) {
      hasNavigate = true;
    } else if (/^(?:←\/→|left\/right)\s+(?:to\s+)?(?:prev(?:ious)?\/next|next\/prev|switch|navigate|move|change)$/i.test(seg)) {
      prevKey = 'left';
      nextKey = 'right';
    } else if (/^(?:←|left)\s+(?:to\s+)?(?:prev(?:ious)?|back|switch)$/i.test(seg)) {
      prevKey = 'left';
    } else if (/^shift\+tab\s+(?:to\s+)?(?:prev(?:ious)?|back|switch)$/i.test(seg)) {
      prevKey ??= 'shift+tab';
    } else if (/^(?:→|right)\s+(?:to\s+)?(?:next|switch)$/i.test(seg)) {
      nextKey = 'right';
    } else if (/^tab\s+(?:to\s+)?(?:next|switch)$/i.test(seg)) {
      nextKey ??= 'tab';
    } else if (/^tab\s+(?:to\s+)?add\s+notes$/i.test(seg)) {
      hasTabNotes = true;
    } else if (/^space\s+(?:to\s+)?(?:toggle|select|check)$/i.test(seg)) {
      hasToggle = true;
    } else if (/^(?:space\/enter|enter\/space)\s+(?:to\s+)?(?:toggle|select)$/i.test(seg)) {
      hasToggle = true;
      hasSelect = true;
    } else if (/^enter\s+(?:to\s+)?(?:select|choose)$/i.test(seg)) {
      hasSelect = true;
    } else if (/^enter\s+(?:to\s+)?(?:confirm|save|continue)$/i.test(seg)) {
      hasConfirm = true;
    } else if (/^enter\s+(?:to\s+)?submit(?:\s+(?:all|answer|answers))?$/i.test(seg)) {
      hasSubmit = true;
    } else if (/^esc\s+(?:to\s+)?skip$/i.test(seg)) {
      hasSkip = true;
    } else if (/^esc\s+(?:to\s+)?(?:back|go\s+back)$/i.test(seg)) {
      hasBack = true;
    } else if (/^esc\s+(?:to\s+)?(?:cancel|close|interrupt|dismiss|discard)$/i.test(seg)) {
      hasCancel = true;
    } else if (/^ctrl\+r\s+(?:to\s+)?review$/i.test(seg)) {
      hasReview = true;
    } else if (/^[0-9][-–][0-9]\s+(?:to\s+)?(?:quick\s+)?(?:select|choose)$/i.test(seg)) {
      // Valid numeric quick-select shortcut segment.
    } else {
      return null;
    }
  }

  const count = [
    hasNavigate, !!prevKey, !!nextKey, hasToggle, hasSelect, hasConfirm, hasSubmit,
    hasSkip, hasBack, hasCancel, hasReview, hasTabNotes,
  ].filter(Boolean).length;
  if (count === 0) return null;

  return {
    raw: t,
    hasNavigate,
    prevKey,
    nextKey,
    hasToggle,
    hasSelect,
    hasConfirm,
    hasSubmit,
    hasSkip,
    hasBack,
    hasCancel,
    hasReview,
    hasTabNotes,
    count,
  };
}

function mergeParsedHints(parts: ParsedHintBar[]): ParsedHintBar | null {
  if (parts.length === 0) return null;
  let hasNavigate = false;
  let prevKey: 'left' | 'shift+tab' | undefined;
  let nextKey: 'right' | 'tab' | undefined;
  let hasToggle = false;
  let hasSelect = false;
  let hasConfirm = false;
  let hasSubmit = false;
  let hasSkip = false;
  let hasBack = false;
  let hasCancel = false;
  let hasReview = false;
  let hasTabNotes = false;

  for (const p of parts) {
    if (p.hasNavigate) hasNavigate = true;
    if (p.prevKey === 'left' || (!prevKey && p.prevKey)) prevKey = p.prevKey;
    if (p.nextKey === 'right' || (!nextKey && p.nextKey)) nextKey = p.nextKey;
    if (p.hasToggle) hasToggle = true;
    if (p.hasSelect) hasSelect = true;
    if (p.hasConfirm) hasConfirm = true;
    if (p.hasSubmit) hasSubmit = true;
    if (p.hasSkip) hasSkip = true;
    if (p.hasBack) hasBack = true;
    if (p.hasCancel) hasCancel = true;
    if (p.hasReview) hasReview = true;
    if (p.hasTabNotes) hasTabNotes = true;
  }

  const count = [
    hasNavigate, !!prevKey, !!nextKey, hasToggle, hasSelect, hasConfirm, hasSubmit,
    hasSkip, hasBack, hasCancel, hasReview, hasTabNotes,
  ].filter(Boolean).length;
  if (count < 2) return null;
  const hasActionVerb = hasNavigate || hasToggle || hasSelect || hasConfirm || hasSubmit || hasReview || hasSkip || hasBack || hasTabNotes;
  if (!hasActionVerb) return null;

  return {
    raw: parts.map((p) => p.raw).join(' '),
    hasNavigate,
    prevKey,
    nextKey,
    hasToggle,
    hasSelect,
    hasConfirm,
    hasSubmit,
    hasSkip,
    hasBack,
    hasCancel,
    hasReview,
    hasTabNotes,
    count,
  };
}

function matchHintWindow(texts: string[]): ParsedHintBar | null {
  // 1. Whole window joined with spaces (handles tokens broken across any line boundary in 1–3 wrapped rows).
  const whole = parseHintLineTokens(texts.join(' '));
  if (whole) {
    const merged = mergeParsedHints([whole]);
    if (merged) return merged;
  }
  // 2. Each row independently valid, merged together (handles multi-line wrapping without inter-line separators).
  const directParts: ParsedHintBar[] = [];
  for (const t of texts) {
    const p = parseHintLineTokens(t);
    if (!p) {
      directParts.length = 0;
      break;
    }
    directParts.push(p);
  }
  if (directParts.length === texts.length) {
    const merged = mergeParsedHints(directParts);
    if (merged) return merged;
  }
  // 3. Three-row window where one adjacent pair broke mid-token while the remaining row is complete.
  if (texts.length === 3) {
    const ab = parseHintLineTokens(`${texts[0]} ${texts[1]}`);
    const c = parseHintLineTokens(texts[2]);
    if (ab && c) {
      const merged = mergeParsedHints([ab, c]);
      if (merged) return merged;
    }
    const a = parseHintLineTokens(texts[0]);
    const bc = parseHintLineTokens(`${texts[1]} ${texts[2]}`);
    if (a && bc) {
      const merged = mergeParsedHints([a, bc]);
      if (merged) return merged;
    }
  }
  return null;
}

function cleanRecommended(raw: string): { label: string; recommended: boolean } {
  let label = raw.trim();
  let recommended = false;
  if (RECOMMENDED_PREFIX_RE.test(label)) {
    recommended = true;
    const stripped = label.replace(RECOMMENDED_PREFIX_RE, '').trim();
    if (stripped) label = stripped;
  } else if (RECOMMENDED_SUFFIX_RE.test(label)) {
    recommended = true;
    const stripped = label.replace(RECOMMENDED_SUFFIX_RE, '').trim();
    if (stripped) label = stripped;
  }
  return { label, recommended };
}

function parseOptionStart(raw: string): {
  cursor: boolean;
  number?: string;
  checked?: boolean;
  label: string;
  numbered: boolean;
} | null {
  const unboxed = unboxPanelLine(raw);
  if (!unboxed.trim()) return null;
  const cm = PICKER_CURSOR_RE.exec(unboxed);
  const cursor = !!cm;
  const body = (cm ? (cm[3] ?? '') : unboxed.trimStart()).trim();
  if (!body) return null;

  const nm = NUMBERED_OPT_RE.exec(body);
  if (nm) {
    const boxMark = nm[2] ?? nm[3];
    const checked = boxMark !== undefined ? boxMark !== ' ' && boxMark !== '☐' : undefined;
    return { cursor, number: nm[1], checked, label: nm[4].trim(), numbered: true };
  }
  const cbm = CHECKBOX_OPT_RE.exec(body);
  if (cbm) {
    const boxMark = cbm[1] ?? cbm[2];
    const checked = boxMark !== ' ' && boxMark !== '☐';
    return { cursor, number: cbm[3], checked, label: cbm[4].trim(), numbered: !!cbm[3] };
  }
  return null;
}

function buildQuestionActions(
  hint: ParsedHintBar | null,
  mode: PtyInteractivePrompt['mode'],
  hasGlobalCancel: boolean,
): PtyQuestionAction[] {
  const actions: PtyQuestionAction[] = [];
  if (hint?.prevKey) {
    actions.push({
      id: 'prev',
      label: '上一题',
      keyHint: hint.prevKey === 'shift+tab' ? 'Shift+Tab' : '←',
      key: hint.prevKey,
    });
  }
  if (hint?.nextKey) {
    actions.push({
      id: 'next',
      label: '下一题',
      keyHint: hint.nextKey === 'tab' ? 'Tab' : '→',
      key: hint.nextKey,
    });
  }
  if (mode === 'multi') {
    actions.push({ id: 'confirm', label: '确认本题', keyHint: 'Enter', key: 'enter' });
  } else if (mode === 'review' && (hint?.hasSubmit || hint?.hasConfirm)) {
    actions.push({ id: 'submit', label: '提交全部', keyHint: 'Enter', key: 'enter' });
  }
  if (hint?.hasReview) actions.push({ id: 'review', label: '核对提交', keyHint: 'Ctrl+R', key: 'ctrl+r' });
  if (hint?.hasSkip) {
    actions.push({ id: 'skip', label: '跳过', keyHint: 'Esc', key: 'esc' });
  } else if (hint?.hasBack) {
    actions.push({ id: 'back', label: '返回', keyHint: 'Esc', key: 'esc' });
  } else if (hint?.hasCancel || hasGlobalCancel) {
    actions.push({ id: 'cancel', label: '取消', keyHint: 'Esc', key: 'esc' });
  }
  return actions;
}

// Extracts an active interactive question/choice TUI picker from the browser's live xterm.js viewport.
// Returns `null` when the terminal is in alternate screen, sits at a normal CLI prompt, or shows ordinary output.
export function extractPtyInteractivePrompt(
  agent: AgentKind,
  lines: TermLineSample[],
  isAlternate = false,
): PtyInteractivePrompt | null {
  if (isAlternate || lines.length === 0) return null;

  // 1. Strip bottom global chrome (blank rows, status/model footers, subagent bars, closing frame/rules)
  //    while preserving any single-line or narrow-wrapped interactive navigation hint bar.
  let end = lines.length;
  let scanned = 0;
  let hint: ParsedHintBar | null = null;
  const hintRowIndices: number[] = [];
  let hasGlobalCancel = false;

  while (end > 0 && scanned < 10) {
    const raw = lines[end - 1].text;
    const unboxed = unboxPanelLine(raw);
    const t = unboxed.trim();
    scanned++;
    if (!t) {
      end--;
      continue;
    }
    if (parsePtySubagentLine(t)) {
      end--;
      continue;
    }
    // Try matching the longest valid contiguous shortcut hint window (3 -> 2 -> 1 rows) so narrow-screen
    // 2–3 line wrapped hint bars are consumed completely without leaving line 1 inside `slice`.
    let matchedWindow: { parsed: ParsedHintBar; rows: number[] } | null = null;
    for (let k = Math.min(3, end); k >= 1; k--) {
      const rows: number[] = [];
      const texts: string[] = [];
      let contiguous = true;
      for (let r = end - k; r < end; r++) {
        const rt = unboxPanelLine(lines[r].text).trim();
        if (!rt) {
          contiguous = false;
          break;
        }
        rows.push(r);
        texts.push(rt);
      }
      if (!contiguous) continue;
      const parsed = matchHintWindow(texts);
      if (parsed) {
        matchedWindow = { parsed, rows };
        break;
      }
    }
    if (matchedWindow) {
      hint = matchedWindow.parsed;
      hintRowIndices.push(...matchedWindow.rows);
      end = matchedWindow.rows[0];
      break;
    }
    if (RULE_RE.test(t) || PANEL_FRAME_BOTTOM_RE.test(raw)) {
      end--;
      continue;
    }
    if (FOOTER_NOISE_RE.test(t) || TIP_LINE_RE.test(t) || AGY_PROMO_RE.test(t) || PROMPT_FOOTER_EXTRA_RE.test(t)) {
      if (/\besc to cancel\b/i.test(t)) hasGlobalCancel = true;
      end--;
      continue;
    }
    break;
  }

  // A live interactive shortcut hint bar is mandatory: ordinary Markdown replies (e.g. `Question 1/2:` +
  // blockquote `> 1. JSON` + `  2. YAML`) must NEVER be swallowed as an interactive picker.
  if (end <= 0 || !hint) return null;

  // 2. Locate the top boundary of the interactive panel (bounded by horizontal rule, box top, or CLI output anchor).
  const minStart = Math.max(0, end - 36);
  let start = minStart;
  for (let i = end - 1; i >= minStart; i--) {
    const raw = lines[i].text;
    const unboxed = unboxPanelLine(raw);
    const t = unboxed.trim();
    if (!t) continue;
    if (RULE_RE.test(t) || EMBEDDED_RULE_RE.test(t) || PANEL_FRAME_TOP_RE.test(raw)) {
      start = i + 1;
      break;
    }
    if (AGY_MARKER_RE.test(t) || AGY_STATS_RE.test(t) || AGY_BANNER_RE.test(t) || OUTPUT_STOP_RE.test(t)) {
      start = i + 1;
      break;
    }
    if (QUESTION_HEADER_RE.test(t)) {
      start = i;
      // Preserve a Claude-style multi-question tab header immediately above the Question line when present.
      if (i > minStart && TAB_BAR_RE.test(unboxPanelLine(lines[i - 1].text).trim())) {
        start = i - 1;
      }
      break;
    }
  }

  const slice = lines.slice(start, end);
  while (slice.length > 0 && !unboxPanelLine(slice[0].text).trim()) slice.shift();
  while (slice.length > 0 && !unboxPanelLine(slice[slice.length - 1].text).trim()) slice.pop();
  if (slice.length === 0) return null;

  // 3. Scan for numbered / checkbox option groups; prefer the bottom-most group that holds the TUI selection cursor
  //    so numbered summary lines in a Review screen (`1. Q1: ...`) never shadow `> Submit All` / `Back` below.
  interface RawOpt {
    rowIdx: number;
    cursor: boolean;
    number?: string;
    checked?: boolean;
    label: string;
    description?: string;
    numbered: boolean;
  }

  let rawOpts: RawOpt[] = [];
  let firstOptIdx = -1;
  let lastOptEndIdx = -1;

  const isWriteInHint = !!hint && !hint.hasNavigate && (hint.hasSubmit || hint.hasConfirm) && (hint.hasBack || hint.hasCancel);

  let curOpts: RawOpt[] = [];
  let curFirst = -1;
  let curLast = -1;
  const commitGroup = () => {
    if (curOpts.length > 0 && curOpts.some((o) => o.cursor)) {
      rawOpts = curOpts;
      firstOptIdx = curFirst;
      lastOptEndIdx = curLast;
    }
    curOpts = [];
    curFirst = -1;
    curLast = -1;
  };

  for (let i = 0; i < slice.length; i++) {
    const sample = slice[i];
    const unboxed = unboxPanelLine(sample.text);
    const t = unboxed.trim();
    if (!t) {
      commitGroup();
      continue;
    }
    const parsed = parseOptionStart(sample.text);
    if (parsed) {
      if (parsed.numbered) {
        const expected = curOpts.length === 0 ? 1 : Number(curOpts[curOpts.length - 1].number) + 1;
        const got = Number(parsed.number);
        if (got !== expected) {
          commitGroup();
          if (got !== 1) continue;
        }
      }
      if (curFirst < 0) curFirst = i;
      curOpts.push({ rowIdx: i, ...parsed });
      curLast = i;
      continue;
    }
    if (curOpts.length > 0) {
      const prev = curOpts[curOpts.length - 1];
      const isCursorOrPrompt = PICKER_CURSOR_RE.test(unboxed);
      const prevCleanLabel = cleanRecommended(prev.label).label;
      const prevIsWriteIn = WRITE_IN_LABEL_RE.test(prevCleanLabel);
      const isIndented = /^\s+/.test(unboxed);
      const isBoundaryLine =
        isCursorOrPrompt ||
        (isWriteInHint && prevIsWriteIn) ||
        (!isIndented &&
          (prevIsWriteIn ||
            CONTINUATION_BOUNDARY_ACTION_RE.test(t) ||
            TAB_BAR_RE.test(t) ||
            QUESTION_HEADER_RE.test(t) ||
            REVIEW_TITLE_RE.test(t) ||
            STRUCTURAL_WRITE_IN_LABEL_RE.test(t) ||
            WRITE_IN_INPUT_LINE_RE.test(t)));
      if (isBoundaryLine) {
        commitGroup();
        continue;
      }
      if (sample.muted && (/^\s{2,}/.test(unboxed) || prev.description !== undefined)) {
        prev.description = prev.description ? joinWrappedLine(prev.description, t) : t;
      } else {
        // Accept both indented and narrow-screen hard-wrapped unindented continuations inside a hint-verified panel.
        prev.label = joinWrappedLine(prev.label, t);
      }
      curLast = i;
    }
  }
  commitGroup();

  // Fallback for unnumbered cursor action rows (e.g. Review screen: `> Submit All` / `  Back`) when a hint bar is present.
  if (rawOpts.length === 0 && hint) {
    let cursorRow = -1;
    for (let i = slice.length - 1; i >= 0; i--) {
      const unboxed = unboxPanelLine(slice[i].text);
      const cm = PICKER_CURSOR_RE.exec(unboxed);
      if (cm && UNNUMBERED_ACTION_RE.test((cm[3] ?? '').trim())) {
        cursorRow = i;
        break;
      }
    }
    if (cursorRow >= 0) {
      let blockStart = cursorRow;
      while (blockStart > 0) {
        const u = unboxPanelLine(slice[blockStart - 1].text).trim();
        if (!u || !UNNUMBERED_ACTION_RE.test(u.replace(/^[>❯›▸▶]\s+/, ''))) break;
        blockStart--;
      }
      let blockEnd = cursorRow;
      while (blockEnd + 1 < slice.length) {
        const u = unboxPanelLine(slice[blockEnd + 1].text).trim();
        if (!u || !UNNUMBERED_ACTION_RE.test(u.replace(/^[>❯›▸▶]\s+/, ''))) break;
        blockEnd++;
      }
      if (blockEnd >= blockStart) {
        firstOptIdx = blockStart;
        lastOptEndIdx = blockEnd;
        for (let i = blockStart; i <= blockEnd; i++) {
          const u = unboxPanelLine(slice[i].text);
          const cm = PICKER_CURSOR_RE.exec(u);
          rawOpts.push({
            rowIdx: i,
            cursor: !!cm,
            label: (cm ? (cm[3] ?? '') : u).trim(),
            numbered: false,
          });
        }
      }
    }
  }

  // 4. Parse header lines above the options (or the entire panel when in write-in / review mode without options).
  const headerSlice = firstOptIdx >= 0 ? slice.slice(0, firstOptIdx) : slice;
  const trailingSlice = lastOptEndIdx >= 0 && lastOptEndIdx + 1 < slice.length ? slice.slice(lastOptEndIdx + 1) : [];

  let progress: { current: number; total: number } | undefined;
  const titleLines: string[] = [];
  const subtitleLines: string[] = [];
  let inTitle = false;

  for (const sample of headerSlice) {
    const t = unboxPanelLine(sample.text).trim();
    if (!t) {
      if (titleLines.length > 0) inTitle = false;
      continue;
    }
    if (TAB_BAR_RE.test(t)) {
      subtitleLines.push(t);
      continue;
    }
    const qm = QUESTION_HEADER_RE.exec(t);
    if (qm) {
      progress = { current: Number(qm[1]), total: Number(qm[2]) };
      const rest = (qm[3] ?? '').trim();
      if (rest) titleLines.push(rest);
      inTitle = true;
      continue;
    }
    if (titleLines.length === 0) {
      titleLines.push(t);
      inTitle = true;
    } else if (inTitle && !REVIEW_TITLE_RE.test(titleLines[0])) {
      titleLines[titleLines.length - 1] = joinWrappedLine(titleLines[titleLines.length - 1], t);
    } else {
      subtitleLines.push(t);
    }
  }

  const options: PtyQuestionOption[] = rawOpts.map((opt, index) => {
    const { label, recommended } = cleanRecommended(opt.label);
    return {
      index,
      ...(opt.number ? { number: opt.number } : {}),
      label,
      ...(opt.description ? { description: opt.description } : {}),
      ...(recommended ? { recommended: true } : {}),
      selected: opt.cursor,
      ...(opt.checked !== undefined ? { checked: opt.checked } : {}),
      ...(WRITE_IN_LABEL_RE.test(label) ? { isWriteIn: true } : {}),
      ...(SUBMIT_LABEL_RE.test(label) ? { isSubmit: true } : {}),
      ...(BACK_LABEL_RE.test(label) ? { isBack: true } : {}),
    };
  });

  const selectedIndex = options.findIndex((o) => o.selected);
  const title = titleLines.join('\n').trim();
  const trailingText = trailingSlice.map((l) => unboxPanelLine(l.text).trim()).filter(Boolean);

  // 5. Classify mode with strict anti-false-positive guards.
  let mode: PtyInteractivePrompt['mode'] | null = null;
  let writeInText: string | undefined;

  const selectedIsWriteIn = selectedIndex >= 0 && options[selectedIndex]?.isWriteIn === true;
  const hasTrailingInput = trailingText.some((t) => WRITE_IN_LABEL_RE.test(t) || WRITE_IN_INPUT_LINE_RE.test(t));
  const hasSubtitleInput = subtitleLines.some((t) => WRITE_IN_INPUT_LINE_RE.test(t));
  // Match ONLY standalone structural prompt headers, never arbitrary substrings inside a user's Review summary answers.
  const hasStructuralWriteInHeader =
    STRUCTURAL_WRITE_IN_LABEL_RE.test(title) ||
    subtitleLines.some((t) => STRUCTURAL_WRITE_IN_LABEL_RE.test(t));
  const isReviewScreen =
    !selectedIsWriteIn &&
    !hasTrailingInput &&
    (options.some((o) => o.isSubmit) ||
      (REVIEW_TITLE_RE.test(title) && (options.length > 0 || hint.hasSubmit || hint.hasConfirm)) ||
      (!progress && !hasSubtitleInput && !hasStructuralWriteInHeader && hint.hasSubmit && !hint.hasNavigate && options.length === 0 && (subtitleLines.length > 0 || title.length > 0)));

  if (isReviewScreen) {
    mode = 'review';
  } else if (
    isWriteInHint &&
    (selectedIsWriteIn || hasTrailingInput || hasSubtitleInput || hasStructuralWriteInHeader || (options.length === 0 && !!progress))
  ) {
    mode = 'write-in';
    const inputCandidates = trailingText.length > 0 ? trailingText : subtitleLines;
    for (let i = inputCandidates.length - 1; i >= 0; i--) {
      const m = WRITE_IN_INPUT_LINE_RE.exec(inputCandidates[i]);
      if (m) {
        writeInText = m[1].trim();
        if (inputCandidates === subtitleLines) subtitleLines.splice(i, 1);
        break;
      }
    }
    // Drop a lone `Write-in:` label from subtitle when the card itself already shows the Write-in header.
    for (let i = subtitleLines.length - 1; i >= 0; i--) {
      if (/^write-in\s*[:：]?$/i.test(subtitleLines[i])) subtitleLines.splice(i, 1);
    }
  } else if (options.length >= 2 && selectedIndex >= 0) {
    const hasCheckbox = options.some((o) => o.checked !== undefined);
    mode = hasCheckbox || hint.hasToggle ? 'multi' : 'select';
  }

  if (!mode) return null;

  // In Review mode with no explicit title, keep a clean heading and move lines into subtitle.
  let finalTitle = title;
  const finalSubLines = [...subtitleLines];
  if (mode === 'review' && !finalTitle) {
    finalTitle = '核对并提交回答';
  } else if (mode === 'write-in' && !finalTitle) {
    finalTitle = '输入自定义回答';
  }
  if (mode === 'review' && trailingText.length > 0) {
    finalSubLines.push(...trailingText);
  }
  const subtitle = finalSubLines.length > 0 ? finalSubLines.join('\n') : undefined;
  const actions = buildQuestionActions(hint, mode, hasGlobalCancel);
  const rawLines = [
    ...slice.map((l) => l.text.trimEnd()),
    ...hintRowIndices.map((idx) => lines[idx].text.trimEnd()),
  ];
  const fingerprint = JSON.stringify([
    mode,
    progress?.current ?? 0,
    progress?.total ?? 0,
    finalTitle,
    subtitle ?? '',
    selectedIndex,
    options.map((o) => [o.number ?? '', o.label, o.checked ?? null, o.selected]),
    writeInText ?? '',
    hint?.raw ?? '',
  ]);

  return {
    mode,
    ...(progress ? { progress } : {}),
    title: finalTitle || '请选择',
    ...(subtitle ? { subtitle } : {}),
    options,
    selectedIndex,
    ...(writeInText !== undefined ? { writeInText } : {}),
    actions,
    rawHint: hint?.raw ?? '',
    rawLines,
    fingerprint,
  };
}

// Removes live PTY answer text (whole or leading lines) once the authoritative transcript has already committed
// those assistant messages, and guards against replaying previous-turn prose before the CLI echoes a new prompt.
export function dedupeLiveAnswer(answerText: string | undefined, blocks: StreamBlock[]): string | undefined {
  if (!answerText) return undefined;
  const recentCommitted: string[] = [];
  for (let i = blocks.length - 1; i >= 0 && recentCommitted.length < 6; i--) {
    const b = blocks[i];
    if (b.kind === 'user' && !b.pending) break;
    if (b.kind !== 'assistant') continue;
    const normCommitted = normForDedupe(b.text);
    if (normCommitted) recentCommitted.push(normCommitted);
  }
  if (recentCommitted.length === 0) return answerText;

  const matchesCommitted = (normText: string): boolean => {
    for (const c of recentCommitted) {
      if (
        c === normText ||
        c.startsWith(normText) ||
        (c.length >= 16 && normText.startsWith(c)) ||
        (normText.length >= 10 && c.includes(normText.slice(0, Math.min(48, normText.length))))
      ) {
        return true;
      }
    }
    return false;
  };

  // Matches a short wrapped trailing fragment (e.g. standalone "评审结论。" when the first half of the wrapped line
  // scrolled off or sat above an anchor) against the exact tail of a recently committed assistant block.
  const isCommittedWrappedTail = (normFrag: string): boolean => {
    if (normFrag.length < 4) return false;
    const hasTailBoundary = /[。！？.!?…）)\]]$/.test(normFrag) || normFrag.length >= 8;
    if (!hasTailBoundary) return false;
    return recentCommitted.some((c) => c.length > normFrag.length && c.endsWith(normFrag));
  };

  // 0. Check exact/prefix/wrapped-tail containment of the whole joined block first (never `normWhole.startsWith(c)`,
  // because a longer multi-line tail may contain brand-new streamed lines after earlier committed narration).
  const normWhole = normForDedupe(answerText);
  if (
    !normWhole ||
    recentCommitted.some((c) => c === normWhole || c.startsWith(normWhole)) ||
    isCommittedWrappedTail(normWhole)
  ) {
    return undefined;
  }

  // 1. Greedily strip leading committed blocks (spanning 1..N wrapped lines) that were already flushed to transcript.
  const rawLines = answerText.split('\n');
  let startIdx = 0;
  while (startIdx < rawLines.length) {
    if (!normForDedupe(rawLines[startIdx])) {
      startIdx++;
      continue;
    }
    let matchedEnd = -1;
    const maxEnd = Math.min(rawLines.length, startIdx + 12);
    for (let endIdx = maxEnd; endIdx > startIdx; endIdx--) {
      const seg = normForDedupe(rawLines.slice(startIdx, endIdx).join('\n'));
      if (!seg) continue;
      const hit = recentCommitted.some(
        (c) => c === seg || c.startsWith(seg) || (seg.length >= 10 && c.includes(seg)),
      ) || (startIdx === 0 && endIdx === 1 && isCommittedWrappedTail(seg));
      if (hit) {
        matchedEnd = endIdx;
        break;
      }
    }
    if (matchedEnd > startIdx) startIdx = matchedEnd;
    else break;
  }
  const remaining = rawLines.slice(startIdx).join('\n').trim();
  if (!remaining) return undefined;

  // 2. Compare the remaining live tail against recently committed full blocks.
  const normRem = normForDedupe(remaining);
  if (!normRem || matchesCommitted(normRem) || isCommittedWrappedTail(normRem)) return undefined;
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
  subagents?: StreamSubagent[];
  now: number;
}): LiveStreamTail | null {
  const { session, blocks, activity, ptyExtract, subagents, now } = opts;
  if (session.status !== 'working') return null;
  const startedAt = activity?.turnStartedAt ?? session.statusSince ?? now;
  const answerText = dedupeLiveAnswer(ptyExtract?.answerText, blocks);
  const ptyThinking = dedupeLiveThinking(ptyExtract?.thinkingText, blocks);
  const actThinking = dedupeLiveThinking(activity?.thinkingSnippet, blocks);
  const thinkingText = ptyThinking || actThinking || undefined;
  const activeStep = [...blocks].reverse().find((b): b is Extract<StreamBlock, { kind: 'step' }> => b.kind === 'step' && b.active === true);
  const hasRunningStep = !!activeStep;
  const hasRunningNonSubagentTool = !!activeStep?.tools.some((t) => t.status === 'running' && !t.subagentId);
  const runningSubs = (subagents ?? []).filter((s) => s.status === 'running');
  const ptyRunningSubs = (ptyExtract?.subagents ?? []).filter((s) => s.status === 'running');
  const activeSubCount = Math.max(runningSubs.length, ptyRunningSubs.length);

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
  if (!hasRunningNonSubagentTool && (activity?.phase === 'subagent' || activeSubCount > 0)) {
    const lead = runningSubs[0] ?? ptyRunningSubs[0];
    const leadLabel = lead ? (lead.role ? `${lead.name}: ${lead.role}` : lead.name) : '';
    const subSummary = activeSubCount > 1
      ? `正在等待 ${activeSubCount} 个子代理完成…`
      : leadLabel
        ? `等待子代理：${leadLabel}`
        : activity?.summary || '等待子代理或后台任务完成…';
    return {
      phase: 'subagent',
      ...(ptyThinking ? { thinkingText: ptyThinking } : {}),
      toolSummary: subSummary,
      startedAt,
      updatedAt: now,
      source: ptyRunningSubs.length > 0 ? 'pty' : 'activity',
    };
  }
  if (hasRunningStep || activity?.phase === 'tool') {
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
