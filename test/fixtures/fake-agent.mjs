// Fake interactive CLI for e2e tests: behaves like a real agent under ConPTY without using quota.
// Commands (typed line): `link <uri> [text]` (prints an OSC 8 hyperlink to <uri>, then a prompt), `sleep N`, `ask`, `quota`, `tui` (Claude-style hidden cursor),
// `osc52 <text>` (copies <text> like Claude's fullscreen selection does), `osc52?` (asks to read the clipboard),
// `fullscreen` (alternate screen + mouse reporting), `flood N` (prints N KB),`exit N`, `usage <model> <message id> <input> <output> <cache read> <cache write>`
// (writes a Claude-format usage line to the transcript), `/resume <id>` (switches to conversation <id> like claude's in-CLI
// /resume: not a prompt, prints `RESUMED <id>`, sends SessionStart source=resume with the new id); anything else is a 300 ms turn.
// `limits <5h %> <7d %> [5h reset in seconds]` (pipes a claude-style status line with rate_limits through hooks/statusline.mjs, then ends the turn).
// `agylimits <5h %> <7d %> [5h reset in seconds]` (pipes an agy-style status line with Gemini `quota` buckets through hooks/statusline.mjs).
// `menu` (3-item numbered permission menu + PermissionRequest; answered by 1/2/3), `[[trust]] <prompt>` as the first prompt (prints a
// folder-trust startup prompt before any turn and waits for Enter, then runs <prompt>). Keys answering `ask` / `menu` / the trust
// prompt are appended to `<FAKE_AGENT_LOG>.keys` as {sessionId, key}.
// Keeps its own transcript (one JSON line per turn) at <tmp>/shoal-fake/<native id>.jsonl and reports it as transcript_path.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOTIFY = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'notify.mjs');
const STATUSLINE = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'statusline.mjs');
const sid = process.env.WORKBENCH_SESSION_ID ?? 'no-session';
// `--resume <id>` reopens a conversation and keeps its native id, like the real CLIs.
const resumeId = process.argv[2] === '--resume' ? process.argv[3] : undefined;
let nativeId = resumeId ?? `fake-${sid}`;
const initialPrompt = resumeId ? undefined : process.argv[2];
const out = s => process.stdout.write(s);
const transcriptFor = id => path.join(os.tmpdir(), 'shoal-fake', `${id}.jsonl`);
let transcript = transcriptFor(nativeId);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const record = (role, text) => fs.appendFileSync(transcript, JSON.stringify({ role, text }) + '\n');

// One hook at a time, in order, like the real CLIs (they wait for each hook). Fired concurrently, a PermissionRequest
// could reach the server before the UserPromptSubmit sent just before it, leaving the session stuck in working.
let hooks = Promise.resolve();
function hook(event, extra = {}) {
  const body = JSON.stringify({ session_id: nativeId, transcript_path: transcript, ...extra });
  hooks = hooks.then(() => new Promise((done) => {
    const p = spawn(process.execPath, [NOTIFY, 'fake', event], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.on('error', done);
    p.on('exit', done);
    p.stdin.on('error', () => {});
    p.stdin.end(body);
  }));
}

// Like claude's status line command: queued behind the hooks, fed the status JSON on stdin.
function statusLine(status) {
  hooks = hooks.then(() => new Promise((done) => {
    const p = spawn(process.execPath, [STATUSLINE, 'fake'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.on('error', done);
    p.on('exit', done);
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify({ session_id: nativeId, ...status }));
  }));
}

let line = '';
let mode = 'idle'; // idle | working | ask
let queued = false; // Enter pressed while working
let workTimer = null;
let ctrlCAt = 0;

const logKey = (k) => {
  if (process.env.FAKE_AGENT_LOG) fs.appendFileSync(`${process.env.FAKE_AGENT_LOG}.keys`, JSON.stringify({ sessionId: sid, key: k, at: Date.now() }) + '\r\n');
};
const showPrompt = () => out('\r\n> ' + line);

function finishTurn(text) {
  mode = 'idle';
  out(`\r\nreply: ${text}`);
  record('assistant', `reply: ${text}`);
  hook('Stop', { last_assistant_message: `reply: ${text}` });
  out('\r\n> ');
  if (queued) {
    queued = false;
    submit();
  }
}

function splitShellArgs(raw) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function submit() {
  const text = line;
  line = '';
  out('\r\n');
  // Like claude's in-CLI /resume: switches conversation without being a prompt (no UserPromptSubmit, no log entry).
  const switchTo = /^\/resume\s+(\S+)$/.exec(text.trim())?.[1];
  if (switchTo) {
    nativeId = switchTo;
    transcript = transcriptFor(nativeId);
    out(`RESUMED ${nativeId}\r\n> `);
    hook('SessionStart', { source: 'resume' });
    return;
  }
  if (process.env.FAKE_AGENT_LOG) {
    fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ sessionId: sid, line: text, at: Date.now() }) + '\n');
  }
  mode = 'working';
  record('user', text);
  hook('UserPromptSubmit', { prompt: text });
  const [cmd, arg, ...rest] = text.trim().split(/\s+/);
  // `[[sleep N]]` / `[[ask]]` anywhere in the text act like the `sleep N` / `ask` commands, for prompts that wrap the
  // test's text in other words (a delegated task's brief). The reply drops the marker so the task it is sent back to
  // does not act on it too.
  const marker = /\[\[(sleep|ask)(?:\s+(\d+))?\]\]/.exec(text);
  const echo = marker ? text.replace(marker[0], '').trim() : text;
  if (cmd === 'quota') {
    workTimer = setTimeout(() => {
      const msg = "You've hit your session limit · resets 5pm";
      mode = 'idle';
      out(`\r\n${msg}`);
      hook('StopFailure', { error: 'rate_limit', last_assistant_message: msg });
      out('\r\n> ');
    }, 300);
  } else if (cmd === 'limits') {
    const now = Math.floor(Date.now() / 1000);
    statusLine({ rate_limits: {
      five_hour: { used_percentage: Number(arg), resets_at: now + (Number(rest[1]) || 7200) },
      seven_day: { used_percentage: Number(rest[0]), resets_at: now + 5 * 86400 },
    } });
    workTimer = setTimeout(() => finishTurn(text), 300);
  } else if (cmd === 'agylimits') {
    const nowMs = Date.now();
    const s5 = Number(rest[1]) || 7200;
    const s7 = 5 * 86400;
    const rem5 = (100 - Number(arg)) / 100;
    const rem7 = (100 - Number(rest[0])) / 100;
    statusLine({ quota: {
      'gemini-5h': { ...(rem5 > 0 ? { remaining_fraction: rem5 } : {}), reset_time: new Date(nowMs + s5 * 1000).toISOString(), reset_in_seconds: s5 },
      'gemini-weekly': { ...(rem7 > 0 ? { remaining_fraction: rem7 } : {}), reset_time: new Date(nowMs + s7 * 1000).toISOString(), reset_in_seconds: s7 },
    } });
    workTimer = setTimeout(() => finishTurn(text), 300);
  } else if (cmd === 'link') {
    out(`\x1b]8;;${arg}\x07${rest.join(' ') || arg}\x1b]8;;\x07`);
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'usage') {
    const [id, input, output, cacheRead, cacheWrite] = rest;
    const usage = { input_tokens: +input || 0, output_tokens: +output || 0, cache_read_input_tokens: +cacheRead || 0, cache_creation_input_tokens: +cacheWrite || 0 };
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: arg, usage } }) + '\n');
    workTimer = setTimeout(() => finishTurn(text), 100);
  } else if (cmd === 'tui') {
    // Like Claude Code: hides the real cursor, paints its own as an inverse cell after `TUI> `, and keeps repainting a
    // status line below that leaves the real cursor at the right end of the input row.
    mode = 'tui';
    out('\x1b[?25lTUI> \x1b[7m \x1b[27m\r\n\x1b[1A\x1b[999C');
    let n = 0;
    setInterval(() => out(`\x1b[1B\r\x1b[Kstatus ${n++}\x1b[1A\x1b[999C`), 50);
  } else if (cmd === 'osc52' || cmd === 'osc52?') {
    const payload = cmd === 'osc52?' ? '?' : Buffer.from(text.trim().slice(6), 'utf8').toString('base64');
    out(`\x1b]52;c;${payload}\x07copied`);
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'fullscreen') {
    // Like Claude Code's fullscreen mode: alternate screen and SGR mouse reporting.
    out('\x1b[?1049h\x1b[?1000;1006h\x1b[HFULLSCREEN');
    mode = 'idle';
    out('\r\n> ');
  } else if (cmd === 'flood') {
    for (let i = 0; i < (Number(arg) || 1) * 16; i++) out(`\r\nflood ${i} ${'x'.repeat(56)}`);
    mode = 'idle';
    out('\r\nflooded\r\n> ');
  } else if (cmd === 'exit') {
    out('bye\r\n');
    process.exit(Number(arg) || 0); // like a crash: hooks still queued are lost
  } else if (cmd === 'ask' || (cmd !== 'shoal' && marker?.[1] === 'ask')) {
    hook('PermissionRequest', { tool_name: 'Fake' });
    out('Allow? (y/n)');
    mode = 'ask';
    askText = echo;
  } else if (cmd === 'menu') {
    hook('PermissionRequest', { tool_name: 'Fake' });
    out("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No, keep asking");
    mode = 'menu';
    askText = echo;
  } else if (cmd === 'stream') {
    // Simulates an agy-style multi-stage streaming turn: live thinking + todolist -> tool step -> live PTY answer -> lossless Markdown.
    const fileArg = [arg, ...rest].filter(Boolean).join(' ').trim();
    const t0 = Date.now();
    out('\r\n⣷  1/3 steps · 正在核查系统环境与终端渲染链路...\r\n  ⎿  ✓ 初始化检查任务\r\n     ● 核查系统环境与终端渲染\r\n     ○ 输出结构化验证结论');
    workTimer = setTimeout(() => {
      fs.appendFileSync(transcript, JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(t0 + 1200).toISOString(),
        model: 'gemini-4-carbon-medium',
        thinking: 'Checking environment details and inspecting target file before summarizing.',
        content: '好，我就跑一下，先确认一下当前环境和关键文件。',
        tool_calls: [
          {
            name: 'default_api:update_steps',
            args: {
              steps: JSON.stringify([
                { title: '初始化检查任务', status: 'done' },
                { title: '核查系统环境与终端渲染', status: 'in_progress' },
                { title: '输出结构化验证结论', status: 'pending' },
              ]),
            },
          },
          {
            name: 'default_api:run_command',
            args: { CommandLine: '"uname -a"', toolSummary: '"确认执行环境与架构"' },
          },
          ...(fileArg ? [{ name: 'default_api:read_file', args: { Path: JSON.stringify(fileArg) } }] : []),
        ],
      }) + '\n');
      out('\r\n▸ Thought for 1s');
      workTimer = setTimeout(() => {
        fs.appendFileSync(transcript, JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date(t0 + 2000).toISOString(),
        }) + '\n');
        out('\r\n  1. 检测到当前运行在原生交互式 PTY 模式\r\n⠼ Working...\r\n  Tip: Use /settings to configure your environment.');
        workTimer = setTimeout(() => {
          out('\r\n  2. 双源融合渲染器正在实时逐字承接流式输出\r\n⠴ Working...\r\n  Use /settings to configure your environment.');
          workTimer = setTimeout(() => {
            const finalMd = [
              '### 验证结论',
              '',
              '1. 底层仍运行官方原生交互式 CLI，保持零额度差异与完整兼容。',
              '2. 落盘后自动切换为无损高亮 Markdown：',
              '',
              '```ts',
              'export const mode = "native-pty-dual-source";',
              'console.log("smooth streaming ready:", mode);',
              '```',
            ].join('\n');
            fs.appendFileSync(transcript, JSON.stringify({
              step_index: 3,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              created_at: new Date(t0 + 3200).toISOString(),
              model: 'gemini-4-carbon-medium',
              thinking: 'All checks passed, emit final structured report.',
              content: finalMd,
              tool_calls: [
                {
                  name: 'default_api:update_steps',
                  args: {
                    steps: JSON.stringify([
                      { title: '初始化检查任务', status: 'done' },
                      { title: '核查系统环境与终端渲染', status: 'done' },
                      { title: '输出结构化验证结论', status: 'done' },
                    ]),
                  },
                },
              ],
            }) + '\n');
            mode = 'idle';
            out('\r\n  完成。');
            hook('Stop', { last_assistant_message: finalMd });
            out('\r\n> ');
          }, 420);
        }, 280);
      }, 320);
    }, 260);
  } else if (cmd === 'subagent') {
    // Simulates an agy-style async subagent workflow: update_steps + invoke_subagent + child transcript +
    // wrapped narration ("...\n评审结论。") + live bottom subagent bar -> final SYSTEM_MESSAGE reply & completion.
    const fileArg = arg && !/^\d+$/.test(arg) ? arg : '';
    const holdMs = Math.max(300, Number(/^\d+$/.test(arg ?? '') ? arg : rest[0]) || 1600);
    const t0 = Date.now();
    const subId = '11111111-2222-4333-8444-555555555555';
    const subLogsDir = path.join(
      process.env.AGY_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'),
      'brain', subId, '.system_generated', 'logs',
    );
    fs.mkdirSync(subLogsDir, { recursive: true });
    const subTranscript = path.join(subLogsDir, 'transcript.jsonl');
    fs.writeFileSync(subTranscript, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t0 + 100).toISOString(),
      model: 'gemini-4-neon-high',
      thinking: 'Inspecting target implementation and checking break damage propagation.',
      tool_calls: fileArg
        ? [{ name: 'default_api:read_file', args: { Path: JSON.stringify(fileArg) } }]
        : [{ name: 'default_api:fast_search', args: { Query: '"break_dmg"' } }],
    }) + '\n');
    const subLogUri = `file:///${subTranscript.replaceAll('\\', '/')}`;
    fs.appendFileSync(transcript, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t0 + 120).toISOString(),
      model: 'gemini-4-neon-high',
      thinking: 'Dispatch independent read-only review subagent.',
      tool_calls: [
        {
          name: 'default_api:update_steps',
          args: {
            steps: JSON.stringify([
              { title: '接入破绽上限递增机制', status: 'done' },
              { title: '独立评审与回归验收', status: 'in_progress' },
            ]),
          },
        },
        {
          name: 'default_api:invoke_subagent',
          args: {
            TypeName: '"gemini-reviewer"',
            Role: '"首领破绽节奏只读评审员"',
            Model: '"inherit"',
          },
        },
      ],
    }) + '\n');
    fs.appendFileSync(transcript, JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date(t0 + 150).toISOString(),
      content: 'Steps updated.',
    }) + '\n');
    fs.appendFileSync(transcript, JSON.stringify({
      step_index: 3,
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date(t0 + 180).toISOString(),
      content: `Created the following subagent:\n{\n  "conversationId": "${subId}",\n  "logAbsoluteUri": "${subLogUri}"\n}`,
    }) + '\n');
    fs.appendFileSync(transcript, JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t0 + 200).toISOString(),
      model: 'gemini-4-neon-high',
      content: '核心回归 5 项全过，正在等待 `gemini-reviewer` 评审结论。',
      tool_calls: [],
    }) + '\n');
    out(
      '\r\n● Agent(gemini-reviewer: 首领破绽节奏只读评审员)(只读审查...) (ctrl+o to expand)'
      + '\r\n  核心回归 5 项全过，正在等待 gemini-reviewer'
      + '\r\n  评审结论。'
      + '\r\n────────────────────────────────────────────────────────────'
      + '\r\n>'
      + '\r\n────────────────────────────────────────────────────────────'
      + '\r\n● Agent(gemini-reviewer: 首领破绽节奏只读评审员) · Gemini 4 Neon   The inconsistent break dama... · 1m12s',
    );
    workTimer = setTimeout(() => {
      fs.appendFileSync(subTranscript, JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: new Date(Date.now()).toISOString(),
        content: 'Read file done.',
      }) + '\n');
      fs.appendFileSync(transcript, JSON.stringify({
        step_index: 5,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: new Date(Date.now()).toISOString(),
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${new Date().toISOString()} sender=${subId} priority=HIGH content=VERDICT: PASS（0 P0 / 0 P1）\n</SYSTEM_MESSAGE>`,
      }) + '\n');
      const finalReply = '独立评审已通过（VERDICT: PASS），全部验证闭环。';
      fs.appendFileSync(transcript, JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(Date.now()).toISOString(),
        model: 'gemini-4-neon-high',
        content: finalReply,
        tool_calls: [
          {
            name: 'default_api:update_steps',
            args: {
              steps: JSON.stringify([
                { title: '接入破绽上限递增机制', status: 'done' },
                { title: '独立评审与回归验收', status: 'done' },
              ]),
            },
          },
        ],
      }) + '\n');
      mode = 'idle';
      out(`\r\n  ${finalReply}`);
      hook('Stop', { last_assistant_message: finalReply });
      out('\r\n> ');
    }, holdMs);
  } else if (cmd === 'rich') {
    const t0 = Date.now();
    const richMd = [
      '## 交付总结与性能可视化报告',
      '',
      '已完成 `StreamMarkdown` 渲染引擎重构，采用 `Inter Variable` + `Noto Sans SC` 字体栈，并集成 `remend`、`shiki`、`beautiful-mermaid`、`echarts` 与 `katex`。',
      '',
      '> [!TIP]',
      '> 所有重型可视化引擎均通过动态 `import()` 按需加载，普通文本会话零首屏开销；点击图表右上角可随时切换源码、放大缩放或导出高清 PNG。',
      '',
      '### 1. 端到端验证结果（无竖排挤压）',
      '',
      '| 检查项 | 结果 | 关键实测指标 |',
      '| --- | --- | --- |',
      '| TypeScript 类型检查 | 通过 | 全量 `tsc -p tsconfig.json` 零错误，覆盖服务端与前端 |',
      '| 日志完整读取回归 | 通过 | 优先读取 `transcript_full.jsonl`，彻底消除长表格 `<truncated>` 截断 |',
      '| 390px 移动端视口 | 警告 | 宽表格启用水平滚动保护，主内容无横向溢出 |',
      '| 非法 JSON 图表兜底 | 失败 | 刻意构造的异常 JSON 已安全降级为代码卡片而非白屏 |',
      '',
      '### 2. 流式渲染管线架构',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[原生 CLI PTY + Full Transcript] --> B[remend 断句自愈]',
      '  B --> C[Marked AST 解析]',
      '  C --> D[Shiki 代码高亮]',
      '  C --> E[Mermaid / ECharts 图表]',
      '  C --> F[智能表格与 Callout]',
      '```',
      '',
      '### 3. 各模块首屏与渲染耗时对比',
      '',
      '```echarts',
      '{',
      '  "title": { "text": "渲染耗时对比 (ms)" },',
      '  "legend": { "bottom": 0 },',
      '  "xAxis": { "type": "category", "data": ["普通段落", "大表格", "代码高亮", "Mermaid 图", "ECharts 图"] },',
      '  "yAxis": { "type": "value", "name": "ms" },',
      '  "series": [',
      '    { "name": "优化前", "type": "bar", "data": [18, 42, 65, 190, 240] },',
      '    { "name": "优化后", "type": "bar", "data": [9, 16, 22, 54, 78] }',
      '  ]',
      '}',
      '```',
      '',
      '### 4. 核心代码与平滑速率公式',
      '',
      '```ts',
      'export interface RenderBudget {',
      '  readonly targetFps: number;',
      '  readonly lazyModules: ("shiki" | "mermaid" | "echarts" | "katex")[];',
      '}',
      'export const budget: RenderBudget = { targetFps: 60, lazyModules: ["shiki", "mermaid", "echarts", "katex"] };',
      '```',
      '',
      '流式帧平滑吞吐公式（支持行内 $\\alpha = 0.25$ 与块级公式）：',
      '',
      '$$',
      'v(t) = \\max\\left(2,\\; \\lceil \\alpha \\cdot (L_{\\text{target}} - L_{\\text{shown}}(t)) \\rceil\\right)',
      '$$',
      '',
      '> [!WARNING]',
      '> 下方为刻意构造的非法图表 JSON，用于验证优雅降级：',
      '',
      '```echarts',
      '{ invalid json',
      '```',
    ].join('\n');
    workTimer = setTimeout(() => {
      fs.appendFileSync(transcript, JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(t0 + 200).toISOString(),
        model: 'gemini-4-carbon-medium',
        content: richMd,
        tool_calls: [],
      }) + '\n');
      mode = 'idle';
      out('\r\n完成。');
      hook('Stop', { last_assistant_message: richMd });
      out('\r\n> ');
    }, 180);
  } else if (cmd === 'autoscroll') {
    // Reproduces the exact step-collapse + typewriter reveal + dock-expansion race:
    // 1. Emit a tall lone completed step with long thinking + 3 tools (stays expanded in buildFlow).
    // 2. Emit a second completed step so buildFlow collapses BOTH into a 1-line StepGroup (sudden scrollHeight shrink),
    //    plus a long assistant reply that animates via StreamMarkdown typewriter reveal & expands DockTray todos.
    const t0 = Date.now();
    const longThinking = Array.from({ length: 8 }, (_, i) => `Reasoning line ${i + 1}: inspecting layout geometry, step collapse clamp, and dock height transitions.`).join('\n');
    out('\r\n⣷  正在读取并分析 3 个文件...');
    workTimer = setTimeout(() => {
      fs.appendFileSync(transcript, JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(t0 + 200).toISOString(),
        model: 'gemini-4-neon-xhigh',
        thinking: longThinking,
        tool_calls: [
          { name: 'default_api:read_file', args: { Path: '"web/src/StreamView.tsx"' } },
          { name: 'default_api:read_file', args: { Path: '"web/src/styles.css"' } },
          { name: 'default_api:read_file', args: { Path: '"web/src/stream/DockTray.tsx"' } },
        ],
      }) + '\n');
      workTimer = setTimeout(() => {
        const longReply = [
          '### 根因定位与修复结论',
          '',
          ...Array.from({ length: 18 }, (_, i) => `${i + 1}. 自动跟底验证段落 #${i + 1}：步骤折叠瞬间触发浏览器 scrollTop clamp，叠加新回复逐字展开与 Dock 托盘增高，不得误判为用户主动上滚。`),
          '',
          '**AUTOSCROLL_TAIL_SENTINEL**',
        ].join('\n');
        fs.appendFileSync(transcript, JSON.stringify({
          step_index: 11,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(t0 + 600).toISOString(),
          model: 'gemini-4-neon-xhigh',
          thinking: 'Collapsing step run and emitting final multi-paragraph response.',
          tool_calls: [
            {
              name: 'default_api:update_steps',
              args: {
                steps: JSON.stringify([
                  { title: '定位步骤折叠回退误杀', status: 'done' },
                  { title: '补齐视口缩放与页签恢复', status: 'in_progress' },
                  { title: '端到端自动滚动回归', status: 'pending' },
                ]),
              },
            },
          ],
          content: longReply,
        }) + '\n');
        mode = 'idle';
        out('\r\nreply: autoscroll done\r\n\r\n> ');
        hook('Stop', { last_assistant_message: longReply });
      }, 650);
    }, 200);
  } else if (cmd === 'shoal') {
    const cliArgs = splitShellArgs(text.trim().slice(5).trim());
    const p = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', 'shoal', ...cliArgs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      : spawn('shoal', cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = '';
    p.stdout.on('data', d => { captured += d.toString('utf8'); });
    p.stderr.on('data', d => { captured += d.toString('utf8'); });
    p.on('error', e => finishTurn(`shoal(err): ${e.message}`));
    p.on('exit', code => finishTurn(`shoal(${code ?? 1}): ${captured.trim()}`));
  } else {
    const ms = cmd === 'sleep' ? (Number(arg) || 0) * 1000 : marker?.[1] === 'sleep' ? (Number(marker[2]) || 0) * 1000 : 300;
    workTimer = setTimeout(() => finishTurn(echo), ms);
  }
}
let askText = '';

function interrupt() {
  clearTimeout(workTimer);
  queued = false;
  mode = 'idle';
  out('\r\nInterrupted');
  showPrompt();
}

function key(ch) {
  if (ch === '\x03') {
    if (mode !== 'idle') return interrupt();
    const now = Date.now();
    if (now - ctrlCAt < 1500) process.exit(0);
    ctrlCAt = now;
    out('\r\nPress Ctrl+C again to exit');
    return showPrompt();
  }
  if (mode === 'tui') {
    if (ch >= ' ') line += ch;
    out(`\r\x1b[KTUI> ${line}\x1b[7m \x1b[27m\x1b[999C`);
    return;
  }
  if (mode === 'ask') {
    if (ch === 'y' || ch === 'n') {
      logKey(ch);
      out(ch);
      finishTurn(askText);
    }
    return;
  }
  if (mode === 'menu') {
    if (ch === '1' || ch === '2' || ch === '3') {
      logKey(ch);
      out(ch);
      finishTurn(`${askText} [${ch}]`);
    }
    return;
  }
  if (mode === 'trust') {
    if (ch === '\r') {
      logKey('\r');
      mode = 'idle';
      line = trustPrompt;
      out('\r\n> ' + line);
      submit();
    }
    return;
  }
  // Like Codex on Windows: inside a paste only \n is a newline, \r still submits.
  if (inPaste && ch === '\n') {
    line += '\n';
    out('\r\n');
  } else if (ch === '\r' || ch === '\n') {
    if (mode === 'working') queued = true;
    else submit();
  } else if (ch === '\x15') {
    // Ctrl+U: clear entire uncommitted input line (like readline / TUI composers).
    line = '';
    out('\r\x1b[K> ');
  } else if (ch === '\x05' || ch === '\x01') {
    // Ctrl+E / Ctrl+A: cursor navigation no-op in simple single-line fake CLI.
  } else if (ch === '\x7f' || ch === '\b') {
    const chars = Array.from(line);
    if (chars.length) {
      chars.pop();
      line = chars.join('');
      out('\b \b');
    }
  } else if (ch >= ' ') {
    line += ch;
    out(ch);
  }
}

let carry = '';
let escTimer = null;
let inPaste = false; // between bracketed-paste markers \n is a newline in the input, not a submit
function feed(data) {
  clearTimeout(escTimer);
  const s = carry + data;
  carry = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      if (i + 1 >= s.length) {
        carry = s.slice(i);
        escTimer = setTimeout(() => {
          if (carry === '\x1b') {
            carry = '';
            if (mode !== 'idle') {
              clearTimeout(workTimer);
              queued = false;
              mode = 'idle';
              out('\r\nEscaped');
              hook('Stop', { error: 'canceled' });
              showPrompt();
            }
          }
        }, 25);
        break;
      }
      if (s[i + 1] === '[') {
        // CSI: params then a final byte in 0x40-0x7e (covers paste markers, arrows, focus events)
        let j = i + 2;
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
        if (j >= s.length) { carry = s.slice(i); break; }
        const seq = s.slice(i, j + 1);
        if (seq === '\x1b[200~') inPaste = true;
        else if (seq === '\x1b[201~') inPaste = false;
        i = j + 1;
      } else {
        // Meta key (Alt+x): echo it visibly so a leaked workbench shortcut shows up in tests.
        for (const c of `<M-${s[i + 1]}>`) key(c);
        i += 2;
      }
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    key(ch);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.on('data', feed);
process.stdin.resume();

out('\x1b[?2004h'); // bracketed paste on, like the real CLIs
const TRUST_MARK = '[[trust]]';
const banner = `FAKE AGENT ${sid.slice(0, 8)}${resumeId ? ` RESUMED ${resumeId}` : ''}\r\n`;
// The startup dialog comes before the input line, like the real CLIs.
out(initialPrompt?.startsWith(TRUST_MARK) ? banner : `${banner}> `);
hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
let trustPrompt = '';
if (initialPrompt?.startsWith(TRUST_MARK)) {
  // Startup folder-trust prompt: printed before any turn, so the server flags the session as blocked (startup).
  trustPrompt = initialPrompt.slice(TRUST_MARK.length).trim();
  mode = 'trust';
  out('Do you trust the files in this folder?\r\nPress Enter to continue');
} else if (initialPrompt) {
  setTimeout(() => {
    line = initialPrompt;
    out(line);
    submit();
  }, 300);
}
