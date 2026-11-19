import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { MobileTunnelMode, MobileTunnelStatus } from '../shared/protocol.ts';

const TOKEN_STRICT_RE = /^[A-Za-z0-9+/=_-]{40,}$/;
const TOKEN_EXTRACT_RE = /(eyJ[A-Za-z0-9_-]{20,}=*)/;

export function extractTunnelToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (TOKEN_STRICT_RE.test(trimmed)) return trimmed;
  const embedded = TOKEN_EXTRACT_RE.exec(trimmed)?.[1];
  if (embedded && TOKEN_STRICT_RE.test(embedded)) return embedded;
  throw new Error('Cloudflare Tunnel Token 格式无效，请粘贴纯 Token 或 cloudflared install 命令');
}

export function findCloudflaredBinary(): string | null {
  const envPath = process.env.CLOUDFLARED_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
      ]
    : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const d of pathDirs) {
    const full = path.join(d, exe);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export interface TunnelManager {
  status(): MobileTunnelStatus;
  sync(opts: { enabled: boolean; mode?: MobileTunnelMode; token: string; targetUrl?: string }): void;
  stop(): Promise<void>;
}

export interface TunnelManagerOptions {
  findBinary?: () => string | null;
  spawnImpl?: typeof spawn;
  onStatus?: (st: MobileTunnelStatus) => void;
}

const QUICK_TUNNEL_URL_RE = /https:\/\/([a-z0-9-]{3,100})\.trycloudflare\.com\b/i;

export function parseCloudflaredLine(line: string, st: MobileTunnelStatus): boolean {
  if (!line) return false;
  let changed = false;
  const quickMatch = QUICK_TUNNEL_URL_RE.exec(line);
  if (quickMatch && quickMatch[1].toLowerCase() !== 'api') {
    const quickUrl = `https://${quickMatch[1].toLowerCase()}.trycloudflare.com`;
    if (st.quickUrl !== quickUrl) {
      st.quickUrl = quickUrl;
      changed = true;
    }
    if (st.mode === 'quick' && st.connectedEdges > 0 && st.state !== 'running') {
      st.state = 'running';
      delete st.lastError;
      changed = true;
    }
  }
  if (/\bunregistered tunnel connection\b/i.test(line)) {
    st.connectedEdges = Math.max(0, st.connectedEdges - 1);
    changed = true;
  } else if (/\bregistered tunnel connection\b|\bconnection\s+\S+\s+registered\b/i.test(line)) {
    st.connectedEdges += 1;
    if (st.mode !== 'quick' || st.quickUrl) {
      if (st.state !== 'running') st.state = 'running';
      delete st.lastError;
    }
    changed = true;
  } else if (/\bERR\b/i.test(line)) {
    const cleaned = line.replace(/^.*?\bERR\b\s*/, '').trim() || line.trim();
    const cut = cleaned.length > 180 ? cleaned.slice(0, 180) + '…' : cleaned;
    if (st.lastError !== cut) {
      st.lastError = cut;
      changed = true;
    }
  }
  return changed;
}

function killProcTree(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return Promise.resolve();
  if (process.platform === 'win32' && proc.pid) {
    return new Promise(resolve => {
      execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 2500 }, () => resolve());
    });
  }
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  return Promise.resolve();
}

export function createTunnelManager(opts: TunnelManagerOptions = {}): TunnelManager {
  const resolveBin = opts.findBinary ?? findCloudflaredBinary;
  const runSpawn = opts.spawnImpl ?? spawn;

  const st: MobileTunnelStatus = {
    state: 'stopped',
    mode: 'named',
    pid: null,
    startedAt: null,
    connectedEdges: 0,
    binaryPath: resolveBin(),
  };

  let wantEnabled = false;
  let currentMode: MobileTunnelMode = 'named';
  let currentToken = '';
  let currentTargetUrl = '';
  let proc: ChildProcess | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let backoffMs = 2000;
  let stopping = false;
  let stopSeq = 0;
  let inFlightKill: Promise<void> | null = null;

  const emit = () => opts.onStatus?.({ ...st });

  const killActive = (active: ChildProcess | null): Promise<void> => {
    const prev = inFlightKill ?? Promise.resolve();
    const next = prev.then(() => (active ? killProcTree(active) : Promise.resolve()));
    const wrapped = next.finally(() => {
      if (inFlightKill === wrapped) inFlightKill = null;
    });
    inFlightKill = wrapped;
    return wrapped;
  };

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const launch = () => {
    clearRetry();
    st.binaryPath = resolveBin();
    st.mode = currentMode;
    delete st.quickUrl;
    if (!wantEnabled || (currentMode === 'named' ? !currentToken : !currentTargetUrl)) return;
    if (!st.binaryPath) {
      st.state = 'error';
      st.lastError = '未找到 cloudflared 可执行文件';
      emit();
      return;
    }
    st.state = 'starting';
    st.startedAt = Date.now();
    st.connectedEdges = 0;
    delete st.lastError;
    emit();

    const protocol = process.env.SHOAL_TUNNEL_PROTOCOL?.trim() || 'http2';
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (currentMode === 'named') {
      spawnEnv.TUNNEL_TOKEN = currentToken;
    } else {
      delete spawnEnv.TUNNEL_TOKEN;
    }
    const args = currentMode === 'quick'
      ? ['tunnel', '--no-autoupdate', '--protocol', protocol, '--edge-ip-version', '4', '--url', currentTargetUrl]
      : ['tunnel', '--no-autoupdate', '--protocol', protocol, '--edge-ip-version', '4', 'run'];

    const child = runSpawn(st.binaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never put the tunnel token in CLI args where process inspection can read it.
      env: spawnEnv,
    });
    proc = child;
    st.pid = child.pid ?? null;
    emit();

    let carryOut = '';
    let carryErr = '';
    const consume = (chunk: Buffer, isStdout: boolean) => {
      if (proc !== child) return;
      const merged = (isStdout ? carryOut : carryErr) + chunk.toString('utf8');
      const lines = merged.split(/\r?\n/);
      const tail = lines.pop() ?? '';
      if (isStdout) carryOut = tail;
      else carryErr = tail;
      let dirty = false;
      for (const line of lines) {
        if (parseCloudflaredLine(line, st)) dirty = true;
      }
      if (dirty) emit();
    };
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => consume(chunk, false));

    child.once('error', err => {
      if (proc !== child) return;
      proc = null;
      st.pid = null;
      st.connectedEdges = 0;
      delete st.quickUrl;
      st.state = 'error';
      st.lastError = err.message;
      emit();
    });

    child.once('exit', (code, signal) => {
      if (proc !== child) return;
      proc = null;
      st.pid = null;
      st.connectedEdges = 0;
      delete st.quickUrl;
      if (stopping || !wantEnabled) {
        st.state = 'stopped';
        st.startedAt = null;
        emit();
        return;
      }
      st.state = 'error';
      if (!st.lastError) st.lastError = `cloudflared 已退出（code=${code ?? signal ?? 'unknown'}）`;
      emit();
      const delay = backoffMs;
      backoffMs = Math.min(30_000, backoffMs * 2);
      retryTimer = setTimeout(() => {
        if (wantEnabled && !stopping) launch();
      }, delay);
      retryTimer.unref?.();
    });
  };

  const stop = async () => {
    clearRetry();
    wantEnabled = false;
    stopping = true;
    const myStop = ++stopSeq;
    const active = proc;
    proc = null;
    st.pid = null;
    st.connectedEdges = 0;
    st.state = 'stopped';
    st.startedAt = null;
    delete st.quickUrl;
    delete st.lastError;
    emit();
    await killActive(active);
    if (!wantEnabled && stopSeq === myStop) {
      stopping = false;
      emit();
    }
  };

  return {
    status: () => ({ ...st }),
    sync({ enabled, mode = 'named', token, targetUrl = '' }) {
      const nextMode: MobileTunnelMode = mode === 'quick' ? 'quick' : 'named';
      const nextToken = nextMode === 'named' ? token.trim() : '';
      const nextTargetUrl = targetUrl.trim();
      const nextEnabled = enabled && (nextMode === 'quick' ? nextTargetUrl.length > 0 : nextToken.length > 0);
      if (nextEnabled === wantEnabled && nextMode === currentMode && nextToken === currentToken && nextTargetUrl === currentTargetUrl) {
        if (nextEnabled && !proc && !retryTimer && !inFlightKill) launch();
        return;
      }
      currentMode = nextMode;
      currentToken = nextToken;
      currentTargetUrl = nextTargetUrl;
      st.mode = nextMode;
      delete st.quickUrl;
      if (!nextEnabled) {
        void stop();
        return;
      }
      wantEnabled = true;
      stopping = false;
      backoffMs = 2000;
      if (proc) {
        const old = proc;
        proc = null;
        void killActive(old).then(() => {
          if (wantEnabled && !stopping && !proc && !inFlightKill) launch();
        });
      } else if (inFlightKill) {
        void inFlightKill.then(() => {
          if (wantEnabled && !stopping && !proc && !inFlightKill) launch();
        });
      } else {
        launch();
      }
    },
    stop,
  };
}

// ---- Cloudflare Access RS256 JWT edge defense-in-depth verifier ----
export function normalizeTeamDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!v.includes('.')) v = `${v}.cloudflareaccess.com`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(v)) {
    throw new Error('Cloudflare Access Team Domain 格式无效（应为 team 或 team.cloudflareaccess.com）');
  }
  return v;
}

const b64UrlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface JwkEntry {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

export function createCfAccessVerifier(
  opts: {
    fetchImpl?: typeof fetch;
    nowSec?: () => number;
    nowMs?: () => number;
    fetchTimeoutMs?: number;
    minForceRefreshMs?: number;
  } = {},
) {
  const doFetch = opts.fetchImpl ?? fetch;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = opts.nowMs ?? (() => Date.now());
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 5_000;
  const minForceRefreshMs = opts.minForceRefreshMs ?? 60_000;
  const cache = new Map<string, { fetchedAt: number; keys: JwkEntry[] }>();
  const lastForcedAt = new Map<string, number>();
  const inFlight = new Map<string, { tag: symbol; promise: Promise<JwkEntry[]> }>();
  const CACHE_TTL_MS = 3600_000;

  async function loadKeys(domain: string, force = false): Promise<JwkEntry[]> {
    const t = nowMs();
    const cached = cache.get(domain);
    if (!force && cached && t - cached.fetchedAt < CACHE_TTL_MS) return cached.keys;
    if (force) {
      const lastForced = lastForcedAt.get(domain) ?? 0;
      if (lastForced > 0 && t - lastForced < minForceRefreshMs) {
        return cached?.keys ?? [];
      }
      lastForcedAt.set(domain, t);
    }
    const existing = inFlight.get(domain);
    if (existing) return existing.promise;

    const tag = Symbol();
    const promise = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
      timer.unref?.();
      try {
        const res = await doFetch(`https://${domain}/cdn-cgi/access/certs`, { signal: ac.signal });
        if (!res.ok) throw new Error(`拉取 Cloudflare Access 公钥失败 (HTTP ${res.status})`);
        const json = await res.json() as { keys?: unknown };
        const keys = Array.isArray(json.keys) ? (json.keys as JwkEntry[]) : [];
        cache.set(domain, { fetchedAt: nowMs(), keys });
        return keys;
      } finally {
        clearTimeout(timer);
        if (inFlight.get(domain)?.tag === tag) inFlight.delete(domain);
      }
    })();
    inFlight.set(domain, { tag, promise });
    return promise;
  }

  return {
    async verify(jwt: string, rawTeamDomain: string, expectedAud: string): Promise<boolean> {
      try {
        const domain = normalizeTeamDomain(rawTeamDomain);
        const aud = expectedAud.trim();
        if (!domain || !aud) return false;
        const parts = jwt.split('.');
        if (parts.length !== 3) return false;
        const [hB64, pB64, sB64] = parts;
        const header = JSON.parse(b64UrlToBuf(hB64).toString('utf8')) as { alg?: string; kid?: string };
        const payload = JSON.parse(b64UrlToBuf(pB64).toString('utf8')) as {
          iss?: string;
          aud?: string | string[];
          exp?: number;
          nbf?: number;
        };
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
        const t = nowSec();
        if (typeof payload.exp !== 'number' || payload.exp <= t - 30) return false;
        if (typeof payload.nbf === 'number' && payload.nbf > t + 30) return false;
        const iss = typeof payload.iss === 'string' ? payload.iss.replace(/\/$/, '') : '';
        if (iss !== `https://${domain}`) return false;
        const audList = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === 'string' ? [payload.aud] : [];
        if (!audList.includes(aud)) return false;

        let keys = await loadKeys(domain);
        let jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
        if (!jwk) {
          keys = await loadKeys(domain, true);
          jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
        }
        if (!jwk) return false;
        const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' } as crypto.JsonWebKeyInput);
        return crypto.verify('RSA-SHA256', Buffer.from(`${hB64}.${pB64}`), pub, b64UrlToBuf(sB64));
      } catch {
        return false;
      }
    },
  };
}
