import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePrivacy } from './privacy.ts';
import type { AgentKind, AgyOptimizeStatus, Card, CreateProjectBody, CreateTaskBody, DirListing, ForwardBody, MobileAdminStatus, MobileConfigPatch, MobileTunnelMode, Project, SessionInfo, Settings, Task } from '../../shared/protocol.ts';
import { AGENT_LABEL, AGY_MODELS, DEFAULT_DELEGATION_RULES, DELEGATION_RULES_MAX, FORWARD_NOTE, forwardText } from '../../shared/protocol.ts';
import { QrCodeSvg } from './QrCode.tsx';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `请求失败 (${res.status})`);
  return json as T;
}

async function delJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `请求失败 (${res.status})`);
  return json as T;
}

export async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(json.error ?? `请求失败 (${res.status})`), { code: json.code });
  return json as T;
}

async function getDirs(query: string): Promise<DirListing> {
  const res = await fetch(`/api/dirs${query}`);
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `请求失败 (${res.status})`);
  return json as DirListing;
}

function DirBrowser({ start, onSelect }: { start: string; onSelect(dir: string): void }) {
  const privacy = usePrivacy();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const load = (query: string) => {
    const n = ++seq.current;
    getDirs(query).then(
      (l) => { if (n === seq.current) { setListing(l); setError(''); } },
      (e) => { if (n === seq.current) setError((e as Error).message); },
    );
  };
  useEffect(() => {
    load(start.trim() ? `?path=${encodeURIComponent(start.trim())}` : '');
  }, []);

  const canUp = listing !== null && listing.path !== null; // parent null at a drive root -> drive list
  const up = () => {
    if (!listing || listing.path === null) return;
    load(listing.parent ? `?path=${encodeURIComponent(listing.parent)}` : '?drives=1');
  };

  return (
    <div className="dir-browser" data-testid="dir-browser">
      <div className="dir-bar">
        <button type="button" data-testid="dir-up" disabled={!canUp} onClick={up}>上一级</button>
        <button type="button" data-testid="dir-drives" onClick={() => load('?drives=1')}>磁盘</button>
        <span className="dir-current" data-testid="dir-current" data-private="" title={privacy ? undefined : listing?.path ?? ''}>
          {listing ? (listing.path ?? '此电脑') : ''}
        </span>
      </div>
      {error && <div className="form-error" data-testid="dir-error">{error}</div>}
      <div className="dir-list">
        {listing?.entries.map((en) => (
          <button
            type="button"
            key={en.path}
            data-testid="dir-entry"
            data-private=""
            data-path={en.path}
            onClick={() => load(`?path=${encodeURIComponent(en.path)}`)}
          >{en.name}</button>
        ))}
        {listing && listing.entries.length === 0 && <div className="dir-empty">（没有子目录）</div>}
      </div>
      <div className="actions">
        <button
          type="button"
          className="primary"
          data-testid="dir-select"
          disabled={!listing || listing.path === null}
          onClick={() => listing?.path && onSelect(listing.path)}
        >选择此目录</button>
      </div>
    </div>
  );
}

function Modal({ title, testId, onClose, onSubmit, children }: {
  title: ReactNode;
  testId?: string;
  onClose(): void;
  onSubmit(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        data-testid={testId}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

const AUTO_DELEGATE_TIP = '启动 Claude Code、Codex 和 Antigravity 会话时告诉它们可以用 shoal delegate 把任务派给其他 CLI。关闭后 shoal 命令仍然可用，但 agent 只在你明确要求时才会用。只对之后新启动的会话生效。';

const AI_TITLES_TIP = [
  '开启后，任务的第一句需求发出时，工作台先用这句话的第一行当标题，同时在后台让支持 headless 的 CLI 做一次短调用，写一个更短、更概括的标题，通常十几秒内换上。',
  '· 会消耗少量额度：Claude 用 Haiku；Codex 用默认模型、最低推理档；Antigravity 为规避 headless 账号风控保持首行标题不额外调用。每个任务最多调用一次。',
  '· 这次调用不计入 Token 统计。',
  '· 你自己填写或改过的标题不会被替换；生成失败或超过 60 秒时保留第一行标题。',
  '· 只对开启之后发出第一句需求的任务生效，已有任务的标题不变。',
  '默认关闭。',
].join('\n');

const VIA_LABEL: Record<string, string> = { lan: '同 Wi-Fi', tunnel: 'Cloudflare', local: '本机' };

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function MobileSettingsSection() {
  const [status, setStatus] = useState<MobileAdminStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qrIdx, setQrIdx] = useState(0);
  const [pairCode, setPairCode] = useState('');

  // Draft fields for Tunnel & Webhook forms; secret inputs stay blank unless user replaces them.
  const [draftOrigin, setDraftOrigin] = useState('');
  const [draftTunnelEnabled, setDraftTunnelEnabled] = useState(false);
  const [draftTunnelMode, setDraftTunnelMode] = useState<MobileTunnelMode>('quick');
  const [draftTunnelToken, setDraftTunnelToken] = useState('');
  const [draftCfDomain, setDraftCfDomain] = useState('');
  const [draftCfAud, setDraftCfAud] = useState('');
  const [draftFeishuEnabled, setDraftFeishuEnabled] = useState(false);
  const [draftFeishuWebhook, setDraftFeishuWebhook] = useState('');
  const [draftFeishuSecret, setDraftFeishuSecret] = useState('');
  const [draftQuiet, setDraftQuiet] = useState(true);
  const hydrated = useRef(false);
  const statusSeq = useRef(0);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);

  const applyStatus = useCallback((s: MobileAdminStatus, forceSyncDrafts = false, syncControls = false) => {
    setStatus(s);
    if (!hydrated.current || forceSyncDrafts) {
      hydrated.current = true;
      setDraftOrigin(s.config.publicOrigin);
      setDraftTunnelEnabled(s.config.tunnelEnabled);
      setDraftTunnelMode(s.config.tunnelMode);
      setDraftCfDomain(s.config.cfAccessTeamDomain);
      setDraftCfAud(s.config.cfAccessAud);
      setDraftFeishuEnabled(s.config.feishuEnabled);
      setDraftQuiet(s.config.quietWhenDesktopActive);
    } else if (syncControls) {
      setDraftTunnelEnabled(s.config.tunnelEnabled);
      setDraftTunnelMode(s.config.tunnelMode);
      setDraftFeishuEnabled(s.config.feishuEnabled);
      setDraftQuiet(s.config.quietWhenDesktopActive);
    }
  }, []);

  const refresh = useCallback(async (syncControls = false) => {
    if (!syncControls && inFlight.current > 0) return;
    const mySeq = ++statusSeq.current;
    try {
      const s = await getJson<MobileAdminStatus>('/api/mobile/admin/status');
      if (mySeq !== statusSeq.current || inFlight.current > 0) return;
      applyStatus(s, false, syncControls);
    } catch (e) {
      if (mySeq === statusSeq.current) setError((e as Error).message);
    }
  }, [applyStatus]);

  useEffect(() => { void refresh(); }, [refresh]);

  const needPoll = Boolean(status?.activePair) || status?.tunnel.state === 'starting';
  useEffect(() => {
    if (!needPoll) return;
    const t = setInterval(() => void refresh(false), 1000);
    return () => clearInterval(t);
  }, [needPoll, refresh]);

  const runQueued = (task: () => Promise<void>, refreshOnErr = false) => {
    inFlight.current += 1;
    statusSeq.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    let failed = false;
    actionQueue.current = actionQueue.current.then(async () => {
      try {
        await task();
      } catch (e) {
        failed = true;
        setError((e as Error).message);
      } finally {
        inFlight.current = Math.max(0, inFlight.current - 1);
        setBusy(inFlight.current > 0);
        if (failed && refreshOnErr && inFlight.current === 0) {
          void refresh(true);
        }
      }
    });
  };

  const runAction = (fn: () => Promise<MobileAdminStatus>, okMsg = '', syncDrafts = false) => {
    runQueued(async () => {
      const s = await fn();
      statusSeq.current += 1;
      applyStatus(s, syncDrafts);
      if (okMsg) setNotice(okMsg);
    }, true);
  };

  const patchMobile = (patch: MobileConfigPatch, okMsg = '', syncDrafts = false) => {
    setStatus((cur) => (cur ? {
      ...cur,
      config: {
        ...cur.config,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.lanEnabled !== undefined ? { lanEnabled: patch.lanEnabled } : {}),
        ...(patch.keepAwake !== undefined ? { keepAwake: patch.keepAwake } : {}),
        ...(patch.tunnelEnabled !== undefined ? { tunnelEnabled: patch.tunnelEnabled } : {}),
        ...(patch.tunnelMode !== undefined ? { tunnelMode: patch.tunnelMode } : {}),
        ...(patch.feishuEnabled !== undefined ? { feishuEnabled: patch.feishuEnabled } : {}),
        ...(patch.quietWhenDesktopActive !== undefined ? { quietWhenDesktopActive: patch.quietWhenDesktopActive } : {}),
      },
    } : cur));
    runAction(() => post<MobileAdminStatus>('/api/mobile/admin/config', patch), okMsg, syncDrafts);
  };

  const cfg = status?.config;
  const pair = status?.activePair ?? null;
  const qrList = pair?.qrUrls ?? [];
  const safeQrIdx = qrIdx < qrList.length ? qrIdx : 0;
  const selectedQr = qrList[safeQrIdx];
  const listenPort = status?.actualPort ?? cfg?.port ?? 47801;

  return (
    <div className="mobile-admin" data-testid="mobile-settings-section">
      <div className="mobile-admin-head">
        <h4>手机远程连接（Android / 浏览器）</h4>
        <span className={`mobile-admin-pill ${status?.listening ? 'is-on' : ''}`}>
          {!cfg ? '加载中…' : !cfg.enabled ? '未开启' : status?.listening ? `监听中 :${listenPort}` : '启动失败'}
        </span>
      </div>

      {cfg && (
        <>
          <div className="mobile-admin-card">
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="mobile-enable-toggle"
                checked={cfg.enabled}
                onChange={(e) => patchMobile({ enabled: e.target.checked })}
              />
              开启手机远程网关（独立端口 {listenPort}，每次访问强校验设备 Cookie）
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="mobile-lan-toggle"
                checked={cfg.lanEnabled}
                onChange={(e) => patchMobile({ lanEnabled: e.target.checked })}
              />
              允许同局域网 Wi-Fi 访问
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="mobile-keepawake-toggle"
                checked={cfg.keepAwake}
                onChange={(e) => patchMobile({ keepAwake: e.target.checked })}
              />
              手机网关开启期间阻止电脑自动休眠 {status?.powerAwake ? '（防睡眠已生效）' : ''}
            </label>
            {cfg.enabled && status && (
              <div className="mobile-admin-hint">
                {status.lanUrls.length > 0 ? `局域网入口：${status.lanUrls.join(' · ')}` : '当前仅本机 127.0.0.1 监听（出门可搭配下方 Cloudflare 隧道）'}
              </div>
            )}
          </div>

          <div className="mobile-admin-card">
            <div className="mobile-admin-card-title">
              <span>扫码配对新手机</span>
              <div className="mobile-admin-row">
                {pair && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void runAction(() => post<MobileAdminStatus>('/api/mobile/admin/pair/cancel', {}))}
                  >取消配对</button>
                )}
                <button
                  type="button"
                  data-testid="mobile-pair-start"
                  disabled={busy || !cfg.enabled}
                  onClick={() => {
                    setPairCode('');
                    setQrIdx(0);
                    void runAction(() => post<MobileAdminStatus>('/api/mobile/admin/pair/start', {}));
                  }}
                >{pair ? '刷新二维码' : '发起扫码配对'}</button>
              </div>
            </div>

            {!pair && (
              <div className="mobile-admin-hint">
                配对采用 3 分钟一次性二维码 + 手机端认领后桌面输入 6 位确认码（连续 3 次输错自动作废）。
              </div>
            )}

            {pair && selectedQr && (
              <div className="mobile-pair-wrap">
                <QrCodeSvg value={selectedQr.url} size={156} testId="mobile-pair-qr" />
                <div className="mobile-pair-meta">
                  {qrList.length > 1 && (
                    <div className="mobile-admin-tabs">
                      {qrList.map((item, idx) => (
                        <button
                          key={item.url}
                          type="button"
                          className={`mobile-admin-tab ${idx === safeQrIdx ? 'on' : ''}`}
                          onClick={() => setQrIdx(idx)}
                        >{item.label}</button>
                      ))}
                    </div>
                  )}
                  <code className="mobile-pair-url" data-testid="mobile-pair-url">{selectedQr.url}</code>
                  <div className="mobile-admin-row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void navigator.clipboard?.writeText(selectedQr.url).then(() => setNotice('配对链接已复制')).catch(() => {})}
                    >复制链接</button>
                    <span className="mobile-admin-hint">
                      {pair.status === 'waiting_scan'
                        ? '等待手机扫码打开…'
                        : `已认领（剩余 ${pair.attemptsLeft} 次校验机会）`}
                    </span>
                  </div>

                  {pair.status === 'claimed' && (
                    <div className="mobile-claim-box">
                      <div className="mobile-admin-card-title">
                        <span>设备：{pair.deviceName || 'Android 手机'}</span>
                        <span className="mobile-admin-hint">{pair.claimedIp}</span>
                      </div>
                      <div className="mobile-admin-row">
                        <input
                          data-testid="mobile-pair-code-input"
                          value={pairCode}
                          maxLength={6}
                          inputMode="numeric"
                          placeholder="输入手机显示的 6 位配对码"
                          onChange={(e) => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        />
                        <button
                          type="button"
                          className="primary"
                          data-testid="mobile-pair-approve"
                          disabled={busy || pairCode.trim().length !== 6}
                          onClick={() => void runAction(async () => {
                            const s = await post<MobileAdminStatus>('/api/mobile/admin/pair/approve', { code: pairCode.trim() });
                            setPairCode('');
                            return s;
                          }, '手机配对已放行')}
                        >确认放行</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="mobile-admin-card">
            <div className="mobile-admin-card-title">
              <span>已配对设备（{status.devices.length}）</span>
              {status.devices.length > 0 && (
                <button
                  type="button"
                  className="ghost"
                  data-testid="mobile-devices-revoke-all"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm('踢出全部已配对的手机？这些设备需要重新扫码配对才能再连接。')) return;
                    void runAction(() => post<MobileAdminStatus>('/api/mobile/admin/devices/revoke-all', {}), '已撤销全部设备');
                  }}
                >全部踢出</button>
              )}
            </div>
            <div className="mobile-device-list" data-testid="mobile-device-list">
              {status.devices.length === 0 ? (
                <div className="mobile-admin-hint">暂无已配对手机</div>
              ) : (
                status.devices.map((d) => (
                  <div key={d.id} className="mobile-device-item">
                    <span className={`mobile-device-dot ${d.online ? 'on' : ''}`} title={d.online ? '在线' : '离线'} />
                    <div className="mobile-device-info">
                      <span className="mobile-device-name">{d.name}</span>
                      <span className="mobile-device-sub">
                        {VIA_LABEL[d.via] ?? d.via} · {d.lastIp || '未知 IP'} · 最近活跃 {fmtClock(d.lastSeenAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      data-testid="mobile-device-revoke"
                      disabled={busy}
                      onClick={() => void runAction(() => delJson<MobileAdminStatus>(`/api/mobile/admin/devices/${encodeURIComponent(d.id)}`), `已撤销 ${d.name}`)}
                    >撤销</button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mobile-admin-card">
            <div className="mobile-admin-card-title">
              <span>出门公网（Cloudflare Tunnel / 外部 HTTPS）</span>
              <span className={`mobile-admin-pill ${status.tunnel.state === 'running' ? 'is-on' : status.tunnel.state === 'error' ? 'is-warn' : ''}`}>
                {status.tunnel.state === 'running'
                  ? `已连通（${status.tunnel.connectedEdges} 节点）`
                  : status.tunnel.state === 'starting'
                    ? '正在建链…'
                    : status.tunnel.state === 'error'
                      ? '隧道异常'
                      : '未启动'}
              </span>
            </div>
            <div className="mobile-admin-tabs">
              <button
                type="button"
                data-testid="mobile-tunnel-mode-quick"
                className={`mobile-admin-tab ${draftTunnelMode === 'quick' ? 'on' : ''}`}
                disabled={busy}
                onClick={() => setDraftTunnelMode('quick')}
              >免账号临时隧道（trycloudflare）</button>
              <button
                type="button"
                data-testid="mobile-tunnel-mode-named"
                className={`mobile-admin-tab ${draftTunnelMode === 'named' ? 'on' : ''}`}
                disabled={busy}
                onClick={() => setDraftTunnelMode('named')}
              >固定域名 / 外部 HTTPS</button>
            </div>

            {draftTunnelMode === 'quick' ? (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    data-testid="mobile-tunnel-toggle"
                    checked={cfg.tunnelMode === 'quick' && draftTunnelEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftTunnelEnabled(checked);
                      patchMobile({ tunnelMode: 'quick', tunnelEnabled: checked }, '', false);
                    }}
                  />
                  启动免注册临时公网隧道（每次重启生成新 https://*.trycloudflare.com 地址）
                </label>
                {status.tunnel.quickUrl && (
                  <div className="mobile-admin-row">
                    <code className="mobile-pair-url" data-testid="mobile-quick-url">{status.tunnel.quickUrl}</code>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void navigator.clipboard?.writeText(status.tunnel.quickUrl!).then(() => setNotice('临时隧道地址已复制')).catch(() => {})}
                    >复制地址</button>
                  </div>
                )}
              </>
            ) : (
              <>
                <label>
                  <span>公网访问域名 Origin（用于生成外网二维码与 Origin/Host 校验）</span>
                  <input
                    type="url"
                    data-testid="mobile-public-origin"
                    value={draftOrigin}
                    placeholder="https://shoal.example.com"
                    onChange={(e) => setDraftOrigin(e.target.value)}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    data-testid="mobile-tunnel-toggle"
                    checked={cfg.tunnelMode === 'named' && draftTunnelEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftTunnelEnabled(checked);
                      patchMobile({ tunnelMode: 'named', tunnelEnabled: checked }, '', false);
                    }}
                  />
                  随手机网关自动启动 cloudflared 隧道
                </label>
                <label>
                  <span>Tunnel Token <span className="opt">（通过环境变量注入子进程，留空保持现有凭据）</span></span>
                  <input
                    type="password"
                    data-testid="mobile-tunnel-token"
                    value={draftTunnelToken}
                    placeholder={cfg.hasTunnelToken ? '已保存 Tunnel Token（留空则保持不变）' : '粘贴 Token 或 cloudflared service install eyJ...'}
                    onChange={(e) => setDraftTunnelToken(e.target.value)}
                  />
                </label>
                <details>
                  <summary>可选第二道防线：Cloudflare Access 边缘 JWT 校验</summary>
                  <div className="mobile-admin-card" style={{ marginTop: '0.375rem' }}>
                    <label>
                      <span>Team Domain</span>
                      <input
                        data-testid="mobile-cf-domain"
                        value={draftCfDomain}
                        placeholder="your-team.cloudflareaccess.com"
                        onChange={(e) => setDraftCfDomain(e.target.value)}
                      />
                    </label>
                    <label>
                      <span>Application AUD</span>
                      <input
                        data-testid="mobile-cf-aud"
                        value={draftCfAud}
                        placeholder="填写 Cloudflare Access Application AUD"
                        onChange={(e) => setDraftCfAud(e.target.value)}
                      />
                    </label>
                  </div>
                </details>
                <div className="mobile-admin-row">
                  <button
                    type="button"
                    data-testid="mobile-tunnel-save"
                    disabled={busy}
                    onClick={() => {
                      const patch: MobileConfigPatch = {
                        tunnelMode: 'named',
                        publicOrigin: draftOrigin.trim(),
                        tunnelEnabled: cfg.tunnelMode === 'named' && draftTunnelEnabled,
                        cfAccessTeamDomain: draftCfDomain.trim(),
                        cfAccessAud: draftCfAud.trim(),
                      };
                      if (draftTunnelToken.trim()) patch.tunnelToken = draftTunnelToken.trim();
                      void runAction(async () => {
                        const s = await post<MobileAdminStatus>('/api/mobile/admin/config', patch);
                        setDraftTunnelToken('');
                        return s;
                      }, '公网隧道设置已保存', true);
                    }}
                  >保存隧道配置</button>
                  {cfg.hasTunnelToken && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm('清除已保存的 Tunnel Token？固定隧道会随之关闭，之后需要重新粘贴 Token 才能开启。')) return;
                        setDraftTunnelToken('');
                        patchMobile({ tunnelEnabled: false, tunnelToken: '' }, 'Tunnel Token 已清除', true);
                      }}
                    >清除 Token</button>
                  )}
                </div>
              </>
            )}
            <div className="mobile-admin-hint">
              {draftTunnelMode === 'quick'
                ? `无需账号与域名，自动转发至 127.0.0.1:${listenPort}（生成地址后上方二维码同步提供外网入口）`
                : `Zero Trust 后台 Public Hostname 请指向：http://127.0.0.1:${listenPort}`}
              {status.tunnel.binaryPath ? ' · 已检测到 cloudflared' : ' · 未检测到 cloudflared.exe，请先安装或加入 PATH'}
              {status.tunnel.lastError ? ` · 最近报错：${status.tunnel.lastError}` : ''}
            </div>
          </div>

          <div className="mobile-admin-card">
            <div className="mobile-admin-card-title">
              <span>锁屏提醒（飞书 / Discord / Slack / Telegram / Webhook）</span>
              <span className={`mobile-admin-pill ${cfg.feishuEnabled ? 'is-on' : ''}`}>
                {cfg.feishuEnabled ? '已启用' : '未启用'}
              </span>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="mobile-feishu-toggle"
                checked={draftFeishuEnabled}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setDraftFeishuEnabled(checked);
                  patchMobile({ feishuEnabled: checked }, '', false);
                }}
              />
              任务需要人工授权 / 额度耗尽 / 待验收时推送通知
            </label>
            <label>
              <span>推送 Webhook 地址</span>
              <input
                type="url"
                data-testid="mobile-feishu-webhook"
                value={draftFeishuWebhook}
                placeholder={cfg.feishuWebhookUrlMasked || '支持飞书、Discord、Slack、Telegram 或任意公网 HTTPS Webhook'}
                onChange={(e) => setDraftFeishuWebhook(e.target.value)}
              />
            </label>
            <label>
              <span>安全加签密钥（Secret） <span className="opt">（飞书加签或通用 HMAC-SHA256 签名；其他平台留空）</span></span>
              <input
                type="password"
                data-testid="mobile-feishu-secret"
                value={draftFeishuSecret}
                placeholder={cfg.hasFeishuSecret ? '已保存加签密钥（留空则保持不变）' : '可选，飞书开启加签或自建接收端校验时填写'}
                onChange={(e) => setDraftFeishuSecret(e.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                data-testid="mobile-feishu-quiet"
                checked={draftQuiet}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setDraftQuiet(checked);
                  patchMobile({ quietWhenDesktopActive: checked }, '', false);
                }}
              />
              最近 60 秒内桌面端有操作时静默推送
            </label>
            <div className="mobile-admin-row">
              <button
                type="button"
                data-testid="mobile-feishu-save"
                disabled={busy}
                onClick={() => {
                  const patch: MobileConfigPatch = {
                    feishuEnabled: draftFeishuEnabled,
                    quietWhenDesktopActive: draftQuiet,
                  };
                  if (draftFeishuWebhook.trim()) patch.feishuWebhookUrl = draftFeishuWebhook.trim();
                  if (draftFeishuSecret.trim()) patch.feishuSecret = draftFeishuSecret.trim();
                  void runAction(async () => {
                    const s = await post<MobileAdminStatus>('/api/mobile/admin/config', patch);
                    setDraftFeishuWebhook('');
                    setDraftFeishuSecret('');
                    return s;
                  }, '通知设置已保存', true);
                }}
              >保存通知设置</button>
              <button
                type="button"
                className="ghost"
                data-testid="mobile-feishu-test"
                disabled={busy}
                onClick={() => {
                  runQueued(async () => {
                    await post<{ ok: true }>('/api/mobile/admin/notify/test', {});
                    setNotice('测试通知已发送');
                  });
                }}
              >发送测试通知</button>
              {(cfg.feishuWebhookUrlMasked || cfg.hasFeishuSecret) && (
                <button
                  type="button"
                  className="ghost"
                  data-testid="mobile-feishu-clear"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm('清除飞书通知配置？Webhook 地址和签名密钥会被删除，手机将不再收到提醒。')) return;
                    setDraftFeishuWebhook('');
                    setDraftFeishuSecret('');
                    patchMobile({ feishuEnabled: false, feishuWebhookUrl: '', feishuSecret: '' }, '通知配置已清除', true);
                  }}
                >清除通知</button>
              )}
            </div>
          </div>
        </>
      )}

      {notice && <div className="mobile-admin-ok" data-testid="mobile-settings-notice">{notice}</div>}
      {error && <div className="form-error" data-testid="mobile-settings-error">{error}</div>}
    </div>
  );
}

function AgyOptimizeSection() {
  const [status, setStatus] = useState<AgyOptimizeStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getJson<AgyOptimizeStatus>('/api/agy/optimize').then(
      (s) => { if (alive) setStatus(s); },
      (e) => { if (alive) setError((e as Error).message); },
    );
    return () => { alive = false; };
  }, []);

  const doneCount = status
    ? [status.cliSettings.optimized, status.outputRule.optimized, status.fastToolsMcp.optimized].filter(Boolean).length
    : 0;
  const pillLabel = status?.optimized ? '已优化' : doneCount > 0 ? '部分启用' : '待优化';

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await post<AgyOptimizeStatus>('/api/agy/optimize', {});
      setStatus(next);
      setConfirming(false);
      setNotice('已完成一键优化（新开或重连的 agy 会话立即生效）');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const items = [
    { ok: status?.cliSettings.optimized ?? false, label: 'CLI 降噪与柔和配色（verbosity: low + tokyo night）' },
    { ok: status?.outputRule.optimized ?? false, label: '终端清爽排版与阶段心跳规则（防反引号碎块 / 加粗破损 / 链接刷屏）' },
    { ok: status?.fastToolsMcp.optimized ?? false, label: '零依赖 fast-tools 极速检索 MCP（告别 node -e 与 PowerShell 刷屏）' },
  ];

  return (
    <div className="mobile-admin-card" data-testid="agy-optimize-card" style={{ marginTop: '0.75rem' }}>
      <div className="mobile-admin-card-title">
        <span>Antigravity CLI 输出与排版优化</span>
        <span className={`mobile-admin-pill ${status?.optimized ? 'is-on' : ''}`} data-testid="agy-optimize-status">
          {pillLabel}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: '0.375rem 0' }}>
        {items.map((item) => (
          <div key={item.label} className="mobile-admin-hint" style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
            <span style={{ color: item.ok ? 'var(--ok, #74bbac)' : 'inherit', fontWeight: 600 }}>{item.ok ? '✓' : '○'}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {!confirming ? (
        <div className="mobile-admin-row">
          <button
            type="button"
            className={status?.optimized ? 'ghost' : 'primary'}
            data-testid="agy-optimize-btn"
            disabled={busy || !status}
            onClick={() => { setNotice(''); setError(''); setConfirming(true); }}
          >{status?.optimized ? '重新应用优化' : '一键优化'}</button>
        </div>
      ) : (
        <div className="mobile-claim-box" data-testid="agy-optimize-confirm-box">
          <div className="mobile-admin-hint">
            将自动备份原配置并无损写入 ~/.gemini 下的 CLI 设置、排版规则与 fast-tools MCP（保留已有模型、权限与其他 MCP；新开或重连会话生效）。
          </div>
          <div className="mobile-admin-row" style={{ justifyContent: 'flex-end', marginTop: '0.375rem' }}>
            <button
              type="button"
              className="ghost"
              data-testid="agy-optimize-cancel"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >取消</button>
            <button
              type="button"
              className="primary"
              data-testid="agy-optimize-confirm"
              disabled={busy}
              onClick={() => void apply()}
            >{busy ? '优化中…' : '确定'}</button>
          </div>
        </div>
      )}
      {notice && <div className="mobile-admin-ok" data-testid="agy-optimize-notice">{notice}</div>}
      {error && <div className="form-error" data-testid="agy-optimize-error">{error}</div>}
    </div>
  );
}

// Changes are saved at once; the checkbox follows the server's value (settings arrive over the WebSocket).
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Optimistic: a controlled checkbox that waits for the server's value snaps back on the click, so this one flips at once
  // and is re-synced from the settings that arrive over the WebSocket.
  const serverAutoDelegate = settings.autoDelegate !== false;
  const [autoDelegate, setAutoDelegate] = useState(serverAutoDelegate);
  useEffect(() => setAutoDelegate(serverAutoDelegate), [serverAutoDelegate]);
  const setAutoDelegateNow = (value: boolean) => {
    setAutoDelegate(value);
    setError('');
    post<Settings>('/api/settings', { autoDelegate: value }).catch((e) => {
      setError((e as Error).message);
      setAutoDelegate(serverAutoDelegate);
    });
  };

  // Rules text is edited locally and saved with the button; it resets whenever the server's value changes.
  const serverRules = settings.delegationRules ?? DEFAULT_DELEGATION_RULES;
  const [rules, setRules] = useState(serverRules);
  useEffect(() => setRules(serverRules), [serverRules]);
  const rulesLen = [...rules].length;
  const rulesTooLong = rulesLen > DELEGATION_RULES_MAX;

  const patchSettings = async (patch: Partial<Settings> | { delegationRules: null }) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await post<Settings>('/api/settings', patch);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeAgyDesc = AGY_MODELS.find((m) => m.slug === (settings.agyModel ?? ''))?.desc;

  return (
    <Modal title="设置" testId="settings-dialog" onClose={onClose} onSubmit={() => {}}>
      <div className="setting-row">
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="setting-ai-titles"
            checked={settings.aiTitles}
            onChange={(e) => void patchSettings({ aiTitles: e.target.checked })}
          />
          用 AI 自动起任务标题
        </label>
        <span className="help">
          <button type="button" className="help-btn" data-testid="setting-ai-titles-help" aria-label="说明" aria-describedby="tip-ai-titles">?</button>
          <span role="tooltip" id="tip-ai-titles" className="help-tip" data-testid="setting-ai-titles-tip">{AI_TITLES_TIP}</span>
        </span>
      </div>
      <div className="setting-row">
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="setting-auto-delegate"
            checked={autoDelegate}
            onChange={(e) => setAutoDelegateNow(e.target.checked)}
          />
          允许主 agent 主动委派
        </label>
        <span className="help">
          <button type="button" className="help-btn" data-testid="setting-auto-delegate-help" aria-label="说明" aria-describedby="tip-auto-delegate">?</button>
          <span role="tooltip" id="tip-auto-delegate" className="help-tip" data-testid="setting-auto-delegate-tip">{AUTO_DELEGATE_TIP}</span>
        </span>
      </div>
      <div className="delegation-rules">
        <label>
          <span>分工与评审规则</span>
          <textarea
            data-testid="setting-delegation-rules"
            rows={10}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
          />
        </label>
        <div className="delegation-rules-bar">
          <span className={`delegation-rules-count ${rulesTooLong ? 'over' : ''}`} data-testid="setting-delegation-rules-count">
            {rulesLen} / {DELEGATION_RULES_MAX}
          </span>
          <button
            type="button"
            className="ghost"
            data-testid="setting-delegation-rules-reset"
            disabled={busy || settings.delegationRules === undefined}
            onClick={() => void patchSettings({ delegationRules: null })}
          >
            恢复默认
          </button>
          <button
            type="button"
            className="primary"
            data-testid="setting-delegation-rules-save"
            disabled={busy || rulesTooLong || rules === serverRules}
            onClick={() => void patchSettings({ delegationRules: rules })}
          >
            保存
          </button>
        </div>
        <span className="field-hint">告诉每个会话哪类工作交给哪个 CLI、什么时候请另外两个 CLI 一起评审。只对之后新启动的会话生效；关闭「允许主 agent 主动委派」时不注入。</span>
      </div>
      <label>
        <span>Antigravity 默认模型档位</span>
        <select
          data-testid="setting-agy-model"
          value={settings.agyModel ?? ''}
          disabled={busy}
          onChange={(e) => void patchSettings({ agyModel: e.target.value })}
        >
          {AGY_MODELS.map((m) => (
            <option key={m.slug} value={m.slug}>{m.label}</option>
          ))}
        </select>
        {activeAgyDesc && <span className="field-hint">{activeAgyDesc}</span>}
      </label>
      <AgyOptimizeSection />
      <MobileSettingsSection />
      {error && <div className="form-error" data-testid="settings-error">{error}</div>}
      <div className="actions">
        <button type="button" data-testid="settings-close" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

export function ProjectDialog({ onClose, onCreated }: { onClose(): void; onCreated(p: Project): void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const pick = (dir: string) => {
    setPath(dir);
    if (!name.trim()) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
    setBrowsing(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: CreateProjectBody = { name: name.trim(), path: path.trim() };
      onCreated(await post<Project>('/api/projects', body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="新建项目" onClose={onClose} onSubmit={submit}>
      <label>名称<input data-testid="project-name" data-private="" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>路径
        <div className="path-row">
          <input data-testid="project-path" data-private="" value={path} placeholder="C:\Projects\my-app" onChange={(e) => setPath(e.target.value)} />
          <button type="button" data-testid="project-browse" onClick={() => setBrowsing((b) => !b)}>浏览…</button>
        </div>
      </label>
      {browsing && <DirBrowser start={path} onSelect={pick} />}
      {error && <div className="form-error" data-testid="project-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 创建</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="project-submit" disabled={busy} onClick={submit}>创建</button>
      </div>
    </Modal>
  );
}

export function TaskDialog({ projects, agents, defaultProjectId, defaultAgent, defaultAgyModel, size, onClose, onCreated }: {
  projects: Project[];
  agents: AgentKind[];
  defaultProjectId: string;
  defaultAgent(projectId: string): AgentKind;
  defaultAgyModel?: string;
  size: { cols: number; rows: number };
  onClose(): void;
  onCreated(r: { task: Task; session: SessionInfo }): void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<AgentKind>(() => defaultAgent(defaultProjectId));
  const [agyModel, setAgyModel] = useState<string>(defaultAgyModel ?? '');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: CreateTaskBody = {
        projectId,
        title: title.trim() || undefined,
        agent,
        ...(agent === 'agy' ? { model: agyModel } : {}),
        prompt: prompt.trim() || undefined,
        ...size,
      };
      onCreated(await post<{ task: Task; session: SessionInfo }>('/api/tasks', body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const agyDesc = agent === 'agy' ? AGY_MODELS.find((m) => m.slug === agyModel)?.desc : undefined;

  return (
    <Modal title="新建任务" onClose={onClose} onSubmit={submit}>
      <label>项目
        <select
          data-testid="task-project"
          data-private=""
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setAgent(defaultAgent(e.target.value));
          }}
        >
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label><span>标题 <span className="opt">可选</span></span>
        <input data-testid="task-title" value={title} placeholder="留空则用第一句需求作标题" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>Agent
        <select data-testid="task-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      {agent === 'agy' && (
        <label><span>模型档位 <span className="opt">Antigravity</span></span>
          <select data-testid="task-agy-model" value={agyModel} onChange={(e) => setAgyModel(e.target.value)}>
            {AGY_MODELS.map((m) => (
              <option key={m.slug} value={m.slug}>{m.label}</option>
            ))}
          </select>
          {agyDesc && <span className="field-hint">{agyDesc}</span>}
        </label>
      )}
      <label><span>需求 <span className="opt">可选，也可以启动后在终端里输入</span></span>
        <textarea data-testid="task-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {error && <div className="form-error" data-testid="task-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 创建</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="task-submit" disabled={busy} onClick={submit}>创建</button>
      </div>
    </Modal>
  );
}

export function SwitchDialog({ task, agents, onClose, onSwitch }: {
  task: Task;
  agents: AgentKind[];
  onClose(): void;
  onSwitch(agent: AgentKind, note: string): Promise<void>; // throws on failure
}) {
  const [agent, setAgent] = useState<AgentKind>(() => agents.find((a) => a !== task.agent) ?? agents[0] ?? task.agent);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSwitch(agent, note.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={<>换 agent：<span data-private="">{task.title}</span></>} testId="switch-dialog" onClose={onClose} onSubmit={submit}>
      <label>换成
        <select data-testid="switch-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <div className="hint">由 {AGENT_LABEL[agent]} 把当前进度整理成交接卡片，在这个面板里开新会话继续；原会话会被结束。</div>
      <label><span>补充说明 <span className="opt">可选</span></span>
        <textarea data-testid="switch-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="form-error" data-testid="switch-error">{error}</div>}
      {busy && <div className="hint" data-testid="switch-pending">正在整理交接卡片…</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 换</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="switch-submit" disabled={busy} onClick={submit}>换 agent</button>
      </div>
    </Modal>
  );
}

export function ForwardDialog({ source, card, sourceAgent, projects, tasks, agents, onClose, onForward }: {
  source: Task;
  card: Card;
  sourceAgent: AgentKind;
  projects: Project[];
  tasks: Task[];
  agents: AgentKind[];
  onClose(): void;
  onForward(to: ForwardBody['to'], note: string, replyBack: boolean): Promise<void>; // throws on failure
}) {
  const others = (projectId: string) =>
    tasks.filter((t) => t.projectId === projectId && t.id !== source.id && t.phase !== 'archived').sort((a, b) => a.createdAt - b.createdAt);
  const [target, setTarget] = useState(() => {
    const first = others(source.projectId)[0];
    return first ? `task:${first.id}` : `new:${source.projectId}`;
  });
  const [agent, setAgent] = useState<AgentKind>(() => (agents.includes(source.agent) ? source.agent : agents[0] ?? source.agent));
  const [note, setNote] = useState('');
  const [replyBack, setReplyBack] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = target.startsWith('new:');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const to: ForwardBody['to'] = isNew ? { projectId: target.slice(4), agent } : { taskId: target.slice(5) };
      await onForward(to, note.trim(), replyBack);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="转发这张卡片" testId="forward-dialog" onClose={onClose} onSubmit={submit}>
      <label>转发到
        <select data-testid="forward-target" data-private="" value={target} onChange={(e) => setTarget(e.target.value)}>
          {projects.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {others(p.id).map((t) => <option key={t.id} value={`task:${t.id}`}>{t.title}</option>)}
              <option value={`new:${p.id}`}>新建任务</option>
            </optgroup>
          ))}
        </select>
      </label>
      {isNew && (
        <label>Agent
          <select data-testid="forward-agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      )}
      <label><span>附言 <span className="opt">可选</span></span>
        <textarea data-testid="forward-note" rows={3} value={note} placeholder={FORWARD_NOTE} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          data-testid="forward-reply-back"
          checked={replyBack}
          onChange={(e) => setReplyBack(e.target.checked)}
        />
        <span>对方本轮完成后，自动把结果传回「<span data-private="">{source.title}</span>」</span>
      </label>
      <label>将发送的内容
        <pre className="preview" data-testid="forward-preview" data-private="">{forwardText({ title: source.title, agent: sourceAgent }, card.body, note, { replyBack })}</pre>
      </label>
      {error && <div className="form-error" data-testid="forward-error">{error}</div>}
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 转发</span>
        <button onClick={onClose}>取消</button>
        <button className="primary" data-testid="forward-submit" disabled={busy} onClick={submit}>转发</button>
      </div>
    </Modal>
  );
}

export function FeedbackDialog({ task, onClose, onFeedback }: {
  task: Task;
  onClose(): void;
  onFeedback(text: string): Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const blank = !text.trim();

  const submit = async () => {
    if (blank || busy) return;
    setBusy(true);
    const ok = await onFeedback(text);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal title={<>新会话继续：<span data-private="">{task.title}</span></>} testId="feedback-dialog" onClose={onClose} onSubmit={() => void submit()}>
      <div className="hint">在这个面板里开新会话继续（原会话会被结束），初始消息会带上任务需求、上一轮结果和你写的要求。要接着和当前会话对话，直接在终端里打字即可。</div>
      <label>接下来要做的事
        <textarea
          data-testid="feedback-input"
          rows={4}
          value={text}
          placeholder="写下接下来要做的事…"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="actions">
        <span className="actions-hint"><kbd>Ctrl</kbd><kbd>Enter</kbd> 开新会话</span>
        <button type="button" data-testid="feedback-cancel" onClick={onClose}>取消</button>
        <button type="button" className="primary" data-testid="feedback-new" disabled={blank || busy} onClick={() => void submit()}>开新会话</button>
      </div>
    </Modal>
  );
}
