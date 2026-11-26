import { existsSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { piSessionHeader, samePiWorkspace } from '../shared/piSession.ts';

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

export default function shoalPi(pi: ExtensionAPI) {
  const { WORKBENCH_PORT: port, WORKBENCH_HOOK_TOKEN: token, WORKBENCH_SESSION_ID: sessionId,
    WORKBENCH_PI_CWD: cwd, WORKBENCH_PI_PERMISSION: permission } = process.env;
  if (!port || !token || !sessionId || !cwd) return;

  let pending = Promise.resolve();
  let working = false;
  let inWorkspace = false;

  function report(event: string, ctx: ExtensionContext, extra: Record<string, unknown> = {}) {
    if (!inWorkspace) return pending;
    const manager = ctx.sessionManager;
    const file = manager.getSessionFile();
    const model = ctx.model;
    const body = JSON.stringify({ sessionId, agent: 'pi', event, at: Date.now(), payload: {
      cwd, session_id: manager.getSessionId(), transcript_path: file, leaf_id: manager.getLeafId(),
      resumable: !!file && existsSync(file), model: model && `${model.provider}/${model.id}`, ...extra,
    } });
    pending = pending.then(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(1500),
      });
      await res.body?.cancel();
    }).catch(() => { /* Pi keeps running if the workbench is unavailable. */ });
    return pending;
  }

  function context(ctx: ExtensionContext) {
    const tokens = ctx.getContextUsage()?.tokens;
    const window = ctx.model?.contextWindow;
    return { context_window: typeof tokens === 'number' && typeof window === 'number'
      ? { used_tokens: tokens, context_window_size: window } : null };
  }

  pi.on('session_start', (event, ctx) => {
    inWorkspace = samePiWorkspace(cwd, ctx.cwd);
    working = false;
    return report('SessionStart', ctx, { source: event.reason, ...context(ctx) });
  });
  pi.on('session_before_switch', (event, ctx) => {
    if (event.reason !== 'resume' || !event.targetSessionFile) return;
    const header = piSessionHeader(event.targetSessionFile);
    if (header && samePiWorkspace(cwd, header.cwd)) return;
    ctx.ui.notify('请选择当前 Shoal 项目中的 Pi 会话。', 'warning');
    return { cancel: true };
  });
  pi.on('before_agent_start', (event, ctx) => {
    if (working) return;
    working = true;
    return report('UserPromptSubmit', ctx, { prompt: event.prompt.slice(0, 8000) });
  });
  pi.on('ui_prompt_start', (_event, ctx) => report('PermissionRequest', ctx));
  pi.on('ui_prompt_end', (_event, ctx) => report(working ? 'PiContinued' : 'PiIdle', ctx));

  if (permission === 'normal') {
    pi.on('tool_call', async (event, ctx) => {
      if (READ_TOOLS.has(event.toolName)) return;
      const command = typeof event.input.command === 'string' ? event.input.command : undefined;
      const file = typeof event.input.path === 'string' ? event.input.path : undefined;
      if (await ctx.ui.confirm(`允许 Pi 执行 ${event.toolName}？`, (command ?? file ?? event.toolName).slice(0, 400))) return;
      return { block: true, reason: '用户未批准此工具调用。' };
    });
  }

  pi.on('tool_execution_start', (_event, ctx) => report('PiTranscript', ctx));
  pi.on('turn_end', (_event, ctx) => report('PiTranscript', ctx));
  pi.on('session_tree', (_event, ctx) => report('PiContext', ctx, context(ctx)));
  pi.on('session_compact', (_event, ctx) => report('PiContext', ctx, context(ctx)));
  pi.on('model_select', (_event, ctx) => report('PiContext', ctx, context(ctx)));

  pi.on('agent_settled', (event, ctx) => {
    working = false;
    let assistant;
    for (const entry of ctx.sessionManager.getBranch().toReversed()) {
      if (entry.type !== 'message') continue;
      if (entry.message.role === 'user') break;
      if (entry.message.role === 'assistant') { assistant = entry.message; break; }
    }
    const text = assistant?.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    if (event.aborted || !text || (assistant?.stopReason !== 'stop' && assistant?.stopReason !== 'length')) {
      const limited = assistant?.stopReason === 'error'
        && /\b(?:429|rate[_ -]limit(?:ed)?|usage_limit_reached|insufficient_quota)\b/i.test(assistant.errorMessage ?? '');
      return report('StopFailure', ctx, { error: event.aborted ? 'aborted' : limited ? 'rate_limit' : 'pi_turn_failed', ...context(ctx) });
    }
    return report('Stop', ctx, { last_assistant_message: text.slice(0, 32_000), ...context(ctx) });
  });
}
