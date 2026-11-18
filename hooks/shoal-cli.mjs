#!/usr/bin/env node
// Zero-dependency CLI injected into Shoal workbench PTYs via <stateDir>/bin.
// Subcommands: `shoal peers`, `shoal send <target> ...`, `shoal ask <target> ...`,
// `shoal delegate <agent> ...`, `shoal status`, `shoal rework / done / cancel <id>`.
import fs from 'node:fs';
import process from 'node:process';

const USAGE = [
  'Shoal 跨 CLI 同项目协作命令：',
  '  shoal peers [--json]',
  '  shoal send <target> [-m "短说明"] [--file <path>] [--stdin] [--new]',
  '  shoal ask  <target> [-m "短说明"] [--file <path>] [--stdin] [--new]',
  '',
  '委派（把一件事派给另一个 CLI 的新任务，每轮结果自动送回当前会话）：',
  '  shoal delegate <claude|codex|agy> [--review] [--title "标题"] [-m "一行说明"] [--file <path>] [--stdin]',
  '  shoal status [--json]                      查看已委派的任务和状态',
  '  shoal rework <句柄|#序号|标题片段> [-m "意见"] [--file <path>] [--stdin]   打回返工',
  '  shoal done   <句柄|#序号|标题片段>          验收通过并关闭',
  '  shoal cancel <句柄|#序号|标题片段>          放弃并关闭',
  '',
  '提示：<target> 支持 #序号（如 #2）、taskId 前缀、任务标题或 agent 名（claude/codex/agy）。',
  '在 PowerShell 中请勿给目标加未加引号的 @ 前缀；多行正文请使用 --file 或 --stdin。',
  '委派后不要等待或轮询：结果会自动送回当前会话。',
].join('\n');

// Mirrors DELEGATION_LABEL in shared/protocol.ts (this script has no imports from the repo).
const DELEGATION_LABEL = {
  working: '执行中', rework: '返工中', needs_you: '等你处理', review: '待验收', failed: '已中断', accepted: '已通过', canceled: '已取消',
};
const stateLabel = state => DELEGATION_LABEL[state] ?? state;

const port = process.env.WORKBENCH_PORT;
const token = process.env.WORKBENCH_PEER_TOKEN;

function fail(msg, code = 1) {
  process.stderr.write(`[shoal] ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const cmd = (args[0] ?? 'help').toLowerCase();

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (!port || !token) {
  fail('当前终端未在 Shoal 会话内运行（缺少 WORKBENCH_PORT / WORKBENCH_PEER_TOKEN）', 2);
}

const baseUrl = `http://127.0.0.1:${port}`;
const authHeader = { authorization: `Bearer ${token}` };

async function callJson(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body !== undefined
      ? { ...authHeader, 'content-type': 'application/json' }
      : authHeader,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    fail(json?.error ?? `请求失败 (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? 3 : 1);
  }
  return json;
}

if (cmd === 'peers') {
  const asJson = args.includes('--json');
  const data = await callJson('GET', '/api/peer/peers');
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(0);
  }
  process.stdout.write(`项目「${data.projectName}」同行任务（索引文件: ${data.peersFile}）：\n`);
  for (const t of data.tasks) {
    const mark = t.isSelf ? ' [当前]' : '';
    const reply = t.latestReplyFile ? ` -> ${t.latestReplyFile}` : '';
    const deleg = t.delegation ? ` [委派 · ${stateLabel(t.delegation.state)} · 第 ${t.delegation.round} 轮]` : '';
    process.stdout.write(`  #${t.index} [${t.agent}] ${t.title} (${t.status}/${t.phase})${deleg}${mark}${reply}\n`);
  }
  process.exit(0);
}

if (cmd === 'status') {
  const data = await callJson('GET', '/api/peer/delegations');
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    process.exit(0);
  }
  if (data.parent) process.stdout.write(`当前任务是主任务「${data.parent.title}」委派的子任务，不能再向下委派。\n`);
  if (!data.tasks.length) {
    process.stdout.write('当前会话还没有委派任务（用 shoal delegate <claude|codex|agy> 派发）。\n');
    process.exit(0);
  }
  process.stdout.write(`项目「${data.projectName}」中由当前会话委派的任务：\n`);
  for (const t of data.tasks) {
    const reply = t.latestReplyFile ? ` -> ${t.latestReplyFile}` : '';
    process.stdout.write(`  ${t.handle} [${t.agent}] ${t.title} · ${stateLabel(t.state)} · 第 ${t.round} 轮 · ${t.brief}${reply}\n`);
  }
  process.exit(0);
}

if (!['send', 'ask', 'delegate', 'rework', 'done', 'cancel'].includes(cmd)) {
  fail(`未知子命令：${cmd}\n\n${USAGE}`, 2);
}

let target = '';
let note = '';
let title = '';
let filePath = '';
let useStdin = false;
let createIfAgent = false;
let review = false;
const positionals = [];

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--title') {
    if (i + 1 >= args.length) fail(`${a} 缺少参数值`, 2);
    title = args[++i];
  } else if (a === '-m' || a === '--message' || a === '--note') {
    if (i + 1 >= args.length) fail(`${a} 缺少参数值`, 2);
    note = note ? `${note}\n${args[++i]}` : args[++i];
  } else if (a === '--file' || a === '-f') {
    if (i + 1 >= args.length) fail(`${a} 缺少文件路径`, 2);
    filePath = args[++i];
  } else if (a === '--stdin') {
    useStdin = true;
  } else if (a === '--review') {
    review = true;
  } else if (a === '--new') {
    createIfAgent = true;
  } else if (a.startsWith('-')) {
    fail(`未知参数：${a}`, 2);
  } else {
    positionals.push(a);
  }
}

target = (positionals[0] ?? '').replace(/^@+/, '');
if (!target) {
  fail(cmd === 'delegate'
    ? '用法：shoal delegate <claude|codex|agy> [--review] [--title "标题"] [-m "说明"] [--file <path>] [--stdin]'
    : `用法：shoal ${cmd} <${cmd === 'send' || cmd === 'ask' ? 'target' : '句柄|#序号|标题片段'}>${cmd === 'done' || cmd === 'cancel' ? '' : ' [-m "内容"] [--file <path>] [--stdin]'}`, 2);
}
if (cmd === 'done' || cmd === 'cancel') {
  const r = await callJson('POST', `/api/peer/${cmd}`, { target });
  const t = r.task;
  process.stdout.write(`委派任务「${t.title}」(${t.handle}, ${t.agent}) 状态：${stateLabel(t.state)}，已关闭。\n`);
  process.exit(0);
}
if (positionals.length > 1 && !note) {
  note = positionals.slice(1).join(' ');
}

let stdinText = '';
if (useStdin) {
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) stdinText += chunk;
  } catch (e) {
    fail(`读取 stdin 失败：${e?.message ?? e}`, 1);
  }
}

if (cmd === 'delegate') {
  const r = await callJson('POST', '/api/peer/delegate', {
    agent: target,
    ...(title ? { title } : {}),
    ...(note ? { note } : {}),
    ...(filePath ? { filePath } : {}),
    ...(stdinText ? { stdinText } : {}),
    ...(review ? { review: true } : {}),
  });
  const t = r.task;
  process.stdout.write(
    `${review ? '已派出只读评审' : '已派发'}给 ${t.agent}：「${t.title}」(句柄 ${t.handle})。它每完成一轮，结果会自动送回当前会话。不要等待或轮询：继续处理其他工作，没有其他工作就结束本轮。`
    + `验收后用 \`shoal done ${t.handle}\` 关闭，或 \`shoal rework ${t.handle} --stdin\` 打回。\n`,
  );
  process.exit(0);
}

if (cmd === 'rework') {
  const r = await callJson('POST', '/api/peer/rework', {
    target,
    ...(note ? { note } : {}),
    ...(filePath ? { filePath } : {}),
    ...(stdinText ? { stdinText } : {}),
  });
  const t = r.task;
  process.stdout.write(
    `已打回「${t.title}」(句柄 ${t.handle})，进入第 ${t.round} 轮${r.queued ? '（对方还在处理上一轮，意见已排队）' : ''}。`
    + '对方完成后结果会自动送回当前会话。不要等待或轮询：继续处理其他工作，没有其他工作就结束本轮。\n',
  );
  process.exit(0);
}

const result = await callJson('POST', '/api/peer/send', {
  target,
  ...(note ? { note } : {}),
  ...(filePath ? { filePath } : {}),
  ...(stdinText ? { stdinText } : {}),
  replyBack: cmd === 'ask',
  createIfAgent,
});

const verb = result.created ? '已新建协作任务并启动' : result.queued ? '已加入排队投递' : '已发送至';
if (result.replyBack) {
  process.stdout.write(
    `${verb}「${result.targetTitle}」(${result.targetAgent}, hop ${result.hop})。对方本轮完成后结果会自动回传到你的会话；请立即结束当前回合等待回传，勿轮询。\n`,
  );
} else {
  process.stdout.write(`${verb}「${result.targetTitle}」(${result.targetAgent}, hop ${result.hop})。\n`);
}
