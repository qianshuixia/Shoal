import type { AgentKind, LiveStreamTail, SessionActivity, SessionInfo, StreamBlock, StreamSubagent } from './protocol.ts';

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
