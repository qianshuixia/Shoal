import fs from 'node:fs';
import type { AgentKind } from '../shared/protocol.ts';

export interface Turn { role: 'user' | 'assistant' | 'tool'; text: string }

const FULL_READ = 4 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 3 * 1024 * 1024;
const USER_KEEP = 2000; // first / last user turn
const TEXT_MAX = 1500;
const TOOL_MAX = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// Conversation turns of a CLI's own transcript file; [] when it cannot be read. Never throws.
export function readTranscript(agent: AgentKind, file: string): Turn[] {
  try {
    const fd = fs.openSync(file, 'r');
    let raw: string;
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= FULL_READ) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        raw = buf.toString('utf8');
      } else {
        const head = Buffer.alloc(HEAD_BYTES);
        fs.readSync(fd, head, 0, HEAD_BYTES, 0);
        const tail = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
        const h = head.toString('utf8');
        const t = tail.toString('utf8');
        // Drop the lines cut by the two boundaries.
        raw = h.slice(0, h.lastIndexOf('\n') + 1) + t.slice(t.indexOf('\n') + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
    return parseTranscript(agent, raw);
  } catch (e) {
    console.warn(`[transcript] 读取失败：${(e as Error).message}`);
    return [];
  }
}

const SKIP_USER_PREFIX = ['<command-', '<local-command', '<system-reminder>'];

function claudeTurns(v: Obj, out: Turn[]) {
  if (v.isSidechain === true) return;
  const message = isObj(v.message) ? v.message : {};
  const content = message.content;
  if (v.type === 'user') {
    if (v.isMeta === true) return;
    const parts = typeof content === 'string' ? [content] : Array.isArray(content)
      ? content.filter((b): b is Obj => isObj(b) && b.type === 'text').map(b => str(b.text)) : [];
    const text = parts.join('\n').trim();
    if (text && !SKIP_USER_PREFIX.some(p => text.startsWith(p))) out.push({ role: 'user', text });
  } else if (v.type === 'assistant') {
    if (v.isApiErrorMessage === true || !Array.isArray(content)) return;
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && str(b.text).trim()) out.push({ role: 'assistant', text: str(b.text).trim() });
      else if (b.type === 'tool_use') out.push({ role: 'tool', text: `${str(b.name)} ${JSON.stringify(b.input ?? {})}` });
    }
  }
}

function codexTurns(v: Obj, out: Turn[]) {
  if (v.type !== 'response_item' || !isObj(v.payload)) return;
  const p = v.payload;
  if (p.type === 'message') {
    if (p.role !== 'user' && p.role !== 'assistant') return; // developer and others
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b): b is Obj => isObj(b) && (b.type === 'input_text' || b.type === 'output_text'))
      .map(b => str(b.text)).join('').trim();
    if (!text) return;
    if (p.role === 'user' && (text.startsWith('# AGENTS.md instructions') || text.startsWith('<'))) return;
    out.push({ role: p.role, text });
  } else if (p.type === 'function_call') {
    out.push({ role: 'tool', text: `${str(p.name)} ${str(p.arguments)}` });
  } else if (p.type === 'custom_tool_call') {
    out.push({ role: 'tool', text: `${str(p.name)} ${str(p.input)}` });
  }
}

// Extracts only the human-authored message from an agy USER_INPUT payload, discarding agy-injected sibling tags
// such as <ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, <SYSTEM_MESSAGE>, or <EPHEMERAL_MESSAGE>.
export function cleanAgyUserInput(raw: string): string {
  const match = /<USER_REQUEST>([\s\S]*)<\/USER_REQUEST>/i.exec(raw);
  if (match) return match[1].trim();
  return raw
    .replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|EPHEMERAL_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|EPHEMERAL_MESSAGE)>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
}

function agyTurns(v: Obj, out: Turn[]) {
  if (v.type === 'USER_INPUT') {
    if (v.source !== 'USER_EXPLICIT') return;
    const text = cleanAgyUserInput(str(v.content));
    if (text) out.push({ role: 'user', text });
  } else if (v.type === 'PLANNER_RESPONSE') {
    if (str(v.content).trim()) out.push({ role: 'assistant', text: str(v.content).trim() });
    if (Array.isArray(v.tool_calls)) {
      for (const c of v.tool_calls) if (isObj(c)) out.push({ role: 'tool', text: `${str(c.name)} ${JSON.stringify(c.args ?? {})}` });
    }
  }
}

function fakeTurns(v: Obj, out: Turn[]) {
  if ((v.role === 'user' || v.role === 'assistant') && str(v.text)) out.push({ role: v.role, text: str(v.text) });
}

export function parseTranscript(agent: AgentKind, raw: string): Turn[] {
  const each = agent === 'claude' ? claudeTurns : agent === 'codex' ? codexTurns : agent === 'agy' ? agyTurns : agent === 'fake' ? fakeTurns : null;
  if (!each) return [];
  const out: Turn[] = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let v: unknown;
    try { v = JSON.parse(l); } catch { continue; }
    if (isObj(v)) each(v, out);
  }
  return out;
}

const LABEL = { user: '【用户】', assistant: '【agent】', tool: '【工具】' } as const;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function render(t: Turn, keepUser: boolean): string {
  if (t.role === 'tool') return LABEL.tool + cut(t.text.split('\n')[0], TOOL_MAX);
  return LABEL[t.role] + cut(t.text, t.role === 'user' && keepUser ? USER_KEEP : TEXT_MAX);
}

// Condensed view of a conversation: always the first and last user turn, then the newest turns until the budget is used.
export function excerpt(turns: Turn[], budget: number): string {
  if (!turns.length) return '';
  const users = turns.flatMap((t, i) => (t.role === 'user' ? [i] : []));
  const picked = new Map<number, string>();
  let used = 0;
  for (const i of new Set([users[0], users.at(-1)])) {
    if (i === undefined) continue;
    const s = render(turns[i], true);
    picked.set(i, s);
    used += s.length;
  }
  for (let i = turns.length - 1; i >= 0 && used < budget; i--) {
    if (picked.has(i)) continue;
    const s = render(turns[i], false);
    picked.set(i, s);
    used += s.length;
  }
  const lines: string[] = [];
  let gap = 0;
  for (let i = 0; i < turns.length; i++) {
    const s = picked.get(i);
    if (s === undefined) { gap++; continue; }
    if (gap) lines.push(`（中间省略了 ${gap} 条记录）`);
    gap = 0;
    lines.push(s);
  }
  if (gap) lines.push(`（中间省略了 ${gap} 条记录）`);
  return lines.join('\n');
}
