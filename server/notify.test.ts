import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionInfo, Task } from '../shared/protocol.ts';
import {
  buildFeishuPayload,
  createMobileNotifier,
  detectWebhookProvider,
  isAllowedFeishuWebhook,
  isAllowedWebhookUrl,
  resolveAndValidatePublicAddrs,
  sendFeishuNotification,
  sendWebhookNotification,
  signFeishuWebhook,
} from './notify.ts';

describe('feishu webhook notifications', () => {
  it('computes official Feishu HMAC-SHA256 signature over empty message with string timestamp', () => {
    const { timestamp, sign } = signFeishuWebhook('my-secret', 1700000000);
    expect(timestamp).toBe('1700000000');
    const expected = crypto.createHmac('sha256', '1700000000\nmy-secret').update('').digest('base64');
    expect(sign).toBe(expected);
  });

  it('allows official Feishu/Lark URLs and blocks arbitrary internal SSRF hosts in prod', () => {
    expect(isAllowedFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc-123', false)).toBe(true);
    expect(isAllowedFeishuWebhook('https://open.larksuite.com/open-apis/bot/v2/hook/xyz', false)).toBe(true);
    expect(isAllowedFeishuWebhook('http://127.0.0.1:8080/hook', false)).toBe(false);
    expect(isAllowedFeishuWebhook('http://169.254.169.254/latest/meta-data', true)).toBe(false);
    expect(isAllowedFeishuWebhook('http://127.0.0.1:48000/feishu', true)).toBe(true);
  });

  it('sanitizes notification payload to exclude code, paths, and body content', async () => {
    const payload = buildFeishuPayload({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-id',
      secret: 'sec-123',
      projectName: 'agent-workbench',
      taskId: 'task-9',
      taskTitle: '修复认证   状态机',
      kind: 'review',
      deepLinkBase: 'https://shoal.example.com/',
      nowMs: 1700000000_000,
    });
    const raw = JSON.stringify(payload);
    expect(raw).toContain('[Shoal] 待验收 · agent-workbench');
    expect(raw).toContain('修复认证 状态机');
    expect(raw).toContain('https://shoal.example.com/#task=task-9');
    expect(raw).not.toContain('G:\\Workspace');
    expect((payload as { sign?: string }).sign).toBeTruthy();

    let posted = false;
    await sendFeishuNotification({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-id',
      secret: 'sec-123',
      projectName: 'agent-workbench',
      taskId: 'task-9',
      taskTitle: '修复认证',
      kind: 'review',
      fetchImpl: (async () => {
        posted = true;
        return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
      }) as never,
    });
    expect(posted).toBe(true);
  });

  it('debounces needs_you when immediately followed by review and respects desktop quiet mode', async () => {
    const sent: string[] = [];
    let task: Task = {
      id: 't1', projectId: 'p1', title: '测试通知', prompt: 'SECRET_PROMPT_DO_NOT_LEAK',
      titleAuto: false, color: '#8baeda', agent: 'fake', sessionId: 's1', createdAt: 1, phase: 'active', phaseSince: 1,
    };
    let session: SessionInfo = {
      id: 's1', taskId: 't1', agent: 'fake', nativeSessionId: null, status: 'working', statusSince: 1, startedAt: 1, exitCode: null, cols: 120, rows: 40,
    };
    let desktopAt = 0;
    const nowAt = 1_000_000;
    const notifier = createMobileNotifier({
      getSettings: () => ({
        enabled: true,
        feishuEnabled: true,
        feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        feishuSecret: '',
        quietWhenDesktopActive: true,
        deepLinkBase: 'https://shoal.example.com',
      }),
      getTask: id => (id === task.id ? task : undefined),
      getProjectName: () => 'Shoal',
      lastDesktopActiveAt: () => desktopAt,
      nowMs: () => nowAt,
      debounceMs: 40,
      cooldownMs: 30_000,
      sendFn: async input => {
        sent.push(input.kind);
      },
    });
    notifier.seed([task], [session]);

    // Working -> needs_you followed immediately by review -> only review fires.
    session = { ...session, status: 'needs_you' };
    notifier.onSession(session);
    task = { ...task, phase: 'review' };
    notifier.onTask(task);
    await new Promise(r => setTimeout(r, 80));
    expect(sent).toEqual(['review']);

    // A delegated task's finished round is reviewed by its main task: nothing is pushed to the user.
    notifier.onTask({ ...task, id: 't2', phase: 'review', delegation: { parentTaskId: 't1', brief: 'x', round: 1, createdAt: 1 } });
    await new Promise(r => setTimeout(r, 80));
    expect(sent).toEqual(['review']);

    // Desktop active recently -> suppresses limit alert.
    desktopAt = nowAt - 5_000;
    session = { ...session, limit: { message: 'hit limit', resetsAt: null, at: nowAt } };
    notifier.onSession(session);
    expect(sent).toEqual(['review']);
    notifier.dispose();
  });

  it('supports Discord, Slack, Telegram, and HMAC-signed generic HTTPS webhooks', async () => {
    expect(detectWebhookProvider('https://discord.com/api/webhooks/123/tok')).toBe('discord');
    expect(detectWebhookProvider('https://hooks.slack.com/services/T1/B1/S1')).toBe('slack');
    expect(detectWebhookProvider('https://api.telegram.org/bot123:abc/sendMessage?chat_id=999')).toBe('telegram');
    expect(detectWebhookProvider('https://api.telegram.org/bot123:abc/sendMessage')).toBeNull();
    expect(detectWebhookProvider('https://notify.example.com/shoal')).toBe('generic');

    const calls: { url: string; init: RequestInit }[] = [];
    const okFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('discord.com')) return new Response(null, { status: 204 });
      if (url.includes('hooks.slack.com')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as never;

    await sendWebhookNotification({
      webhookUrl: 'https://discord.com/api/webhooks/123/tok',
      projectName: 'Shoal',
      taskId: 't-dis',
      taskTitle: 'Discord 任务',
      kind: 'needs_you',
      deepLinkBase: 'https://shoal.example.com',
      fetchImpl: okFetch,
      allowLocalTest: false,
    });
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/123/tok');
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0].init.body)).embeds[0].url).toBe('https://shoal.example.com/#task=t-dis');

    await sendWebhookNotification({
      webhookUrl: 'https://hooks.slack.com/services/T1/B1/S1',
      projectName: 'Shoal',
      taskId: 't-slk',
      taskTitle: 'Slack 任务',
      kind: 'review',
      fetchImpl: okFetch,
      allowLocalTest: false,
    });
    expect(JSON.parse(String(calls[1].init.body)).text).toContain('Slack 任务');

    await sendWebhookNotification({
      webhookUrl: 'https://api.telegram.org/bot123:abc/sendMessage?chat_id=-10042',
      projectName: 'Shoal',
      taskId: 't-tg',
      taskTitle: 'Telegram 任务',
      kind: 'limit',
      fetchImpl: okFetch,
      allowLocalTest: false,
    });
    expect(calls[2].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(String(calls[2].init.body)).chat_id).toBe('-10042');

    await sendWebhookNotification({
      webhookUrl: 'https://notify.example.com/shoal',
      secret: 'generic-hmac-secret',
      projectName: 'Shoal',
      taskId: 't-gen',
      taskTitle: 'Generic 任务',
      kind: 'test',
      nowMs: 1_700_000_000_000,
      fetchImpl: okFetch,
      allowLocalTest: false,
    });
    const genReq = calls[3];
    const headers = genReq.init.headers as Record<string, string>;
    const bodyStr = String(genReq.init.body);
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', 'generic-hmac-secret').update(`1700000000.${bodyStr}`).digest('hex');
    expect(headers['x-shoal-timestamp']).toBe('1700000000');
    expect(headers['x-shoal-signature']).toBe(expectedSig);
  });

  it('blocks private IP literals, IPv6 transitional ranges, trailing dots, and DNS rebinding (SSRF protection)', async () => {
    for (const bad of [
      'http://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/hook',
      'https://10.0.0.8/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.5/hook',
      'https://100.64.0.5/hook',
      'https://192.0.2.10/hook',
      'https://198.51.100.10/hook',
      'https://203.0.113.10/hook',
      'https://[::1]/hook',
      'https://[::127.0.0.1]/hook',
      'https://[::ffff:7f00:1]/hook',
      'https://[::ffff:0:127.0.0.1]/hook',
      'https://[64:ff9b::127.0.0.1]/hook',
      'https://[2002:7f00:1::]/hook',
      'https://[2001:db8::1]/hook',
      'https://[fe80::1]/hook',
      'https://[fec0::1]/hook',
      'https://localhost./hook',
      'https://internal.local./hook',
      'https://meta.internal./hook',
      'https://internal.local/hook',
      'https://user:pass@notify.example.com/hook',
      'https://open.feishu.cn/other/path',
    ]) {
      expect(isAllowedWebhookUrl(bad, false), bad).toBe(false);
    }

    let dnsCalls = 0;
    await expect(sendWebhookNotification({
      webhookUrl: 'https://rebind.example.com/hook',
      projectName: 'Shoal',
      taskId: 't-ssrf',
      taskTitle: 'SSRF',
      kind: 'test',
      allowLocalTest: false,
      lookupImpl: async () => {
        dnsCalls += 1;
        return [{ address: '10.0.0.5' }];
      },
    })).rejects.toThrow('SSRF');
    expect(dnsCalls).toBe(1);

    await expect(resolveAndValidatePublicAddrs('mixed.example.com', async () => [
      { address: '8.8.8.8' },
      { address: '64:ff9b::127.0.0.1' },
    ])).rejects.toThrow('SSRF');

    const okAddrs = await resolveAndValidatePublicAddrs('public.example.com', async () => [
      { address: '8.8.8.8' },
      { address: '2606:4700:4700::1111' },
    ]);
    expect(okAddrs).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });
});
