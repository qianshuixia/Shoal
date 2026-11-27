import type { StreamBlock, StreamToolEntry } from '../../../shared/protocol.ts';
import { fmtCompactSec } from './format.ts';

export type StepBlock = Extract<StreamBlock, { kind: 'step' }>;

export type ToolClass = 'read' | 'command' | 'edit' | 'other';

// Tool names differ across Claude Code / Codex / Antigravity; classify by well-known verbs only.
const READ_RE = /^(read|view|open|cat|ls|list|glob|grep|search|find|fetch|web_?search|web_?fetch|view_file|read_file|list_dir|grep_search|find_by_name|codebase_search)/i;
const COMMAND_RE = /^(bash|shell|sh|exec|run|command|powershell|pwsh|terminal|local_shell|shell_command|run_command|execute)/i;
const EDIT_RE = /^(edit|write|multi_?edit|apply_?patch|patch|replace|create|str_replace|notebook_?edit|update_file|write_to_file|replace_file_content|multi_replace)/i;

export function classifyTool(name: string): ToolClass {
  const n = name.trim();
  if (EDIT_RE.test(n)) return 'edit';
  if (COMMAND_RE.test(n)) return 'command';
  if (READ_RE.test(n)) return 'read';
  return 'other';
}

export interface StepSummary {
  steps: number; // tool calls, plus thinking-only blocks (one step each)
  reads: number;
  commands: number;
  edits: number;
  failed: number;
  durationSec: number; // 0 when unknown
}

function toolsOf(block: StepBlock): StreamToolEntry[] {
  return block.tools ?? [];
}

export function summarizeStepGroup(blocks: StepBlock[]): StepSummary {
  let steps = 0;
  let reads = 0;
  let commands = 0;
  let edits = 0;
  let failed = 0;
  let thinkingSum = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  for (const b of blocks) {
    const tools = toolsOf(b);
    steps += tools.length > 0 ? tools.length : 1;
    for (const t of tools) {
      const cls = classifyTool(t.name);
      if (cls === 'read') reads++;
      else if (cls === 'command') commands++;
      else if (cls === 'edit') edits++;
      if (t.status === 'error') failed++;
    }
    if (b.thinkingSec && b.thinkingSec > 0) thinkingSum += b.thinkingSec;
    if (b.at) {
      if (firstAt === undefined || b.at < firstAt) firstAt = b.at;
      if (lastAt === undefined || b.at > lastAt) lastAt = b.at;
    }
  }
  const span = firstAt !== undefined && lastAt !== undefined ? Math.max(0, (lastAt - firstAt) / 1000) : 0;
  return { steps, reads, commands, edits, failed, durationSec: Math.max(thinkingSum, span) };
}

export function formatStepSummary(s: StepSummary): string {
  const parts = [`思考与执行 · ${s.steps} 步`];
  if (s.reads > 0) parts.push(`读取 ${s.reads} 个文件`);
  if (s.commands > 0) parts.push(`运行 ${s.commands} 次命令`);
  if (s.edits > 0) parts.push(`编辑 ${s.edits} 处`);
  if (s.failed > 0) parts.push(`${s.failed} 处失败`);
  if (s.durationSec >= 1) parts.push(fmtCompactSec(s.durationSec));
  return parts.join(' · ');
}

export type FlowItem =
  | { type: 'block'; id: string; block: StreamBlock }
  | { type: 'steps'; id: string; blocks: StepBlock[] };

// Turns the raw block list into render items:
// - completed steps of an older turn always collapse into one capsule per consecutive run;
// - inside the latest turn a run of >= 2 completed steps collapses, a lone step and any active step stay expanded.
// A turn starts at a user block that is not a queued/failed pending bubble.
export function buildFlow(blocks: StreamBlock[]): FlowItem[] {
  let latestTurnStart = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'user' && !b.pending) {
      latestTurnStart = i;
      break;
    }
  }
  const items: FlowItem[] = [];
  let run: StepBlock[] = [];
  let runStart = -1;
  const flush = () => {
    if (run.length === 0) return;
    const inLatest = runStart > latestTurnStart;
    if (!inLatest || run.length >= 2) {
      items.push({ type: 'steps', id: `steps:${run[0].id}`, blocks: run });
    } else {
      for (const b of run) items.push({ type: 'block', id: b.id, block: b });
    }
    run = [];
    runStart = -1;
  };
  blocks.forEach((b, idx) => {
    if (b.kind === 'step' && !b.active) {
      if (run.length === 0) runStart = idx;
      run.push(b);
      return;
    }
    flush();
    items.push({ type: 'block', id: b.id, block: b });
  });
  flush();
  return items;
}

export const WINDOW_SIZE = 60;

export interface WindowedFlow {
  items: FlowItem[];
  hidden: number; // items older than the window
}

export function windowFlow(items: FlowItem[], limit: number): WindowedFlow {
  if (items.length <= limit) return { items, hidden: 0 };
  return { items: items.slice(items.length - limit), hidden: items.length - limit };
}
