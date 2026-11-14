import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentKind, Card, SessionInfo, Task } from '../shared/protocol.ts';
import { AGENT_LABEL } from '../shared/protocol.ts';
import { availableAgents, buildGenerator } from './agents.ts';
import { ENV_STRIP } from './sessions.ts';
import { excerpt } from './transcript.ts';
import type { Turn } from './transcript.ts';

export interface HandoffInput {
  task: Task; from: AgentKind; to: AgentKind;
  cards: Card[]; // the task's cards, oldest first
  turns: Turn[]; // readTranscript result, may be empty
  transcriptPath?: string;
  note?: string; // what the user added
  limit?: SessionInfo['limit'];
}

// agy only takes the prompt as a command-line argument and Windows allows about 32K there.
const PROMPT_MAX = 20_000;
const SECTIONS = ['目标', '已完成', '正在做的', '关键决策', '踩过的坑', '下一步', '必须先读的文件', '验收方法'];

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…（已截断）' : s);
const latest = (cards: Card[], kind: Card['kind']) => cards.filter(c => c.kind === kind).at(-1);

export function generatorPrompt(i: HandoffInput): string {
  const result = latest(i.cards, 'result');
  const prevHandoff = latest(i.cards, 'handoff');
  // Newest first, so the older ones are the first to be dropped when the room runs out.
  const feedback: string[] = [];
  let room = 4000;
  for (const c of i.cards.filter(c => c.kind === 'feedback' || c.kind === 'forward').reverse()) {
    const s = cap(c.body.trim(), 2000);
    if (s.length > room) break;
    room -= s.length;
    feedback.unshift(`### ${c.kind === 'feedback' ? '用户的反馈' : '转发来的内容'}\n${s}`);
  }
  const head = [
    '你要为一个编程任务写一份交接卡片，接手的是另一个 agent。只输出交接卡片正文（Markdown），不要使用任何工具，不要寒暄。',
    `卡片小节固定为：${SECTIONS.map(s => `\`## ${s}\``).join('、')}。没有信息的小节写「（记录里没有）」，不要编造。`,
    '',
    `# 任务：${i.task.title}`,
    `原来由 ${AGENT_LABEL[i.from]} 做，现在交给 ${AGENT_LABEL[i.to]}。${i.limit ? '原因：额度用完。' : ''}`,
    '',
    '## 任务需求',
    cap(i.task.prompt.trim(), 2000) || '（创建任务时没有写需求）',
    '',
    '## 最近一次结果',
    result ? cap(result.body.trim(), 3000) : '（没有）',
    ...(feedback.length ? ['', '## 反馈和转发', ...feedback] : []),
    ...(prevHandoff ? ['', '## 上一张交接卡片', cap(prevHandoff.body.trim(), 2500)] : []),
    ...(i.note?.trim() ? ['', '## 用户补充', cap(i.note.trim(), 1500)] : []),
    '',
    '## 对话记录摘录',
    '',
  ].join('\n');
  const tail = '\n\n现在输出交接卡片。';
  // The excerpt may overshoot its budget by a couple of long turns, so keep a margin and cut hard at the end.
  const room2 = Math.max(0, PROMPT_MAX - head.length - tail.length);
  const body = cap(excerpt(i.turns, Math.max(0, room2 - 4000)) || '（没有读到对话记录）', room2);
  return head + body + tail;
}

export function fallbackCard(i: HandoffInput): string {
  const result = latest(i.cards, 'result');
  const feedback = i.cards.filter(c => c.kind === 'feedback').slice(-3);
  return [
    '（自动整理失败，下面是按记录摘录的原始材料，没有经过总结。）',
    '',
    '## 任务需求',
    i.task.prompt.trim() || '（创建任务时没有写需求）',
    '',
    '## 最近的结果',
    result ? cap(result.body.trim(), 6000) : '（没有）',
    ...(feedback.length ? ['', '## 用户的反馈', ...feedback.map(c => cap(c.body.trim(), 2000))] : []),
    '',
    '## 对话摘录',
    excerpt(i.turns, 12_000) || '（没有读到对话记录）',
  ].join('\n');
}

export function handoffPrompt(task: Pick<Task, 'title'>, card: string, o: { from: AgentKind; transcriptPath?: string; note?: string; limit?: boolean }): string {
  return [
    `继续任务「${task.title}」。之前由 ${AGENT_LABEL[o.from]} 做，${o.limit ? '它的额度用完了' : '用户决定换人'}，现在交给你。`,
    '',
    '## 交接卡片',
    card.trim(),
    ...(o.note?.trim() ? ['', '## 用户的补充', o.note.trim()] : []),
    ...(o.transcriptPath ? ['', '## 原始记录', `${AGENT_LABEL[o.from]} 的完整对话记录在 ${o.transcriptPath}。卡片没写清的地方可以去查，不要整份读进来。`] : []),
    '',
    '先用几句话确认你理解的当前状态和下一步，然后继续做。',
  ].join('\n');
}

// Runs the agent headless once on the prompt and returns its trimmed output. Null on any failure (logged with `what`); never throws.
export async function runHeadless(agent: AgentKind, prompt: string, o: { cwd: string; stateDir: string; timeoutMs?: number; what: string }): Promise<string | null> {
  const outFile = path.join(o.stateDir, 'handoff', `${crypto.randomUUID()}.md`);
  const launch = buildGenerator(agent, prompt, outFile);
  if (!launch) return null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_STRIP.test(k)));
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(launch.file, launch.args, { cwd: o.cwd, env, windowsHide: true, stdio: [launch.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error('超时')));
      }, o.timeoutMs ?? 120_000);
      child.stdout!.setEncoding('utf8').on('data', d => (out += d));
      child.stderr!.setEncoding('utf8').on('data', d => (err += d));
      child.on('error', e => finish(() => reject(e)));
      child.on('close', code => finish(() => (code === 0 ? resolve(out) : reject(new Error(`退出码 ${code}：${err.trim().slice(-300)}`)))));
      if (launch.stdin !== null) {
        child.stdin!.on('error', () => {});
        child.stdin!.end(launch.stdin);
      }
    });
    const text = (launch.outFile ? fs.readFileSync(launch.outFile, 'utf8') : stdout).trim();
    if (!text) throw new Error('输出为空');
    return text;
  } catch (e) {
    console.warn(`[handoff] ${agent} ${o.what}失败：${(e as Error).message}`);
    return null;
  } finally {
    if (launch.outFile) fs.rmSync(launch.outFile, { force: true });
  }
}

// Runs the target agent headless to write the card (when switching to agy, borrows claude/codex if installed, else falls back to excerpt).
// Null on any failure (logged); never throws.
export function generateCard(agent: AgentKind, prompt: string, o: { cwd: string; stateDir: string; timeoutMs?: number }): Promise<string | null> {
  const runner = agent === 'agy' ? availableAgents().find((a): a is 'claude' | 'codex' | 'fake' => a === 'claude' || a === 'codex' || a === 'fake') : agent;
  if (!runner) return Promise.resolve(null);
  return runHeadless(runner, prompt, { ...o, what: '生成交接卡片' });
}
