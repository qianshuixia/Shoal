import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type {
  AgentKind,
  Card,
  ClientMsg,
  ConversationItem,
  DiffPayload,
  ForwardResult,
  MobileAdminStatus,
  MobileConfigPatch,
  MobileConfigView,
  MobilePairChallengeView,
  MobilePairClaimResult,
  MobilePairRedeemResult,
  MobileRouteVia,
  MobileTunnelMode,
  PairedDeviceSummary,
  Project,
  ProjectChanges,
  ResumeResult,
  ServerMsg,
  SessionActivity,
  SessionInfo,
  Snapshot,
  SwitchResult,
  Task,
  TaskConversationResponse,
} from '../shared/protocol.ts';
import type { ActivityTracker } from './activity.ts';
import { buildTaskConversation } from './conversation.ts';
import { createMobileNotifier, isAllowedWebhookUrl } from './notify.ts';
import { createPowerBlocker } from './power.ts';
import { readPrompt } from './prompt.ts';
import type { SessionManager } from './sessions.ts';
import type { Store } from './store.ts';
import { createCfAccessVerifier, createTunnelManager, extractTunnelToken, normalizeTeamDomain } from './tunnel.ts';

const COOKIE_NAME = 'shoal_mobile';
const COOKIE_MAX_AGE_S = 90 * 86400; // 90 days
const PAIR_TTL_MS = 3 * 60_000;
const REDEEM_TTL_MS = 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_FAILS = 5;
const LAST_SEEN_SAVE_MS = 5 * 60_000;
const MAX_MOBILE_BODY = 1024 * 1024;
const MAX_MOBILE_ATTACHMENT = 20 * 1024 * 1024;
const MOBILE_DEFAULT_COLS = 120;
const MOBILE_DEFAULT_ROWS = 40;
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class MobileGatewayError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PersistedDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  via: MobileRouteVia;
}

interface PersistedMobileConfig {
  enabled: boolean;
  lanEnabled: boolean;
  keepAwake: boolean;
  publicOrigin: string;
  tunnelEnabled: boolean;
  tunnelMode: MobileTunnelMode;
  tunnelToken: string;
  cfAccessTeamDomain: string;
  cfAccessAud: string;
  feishuEnabled: boolean;
  feishuWebhookUrl: string;
  feishuSecret: string;
  quietWhenDesktopActive: boolean;
}

interface MobileDiskFile {
  version: 1;
  config: PersistedMobileConfig;
  devices: PersistedDevice[];
}

interface ActivePairChallenge {
  id: string;
  pairToken: string;
  createdAt: number;
  expiresAt: number;
  status: 'waiting_scan' | 'claimed';
  claimId?: string;
  claimSecret?: string;
  code?: string;
  deviceName?: string;
  claimedIp?: string;
  attemptsLeft: number;
}

interface ApprovedRedeem {
  claimSecret: string;
  rawToken: string;
  device: PersistedDevice;
  expiresAt: number;
}

export interface MobileHandlers {
  distDir: string;
  mainPort: number;
  mobilePort?: number;
  stateDir: string;
  store: Store;
  sessions: SessionManager;
  activity: ActivityTracker;
  availableAgents(): AgentKind[];
  snapshot(): Snapshot;
  createTask(body: Record<string, unknown>): { task: Task; session: SessionInfo };
  renameTask(id: string, body: Record<string, unknown>): Task;
  resumeTask(id: string, body: Record<string, unknown>): ResumeResult;
  feedback(id: string, body: Record<string, unknown>): { task: Task; session: SessionInfo; card: Card };
  switchAgent(id: string, body: Record<string, unknown>): Promise<SwitchResult>;
  forward(cardId: string, body: Record<string, unknown>): ForwardResult;
  setTaskPhase(task: Task, phase: 'approved' | 'archived' | 'active'): Task;
  saveAttachment(ext: string, data: Buffer): { path: string; name: string };
  listChanges(projectId: string): Promise<ProjectChanges>;
  readDiff(projectId: string, relPath: string): Promise<DiffPayload>;
  resolveRawImage(projectId: string, relPath: string): { absPath: string; mime: string; size: number };
  forwardHttpError(err: unknown): { status: number; message: string; code?: string } | null;
}

const VIRTUAL_IFACE_RE = /(vethernet|wsl|hyper-v|vmware|virtualbox|loopback|teredo|isatap|utun|tun|tap|zerotier|docker|br-)/i;

export function detectLanIps(): string[] {
  const ifaces = os.networkInterfaces();
  const preferred: string[] = [];
  const other: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_IFACE_RE.test(name)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const addr = info.address;
      if (addr.startsWith('169.254.')) continue;
      if (addr.startsWith('192.168.')) preferred.push(addr);
      else if (addr.startsWith('10.') || is172Private(addr) || isCgnat(addr)) other.push(addr);
    }
  }
  return [...new Set([...preferred, ...other])];
}

function parseIpv4Octets(ip: string): number[] | null {
  const norm = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const parts = norm.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

const is172Private = (ip: string) => {
  const o = parseIpv4Octets(ip);
  return !!o && o[0] === 172 && o[1] >= 16 && o[1] <= 31;
};

const isCgnat = (ip: string) => {
  const o = parseIpv4Octets(ip);
  return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
};

export function normalizeRemoteIp(raw: string | undefined): string {
  if (!raw) return '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function isPrivateOrLoopbackIp(raw: string | undefined): boolean {
  if (!raw) return false;
  const ip = normalizeRemoteIp(raw.trim());
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const o = parseIpv4Octets(ip);
  if (!o) return false;
  if (o[0] === 127 || o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
  return false;
}

const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function timingSafeStrEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function maskWebhookUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.hostname.toLowerCase() === 'api.telegram.org') {
      return 'https://api.telegram.org/bot****/sendMessage';
    }
    const tail = u.pathname.slice(-6);
    return `${u.origin}/.../****${tail}`;
  } catch {
    return '****';
  }
}

export function normalizePublicOrigin(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  let u: URL;
  try {
    u = new URL(t.includes('://') ? t : `https://${t}`);
  } catch {
    throw new MobileGatewayError(400, '公网访问域名格式无效');
  }
  if (u.protocol !== 'https:' && !(process.env.WORKBENCH_FAKE_AGENT === '1' && u.protocol === 'http:')) {
    throw new MobileGatewayError(400, '公网访问入口必须使用 https:// 协议');
  }
  if (!u.hostname || u.hostname === '0.0.0.0') {
    throw new MobileGatewayError(400, '公网访问域名无效');
  }
  return u.origin;
}

const baseOfPath = (p: string) => {
  const norm = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return norm.split('/').pop() || norm;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRAILING_PATH_DELIM = String.raw`\s"'` + '`' + String.raw`),;\]\}>，。；：！？）」』】》”’、`;
const GENERIC_ABS_PATH_RE = new RegExp(
  `(?:file:\\/\\/\\/?)?(?:[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|var|opt|srv|mnt)[\\\\/])[^${TRAILING_PATH_DELIM}]*`,
  'g',
);

function collectScrubDirs(stateDir?: string, extraDirs?: Iterable<string>): string[] {
  const raw: string[] = [];
  if (stateDir) raw.push(stateDir);
  if (extraDirs) {
    for (const d of extraDirs) {
      if (d) raw.push(d);
    }
  }
  raw.push(os.homedir(), os.tmpdir());
  const norms = new Set<string>();
  for (const r of raw) {
    const resolved = path.resolve(r);
    const list = [resolved];
    try {
      list.push(fs.realpathSync(resolved));
    } catch { /* ignore */ }
    for (const c of list) {
      const norm = c.replaceAll('\\', '/').replace(/\/+$/, '');
      if (!norm) continue;
      const parts = norm.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      if (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) continue;
      norms.add(norm);
    }
  }
  return [...norms].sort((a, b) => b.length - a.length);
}

export function scrubStatePaths(text: string, stateDir?: string, extraDirs?: Iterable<string>): string {
  if (!text) return text;
  let out = text;
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const sep = '[\\\\/]';
  if (stateDir) {
    const resolved = path.resolve(stateDir);
    const stateNorms = new Set<string>();
    for (const c of [resolved, (() => { try { return fs.realpathSync(resolved); } catch { return ''; } })()]) {
      if (!c) continue;
      const norm = c.replaceAll('\\', '/').replace(/\/+$/, '');
      if (norm) stateNorms.add(norm);
    }
    for (const norm of stateNorms) {
      const parts = norm.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      const prefix = norm.startsWith('/') ? sep : '';
      const dirPattern = prefix + parts.map(escapeRegExp).join(sep);
      const attachRe = new RegExp(`(?:file:\\/\\/\\/?)?${dirPattern}${sep}attachments${sep}([0-9a-zA-Z._-]+)`, flags);
      out = out.replace(attachRe, (_m, name: string) => `[图片附件: ${name}]`);
    }
  }
  for (const norm of collectScrubDirs(stateDir, extraDirs)) {
    const parts = norm.split('/').filter(Boolean);
    const prefix = norm.startsWith('/') ? sep : '';
    const dirPattern = `(?:file:\\/\\/\\/?)?${prefix}${parts.map(escapeRegExp).join(sep)}`;
    const anyRe = new RegExp(`${dirPattern}(?:${sep}[^${TRAILING_PATH_DELIM}]*)?`, flags);
    out = out.replace(anyRe, '[本机路径]');
  }
  out = out.replace(new RegExp(`file:\\/\\/\\/?[A-Za-z]:[^${TRAILING_PATH_DELIM}]*`, 'gi'), '[本机路径]');
  return out;
}

export function scrubErrorForMobile(msg: string, stateDir?: string, extraDirs?: Iterable<string>): string {
  return scrubStatePaths(msg, stateDir, extraDirs).replace(GENERIC_ABS_PATH_RE, '[本机路径]');
}

export function sanitizeProjectForMobile(p: Project): Project {
  return { ...p, path: '' };
}

export function sanitizeTaskForMobile(t: Task, stateDir?: string, extraDirs?: Iterable<string>): Task {
  const prompt = scrubStatePaths(t.prompt, stateDir, extraDirs);
  const lastPrompt = t.lastPrompt !== undefined ? scrubStatePaths(t.lastPrompt, stateDir, extraDirs) : undefined;
  if (prompt === t.prompt && lastPrompt === t.lastPrompt) return t;
  return { ...t, prompt, ...(lastPrompt !== undefined ? { lastPrompt } : {}) };
}

export function sanitizeCardForMobile(c: Card, stateDir?: string, extraDirs?: Iterable<string>): Card {
  const body = scrubStatePaths(c.body, stateDir, extraDirs);
  return body === c.body ? c : { ...c, body };
}

export function sanitizeConversationItemForMobile(item: ConversationItem, stateDir?: string, extraDirs?: Iterable<string>): ConversationItem {
  switch (item.kind) {
    case 'user':
    case 'assistant':
      return { ...item, text: scrubStatePaths(item.text, stateDir, extraDirs) };
    case 'tools':
      return { ...item, tools: item.tools.map(t => scrubStatePaths(t, stateDir, extraDirs)) };
    case 'card':
      return { ...item, card: sanitizeCardForMobile(item.card, stateDir, extraDirs) };
  }
}

export function sanitizeSessionForMobile(s: SessionInfo): SessionInfo {
  const copy = { ...s };
  delete copy.transcriptPath;
  return copy;
}

export function sanitizeActivityForMobile(a: SessionActivity): SessionActivity {
  return {
    ...a,
    filesRead: a.filesRead.map(baseOfPath),
    filesWritten: a.filesWritten.map(baseOfPath),
  };
}

export function sanitizeSnapshotForMobile(s: Snapshot, stateDir?: string, extraDirs?: Iterable<string>): Snapshot {
  const activity: Record<string, SessionActivity> | undefined = s.activity
    ? Object.fromEntries(Object.entries(s.activity).map(([k, v]) => [k, sanitizeActivityForMobile(v)]))
    : undefined;
  return {
    ...s,
    projects: s.projects.map(sanitizeProjectForMobile),
    tasks: s.tasks.map(t => sanitizeTaskForMobile(t, stateDir, extraDirs)),
    cards: s.cards.map(c => sanitizeCardForMobile(c, stateDir, extraDirs)),
    sessions: s.sessions.map(sanitizeSessionForMobile),
    ...(activity !== undefined ? { activity } : {}),
  };
}

export function sanitizeServerMsgForMobile(m: ServerMsg, stateDir?: string, extraDirs?: Iterable<string>): ServerMsg {
  switch (m.t) {
    case 'snapshot':
      return { t: 'snapshot', state: sanitizeSnapshotForMobile(m.state, stateDir, extraDirs) };
    case 'project':
      return { t: 'project', project: sanitizeProjectForMobile(m.project) };
    case 'task':
      return { t: 'task', task: sanitizeTaskForMobile(m.task, stateDir, extraDirs) };
    case 'card':
      return { t: 'card', card: sanitizeCardForMobile(m.card, stateDir, extraDirs) };
    case 'session':
      return { t: 'session', session: sanitizeSessionForMobile(m.session) };
    case 'activity':
      return { t: 'activity', sessionId: m.sessionId, activity: m.activity ? sanitizeActivityForMobile(m.activity) : null };
    default:
      return m;
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

function summarizeUserAgent(ua: string | undefined): string {
  const s = (ua ?? '').trim();
  if (!s) return '未知手机浏览器';
  const osLabel = /Android/i.test(s)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(s)
      ? 'iOS'
      : /Windows/i.test(s)
        ? 'Windows'
        : /Mac OS/i.test(s)
          ? 'macOS'
          : 'Mobile';
  const browser = /EdgA|Edg\//i.test(s)
    ? 'Edge'
    : /MicroMessenger/i.test(s)
      ? '微信'
      : /Chrome|CriOS/i.test(s)
        ? 'Chrome'
        : /Firefox|FxiOS/i.test(s)
          ? 'Firefox'
          : /Safari/i.test(s)
            ? 'Safari'
            : 'Browser';
  return `${osLabel} · ${browser}`;
}

function defaultConfig(): PersistedMobileConfig {
  return {
    enabled: false,
    lanEnabled: true,
    keepAwake: true,
    publicOrigin: '',
    tunnelEnabled: false,
    tunnelMode: 'quick',
    tunnelToken: '',
    cfAccessTeamDomain: '',
    cfAccessAud: '',
    feishuEnabled: false,
    feishuWebhookUrl: '',
    feishuSecret: '',
    quietWhenDesktopActive: true,
  };
}

function loadDiskFile(file: string): MobileDiskFile {
  const fallback: MobileDiskFile = { version: 1, config: defaultConfig(), devices: [] };
  if (!fs.existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MobileDiskFile>;
    const rawCfg = (parsed.config && typeof parsed.config === 'object' ? parsed.config : {}) as Record<string, unknown>;
    const dflt = defaultConfig();
    const str = (v: unknown, fb: string) => (typeof v === 'string' ? v : fb);
    const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);
    const rawOrigin = str(rawCfg.publicOrigin, dflt.publicOrigin);
    const rawToken = str(rawCfg.tunnelToken, dflt.tunnelToken);
    const cfg: PersistedMobileConfig = {
      enabled: bool(rawCfg.enabled, dflt.enabled),
      lanEnabled: bool(rawCfg.lanEnabled, dflt.lanEnabled),
      keepAwake: bool(rawCfg.keepAwake, dflt.keepAwake),
      publicOrigin: rawOrigin,
      tunnelEnabled: bool(rawCfg.tunnelEnabled, dflt.tunnelEnabled),
      // Preserve backward compatibility for pre-existing Named Tunnel configurations without explicit tunnelMode.
      tunnelMode: rawCfg.tunnelMode === 'named' || rawCfg.tunnelMode === 'quick'
        ? rawCfg.tunnelMode
        : rawToken.trim() || rawOrigin.trim()
          ? 'named'
          : 'quick',
      tunnelToken: rawToken,
      cfAccessTeamDomain: str(rawCfg.cfAccessTeamDomain, dflt.cfAccessTeamDomain),
      cfAccessAud: str(rawCfg.cfAccessAud, dflt.cfAccessAud),
      feishuEnabled: bool(rawCfg.feishuEnabled, dflt.feishuEnabled),
      feishuWebhookUrl: str(rawCfg.feishuWebhookUrl, dflt.feishuWebhookUrl),
      feishuSecret: str(rawCfg.feishuSecret, dflt.feishuSecret),
      quietWhenDesktopActive: bool(rawCfg.quietWhenDesktopActive, dflt.quietWhenDesktopActive),
    };
    const devices = Array.isArray(parsed.devices)
      ? parsed.devices.filter((d): d is PersistedDevice =>
          !!d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && typeof d.name === 'string')
      : [];
    return { version: 1, config: cfg, devices };
  } catch (e) {
    console.warn(`[mobile] 读取 mobile.json 失败，已回退默认配置：${(e as Error).message}`);
    return fallback;
  }
}

function saveDiskFile(file: string, data: MobileDiskFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore on Windows if unsupported */ }
}

function readReqBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new MobileGatewayError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readReqBuffer(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => (size > max ? reject(new MobileGatewayError(413, '图片过大（上限 20 MB）')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function injectMobileMeta(html: string): string {
  let out = html.replace(
    /<meta\s+name=["']viewport["'][^>]*>/i,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
  );
  // index.html already carries theme-color (the phone header colour) and the icons; only the marker is added here.
  const meta = '<meta name="shoal-mobile" content="1" />';
  return out.includes('</head>') ? out.replace('</head>', `  ${meta}\n</head>`) : `${meta}\n${out}`;
}

export function createMobileController(handlers: MobileHandlers) {
  const configuredPort = handlers.mobilePort ?? Number(process.env.WORKBENCH_MOBILE_PORT ?? (handlers.mainPort + 1));
  const file = path.join(handlers.stateDir, 'mobile.json');
  const disk = loadDiskFile(file);

  const power = createPowerBlocker();
  const tunnel = createTunnelManager();
  const cfAccess = createCfAccessVerifier();
  const effectivePublicOrigin = (): string => {
    if (disk.config.tunnelEnabled && disk.config.tunnelMode === 'quick') {
      return tunnel.status().quickUrl ?? '';
    }
    return disk.config.publicOrigin;
  };

  const notifier = createMobileNotifier({
    getSettings: () => ({
      enabled: disk.config.enabled,
      feishuEnabled: disk.config.feishuEnabled,
      feishuWebhookUrl: disk.config.feishuWebhookUrl,
      feishuSecret: disk.config.feishuSecret,
      quietWhenDesktopActive: disk.config.quietWhenDesktopActive,
      deepLinkBase: effectivePublicOrigin() || (actualPort ? `http://${disk.config.lanEnabled ? (detectLanIps()[0] ?? '127.0.0.1') : '127.0.0.1'}:${actualPort}` : ''),
    }),
    getTask: id => handlers.store.getTask(id),
    getProjectName: id => handlers.store.getProject(id)?.name ?? 'Shoal',
    lastDesktopActiveAt: () => handlers.sessions.lastDesktopActiveAt(),
  });
  notifier.seed(handlers.store.tasks(), handlers.sessions.list());

  const getExtraDirs = () => handlers.store.projects().map(p => p.path);

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let actualPort: number | null = null;
  let boundHost = '';
  let lastDiskSeenSave = 0;

  // deviceId -> active WS sockets
  const wsByDevice = new Map<string, Set<WebSocket>>();
  // Feedback retries carry the same clientMsgId; the first result is replayed instead of queueing the text twice.
  const FEEDBACK_REPLAY_MS = 10 * 60_000;
  const feedbackReplays = new Map<string, { at: number; body: unknown }>();
  // Prompt answers for one session run one at a time, so a double tap cannot pass the fingerprint check twice.
  const promptLocks = new Map<string, Promise<unknown>>();
  // ws -> { deviceId, via, watchedSessionId }
  const wsMeta = new Map<WebSocket, { deviceId: string; via: MobileRouteVia; watchedSessionId: string | null }>();

  let activePair: ActivePairChallenge | null = null;
  const approvedRedeems = new Map<string, ApprovedRedeem>();
  const failRates = new Map<string, { count: number; resetAt: number }>();

  const persist = () => saveDiskFile(file, disk);

  const pruneFailRates = (now: number) => {
    if (failRates.size < 256) return;
    for (const [k, rec] of failRates) {
      if (now >= rec.resetAt) failRates.delete(k);
    }
    while (failRates.size >= 2048) {
      const oldest = failRates.keys().next().value;
      if (!oldest) break;
      failRates.delete(oldest);
    }
  };

  const checkRateLimit = (ipKey: string) => {
    const now = Date.now();
    pruneFailRates(now);
    const rec = failRates.get(ipKey);
    if (!rec || now >= rec.resetAt) return;
    if (rec.count >= RATE_MAX_FAILS) {
      throw new MobileGatewayError(429, '尝试次数过多，请 10 分钟后再试');
    }
  };

  const noteRateFail = (ipKey: string) => {
    const now = Date.now();
    pruneFailRates(now);
    const rec = failRates.get(ipKey);
    if (!rec || now >= rec.resetAt) failRates.set(ipKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    else rec.count += 1;
  };

  const clearExpiredPair = () => {
    const now = Date.now();
    if (activePair && now >= activePair.expiresAt) activePair = null;
    for (const [k, v] of approvedRedeems) {
      if (now >= v.expiresAt) approvedRedeems.delete(k);
    }
  };

  const lanUrlsFor = (port: number | null): string[] => {
    if (!port || !disk.config.lanEnabled) return [];
    return detectLanIps().map(ip => `http://${ip}:${port}`);
  };

  const qrUrlsFor = (pairToken: string): { label: string; url: string }[] => {
    const out: { label: string; url: string }[] = [];
    const pub = effectivePublicOrigin();
    if (pub) {
      const label = disk.config.tunnelEnabled && disk.config.tunnelMode === 'quick'
        ? 'Cloudflare 临时隧道'
        : 'Cloudflare 外网通道';
      out.push({ label, url: `${pub}/#pair=${pairToken}` });
    }
    const p = actualPort ?? (configuredPort || null);
    for (const base of lanUrlsFor(p)) {
      out.push({ label: '同 Wi-Fi 局域网', url: `${base}/#pair=${pairToken}` });
    }
    if (out.length === 0 && p) {
      out.push({ label: '本机调试入口', url: `http://127.0.0.1:${p}/#pair=${pairToken}` });
    }
    return out;
  };

  const configView = (): MobileConfigView => ({
    enabled: disk.config.enabled,
    port: actualPort ?? configuredPort,
    lanEnabled: disk.config.lanEnabled,
    keepAwake: disk.config.keepAwake,
    publicOrigin: disk.config.publicOrigin,
    tunnelEnabled: disk.config.tunnelEnabled,
    tunnelMode: disk.config.tunnelMode,
    hasTunnelToken: Boolean(disk.config.tunnelToken),
    cfAccessTeamDomain: disk.config.cfAccessTeamDomain,
    cfAccessAud: disk.config.cfAccessAud,
    feishuEnabled: disk.config.feishuEnabled,
    feishuWebhookUrlMasked: maskWebhookUrl(disk.config.feishuWebhookUrl),
    hasFeishuSecret: Boolean(disk.config.feishuSecret),
    quietWhenDesktopActive: disk.config.quietWhenDesktopActive,
  });

  const deviceSummary = (d: PersistedDevice): PairedDeviceSummary => ({
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    lastIp: d.lastIp,
    via: d.via,
    online: (wsByDevice.get(d.id)?.size ?? 0) > 0,
  });

  const activePairView = (): MobilePairChallengeView | null => {
    clearExpiredPair();
    if (!activePair) return null;
    const urls = qrUrlsFor(activePair.pairToken);
    return {
      id: activePair.id,
      status: activePair.status,
      pairUrl: urls[0]?.url ?? '',
      qrUrls: urls,
      expiresAt: activePair.expiresAt,
      ...(activePair.deviceName ? { deviceName: activePair.deviceName } : {}),
      ...(activePair.claimedIp ? { claimedIp: activePair.claimedIp } : {}),
      attemptsLeft: activePair.attemptsLeft,
    };
  };

  const adminStatus = (): MobileAdminStatus => ({
    config: configView(),
    listening: server !== null && actualPort !== null,
    listenHost: boundHost,
    actualPort,
    lanUrls: lanUrlsFor(actualPort),
    powerAwake: power.isActive(),
    tunnel: tunnel.status(),
    devices: disk.devices.map(deviceSummary),
    activePair: activePairView(),
  });

  const allowedHosts = (): Set<string> => {
    const hosts = new Set<string>();
    if (actualPort) {
      hosts.add(`127.0.0.1:${actualPort}`);
      hosts.add(`localhost:${actualPort}`);
      if (disk.config.lanEnabled) {
        for (const ip of detectLanIps()) hosts.add(`${ip}:${actualPort}`);
      }
    }
    const pub = effectivePublicOrigin();
    if (pub) {
      try { hosts.add(new URL(pub).host.toLowerCase()); } catch { /* ignore */ }
    }
    if (process.env.WORKBENCH_DEV === '1') {
      hosts.add('127.0.0.1:5173');
      hosts.add('localhost:5173');
    }
    return hosts;
  };

  const allowedOrigins = (): Set<string> => {
    const origins = new Set<string>();
    if (actualPort) {
      origins.add(`http://127.0.0.1:${actualPort}`);
      origins.add(`http://localhost:${actualPort}`);
      if (disk.config.lanEnabled) {
        for (const ip of detectLanIps()) origins.add(`http://${ip}:${actualPort}`);
      }
    }
    const pub = effectivePublicOrigin();
    if (pub) origins.add(pub.toLowerCase());
    if (process.env.WORKBENCH_DEV === '1') {
      origins.add('http://127.0.0.1:5173');
      origins.add('http://localhost:5173');
    }
    return origins;
  };

  const resolveRouteVia = (req: http.IncomingMessage): MobileRouteVia => {
    const host = (req.headers.host ?? '').trim().toLowerCase();
    let publicHost = '';
    const pub = effectivePublicOrigin();
    if (pub) {
      try { publicHost = new URL(pub).host.toLowerCase(); } catch { /* ignore */ }
    }
    if (publicHost && host === publicHost) return 'tunnel';
    const remote = normalizeRemoteIp(req.socket.remoteAddress);
    if (remote === '127.0.0.1' || remote === '::1') return 'local';
    return 'lan';
  };

  const resolveClientIp = (req: http.IncomingMessage, via: MobileRouteVia, cfAccessVerified: boolean): string => {
    const sockIp = normalizeRemoteIp(req.socket.remoteAddress) || 'unknown';
    const isLoopback = sockIp === '127.0.0.1' || sockIp === '::1';
    if (
      via === 'tunnel' &&
      isLoopback &&
      (cfAccessVerified || disk.config.tunnelEnabled) &&
      typeof req.headers['cf-connecting-ip'] === 'string' &&
      req.headers['cf-ray']
    ) {
      return req.headers['cf-connecting-ip'].trim() || sockIp;
    }
    return sockIp;
  };

  async function verifyGatewayHeaders(req: http.IncomingMessage): Promise<{ via: MobileRouteVia; ip: string; isHttps: boolean }> {
    const remote = req.socket.remoteAddress;
    if (!isPrivateOrLoopbackIp(remote)) {
      throw new MobileGatewayError(403, '禁止非内网来源直连网关');
    }
    const host = (req.headers.host ?? '').trim().toLowerCase();
    if (!host || !allowedHosts().has(host)) {
      throw new MobileGatewayError(403, 'Host 不被允许');
    }
    const via = resolveRouteVia(req);
    let cfAccessVerified = false;
    if (
      via === 'tunnel' &&
      !(disk.config.tunnelEnabled && disk.config.tunnelMode === 'quick') &&
      disk.config.cfAccessTeamDomain &&
      disk.config.cfAccessAud
    ) {
      const jwt = req.headers['cf-access-jwt-assertion'];
      const token = Array.isArray(jwt) ? jwt[0] : jwt;
      if (!token || !(await cfAccess.verify(token, disk.config.cfAccessTeamDomain, disk.config.cfAccessAud))) {
        throw new MobileGatewayError(403, 'Cloudflare Access 身份校验未通过');
      }
      cfAccessVerified = true;
    }
    const ip = resolveClientIp(req, via, cfAccessVerified);
    const xfProto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
    const pub = effectivePublicOrigin();
    const isHttps = xfProto.includes('https') || (Boolean(pub) && pub.startsWith('https://') && via === 'tunnel');
    return { via, ip, isHttps };
  }

  function verifyCsrf(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin.toLowerCase())) {
      throw new MobileGatewayError(403, 'Origin 不被允许');
    }
    if (req.headers['x-shoal-mobile'] !== '1') {
      throw new MobileGatewayError(403, '缺少移动端安全校验头');
    }
  }

  function authenticateCookie(req: http.IncomingMessage, via: MobileRouteVia, ip: string): PersistedDevice | null {
    const rawCookie = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    if (!rawCookie) return null;
    const dot = rawCookie.indexOf('.');
    if (dot <= 0) return null;
    const id = rawCookie.slice(0, dot);
    const rawToken = rawCookie.slice(dot + 1);
    if (!id || !rawToken) return null;
    const dev = disk.devices.find(d => d.id === id);
    if (!dev) return null;
    const gotHash = sha256Hex(rawToken);
    if (!timingSafeStrEqual(gotHash, dev.tokenHash)) return null;
    const now = Date.now();
    dev.lastSeenAt = now;
    dev.lastIp = ip;
    dev.via = via;
    if (now - lastDiskSeenSave >= LAST_SEEN_SAVE_MS) {
      lastDiskSeenSave = now;
      persist();
    }
    return dev;
  }

  const sendJson = (res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  };

  function serveMobileStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const dist = handlers.distDir;
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('web/dist 不存在，请先运行 npm run build');
      return;
    }
    let cleanPath = '/';
    try { cleanPath = decodeURIComponent(pathname); } catch { /* fallback to root */ }
    let filePath = path.join(dist, cleanPath);
    const inside = filePath === dist || filePath.startsWith(dist + path.sep);
    if (!inside || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(dist, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = path.basename(filePath) === 'index.html';
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (isHtml) {
      headers['cache-control'] = 'no-store';
      headers['content-security-policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
      ].join('; ');
      const html = injectMobileMeta(fs.readFileSync(filePath, 'utf8'));
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(html);
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else {
      pipeline(fs.createReadStream(filePath), res, e => {
        if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[mobile-static]', filePath, e.message);
      });
    }
  }

  function handlePairClaim(b: Record<string, unknown>, ip: string): MobilePairClaimResult {
    clearExpiredPair();
    checkRateLimit(ip);
    const token = typeof b.pairToken === 'string' ? b.pairToken.trim() : '';
    const customName = typeof b.deviceName === 'string' ? b.deviceName.trim().slice(0, 48) : '';
    if (!activePair || activePair.status !== 'waiting_scan' || !token || !timingSafeStrEqual(token, activePair.pairToken)) {
      noteRateFail(ip);
      throw new MobileGatewayError(400, '配对二维码无效或已过期');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const claimId = crypto.randomUUID();
    const claimSecret = crypto.randomBytes(24).toString('hex');
    const deviceName = customName || 'Android 手机';
    activePair.status = 'claimed';
    activePair.claimId = claimId;
    activePair.claimSecret = claimSecret;
    activePair.code = code;
    activePair.deviceName = deviceName;
    activePair.claimedIp = ip;
    return {
      claimId,
      claimSecret,
      code,
      deviceName,
      expiresAt: activePair.expiresAt,
    };
  }

  function handlePairRedeem(b: Record<string, unknown>, via: MobileRouteVia, isHttps: boolean): { body: MobilePairRedeemResult; cookie?: string } {
    clearExpiredPair();
    const claimId = typeof b.claimId === 'string' ? b.claimId.trim() : '';
    const claimSecret = typeof b.claimSecret === 'string' ? b.claimSecret.trim() : '';
    if (!claimId || !claimSecret) throw new MobileGatewayError(400, '缺少配对凭据');

    const approved = approvedRedeems.get(claimId);
    if (approved) {
      if (!timingSafeStrEqual(claimSecret, approved.claimSecret)) {
        throw new MobileGatewayError(403, '配对校验失败', 'pair-mismatch');
      }
      // Kept until it expires (REDEEM_TTL_MS after approval): if the phone never saw the first approved response, its
      // next poll gets the same result. A device revoked in the meantime is not handed back.
      const dev = disk.devices.find(d => d.id === approved.device.id);
      if (!dev) {
        approvedRedeems.delete(claimId);
        throw new MobileGatewayError(410, '配对请求已失效或已被拒绝', 'pair-expired');
      }
      const cookie = `${COOKIE_NAME}=${dev.id}.${approved.rawToken}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
      return {
        body: { status: 'approved', device: deviceSummary({ ...dev, via }) },
        cookie,
      };
    }

    if (activePair && activePair.claimId === claimId && activePair.claimSecret && timingSafeStrEqual(claimSecret, activePair.claimSecret)) {
      return { body: { status: 'pending' } };
    }
    if (activePair && activePair.claimId === claimId) throw new MobileGatewayError(403, '配对校验失败', 'pair-mismatch');
    throw new MobileGatewayError(410, '配对请求已失效或已被拒绝', 'pair-expired');
  }

  async function handleMobileApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const { via, ip, isHttps } = await verifyGatewayHeaders(req);
    const method = req.method ?? 'GET';

    // Desktop-only & dangerous endpoints never exposed on mobile gateway.
    if (pathname === '/hook' || pathname.startsWith('/api/peer/') || pathname.startsWith('/api/mobile/admin/')) {
      throw new MobileGatewayError(403, '手机端网关已禁用此接口');
    }

    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      verifyCsrf(req);
    }

    if (method === 'GET' && pathname === '/api/mobile/session') {
      const dev = authenticateCookie(req, via, ip);
      if (!dev) return sendJson(res, 200, { authenticated: false, via });
      return sendJson(res, 200, { authenticated: true, via, device: deviceSummary(dev) });
    }

    if (method === 'POST' && pathname === '/api/mobile/pair/claim') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new MobileGatewayError(415, '需要 application/json');
      }
      const raw = await readReqBody(req, MAX_MOBILE_BODY);
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(raw);
      } catch {
        throw new MobileGatewayError(400, '请求体不是有效的 JSON');
      }
      const uaName = typeof b.deviceName === 'string' && b.deviceName.trim() ? b.deviceName.trim() : summarizeUserAgent(req.headers['user-agent']);
      return sendJson(res, 200, handlePairClaim({ ...b, deviceName: uaName }, ip));
    }

    if (method === 'POST' && pathname === '/api/mobile/pair/redeem') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new MobileGatewayError(415, '需要 application/json');
      }
      const raw = await readReqBody(req, MAX_MOBILE_BODY);
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(raw);
      } catch {
        throw new MobileGatewayError(400, '请求体不是有效的 JSON');
      }
      const result = handlePairRedeem(b, via, isHttps);
      return sendJson(res, 200, result.body, result.cookie ? { 'set-cookie': result.cookie } : {});
    }

    // All remaining endpoints require an authenticated paired device cookie (ZERO loopback bypass!).
    const device = authenticateCookie(req, via, ip);
    if (!device) {
      throw new MobileGatewayError(401, '设备未配对或登录已失效');
    }

    // Explicitly cropped / dangerous routes return 403 Forbidden.
    if (
      pathname === '/api/shutdown' ||
      pathname === '/api/open' ||
      pathname === '/api/dirs' ||
      pathname === '/api/clipboard/files' ||
      pathname === '/api/usage' ||
      pathname === '/api/settings' ||
      pathname === '/api/agy/optimize' ||
      pathname.startsWith('/api/agy/') ||
      pathname === '/api/projects' ||
      /^\/api\/projects\/[^/]+$/.test(pathname) ||
      /^\/api\/tasks\/[^/]+$/.test(pathname) && method === 'DELETE' ||
      /^\/api\/projects\/[^/]+\/(tree|files|file|discard)$/.test(pathname)
    ) {
      throw new MobileGatewayError(403, '手机端网关已禁用此接口');
    }

    if (method === 'POST' && pathname === '/api/mobile/logout') {
      revokeDevice(device.id);
      const clearCookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
      return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookie });
    }

    if (method === 'POST' && pathname === '/api/attachments') {
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[type];
      if (!ext) throw new MobileGatewayError(415, '只支持 PNG、JPEG、GIF、WebP 图片');
      const data = await readReqBuffer(req, MAX_MOBILE_ATTACHMENT);
      if (data.length === 0) throw new MobileGatewayError(400, '图片内容为空');
      const saved = handlers.saveAttachment(ext, data);
      // Do not expose local filesystem paths to mobile clients.
      return sendJson(res, 200, { name: saved.name });
    }

    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PATCH') {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new MobileGatewayError(415, '需要 application/json');
      }
      const raw = await readReqBody(req, MAX_MOBILE_BODY);
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        throw new MobileGatewayError(400, '请求体不是有效的 JSON 对象');
      }
    }

    const safeDecodeParam = (raw: string): string => {
      try {
        return decodeURIComponent(raw);
      } catch {
        throw new MobileGatewayError(400, '请求路径参数编码无效');
      }
    };
    const extraDirs = getExtraDirs();

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, sanitizeSnapshotForMobile(handlers.snapshot(), handlers.stateDir, extraDirs));
    }

    const convMatch = pathname.match(/^\/api\/mobile\/tasks\/([^/]+)\/conversation$/);
    if (method === 'GET' && convMatch) {
      const taskId = safeDecodeParam(convMatch[1]);
      const task = handlers.store.getTask(taskId);
      if (!task) throw new MobileGatewayError(404, '任务不存在');
      const session = task.sessionId ? handlers.sessions.list().find(s => s.id === task.sessionId) : undefined;
      const act = session ? handlers.activity.all()[session.id] ?? null : null;
      const built = buildTaskConversation({
        task,
        session,
        cards: handlers.store.cards(),
        activity: act ? sanitizeActivityForMobile(act) : null,
      });
      const payload: TaskConversationResponse = {
        ...built,
        items: built.items.map(item => sanitizeConversationItemForMobile(item, handlers.stateDir, extraDirs)),
      };
      return sendJson(res, 200, payload);
    }

    const fixedSize = { cols: MOBILE_DEFAULT_COLS, rows: MOBILE_DEFAULT_ROWS };
    if (method === 'POST' && pathname === '/api/tasks') {
      const created = handlers.createTask({ ...body, ...fixedSize });
      return sendJson(res, 200, {
        task: sanitizeTaskForMobile(created.task, handlers.stateDir, extraDirs),
        session: sanitizeSessionForMobile(created.session),
      });
    }

    const patchTask = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && patchTask) {
      return sendJson(res, 200, sanitizeTaskForMobile(handlers.renameTask(safeDecodeParam(patchTask[1]), body), handlers.stateDir, extraDirs));
    }

    const resumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (method === 'POST' && resumeMatch) {
      const r = handlers.resumeTask(safeDecodeParam(resumeMatch[1]), { ...body, ...fixedSize });
      return sendJson(res, 200, {
        ...r,
        task: sanitizeTaskForMobile(r.task, handlers.stateDir, extraDirs),
        session: sanitizeSessionForMobile(r.session),
      });
    }

    const switchMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/switch$/);
    if (method === 'POST' && switchMatch) {
      const r = await handlers.switchAgent(safeDecodeParam(switchMatch[1]), { ...body, ...fixedSize });
      return sendJson(res, 200, {
        ...r,
        task: sanitizeTaskForMobile(r.task, handlers.stateDir, extraDirs),
        session: sanitizeSessionForMobile(r.session),
        card: sanitizeCardForMobile(r.card, handlers.stateDir, extraDirs),
      });
    }

    const fwMatch = pathname.match(/^\/api\/cards\/([^/]+)\/forward$/);
    if (method === 'POST' && fwMatch) {
      const r = handlers.forward(safeDecodeParam(fwMatch[1]), { ...body, ...fixedSize });
      return sendJson(res, 200, {
        ...r,
        task: sanitizeTaskForMobile(r.task, handlers.stateDir, extraDirs),
        session: sanitizeSessionForMobile(r.session),
        card: sanitizeCardForMobile(r.card, handlers.stateDir, extraDirs),
      });
    }

    const promptMatch = pathname.match(/^\/api\/mobile\/tasks\/([^/]+)\/(prompt|prompt-answer)$/);
    if (promptMatch && ((method === 'GET' && promptMatch[2] === 'prompt') || (method === 'POST' && promptMatch[2] === 'prompt-answer'))) {
      const taskId = safeDecodeParam(promptMatch[1]);
      const task = handlers.store.getTask(taskId);
      if (!task) throw new MobileGatewayError(404, '任务不存在');
      const sessionId = task.sessionId;
      const scrub = (t: string) => scrubErrorForMobile(t, handlers.stateDir, extraDirs);
      // The waitSeq is read together with the screen; rendering is async, so the answer below re-checks it synchronously.
      const read = async () => {
        const w = sessionId ? handlers.sessions.promptWait(sessionId) : null;
        if (!w) return null;
        const view = await readPrompt(w.info, w.waitSeq, w.replay, scrub);
        return view ? { view, waitSeq: w.waitSeq } : null;
      };
      if (method === 'GET') return sendJson(res, 200, { prompt: (await read())?.view ?? null });
      if (!sessionId) throw new MobileGatewayError(409, '已在别处处理', 'stale');
      const { fingerprint, data } = body;
      if (typeof fingerprint !== 'string' || typeof data !== 'string') throw new MobileGatewayError(400, '缺少 fingerprint 或 data');
      const prev = promptLocks.get(sessionId) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(async () => {
        const r = await read();
        if (!r || r.view.fingerprint !== fingerprint) throw new MobileGatewayError(409, '已在别处处理', 'stale');
        if (!r.view.keys.some(k => k.data === data)) throw new MobileGatewayError(400, '这个按键不在当前提示的选项里');
        // From here on nothing awaits: the task still owns the session and no input, delivery or new prompt has
        // happened since the screen was read, or the answer is refused.
        if (handlers.store.getTask(taskId)?.sessionId !== sessionId || !handlers.sessions.answerPrompt(sessionId, r.waitSeq, data)) {
          throw new MobileGatewayError(409, '已在别处处理', 'stale');
        }
      });
      promptLocks.set(sessionId, run);
      try {
        await run;
      } finally {
        if (promptLocks.get(sessionId) === run) promptLocks.delete(sessionId);
      }
      return sendJson(res, 200, { ok: true });
    }

    const actMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|archive|unarchive|feedback)$/);
    if (method === 'POST' && actMatch) {
      const taskId = safeDecodeParam(actMatch[1]);
      const action = actMatch[2];
      if (action === 'feedback') {
        const rawId = body.clientMsgId;
        if (rawId !== undefined && (typeof rawId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(rawId))) {
          throw new MobileGatewayError(400, 'clientMsgId 格式无效');
        }
        const replayKey = typeof rawId === 'string' ? `${device.id}:${taskId}:${rawId}` : null;
        const now = Date.now();
        for (const [k, v] of feedbackReplays) if (now - v.at > FEEDBACK_REPLAY_MS) feedbackReplays.delete(k);
        const prior = replayKey ? feedbackReplays.get(replayKey) : undefined;
        if (prior) return sendJson(res, 200, prior.body);
        const { clientMsgId: _drop, ...feedbackBody } = body;
        const r = handlers.feedback(taskId, { ...feedbackBody, ...fixedSize });
        const payload = {
          ...r,
          task: sanitizeTaskForMobile(r.task, handlers.stateDir, extraDirs),
          session: sanitizeSessionForMobile(r.session),
          card: sanitizeCardForMobile(r.card, handlers.stateDir, extraDirs),
        };
        if (replayKey) feedbackReplays.set(replayKey, { at: now, body: payload });
        return sendJson(res, 200, payload);
      }
      const task = handlers.store.getTask(taskId);
      if (!task) throw new MobileGatewayError(404, '任务不存在');
      // 通过 belongs to the round the phone was looking at: a new round (feedback, delegation result) resets phaseSince.
      if (action === 'approve' && (task.phase !== 'review' || body.phaseSince !== task.phaseSince)) {
        throw new MobileGatewayError(409, '这一轮验收已变化，请看最新结果后再操作', 'stale-round');
      }
      if (action === 'archive' && task.sessionId) handlers.sessions.kill(task.sessionId);
      return sendJson(res, 200, sanitizeTaskForMobile(handlers.setTaskPhase(task, action === 'approve' ? 'approved' : action === 'archive' ? 'archived' : 'active'), handlers.stateDir, extraDirs));
    }

    const projMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(changes|diff|raw)$/);
    if (method === 'GET' && projMatch) {
      const projectId = safeDecodeParam(projMatch[1]);
      const sub = projMatch[2];
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (sub === 'changes') return sendJson(res, 200, await handlers.listChanges(projectId));
      if (sub === 'diff') return sendJson(res, 200, await handlers.readDiff(projectId, q.get('path') ?? ''));
      if (sub === 'raw') {
        const img = handlers.resolveRawImage(projectId, q.get('path') ?? '');
        res.writeHead(200, {
          'content-type': img.mime,
          'content-length': String(img.size),
          'cache-control': 'no-cache',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
        });
        pipeline(fs.createReadStream(img.absPath), res, e => {
          if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[mobile-raw]', img.absPath, e.message);
        });
        return;
      }
    }

    throw new MobileGatewayError(403, '手机端网关已禁用此接口');
  }

  async function stopGateway() {
    for (const [devId, set] of wsByDevice) {
      for (const ws of set) {
        try { ws.close(1001, 'gateway stopped'); } catch { /* ignore */ }
      }
      wsByDevice.delete(devId);
    }
    wsMeta.clear();
    if (wss) {
      const w = wss;
      wss = null;
      await new Promise<void>(resolve => w.close(() => resolve()));
    }
    if (server) {
      const srv = server;
      server = null;
      actualPort = null;
      boundHost = '';
      await new Promise<void>(resolve => {
        srv.close(() => resolve());
        srv.closeIdleConnections?.();
        srv.closeAllConnections?.();
      });
    } else {
      actualPort = null;
      boundHost = '';
    }
  }

  async function startOrRebindGateway() {
    const wantBindHost = disk.config.lanEnabled ? '0.0.0.0' : '127.0.0.1';
    if (!disk.config.enabled) {
      await stopGateway();
      return;
    }
    if (server && boundHost === wantBindHost) return;
    await stopGateway();

    const nextServer = http.createServer((req, res) => {
      const run = async () => {
        let pathname: string;
        try {
          pathname = new URL(req.url ?? '/', 'http://x').pathname;
        } catch {
          throw new MobileGatewayError(400, '请求 URL 无效');
        }
        if (pathname === '/hook') {
          await verifyGatewayHeaders(req);
          throw new MobileGatewayError(403, '手机端网关已禁用此接口');
        }
        if (pathname.startsWith('/api/')) return await handleMobileApi(req, res, pathname);
        await verifyGatewayHeaders(req);
        if (req.method === 'GET' || req.method === 'HEAD') return serveMobileStatic(req, res, pathname);
        throw new MobileGatewayError(404, '未找到资源');
      };
      run().catch(e => {
        if (res.headersSent) return;
        if (e instanceof MobileGatewayError) {
          return sendJson(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
        }
        const forwarded = handlers.forwardHttpError(e);
        if (forwarded) {
          return sendJson(res, forwarded.status, {
            error: scrubErrorForMobile(forwarded.message, handlers.stateDir, getExtraDirs()),
            ...(forwarded.code ? { code: forwarded.code } : {}),
          });
        }
        console.error('[mobile-http]', e);
        sendJson(res, 500, { error: '手机网关内部错误' });
      });
    });

    const nextWss = new WebSocketServer({ noServer: true });
    nextServer.on('upgrade', (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {
        try {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          socket.destroy();
        } catch { /* ignore */ }
        return;
      }
      const runUpgrade = async () => {
        if (pathname !== '/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const { via, ip } = await verifyGatewayHeaders(req);
        const origin = req.headers.origin;
        if (!origin || !allowedOrigins().has(origin.toLowerCase())) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const device = authenticateCookie(req, via, ip);
        if (!device) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        nextWss.handleUpgrade(req, socket, head, ws => nextWss.emit('connection', ws, req, device.id, via));
      };
      runUpgrade().catch(() => {
        try {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
        } catch { /* ignore */ }
      });
    });

    nextWss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, deviceId: string, via: MobileRouteVia) => {
      let set = wsByDevice.get(deviceId);
      if (!set) {
        set = new Set();
        wsByDevice.set(deviceId, set);
      }
      set.add(ws);
      wsMeta.set(ws, { deviceId, via, watchedSessionId: null });

      const cleanup = () => {
        const meta = wsMeta.get(ws);
        wsMeta.delete(ws);
        if (meta) {
          const peers = wsByDevice.get(meta.deviceId);
          if (peers) {
            peers.delete(ws);
            if (peers.size === 0) wsByDevice.delete(meta.deviceId);
          }
        }
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);

      // Invariant 4: send structured snapshot ONLY; never dump sessions.replays() on mobile connect.
      ws.send(JSON.stringify({ t: 'snapshot', state: sanitizeSnapshotForMobile(handlers.snapshot(), handlers.stateDir, getExtraDirs()) } satisfies ServerMsg));

      ws.on('message', raw => {
        let m: ClientMsg;
        try { m = JSON.parse(raw.toString()) as ClientMsg; } catch { return; }
        if (!m || typeof m !== 'object') return;
        const meta = wsMeta.get(ws);
        if (!meta) return;
        if (m.t === 'ping' && typeof m.ts === 'number') {
          ws.send(JSON.stringify({ t: 'pong', ts: m.ts, via: meta.via } satisfies ServerMsg));
          return;
        }
        if (m.t === 'watch-term' && typeof m.id === 'string') {
          meta.watchedSessionId = m.id;
          const rep = handlers.sessions.replayOf(m.id);
          if (rep) ws.send(JSON.stringify({ t: 'replay', id: m.id, d: rep } satisfies ServerMsg));
          return;
        }
        if (m.t === 'unwatch-term') {
          meta.watchedSessionId = null;
          return;
        }
        if (m.t === 'term-key' && typeof m.id === 'string' && typeof m.d === 'string' && m.d.length > 0 && m.d.length <= 64) {
          handlers.sessions.input(m.id, m.d, { fromMobile: true });
          return;
        }
        // Invariant 3: NEVER process 'resize' (or raw 'in') from mobile WebSocket clients!
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => {
        nextServer.removeListener('listening', onListen);
        reject(e);
      };
      const onListen = () => {
        nextServer.removeListener('error', onErr);
        const addr = nextServer.address();
        actualPort = typeof addr === 'object' && addr ? addr.port : configuredPort;
        boundHost = wantBindHost;
        server = nextServer;
        wss = nextWss;
        resolve();
      };
      nextServer.once('error', onErr);
      nextServer.once('listening', onListen);
      nextServer.listen(configuredPort, wantBindHost);
    });
  }

  function revokeDevice(id: string): boolean {
    const idx = disk.devices.findIndex(d => d.id === id);
    if (idx === -1) return false;
    disk.devices.splice(idx, 1);
    persist();
    const sockets = wsByDevice.get(id);
    if (sockets) {
      for (const ws of sockets) {
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'revoked' } satisfies ServerMsg));
          ws.close(4001, 'revoked');
        } catch { /* ignore */ }
      }
      wsByDevice.delete(id);
    }
    return true;
  }

  function revokeAllDevices(): number {
    const count = disk.devices.length;
    disk.devices = [];
    persist();
    for (const [id, sockets] of wsByDevice) {
      for (const ws of sockets) {
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'revoked' } satisfies ServerMsg));
          ws.close(4001, 'revoked');
        } catch { /* ignore */ }
      }
      wsByDevice.delete(id);
    }
    return count;
  }

  let configQueue: Promise<void> = Promise.resolve();
  const enqueueConfigUpdate = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = configQueue.then(fn, fn);
    configQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function syncSideEffects() {
    await startOrRebindGateway();
    power.sync(disk.config.enabled && disk.config.keepAwake);
    tunnel.sync({
      enabled: disk.config.enabled && disk.config.tunnelEnabled && actualPort !== null,
      mode: disk.config.tunnelMode,
      token: disk.config.tunnelToken,
      targetUrl: actualPort !== null ? `http://127.0.0.1:${actualPort}` : '',
    });
  }

  const initPromise = disk.config.enabled
    ? enqueueConfigUpdate(() => syncSideEffects()).catch(e => console.warn(`[mobile] 启动网关失败：${(e as Error).message}`))
    : Promise.resolve();

  return {
    ready: () => initPromise,
    adminStatus,
    updateConfig(raw: Record<string, unknown>): Promise<MobileAdminStatus> {
      return enqueueConfigUpdate(async () => {
        const patch = raw as MobileConfigPatch;
        const prevConfig = { ...disk.config };
        const prevPair = activePair;
        const next = { ...disk.config };
        if (patch.enabled !== undefined) {
          if (typeof patch.enabled !== 'boolean') throw new MobileGatewayError(400, 'enabled 无效');
          next.enabled = patch.enabled;
        }
        if (patch.lanEnabled !== undefined) {
          if (typeof patch.lanEnabled !== 'boolean') throw new MobileGatewayError(400, 'lanEnabled 无效');
          next.lanEnabled = patch.lanEnabled;
        }
        if (patch.keepAwake !== undefined) {
          if (typeof patch.keepAwake !== 'boolean') throw new MobileGatewayError(400, 'keepAwake 无效');
          next.keepAwake = patch.keepAwake;
        }
        if (patch.publicOrigin !== undefined) {
          if (typeof patch.publicOrigin !== 'string') throw new MobileGatewayError(400, 'publicOrigin 无效');
          next.publicOrigin = normalizePublicOrigin(patch.publicOrigin);
        }
        if (patch.tunnelEnabled !== undefined) {
          if (typeof patch.tunnelEnabled !== 'boolean') throw new MobileGatewayError(400, 'tunnelEnabled 无效');
          next.tunnelEnabled = patch.tunnelEnabled;
        }
        if (patch.tunnelMode !== undefined) {
          if (patch.tunnelMode !== 'named' && patch.tunnelMode !== 'quick') {
            throw new MobileGatewayError(400, 'tunnelMode 无效');
          }
          next.tunnelMode = patch.tunnelMode;
        } else if ((patch.publicOrigin && next.publicOrigin) || (patch.tunnelToken && next.tunnelToken)) {
          next.tunnelMode = 'named';
        }
        if (patch.tunnelToken !== undefined) {
          if (typeof patch.tunnelToken !== 'string') throw new MobileGatewayError(400, 'tunnelToken 无效');
          try {
            next.tunnelToken = extractTunnelToken(patch.tunnelToken);
          } catch (e) {
            throw new MobileGatewayError(400, (e as Error).message);
          }
        }
        if (patch.cfAccessTeamDomain !== undefined) {
          if (typeof patch.cfAccessTeamDomain !== 'string') throw new MobileGatewayError(400, 'cfAccessTeamDomain 无效');
          try {
            next.cfAccessTeamDomain = normalizeTeamDomain(patch.cfAccessTeamDomain);
          } catch (e) {
            throw new MobileGatewayError(400, (e as Error).message);
          }
        }
        if (patch.cfAccessAud !== undefined) {
          if (typeof patch.cfAccessAud !== 'string') throw new MobileGatewayError(400, 'cfAccessAud 无效');
          next.cfAccessAud = patch.cfAccessAud.trim();
        }
        if (Boolean(next.cfAccessTeamDomain) !== Boolean(next.cfAccessAud)) {
          throw new MobileGatewayError(400, 'Cloudflare Access Team Domain 与 Application AUD 需成对填写或同时留空');
        }
        if (patch.feishuEnabled !== undefined) {
          if (typeof patch.feishuEnabled !== 'boolean') throw new MobileGatewayError(400, 'feishuEnabled 无效');
          next.feishuEnabled = patch.feishuEnabled;
        }
        if (patch.feishuWebhookUrl !== undefined) {
          if (typeof patch.feishuWebhookUrl !== 'string') throw new MobileGatewayError(400, 'feishuWebhookUrl 无效');
          const trimmedUrl = patch.feishuWebhookUrl.trim();
          if (trimmedUrl && !isAllowedWebhookUrl(trimmedUrl, process.env.WORKBENCH_FAKE_AGENT === '1')) {
            throw new MobileGatewayError(400, 'Webhook 地址无效或不安全（需为公网 HTTPS 地址）');
          }
          next.feishuWebhookUrl = trimmedUrl;
        }
        if (patch.feishuSecret !== undefined) {
          if (typeof patch.feishuSecret !== 'string') throw new MobileGatewayError(400, 'feishuSecret 无效');
          next.feishuSecret = patch.feishuSecret.trim();
        }
        if (patch.quietWhenDesktopActive !== undefined) {
          if (typeof patch.quietWhenDesktopActive !== 'boolean') throw new MobileGatewayError(400, 'quietWhenDesktopActive 无效');
          next.quietWhenDesktopActive = patch.quietWhenDesktopActive;
        }

        if (!next.enabled) activePair = null;
        disk.config = next;
        persist();
        try {
          await syncSideEffects();
        } catch (err) {
          disk.config = prevConfig;
          activePair = prevPair;
          persist();
          await syncSideEffects().catch(() => {});
          throw err;
        }
        return adminStatus();
      });
    },
    startPairing(): MobileAdminStatus {
      if (!disk.config.enabled || actualPort === null) {
        throw new MobileGatewayError(400, '请先开启「手机远程连接」开关');
      }
      const now = Date.now();
      activePair = {
        id: crypto.randomUUID(),
        pairToken: crypto.randomBytes(24).toString('hex'),
        createdAt: now,
        expiresAt: now + PAIR_TTL_MS,
        status: 'waiting_scan',
        attemptsLeft: 3,
      };
      return adminStatus();
    },
    approvePairing(raw: Record<string, unknown>): MobileAdminStatus {
      clearExpiredPair();
      const code = typeof raw.code === 'string' ? raw.code.trim() : '';
      if (!activePair || activePair.status !== 'claimed' || !activePair.code || !activePair.claimId || !activePair.claimSecret) {
        throw new MobileGatewayError(400, '当前没有待批准的手机配对请求，请先在手机上打开配对链接');
      }
      if (!timingSafeStrEqual(code, activePair.code)) {
        activePair.attemptsLeft -= 1;
        const left = activePair.attemptsLeft;
        if (left <= 0) {
          activePair = null;
          throw new MobileGatewayError(410, '确认码连续输错 3 次，本次配对已作废', 'pair-locked');
        }
        throw new MobileGatewayError(400, `确认码不匹配，还剩 ${left} 次机会`);
      }
      const now = Date.now();
      const rawToken = crypto.randomBytes(32).toString('hex');
      const device: PersistedDevice = {
        id: crypto.randomUUID(),
        name: activePair.deviceName || 'Android 手机',
        tokenHash: sha256Hex(rawToken),
        createdAt: now,
        lastSeenAt: now,
        lastIp: activePair.claimedIp || '',
        via: 'lan',
      };
      disk.devices.push(device);
      persist();
      approvedRedeems.set(activePair.claimId, {
        claimSecret: activePair.claimSecret,
        rawToken,
        device,
        expiresAt: now + REDEEM_TTL_MS,
      });
      activePair = null;
      return adminStatus();
    },
    cancelPairing(): MobileAdminStatus {
      activePair = null;
      return adminStatus();
    },
    revokeDevice(id: string): MobileAdminStatus {
      if (!revokeDevice(id)) throw new MobileGatewayError(404, '设备不存在');
      return adminStatus();
    },
    revokeAllDevices(): MobileAdminStatus {
      revokeAllDevices();
      return adminStatus();
    },
    async sendTestNotification(): Promise<{ ok: true }> {
      await notifier.sendTest();
      return { ok: true };
    },
    onServerMsg(m: ServerMsg) {
      if (m.t === 'task') notifier.onTask(m.task);
      else if (m.t === 'session') notifier.onSession(m.session);
      if (wsMeta.size === 0) return;

      if (m.t === 'replay') return; // replays only sent directly in response to watch-term
      if (m.t === 'out') {
        const raw = JSON.stringify(m);
        for (const [ws, meta] of wsMeta) {
          if (meta.watchedSessionId === m.id && ws.readyState === 1) ws.send(raw);
        }
        return;
      }
      const sanitized = JSON.stringify(sanitizeServerMsgForMobile(m, handlers.stateDir, getExtraDirs()));
      for (const [ws] of wsMeta) {
        if (ws.readyState === 1) ws.send(sanitized);
      }
    },
    forwardMobileError(err: unknown) {
      return err instanceof MobileGatewayError ? { status: err.status, message: err.message, code: err.code } : null;
    },
    async close() {
      notifier.dispose();
      power.dispose();
      await Promise.all([stopGateway(), tunnel.stop()]);
    },
  };
}
