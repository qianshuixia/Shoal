import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { SessionInfo, Task } from '../shared/protocol.ts';

export type NotifyKind = 'needs_you' | 'review' | 'limit';
export type WebhookProvider = 'feishu' | 'discord' | 'slack' | 'telegram' | 'generic';

export interface FeishuNotificationInput {
  webhookUrl: string;
  secret?: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  kind: NotifyKind | 'test';
  deepLinkBase?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
  allowLocalTest?: boolean;
}

const singleLineCut = (s: string, max: number): string => {
  const clean = s.replace(/\s+/g, ' ').trim();
  const cps = [...clean];
  return cps.length > max ? cps.slice(0, max).join('') + '…' : clean;
};

function isPublicIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // Link-local 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol 192.0.0.0/24 & TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return false; // Deprecated 6to4 relay 192.88.99.0/24
  if (a === 192 && b === 168) return false; // RFC1918 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3 203.0.113.0/24
  return true;
}

const isEmbeddedIpv4Public = (hi: number, lo: number): boolean =>
  isPublicIpv4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff);

function parseIpv6Hextets(raw: string): number[] | null {
  let s = raw.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4Parts = s.slice(lastColon + 1).split('.').map(Number);
    if (v4Parts.length !== 4 || v4Parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const total = left.length + right.length;
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total >= 8) return null;
  const zeros = new Array<string>(8 - total).fill('0');
  const full = [...left, ...zeros, ...right];
  if (full.length !== 8) return null;
  const nums = full.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

export function isPublicIpAddress(ip: string): boolean {
  let clean = ip.trim().replace(/^\[|\]$/g, '');
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx >= 0) clean = clean.slice(0, zoneIdx);
  const kind = net.isIP(clean);
  if (kind === 4) {
    const [a, b, c] = clean.split('.').map(Number);
    return isPublicIpv4Octets(a, b, c);
  }
  if (kind !== 6) return false;
  const hextets = parseIpv6Hextets(clean);
  if (!hextets) return false;
  // Unspecified ::, loopback ::1, and IPv4-compatible ::/96 (e.g. [::127.0.0.1])
  if (hextets.slice(0, 6).every(x => x === 0)) return false;
  // IPv4-mapped ::ffff:0:0/96
  if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff) {
    return isEmbeddedIpv4Public(hextets[6], hextets[7]);
  }
  // SIIT IPv4-translated ::ffff:0:0:0/96
  if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0xffff && hextets[5] === 0) {
    return isEmbeddedIpv4Public(hextets[6], hextets[7]);
  }
  // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && ((hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) || hextets[2] === 1)) {
    return false;
  }
  // 6to4 (2002::/16) encapsulates IPv4 in bits 16..47
  if (hextets[0] === 0x2002) {
    return isEmbeddedIpv4Public(hextets[1], hextets[2]);
  }
  // Discard-only 100::/64
  if (hextets[0] === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) return false;
  // Teredo (2001:0::/32) & Documentation (2001:db8::/32)
  if (hextets[0] === 0x2001 && (hextets[1] === 0 || hextets[1] === 0x0db8)) return false;
  // ULA fc00::/7, Link-Local fe80::/10, Deprecated Site-Local fec0::/10, Multicast ff00::/8
  if ((hextets[0] & 0xfe00) === 0xfc00) return false;
  if ((hextets[0] & 0xffc0) === 0xfe80) return false;
  if ((hextets[0] & 0xffc0) === 0xfec0) return false;
  if ((hextets[0] & 0xff00) === 0xff00) return false;
  return true;
}

export function detectWebhookProvider(rawUrl: string, allowLocalTest = false): WebhookProvider | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.endsWith('.')) return null;

  if (allowLocalTest && u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
    if (u.pathname.startsWith('/discord')) return 'discord';
    if (u.pathname.startsWith('/slack')) return 'slack';
    if (u.pathname.startsWith('/telegram')) return 'telegram';
    if (u.pathname.startsWith('/generic')) return 'generic';
    return 'feishu';
  }
  if (u.protocol !== 'https:') return null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return null;
  if (net.isIP(host) !== 0 && !isPublicIpAddress(host)) return null;

  if (host === 'open.feishu.cn' || host === 'open.larksuite.com') {
    return u.pathname.startsWith('/open-apis/bot/v2/hook/') && u.pathname.length > '/open-apis/bot/v2/hook/'.length
      ? 'feishu'
      : null;
  }
  if (host === 'discord.com' || host === 'discordapp.com' || host === 'ptb.discord.com' || host === 'canary.discord.com') {
    return /^\/api\/webhooks\/[^/]+\/[^/]+/.test(u.pathname) ? 'discord' : null;
  }
  if (host === 'hooks.slack.com') {
    return /^\/services\/[^/]+\/[^/]+\/[^/]+/.test(u.pathname) ? 'slack' : null;
  }
  if (host === 'api.telegram.org') {
    return /^\/bot[^/]+\/sendMessage$/i.test(u.pathname) && Boolean(u.searchParams.get('chat_id')?.trim())
      ? 'telegram'
      : null;
  }
  return 'generic';
}

export function isAllowedWebhookUrl(rawUrl: string, allowLocalTest = false): boolean {
  return detectWebhookProvider(rawUrl, allowLocalTest) !== null;
}

export function isAllowedFeishuWebhook(rawUrl: string, allowLocalTest = false): boolean {
  return detectWebhookProvider(rawUrl, allowLocalTest) === 'feishu';
}

// Official Feishu custom bot signing: HMAC-SHA256 using key = `${timestamp}\n${secret}` over empty message, base64 encoded.
export function signFeishuWebhook(secret: string, timestampSec: number): { timestamp: string; sign: string } {
  const timestamp = String(timestampSec);
  const sign = crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  return { timestamp, sign };
}

const KIND_META: Record<NotifyKind | 'test', { badge: string; hint: string; color: number }> = {
  needs_you: { badge: '需要你确认', hint: '会话已暂停，正在等待你审批权限或输入下一步指示。', color: 0xf59e0b },
  review: { badge: '待验收', hint: 'Agent 已完成本轮工作，点击下方链接可查看回复与改动 Diff。', color: 0x3b82f6 },
  limit: { badge: '额度耗尽', hint: '当前 CLI 订阅额度已达上限，可在手机端一键切换其他 Agent 接力。', color: 0xef4444 },
  test: { badge: '测试通知', hint: 'Shoal 远程提醒通道连通正常。', color: 0x10b981 },
};

function sanitizeParts(input: FeishuNotificationInput) {
  const meta = KIND_META[input.kind];
  const project = singleLineCut(input.projectName || 'Shoal', 40);
  const title = singleLineCut(input.taskTitle || '未命名任务', 80);
  let href: string | undefined;
  if (input.deepLinkBase && /^https?:\/\//i.test(input.deepLinkBase.trim())) {
    const base = input.deepLinkBase.trim().replace(/\/+$/, '');
    href = input.kind === 'test' ? base : `${base}/#task=${encodeURIComponent(input.taskId)}`;
  }
  return { meta, project, title, headerTitle: `[Shoal] ${meta.badge} · ${project}`, href };
}

// Strictly sanitized payload: contains ONLY project name, truncated 1-line task title, state label, and deep link.
// Never includes prompts, code snippets, local file system paths, terminal buffers, or reply content.
export function buildFeishuPayload(input: FeishuNotificationInput): Record<string, unknown> {
  const { meta, title, headerTitle, href } = sanitizeParts(input);
  const rows: Array<Array<Record<string, unknown>>> = [
    [{ tag: 'text', text: `任务：${title}` }],
    [{ tag: 'text', text: meta.hint }],
  ];
  if (href) {
    rows.push([{ tag: 'a', text: '打开手机遥控台', href }]);
  }
  const body: Record<string, unknown> = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: headerTitle,
          content: rows,
        },
      },
    },
  };
  if (input.secret?.trim()) {
    const ts = Math.floor((input.nowMs ?? Date.now()) / 1000);
    Object.assign(body, signFeishuWebhook(input.secret.trim(), ts));
  }
  return body;
}

export function buildWebhookRequest(
  provider: WebhookProvider,
  input: FeishuNotificationInput,
): { url: string; headers: Record<string, string>; body: string } {
  const { meta, project, title, headerTitle, href } = sanitizeParts(input);
  const ts = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const parsed = new URL(input.webhookUrl.trim());
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

  if (provider === 'feishu') {
    return { url: parsed.toString(), headers, body: JSON.stringify(buildFeishuPayload(input)) };
  }
  if (provider === 'discord') {
    return {
      url: parsed.toString(),
      headers,
      body: JSON.stringify({
        embeds: [
          {
            title: headerTitle,
            description: `任务：${title}\n${meta.hint}`,
            ...(href ? { url: href } : {}),
            color: meta.color,
          },
        ],
      }),
    };
  }
  if (provider === 'slack') {
    return {
      url: parsed.toString(),
      headers,
      body: JSON.stringify({
        text: `*${headerTitle}*\n任务：${title}\n${meta.hint}${href ? `\n<${href}|打开手机遥控台>` : ''}`,
      }),
    };
  }
  if (provider === 'telegram') {
    const chatId = parsed.searchParams.get('chat_id')?.trim() ?? '';
    const postUrl = `${parsed.origin}${parsed.pathname}`;
    return {
      url: postUrl,
      headers,
      body: JSON.stringify({
        chat_id: chatId,
        text: `${headerTitle}\n任务：${title}\n${meta.hint}${href ? `\n${href}` : ''}`,
        disable_web_page_preview: true,
      }),
    };
  }

  const rawBody = JSON.stringify({
    event: input.kind,
    title: headerTitle,
    body: `任务：${title}\n${meta.hint}`,
    project,
    taskTitle: title,
    ...(href ? { url: href } : {}),
    timestamp: ts,
  });
  if (input.secret?.trim()) {
    headers['x-shoal-timestamp'] = String(ts);
    headers['x-shoal-signature'] = 'sha256=' + crypto.createHmac('sha256', input.secret.trim()).update(`${ts}.${rawBody}`).digest('hex');
  }
  return { url: parsed.toString(), headers, body: rawBody };
}

export async function resolveAndValidatePublicAddrs(
  hostname: string,
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const cleanHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalKind = net.isIP(cleanHost);
  if (literalKind === 4 || literalKind === 6) {
    if (!isPublicIpAddress(cleanHost)) {
      throw new Error('拒绝向内网或保留地址推送通知（SSRF 防护）');
    }
    return [{ address: cleanHost, family: literalKind }];
  }
  const resolveHosts = lookupImpl ?? ((h: string) => dns.promises.lookup(h, { all: true }));
  const addrs = await resolveHosts(cleanHost);
  if (addrs.length === 0 || addrs.some(a => !isPublicIpAddress(a.address))) {
    throw new Error('拒绝向内网或保留地址推送通知（SSRF 防护）');
  }
  return addrs.map(a => {
    const fam = net.isIP(a.address);
    if (fam !== 4 && fam !== 6) {
      throw new Error('拒绝向内网或保留地址推送通知（SSRF 防护）');
    }
    return { address: a.address, family: fam };
  });
}

async function postHttpsPinned(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const u = new URL(urlStr);
  const cleanHost = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const validated = await resolveAndValidatePublicAddrs(cleanHost, lookupImpl);
  const port = u.port ? Number(u.port) : 443;

  return new Promise((resolve, reject) => {
    let settled = false;
    const doneErr = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const pinnedLookup = ((_hostname: string, opts: unknown, cb?: unknown) => {
      const callback = (typeof opts === 'function' ? opts : cb) as (
        err: NodeJS.ErrnoException | null,
        addr: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void;
      const optObj = typeof opts === 'object' && opts !== null ? (opts as { all?: boolean }) : {};
      if (optObj.all) {
        callback(null, validated);
      } else {
        callback(null, validated[0].address, validated[0].family);
      }
    }) as never;

    const req = https.request(
      {
        hostname: cleanHost,
        port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'content-length': String(Buffer.byteLength(body)),
        },
        servername: net.isIP(cleanHost) === 0 ? cleanHost : undefined,
        lookup: pinnedLookup,
      },
      res => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          doneErr(new Error(`Webhook 返回重定向 HTTP ${status}（已拒绝）`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 64 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', doneErr);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Webhook 推送超时'));
    });
    req.on('error', doneErr);
    req.write(body);
    req.end();
  });
}

export async function sendFeishuNotification(input: FeishuNotificationInput): Promise<void> {
  const allowLocal = input.allowLocalTest ?? process.env.WORKBENCH_FAKE_AGENT === '1';
  const provider = detectWebhookProvider(input.webhookUrl, allowLocal);
  if (!provider) {
    throw new Error('通知 Webhook 地址无效或不安全（需为飞书、Discord、Slack、Telegram 或公网 HTTPS Webhook）');
  }
  const u = new URL(input.webhookUrl.trim());
  const cleanHost = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const reqSpec = buildWebhookRequest(provider, input);

  let resOk = false;
  let resStatus = 0;
  let text = '';

  if (!input.fetchImpl && u.protocol === 'https:') {
    const pinnedRes = await postHttpsPinned(reqSpec.url, reqSpec.headers, reqSpec.body, 8000, input.lookupImpl);
    resOk = pinnedRes.ok;
    resStatus = pinnedRes.status;
    text = pinnedRes.text;
  } else {
    if (input.lookupImpl && net.isIP(cleanHost) === 0) {
      await resolveAndValidatePublicAddrs(cleanHost, input.lookupImpl);
    }
    const doFetch = input.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await doFetch(reqSpec.url, {
        method: 'POST',
        headers: reqSpec.headers,
        body: reqSpec.body,
        redirect: 'error',
        signal: ctrl.signal,
      });
      resOk = res.ok;
      resStatus = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  let json: { ok?: boolean; code?: number; msg?: string; description?: string; StatusCode?: number; StatusMessage?: string } = {};
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!resOk) throw new Error(`Webhook 返回 HTTP ${resStatus}`);
  if (provider === 'feishu') {
    const code = json.code ?? json.StatusCode ?? 0;
    if (code !== 0) throw new Error(`飞书推送失败（${code}）：${json.msg ?? json.StatusMessage ?? '未知错误'}`);
  } else if (provider === 'telegram' && json.ok === false) {
    throw new Error(`Telegram 推送失败：${json.description ?? '未知错误'}`);
  }
}

export const sendWebhookNotification = sendFeishuNotification;

export interface MobileNotifierConfig {
  getSettings(): {
    enabled: boolean;
    feishuEnabled: boolean;
    feishuWebhookUrl: string;
    feishuSecret: string;
    quietWhenDesktopActive: boolean;
    deepLinkBase: string;
  };
  getTask(id: string): Task | undefined;
  getProjectName(id: string): string;
  lastDesktopActiveAt(): number;
  sendFn?: (input: FeishuNotificationInput) => Promise<void>;
  nowMs?: () => number;
  debounceMs?: number;
  cooldownMs?: number;
}

export function createMobileNotifier(cfg: MobileNotifierConfig) {
  const now = cfg.nowMs ?? (() => Date.now());
  const doSend = cfg.sendFn ?? sendFeishuNotification;
  const debounceMs = cfg.debounceMs ?? 1200;
  const cooldownMs = cfg.cooldownMs ?? 30_000;

  const prevPhase = new Map<string, Task['phase']>();
  const prevStatus = new Map<string, SessionInfo['status']>();
  const prevLimit = new Map<string, boolean>();
  const pendingNeedsYou = new Map<string, NodeJS.Timeout>();
  const lastSentAt = new Map<string, number>();

  const dispatch = (task: Task, kind: NotifyKind) => {
    const s = cfg.getSettings();
    if (!s.enabled || !s.feishuEnabled || !s.feishuWebhookUrl.trim()) return;
    if (s.quietWhenDesktopActive && now() - cfg.lastDesktopActiveAt() < 60_000) return;
    const key = `${task.id}:${kind}`;
    const last = lastSentAt.get(key) ?? 0;
    if (now() - last < cooldownMs) return;
    lastSentAt.set(key, now());
    if (lastSentAt.size > 256) {
      const expireBefore = now() - cooldownMs * 2;
      for (const [k, ts] of lastSentAt) {
        if (ts < expireBefore) lastSentAt.delete(k);
      }
    }
    void doSend({
      webhookUrl: s.feishuWebhookUrl,
      secret: s.feishuSecret,
      projectName: cfg.getProjectName(task.projectId),
      taskId: task.id,
      taskTitle: task.title,
      kind,
      deepLinkBase: s.deepLinkBase,
      nowMs: now(),
    }).catch(e => {
      console.warn(`[notify] ${kind} 通知发送失败：${(e as Error).message}`);
    });
  };

  const cancelNeedsYou = (taskId: string) => {
    const t = pendingNeedsYou.get(taskId);
    if (t) {
      clearTimeout(t);
      pendingNeedsYou.delete(taskId);
    }
  };

  return {
    seed(tasks: Task[], sessions: SessionInfo[]) {
      for (const t of tasks) prevPhase.set(t.id, t.phase);
      for (const s of sessions) {
        prevStatus.set(s.id, s.status);
        prevLimit.set(s.id, Boolean(s.limit));
      }
    },
    onTask(task: Task) {
      const old = prevPhase.get(task.id);
      prevPhase.set(task.id, task.phase);
      if (task.phase === 'review' && old !== 'review') {
        cancelNeedsYou(task.id);
        // A delegated task's result goes to its main task for review, not to the user.
        if (!task.delegation) dispatch(task, 'review');
      } else if (task.phase === 'archived' || task.phase === 'approved') {
        cancelNeedsYou(task.id);
        if (task.phase === 'archived') {
          lastSentAt.delete(`${task.id}:needs_you`);
          lastSentAt.delete(`${task.id}:review`);
          lastSentAt.delete(`${task.id}:limit`);
        }
      }
    },
    onSession(session: SessionInfo) {
      if (session.status === 'exited') {
        prevStatus.delete(session.id);
        prevLimit.delete(session.id);
        cancelNeedsYou(session.taskId);
        return;
      }
      const oldStatus = prevStatus.get(session.id);
      const oldLimited = prevLimit.get(session.id) ?? false;
      prevStatus.set(session.id, session.status);
      const limited = Boolean(session.limit);
      prevLimit.set(session.id, limited);

      const task = cfg.getTask(session.taskId);
      if (!task || task.sessionId !== session.id) return;

      if (limited && !oldLimited) {
        cancelNeedsYou(task.id);
        dispatch(task, 'limit');
      }

      if (session.status === 'needs_you' && (oldStatus === 'working' || oldStatus === 'starting')) {
        if (task.phase === 'active') {
          cancelNeedsYou(task.id);
          const timer = setTimeout(() => {
            pendingNeedsYou.delete(task.id);
            const cur = cfg.getTask(task.id);
            if (cur && cur.sessionId === session.id && cur.phase === 'active') {
              dispatch(cur, 'needs_you');
            }
          }, debounceMs);
          timer.unref?.();
          pendingNeedsYou.set(task.id, timer);
        }
      } else if (session.status !== 'needs_you') {
        cancelNeedsYou(task.id);
      }
    },
    async sendTest() {
      const s = cfg.getSettings();
      if (!s.feishuWebhookUrl.trim()) throw new Error('请先填写通知 Webhook 地址');
      await doSend({
        webhookUrl: s.feishuWebhookUrl,
        secret: s.feishuSecret,
        projectName: 'Shoal',
        taskId: 'test',
        taskTitle: '远程提醒连通测试',
        kind: 'test',
        deepLinkBase: s.deepLinkBase,
        nowMs: now(),
      });
    },
    dispose() {
      for (const t of pendingNeedsYou.values()) clearTimeout(t);
      pendingNeedsYou.clear();
    },
  };
}
