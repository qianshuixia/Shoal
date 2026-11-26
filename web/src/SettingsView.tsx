import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentKind,
  AgyOptimizeStatus,
  CliScanResult,
  CliToolInfo,
  CustomCliConfig,
  MobileAdminStatus,
  MobileConfigPatch,
  MobileTunnelMode,
  PermissionMode,
  Settings,
  WindowCloseAction,
} from '../../shared/protocol.ts';
import { AGY_MODELS, DEFAULT_DELEGATION_RULES, DELEGATION_RULES_MAX, isValidCustomCliId, parseCliArgs } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { post } from './Dialogs.tsx';
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

const AUTO_DELEGATE_TIP = '启动 Claude Code、Codex、Antigravity 和 Pi Agent 会话时告诉它们可以用 shoal delegate 把任务派给其他 CLI。关闭后 shoal 命令仍然可用，但 agent 只在你明确要求时才会用。只对之后新启动的会话生效。';

const RICH_OUTPUT_HINTS_TIP = '启动新会话时附带 4 行轻量排版提示，告诉 CLI 对话视图支持 Mermaid 流程图、ECharts 数据图表、GitHub 提示卡片与数学公式，让模型在适合对比、趋势或架构说明时主动出图。关闭后不影响前端渲染，仅不再主动引导。只对之后新启动的会话生效。';

const AI_TITLES_TIP = [
  '开启后，任务的第一句需求发出时，工作台先用这句话的第一行当标题，同时在后台让支持 headless 的 CLI 做一次短调用，写一个更短、更概括的标题，通常十几秒内换上。',
  '· 会消耗少量额度：Claude 用 Haiku；Codex 用默认模型、最低推理档；Antigravity 为规避 headless 账号风控保持首行标题不额外调用。每个任务最多调用一次。',
  '· 这次调用不计入 Token 统计。',
  '· 你自己填写或改过的标题不会被替换；生成失败或超过 60 秒时保留第一行标题。',
  '· 只对开启之后发出第一句需求的任务生效，已有任务的标题不变。',
  '默认关闭。',
].join('\n');

const VIA_LABEL: Record<string, string> = { lan: '同 Wi-Fi', tunnel: 'Cloudflare', local: '本机' };

type SectionId = 'general' | 'clis' | 'agy' | 'mobile' | 'tunnel' | 'notify';
type DotTone = 'ok' | 'work' | 'warn' | 'off';

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

interface MobileNavSummary {
  gatewayTone: DotTone;
  tunnelTone: DotTone;
  notifyTone: DotTone;
}

function MobileSettingsSection({
  visible,
  onSummary,
}: {
  visible: boolean;
  onSummary: (summary: MobileNavSummary) => void;
}) {
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

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [visible, refresh]);

  const needPoll = visible && (Boolean(status?.activePair) || status?.tunnel.state === 'starting');
  useEffect(() => {
    if (!needPoll) return;
    const t = setInterval(() => void refresh(false), 1000);
    return () => clearInterval(t);
  }, [needPoll, refresh]);

  useEffect(() => {
    if (!status) return;
    const gatewayTone: DotTone = !status.config.enabled ? 'off' : status.listening ? 'ok' : 'warn';
    const tunnelTone: DotTone =
      status.tunnel.state === 'running'
        ? 'ok'
        : status.tunnel.state === 'starting' || status.tunnel.state === 'error'
          ? 'warn'
          : 'off';
    const notifyTone: DotTone = status.config.feishuEnabled ? 'work' : 'off';
    onSummary({ gatewayTone, tunnelTone, notifyTone });
  }, [status, onSummary]);

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
    <div className="settings-mobile-wrap" data-testid="mobile-settings-section">
      {/* Section: 手机远程连接 */}
      <div className="settings-group" id="sec-mobile">
        <div className="settings-group-head">
          <div>
            <h3>手机远程连接</h3>
            <p className="settings-group-desc">在手机浏览器（Android / iOS）上随时查看进度、授权或发送指令</p>
          </div>
          <span className={`mobile-admin-pill ${status?.listening ? 'is-on' : cfg?.enabled && !status?.listening ? 'is-warn' : ''}`}>
            {!cfg ? '加载中…' : !cfg.enabled ? '未开启' : status?.listening ? `监听中 :${listenPort}` : '启动失败'}
          </span>
        </div>

        {cfg && (
          <>
            <div className="settings-card">
              <label className="settings-item settings-toggle-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">开启手机远程网关</span>
                  <span className="settings-item-desc">独立端口 {listenPort}，每次访问强校验设备 Cookie，与桌面端操作隔离</span>
                </div>
                <input
                  type="checkbox"
                  className="switch-input"
                  data-testid="mobile-enable-toggle"
                  checked={cfg.enabled}
                  onChange={(e) => patchMobile({ enabled: e.target.checked })}
                />
              </label>

              <label className="settings-item settings-toggle-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">允许同局域网 Wi-Fi 访问</span>
                  <span className="settings-item-desc">同一局域网下的手机可直接通过局域网地址低延迟连接</span>
                </div>
                <input
                  type="checkbox"
                  className="switch-input"
                  data-testid="mobile-lan-toggle"
                  checked={cfg.lanEnabled}
                  onChange={(e) => patchMobile({ lanEnabled: e.target.checked })}
                />
              </label>

              <label className="settings-item settings-toggle-item">
                <div className="settings-item-info">
                  <span className="settings-item-title">
                    手机网关开启期间阻止电脑自动休眠
                    {status?.powerAwake && <span className="settings-inline-badge is-ok">防睡眠已生效</span>}
                  </span>
                  <span className="settings-item-desc">离开电脑时保持会话与网关在线，关闭网关或退出工作台后自动释放</span>
                </div>
                <input
                  type="checkbox"
                  className="switch-input"
                  data-testid="mobile-keepawake-toggle"
                  checked={cfg.keepAwake}
                  onChange={(e) => patchMobile({ keepAwake: e.target.checked })}
                />
              </label>

              {cfg.enabled && status && (
                <div className="settings-card-foot">
                  <span className="mobile-admin-hint">
                    {status.lanUrls.length > 0
                      ? `局域网入口：${status.lanUrls.join(' · ')}`
                      : '当前仅本机 127.0.0.1 监听（出门可搭配下方 Cloudflare 隧道）'}
                  </span>
                </div>
              )}
            </div>

            <div className={`settings-grid-2 ${pair ? 'has-pair' : ''}`}>
              <div className="settings-card settings-subcard">
                <div className="settings-subcard-head">
                  <span className="settings-subcard-title">扫码配对新手机</span>
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
                      className={pair ? '' : 'primary'}
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

                <div className="settings-subcard-body">
                  {!pair && (
                    <div className="mobile-admin-hint">
                      配对采用 3 分钟一次性二维码 + 手机端认领后桌面输入 6 位确认码（连续 3 次输错自动作废）。
                    </div>
                  )}

                  {pair && selectedQr && (
                    <div className="mobile-pair-wrap">
                      <div className="mobile-qr-frame">
                        <QrCodeSvg value={selectedQr.url} size={156} testId="mobile-pair-qr" />
                      </div>
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
              </div>

              <div className="settings-card settings-subcard">
                <div className="settings-subcard-head">
                  <span className="settings-subcard-title">
                    已配对设备
                    <span className="settings-count-chip">{status.devices.length}</span>
                  </span>
                  {status.devices.length > 0 && (
                    <button
                      type="button"
                      className="ghost danger-ghost"
                      data-testid="mobile-devices-revoke-all"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm('踢出全部已配对的手机？这些设备需要重新扫码配对才能再连接。')) return;
                        void runAction(() => post<MobileAdminStatus>('/api/mobile/admin/devices/revoke-all', {}), '已撤销全部设备');
                      }}
                    >全部踢出</button>
                  )}
                </div>

                <div className="settings-subcard-body">
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
              </div>
            </div>
          </>
        )}
      </div>

      {/* Section: 出门公网隧道 */}
      {cfg && status && (
        <div className="settings-group" id="sec-tunnel">
          <div className="settings-group-head">
            <div>
              <h3>出门公网隧道</h3>
              <p className="settings-group-desc">通过 Cloudflare Tunnel 或外部 HTTPS 网关在外网安全访问本机工作台</p>
            </div>
            <span className={`mobile-admin-pill ${status.tunnel.state === 'running' ? 'is-on' : status.tunnel.state === 'error' || status.tunnel.state === 'starting' ? 'is-warn' : ''}`}>
              {status.tunnel.state === 'running'
                ? `已连通（${status.tunnel.connectedEdges} 节点）`
                : status.tunnel.state === 'starting'
                  ? '正在建链…'
                  : status.tunnel.state === 'error'
                    ? '隧道异常'
                    : '未启动'}
            </span>
          </div>

          <div className="settings-card">
            <div className="settings-card-bar">
              <div className="mobile-admin-tabs" role="tablist" aria-label="隧道模式">
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
            </div>

            {draftTunnelMode === 'quick' ? (
              <>
                <label className="settings-item settings-toggle-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">启动免注册临时公网隧道</span>
                    <span className="settings-item-desc">每次重启生成新的 https://*.trycloudflare.com 临时地址，无需 Cloudflare 账号</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch-input"
                    data-testid="mobile-tunnel-toggle"
                    checked={cfg.tunnelMode === 'quick' && draftTunnelEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftTunnelEnabled(checked);
                      patchMobile({ tunnelMode: 'quick', tunnelEnabled: checked }, '', false);
                    }}
                  />
                </label>
                {status.tunnel.quickUrl && (
                  <div className="settings-form-pad">
                    <div className="mobile-admin-row">
                      <code className="mobile-pair-url" style={{ flex: 1 }} data-testid="mobile-quick-url">{status.tunnel.quickUrl}</code>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void navigator.clipboard?.writeText(status.tunnel.quickUrl!).then(() => setNotice('临时隧道地址已复制')).catch(() => {})}
                      >复制地址</button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="settings-item settings-toggle-item">
                  <div className="settings-item-info">
                    <span className="settings-item-title">随手机网关自动启动 cloudflared 隧道</span>
                    <span className="settings-item-desc">由工作台托管 Named Tunnel 进程，开启手机网关时自动拉起</span>
                  </div>
                  <input
                    type="checkbox"
                    className="switch-input"
                    data-testid="mobile-tunnel-toggle"
                    checked={cfg.tunnelMode === 'named' && draftTunnelEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftTunnelEnabled(checked);
                      patchMobile({ tunnelMode: 'named', tunnelEnabled: checked }, '', false);
                    }}
                  />
                </label>

                <div className="settings-form-pad">
                  <div className="settings-form-grid">
                    <label className="settings-field">
                      <span>公网访问域名 Origin <span className="opt">（用于生成外网二维码与 Origin/Host 校验）</span></span>
                      <input
                        type="url"
                        data-testid="mobile-public-origin"
                        value={draftOrigin}
                        placeholder="https://shoal.example.com"
                        onChange={(e) => setDraftOrigin(e.target.value)}
                      />
                    </label>
                    <label className="settings-field">
                      <span>Tunnel Token <span className="opt">（通过环境变量注入子进程，留空保持现有凭据）</span></span>
                      <input
                        type="password"
                        data-testid="mobile-tunnel-token"
                        value={draftTunnelToken}
                        placeholder={cfg.hasTunnelToken ? '已保存 Tunnel Token（留空则保持不变）' : '粘贴 Token 或 cloudflared service install eyJ...'}
                        onChange={(e) => setDraftTunnelToken(e.target.value)}
                      />
                    </label>
                  </div>

                  <details className="settings-details">
                    <summary>可选第二道防线：Cloudflare Access 边缘 JWT 校验</summary>
                    <div className="settings-details-body settings-form-grid">
                      <label className="settings-field">
                        <span>Team Domain</span>
                        <input
                          data-testid="mobile-cf-domain"
                          value={draftCfDomain}
                          placeholder="your-team.cloudflareaccess.com"
                          onChange={(e) => setDraftCfDomain(e.target.value)}
                        />
                      </label>
                      <label className="settings-field">
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
                      className="primary"
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
                        className="ghost danger-ghost"
                        disabled={busy}
                        onClick={() => {
                          if (!confirm('清除已保存的 Tunnel Token？固定隧道会随之关闭，之后需要重新粘贴 Token 才能开启。')) return;
                          setDraftTunnelToken('');
                          patchMobile({ tunnelEnabled: false, tunnelToken: '' }, 'Tunnel Token 已清除', true);
                        }}
                      >清除 Token</button>
                    )}
                  </div>
                </div>
              </>
            )}

            <div className="settings-card-foot settings-diag-foot">
              <span className="mobile-admin-hint">
                {draftTunnelMode === 'quick'
                  ? `自动转发至 127.0.0.1:${listenPort}（生成地址后上方二维码同步提供外网入口）`
                  : `Zero Trust 后台 Public Hostname 请指向 http://127.0.0.1:${listenPort}`}
              </span>
              <span className={`settings-inline-badge ${status.tunnel.binaryPath ? 'is-ok' : 'is-warn'}`}>
                {status.tunnel.binaryPath ? '已检测到 cloudflared' : '未检测到 cloudflared.exe'}
              </span>
              {status.tunnel.lastError && (
                <span className="form-error" style={{ flexBasis: '100%' }}>最近报错：{status.tunnel.lastError}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Section: 锁屏提醒 */}
      {cfg && (
        <div className="settings-group" id="sec-notify">
          <div className="settings-group-head">
            <div>
              <h3>锁屏提醒</h3>
              <p className="settings-group-desc">支持飞书、Discord、Slack、Telegram 或任意公网 HTTPS Webhook</p>
            </div>
            <span className={`mobile-admin-pill ${cfg.feishuEnabled ? 'is-on' : ''}`}>
              {cfg.feishuEnabled ? '已启用' : '未启用'}
            </span>
          </div>

          <div className="settings-card">
            <label className="settings-item settings-toggle-item">
              <div className="settings-item-info">
                <span className="settings-item-title">开启事件推送通知</span>
                <span className="settings-item-desc">任务需要人工授权、额度耗尽或进入待验收时自动推送提醒</span>
              </div>
              <input
                type="checkbox"
                className="switch-input"
                data-testid="mobile-feishu-toggle"
                checked={draftFeishuEnabled}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setDraftFeishuEnabled(checked);
                  patchMobile({ feishuEnabled: checked }, '', false);
                }}
              />
            </label>

            <div className="settings-form-pad">
              <div className="settings-form-grid">
                <label className="settings-field">
                  <span>推送 Webhook 地址</span>
                  <input
                    type="url"
                    data-testid="mobile-feishu-webhook"
                    value={draftFeishuWebhook}
                    placeholder={cfg.feishuWebhookUrlMasked || 'https://open.feishu.cn/open-apis/bot/v2/hook/...'}
                    onChange={(e) => setDraftFeishuWebhook(e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span>安全加签密钥（Secret） <span className="opt">（飞书加签或 HMAC-SHA256；其他平台留空）</span></span>
                  <input
                    type="password"
                    data-testid="mobile-feishu-secret"
                    value={draftFeishuSecret}
                    placeholder={cfg.hasFeishuSecret ? '已保存加签密钥（留空则保持不变）' : '可选，开启加签或自建接收端校验时填写'}
                    onChange={(e) => setDraftFeishuSecret(e.target.value)}
                  />
                </label>
              </div>
            </div>

            <label className="settings-item settings-toggle-item">
              <div className="settings-item-info">
                <span className="settings-item-title">桌面端活跃时静默推送</span>
                <span className="settings-item-desc">最近 60 秒内桌面端有操作时跳过提醒，避免重复打扰</span>
              </div>
              <input
                type="checkbox"
                className="switch-input"
                data-testid="mobile-feishu-quiet"
                checked={draftQuiet}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setDraftQuiet(checked);
                  patchMobile({ quietWhenDesktopActive: checked }, '', false);
                }}
              />
            </label>

            <div className="settings-card-foot settings-actions-foot">
              <div className="mobile-admin-row">
                <button
                  type="button"
                  className="primary"
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
                    className="ghost danger-ghost"
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
          </div>
        </div>
      )}

      {(notice || error) && (
        <div className="settings-feedback">
          {notice && <div className="mobile-admin-ok" data-testid="mobile-settings-notice">{notice}</div>}
          {error && <div className="form-error" data-testid="mobile-settings-error">{error}</div>}
        </div>
      )}
    </div>
  );
}

function AgyOptimizeSection({
  visible,
  onTone,
}: {
  visible: boolean;
  onTone: (tone: DotTone) => void;
}) {
  const [status, setStatus] = useState<AgyOptimizeStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    getJson<AgyOptimizeStatus>('/api/agy/optimize').then(
      (s) => {
        if (!alive) return;
        setStatus(s);
        onTone(s.optimized ? 'ok' : 'warn');
      },
      (e) => { if (alive) setError((e as Error).message); },
    );
    return () => { alive = false; };
  }, [visible, onTone]);

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
      onTone(next.optimized ? 'ok' : 'warn');
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
    <div className="settings-card settings-subcard" data-testid="agy-optimize-card">
      <div className="settings-subcard-head">
        <span className="settings-subcard-title">Antigravity CLI 输出与排版优化</span>
        <span className={`mobile-admin-pill ${status?.optimized ? 'is-on' : ''}`} data-testid="agy-optimize-status">
          {pillLabel}
        </span>
      </div>
      <div className="settings-subcard-body">
        <div className="agy-opt-list">
          {items.map((item) => (
            <div key={item.label} className={`agy-opt-item ${item.ok ? 'is-ok' : ''}`}>
              <span className="agy-opt-mark" aria-hidden="true">{item.ok ? '✓' : '○'}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>

        {!confirming ? (
          <div className="mobile-admin-row" style={{ marginTop: '0.25rem' }}>
            <button
              type="button"
              className={status?.optimized ? '' : 'primary'}
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
            <div className="mobile-admin-row" style={{ justifyContent: 'flex-end', marginTop: '0.25rem' }}>
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
    </div>
  );
}

function suggestSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32);
}

function CliToolsSection({
  visible,
  settings,
  cliTools,
  onClisUpdated,
}: {
  visible: boolean;
  settings: Settings;
  cliTools?: CliToolInfo[];
  onClisUpdated(agents: AgentKind[], cliTools: CliToolInfo[]): void;
}) {
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [scannedAt, setScannedAt] = useState<number | null>(null);

  // Inline custom CLI add / edit form state.
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftId, setDraftId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [draftCommand, setDraftCommand] = useState('');
  const [draftFullArgs, setDraftFullArgs] = useState('');
  const [draftNormalArgs, setDraftNormalArgs] = useState('');
  const [draftPromptArg, setDraftPromptArg] = useState<'positional' | 'none'>('positional');
  const [formError, setFormError] = useState('');
  const [formBusy, setFormBusy] = useState(false);

  const tools = cliTools ?? [];
  const primaryTools = tools.filter((t) => t.installed || t.source === 'custom');
  const missingBuiltins = tools.filter((t) => !t.installed && t.source === 'builtin');
  const enabledCount = tools.filter((t) => t.enabled && t.usable).length;

  useEffect(() => {
    if (!visible) return;
    if (cliTools && cliTools.length > 0) return;
    let alive = true;
    getJson<CliScanResult>('/api/clis').then(
      (res) => {
        if (!alive) return;
        setScannedAt(res.scannedAt);
        onClisUpdated(res.agents, res.cliTools);
      },
      () => {},
    );
    return () => { alive = false; };
  }, [visible, cliTools, onClisUpdated]);

  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    setError('');
    setNotice('');
    try {
      const res = await post<CliScanResult>('/api/clis/scan', {});
      setScannedAt(res.scannedAt);
      onClisUpdated(res.agents, res.cliTools);
      const found = res.cliTools.filter((t) => t.installed).length;
      setNotice(`扫描完成：共检测到 ${found} 个已安装 CLI（当前已启用 ${res.cliTools.filter((t) => t.enabled && t.usable).length} 个）`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const updatePref = async (id: string, patch: { enabled?: boolean; permissionMode?: PermissionMode }) => {
    if (busyId) return;
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await post<Settings>('/api/settings', { cliPrefs: { [id]: patch } });
      const res = await getJson<CliScanResult>('/api/clis');
      onClisUpdated(res.agents, res.cliTools);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const openAddForm = () => {
    setEditingId(null);
    setDraftLabel('');
    setDraftId('');
    setIdTouched(false);
    setDraftCommand('');
    setDraftFullArgs('');
    setDraftNormalArgs('');
    setDraftPromptArg('positional');
    setFormError('');
    setFormOpen(true);
  };

  const openEditForm = (custom: CustomCliConfig) => {
    setEditingId(custom.id);
    setDraftLabel(custom.label);
    setDraftId(custom.id);
    setIdTouched(true);
    setDraftCommand(custom.command);
    setDraftFullArgs((custom.fullAccessArgs ?? []).join(' '));
    setDraftNormalArgs((custom.normalArgs ?? []).join(' '));
    setDraftPromptArg(custom.promptArg ?? 'positional');
    setFormError('');
    setFormOpen(true);
  };

  const saveCustom = async () => {
    if (formBusy) return;
    const label = draftLabel.trim();
    const id = (editingId ?? draftId).trim().toLowerCase();
    const command = draftCommand.trim();
    if (!label) { setFormError('请填写 CLI 显示名称'); return; }
    if (!isValidCustomCliId(id)) {
      setFormError('标识须以小写字母开头（仅限 a-z、0-9、-、_，最多 32 位）且不能与内置 CLI 重名');
      return;
    }
    if (!command) { setFormError('请填写启动命令名或可执行文件绝对路径'); return; }

    const entry: CustomCliConfig = {
      id,
      label,
      command,
      fullAccessArgs: parseCliArgs(draftFullArgs),
      normalArgs: parseCliArgs(draftNormalArgs),
      promptArg: draftPromptArg,
    };
    const existing = settings.customClis ?? [];
    if (!editingId && existing.some((c) => c.id === id)) {
      setFormError(`标识「${id}」已存在，请换一个标识`);
      return;
    }
    const nextList = editingId
      ? existing.map((c) => (c.id === editingId ? entry : c))
      : [...existing, entry];

    setFormBusy(true);
    setFormError('');
    setError('');
    setNotice('');
    try {
      await post<Settings>('/api/settings', { customClis: nextList });
      const res = await getJson<CliScanResult>('/api/clis');
      onClisUpdated(res.agents, res.cliTools);
      setFormOpen(false);
      setNotice(editingId ? `已更新自定义 CLI「${label}」` : `已添加自定义 CLI「${label}」`);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setFormBusy(false);
    }
  };

  const removeCustom = async (tool: CliToolInfo) => {
    if (busyId) return;
    if (!confirm(`删除自定义 CLI「${tool.label}」？已有历史任务不会删除，但之后无法再用它新建任务。`)) return;
    setBusyId(tool.id);
    setError('');
    setNotice('');
    try {
      const nextList = (settings.customClis ?? []).filter((c) => c.id !== tool.id);
      await post<Settings>('/api/settings', { customClis: nextList });
      const res = await getJson<CliScanResult>('/api/clis');
      onClisUpdated(res.agents, res.cliTools);
      setNotice(`已删除自定义 CLI「${tool.label}」`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const customById = new Map((settings.customClis ?? []).map((c) => [c.id, c]));

  return (
    <div className="settings-group" id="sec-clis" data-testid="cli-tools-section">
      <div className="settings-group-head">
        <div>
          <h3>CLI 工具与权限</h3>
          <p className="settings-group-desc">
            扫描本机已安装的 AI 编程 CLI，勾选启用项并为每个 CLI 独立选择「全部放开」或「正常模式」
          </p>
        </div>
        <div className="mobile-admin-row">
          <button
            type="button"
            className="ghost"
            data-testid="cli-add-btn"
            onClick={() => (formOpen && !editingId ? setFormOpen(false) : openAddForm())}
          >+ 添加自定义 CLI</button>
          <button
            type="button"
            className="primary"
            data-testid="cli-scan-btn"
            disabled={scanning}
            onClick={() => void runScan()}
          >{scanning ? '扫描中…' : '扫描本机 CLI'}</button>
        </div>
      </div>

      <div className="settings-card cli-tier-banner">
        <div className="cli-tier-row">
          <span className="cli-tier-badge tier-deep">深度适配</span>
          <span>Claude Code / Codex / Antigravity / Pi Agent：支持 Hooks 状态感知、待验收结果卡片、自动续接、Token 与额度统计、跨 CLI 委派。</span>
        </div>
        <div className="cli-tier-row">
          <span className="cli-tier-badge tier-generic">通用终端</span>
          <span>其余扫描到的 AI CLI 与自定义 CLI：支持原生终端交互、任务管理与权限模式切换；暂不支持自动状态感知、结果卡片、自动续接与 Token 统计。</span>
        </div>
        <div className="cli-tier-foot">
          默认全部以「全部放开」启动，修改后对新启动或续接的会话生效；跨 CLI 委派时，子 agent 自动继承主 agent 当前的权限模式。
          {scannedAt && ` · 上次扫描 ${fmtClock(scannedAt)}`}
        </div>
      </div>

      {formOpen && (
        <div className="settings-card cli-custom-form" data-testid="cli-custom-form">
          <div className="settings-subcard-head">
            <span className="settings-subcard-title">{editingId ? `编辑自定义 CLI（${editingId}）` : '添加自定义 CLI'}</span>
            <span className="cli-tier-badge tier-generic">通用终端</span>
          </div>
          <div className="settings-subcard-body">
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>显示名称</span>
                <input
                  data-testid="cli-custom-label"
                  value={draftLabel}
                  placeholder="例如：My Code CLI"
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraftLabel(v);
                    if (!editingId && !idTouched) setDraftId(suggestSlug(v));
                  }}
                />
              </label>
              <label className="settings-field">
                <span>唯一标识 ID <span className="opt">（小写字母/数字/-/_）</span></span>
                <input
                  data-testid="cli-custom-id"
                  value={draftId}
                  disabled={Boolean(editingId)}
                  placeholder="例如：my-cli"
                  onChange={(e) => { setIdTouched(true); setDraftId(e.target.value); }}
                />
              </label>
              <label className="settings-field">
                <span>命令名或可执行路径</span>
                <input
                  data-testid="cli-custom-command"
                  value={draftCommand}
                  placeholder="例如：aider 或 C:\Tools\my-cli.exe"
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraftCommand(v);
                    if (!editingId && !idTouched && !draftLabel.trim()) setDraftId(suggestSlug(v));
                  }}
                />
              </label>
              <label className="settings-field">
                <span>初始需求传递方式</span>
                <select
                  data-testid="cli-custom-prompt-arg"
                  value={draftPromptArg}
                  onChange={(e) => setDraftPromptArg(e.target.value === 'none' ? 'none' : 'positional')}
                >
                  <option value="positional">位置参数（启动命令末尾传入需求）</option>
                  <option value="none">不传命令行参数（启动后在终端内输入）</option>
                </select>
              </label>
              <label className="settings-field">
                <span>全放开权限参数 <span className="opt">（空格分隔，可选）</span></span>
                <input
                  data-testid="cli-custom-full-args"
                  value={draftFullArgs}
                  placeholder="例如：--yolo 或 --yes-always"
                  onChange={(e) => setDraftFullArgs(e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>正常模式附加参数 <span className="opt">（空格分隔，可选）</span></span>
                <input
                  data-testid="cli-custom-normal-args"
                  value={draftNormalArgs}
                  placeholder="留空则直接按命令默认启动"
                  onChange={(e) => setDraftNormalArgs(e.target.value)}
                />
              </label>
            </div>
            {formError && <div className="form-error" data-testid="cli-custom-error">{formError}</div>}
            <div className="mobile-admin-row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="ghost" data-testid="cli-custom-cancel" disabled={formBusy} onClick={() => setFormOpen(false)}>取消</button>
              <button type="button" className="primary" data-testid="cli-custom-save" disabled={formBusy} onClick={() => void saveCustom()}>
                {formBusy ? '保存中…' : editingId ? '保存修改' : '添加并启用'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-card cli-list" data-testid="cli-tools-list">
        {primaryTools.length === 0 ? (
          <div className="settings-item">
            <span className="mobile-admin-hint">未检测到已安装的 CLI 工具，请点击上方「扫描本机 CLI」或手动添加自定义 CLI。</span>
          </div>
        ) : (
          primaryTools.map((tool) => {
            const isBusy = busyId === tool.id;
            const customCfg = customById.get(tool.id);
            const activeArgs = tool.permissionMode === 'full' ? tool.fullAccessArgs : tool.normalArgs;
            return (
              <div key={tool.id} className={`cli-row ${!tool.enabled || !tool.usable ? 'is-dim' : ''}`} data-testid={`cli-row-${tool.id}`}>
                <div className="cli-row-main">
                  <div className="cli-row-head">
                    <AgentIcon agent={tool.id} />
                    <span className="cli-row-name">{tool.label}</span>
                    <span className={`cli-tier-badge ${tool.tier === 'deep' ? 'tier-deep' : 'tier-generic'}`}>
                      {tool.tier === 'deep' ? '深度适配' : '通用终端'}
                    </span>
                    {tool.source === 'custom' && <span className="settings-inline-badge">自定义</span>}
                    {tool.version && <span className="settings-inline-badge">v{tool.version}</span>}
                    {!tool.usable && <span className="settings-inline-badge is-warn">{tool.installed ? '不可用' : '未找到'}</span>}
                  </div>
                  <div className="cli-row-meta">
                    {tool.path ? (
                      <code className="cli-path-code" data-private="" title={tool.path}>{tool.path}</code>
                    ) : (
                      <span className="cli-warn-text">{tool.unusableReason ?? `未检测到命令 ${tool.command}`}</span>
                    )}
                    {tool.usable && (
                      <span className="cli-mode-note">
                        {tool.permissionMode === 'full'
                          ? (activeArgs.length > 0
                            ? <>全放开：<code className="cli-flag-code">{activeArgs.join(' ')}</code></>
                            : (tool.fullAccessNote ?? '无额外免确认参数'))
                          : (activeArgs.length > 0
                            ? <>正常模式：<code className="cli-flag-code">{activeArgs.join(' ')}</code></>
                            : (tool.id === 'agy' && tool.fullAccessNote ? tool.fullAccessNote : '正常模式：按 CLI 默认权限确认'))}
                      </span>
                    )}
                    {tool.unusableReason && tool.path && <span className="cli-warn-text">{tool.unusableReason}</span>}
                  </div>
                </div>

                <div className="cli-row-ctrl">
                  <div className="cli-perm-seg" role="group" aria-label={`${tool.label} 权限模式`} data-testid={`cli-perm-${tool.id}`}>
                    <button
                      type="button"
                      className={`cli-perm-btn ${tool.permissionMode === 'full' ? 'on is-full' : ''}`}
                      data-testid={`cli-perm-full-${tool.id}`}
                      disabled={isBusy}
                      title={tool.fullAccessArgs.length ? `启动时附加 ${tool.fullAccessArgs.join(' ')}` : (tool.fullAccessNote ?? '全部放开权限模式')}
                      onClick={() => tool.permissionMode !== 'full' && void updatePref(tool.id, { permissionMode: 'full' })}
                    >全部放开</button>
                    <button
                      type="button"
                      className={`cli-perm-btn ${tool.permissionMode === 'normal' ? 'on is-normal' : ''}`}
                      data-testid={`cli-perm-normal-${tool.id}`}
                      disabled={isBusy}
                      title="正常模式：不跳过 CLI 权限确认与沙箱"
                      onClick={() => tool.permissionMode !== 'normal' && void updatePref(tool.id, { permissionMode: 'normal' })}
                    >正常模式</button>
                  </div>

                  {customCfg && (
                    <div className="cli-custom-actions">
                      <button type="button" className="ghost" data-testid={`cli-custom-edit-${tool.id}`} disabled={isBusy} onClick={() => openEditForm(customCfg)}>编辑</button>
                      <button type="button" className="ghost danger-ghost" data-testid={`cli-custom-delete-${tool.id}`} disabled={isBusy} onClick={() => void removeCustom(tool)}>删除</button>
                    </div>
                  )}

                  <input
                    type="checkbox"
                    className="switch-input"
                    aria-label={`启用 ${tool.label}`}
                    data-testid={`cli-enable-${tool.id}`}
                    checked={tool.enabled}
                    disabled={isBusy || !tool.usable}
                    onChange={(e) => void updatePref(tool.id, { enabled: e.target.checked })}
                  />
                </div>
              </div>
            );
          })
        )}

        {enabledCount === 0 && primaryTools.length > 0 && (
          <div className="settings-card-foot">
            <span className="form-error">当前未启用任何 CLI，请至少开启一个以创建任务。</span>
          </div>
        )}
      </div>

      {missingBuiltins.length > 0 && (
        <details className="settings-details" data-testid="cli-missing-details">
          <summary>未检测到的内置支持 CLI（{missingBuiltins.length}）</summary>
          <div className="cli-missing-grid">
            {missingBuiltins.map((tool) => (
              <div key={tool.id} className="cli-missing-item">
                <span className="cli-missing-name">{tool.label}</span>
                <code className="cli-flag-code">{tool.command}</code>
                <span className={`cli-tier-badge ${tool.tier === 'deep' ? 'tier-deep' : 'tier-generic'}`}>
                  {tool.tier === 'deep' ? '深度适配' : '通用终端'}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {notice && <div className="mobile-admin-ok" data-testid="cli-settings-notice">{notice}</div>}
      {error && <div className="form-error" data-testid="cli-settings-error">{error}</div>}
    </div>
  );
}

const NAV_ITEMS: { id: SectionId; label: string }[] = [
  { id: 'general', label: '常规与协作' },
  { id: 'clis', label: 'CLI 工具与权限' },
  { id: 'agy', label: 'Antigravity CLI' },
  { id: 'mobile', label: '手机远程连接' },
  { id: 'tunnel', label: '出门公网隧道' },
  { id: 'notify', label: '锁屏提醒' },
];

function NavIcon({ id }: { id: SectionId }) {
  if (id === 'agy') return <AgentIcon agent="agy" />;
  if (id === 'clis') {
    return (
      <svg className="settings-nav-ico" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.75" />
        <path d="M4.5 6.25 6.75 8 4.5 9.75M8.25 10h3" />
      </svg>
    );
  }
  if (id === 'general') {
    return (
      <svg className="settings-nav-ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2.5M7.5 11.5H14" />
        <circle cx="10" cy="4.5" r="1.5" />
        <circle cx="6" cy="11.5" r="1.5" />
      </svg>
    );
  }
  if (id === 'mobile') {
    return (
      <svg className="settings-nav-ico" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.5" />
        <path d="M7 12h2" />
      </svg>
    );
  }
  if (id === 'tunnel') {
    return (
      <svg className="settings-nav-ico" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.75" />
        <path d="M2.5 8h11M8 2.25c1.6 1.7 2.25 3.65 2.25 5.75S9.6 12.05 8 13.75C6.4 12.05 5.75 10.1 5.75 8S6.4 3.95 8 2.25Z" />
      </svg>
    );
  }
  return (
    <svg className="settings-nav-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.25 6.75a3.75 3.75 0 0 1 7.5 0c0 2.75 1 3.75 1.5 4.25H2.75c.5-.5 1.5-1.5 1.5-4.25Z" />
      <path d="M6.75 13a1.25 1.25 0 0 0 2.5 0" />
    </svg>
  );
}

export function SettingsView({
  visible,
  settings,
  cliTools,
  onClisUpdated,
}: {
  visible: boolean;
  settings: Settings;
  cliTools?: CliToolInfo[];
  onClisUpdated(agents: AgentKind[], cliTools: CliToolInfo[]): void;
}) {
  const pageRef = useRef<HTMLElement>(null);
  const [activeSec, setActiveSec] = useState<SectionId>('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rulesSavedNotice, setRulesSavedNotice] = useState(false);

  const [agyTone, setAgyTone] = useState<DotTone>('off');
  const [mobileSummary, setMobileSummary] = useState<MobileNavSummary>({
    gatewayTone: 'off',
    tunnelTone: 'off',
    notifyTone: 'off',
  });

  const serverCloseAction: WindowCloseAction = settings.closeAction === 'quit' ? 'quit' : 'tray';
  const [closeAction, setCloseAction] = useState<WindowCloseAction>(serverCloseAction);
  const closeActionSeq = useRef(0);
  useEffect(() => setCloseAction(serverCloseAction), [serverCloseAction]);
  const setCloseActionNow = (value: WindowCloseAction) => {
    if (value === closeAction) return;
    const seq = ++closeActionSeq.current;
    setCloseAction(value);
    setError('');
    post<Settings>('/api/settings', { closeAction: value }).catch((e) => {
      if (closeActionSeq.current !== seq) return;
      setError((e as Error).message);
      setCloseAction(serverCloseAction);
    });
  };

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

  const serverRichOutputHints = settings.richOutputHints !== false;
  const [richOutputHints, setRichOutputHints] = useState(serverRichOutputHints);
  useEffect(() => setRichOutputHints(serverRichOutputHints), [serverRichOutputHints]);
  const setRichOutputHintsNow = (value: boolean) => {
    setRichOutputHints(value);
    setError('');
    post<Settings>('/api/settings', { richOutputHints: value }).catch((e) => {
      setError((e as Error).message);
      setRichOutputHints(serverRichOutputHints);
    });
  };

  // Rules text is edited locally and saved with the button; it resets whenever the server's value changes.
  const serverRules = settings.delegationRules ?? DEFAULT_DELEGATION_RULES;
  const [rules, setRules] = useState(serverRules);
  useEffect(() => setRules(serverRules), [serverRules]);
  const rulesLen = [...rules].length;
  const rulesTooLong = rulesLen > DELEGATION_RULES_MAX;
  const rulesDirty = rules !== serverRules;

  const patchSettings = async (patch: Partial<Settings> | { delegationRules: null }, markSaved = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await post<Settings>('/api/settings', patch);
      if (markSaved) {
        setRulesSavedNotice(true);
        setTimeout(() => setRulesSavedNotice(false), 2500);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeAgyDesc = AGY_MODELS.find((m) => m.slug === (settings.agyModel ?? ''))?.desc;

  const scrollToSection = (id: SectionId) => {
    setActiveSec(id);
    const el = pageRef.current?.querySelector<HTMLElement>(`#sec-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!visible) return;
    const scroller = pageRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) {
        setActiveSec('notify');
        return;
      }
      const top = scroller.getBoundingClientRect().top + 140;
      let current: SectionId = 'general';
      for (const item of NAV_ITEMS) {
        const el = scroller.querySelector<HTMLElement>(`#sec-${item.id}`);
        if (el && el.getBoundingClientRect().top <= top) current = item.id;
      }
      setActiveSec(current);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [visible]);

  const toneFor = (id: SectionId): DotTone | null => {
    if (id === 'agy') return agyTone;
    if (id === 'mobile') return mobileSummary.gatewayTone;
    if (id === 'tunnel') return mobileSummary.tunnelTone;
    if (id === 'notify') return mobileSummary.notifyTone;
    return null;
  };

  return (
    <section className="settings-page" ref={pageRef} data-testid="settings-view" hidden={!visible}>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="设置分类">
          <div className="settings-nav-head">
            <h2>设置</h2>
            <p>工作台、CLI 与手机远程配置</p>
          </div>
          <div className="settings-nav-list">
            {NAV_ITEMS.map((item) => {
              const tone = toneFor(item.id);
              const enabledClis = item.id === 'clis' && cliTools ? cliTools.filter((t) => t.enabled && t.usable).length : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item ${activeSec === item.id ? 'on' : ''}`}
                  data-testid={`settings-nav-${item.id}`}
                  onClick={() => scrollToSection(item.id)}
                >
                  <NavIcon id={item.id} />
                  <span className="settings-nav-label">{item.label}</span>
                  {enabledClis !== null && <span className="settings-count-chip">{enabledClis}</span>}
                  {tone && tone !== 'off' && <span className={`settings-nav-dot tone-${tone}`} />}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="settings-content">
          {error && <div className="form-error settings-top-error" data-testid="settings-error">{error}</div>}

          {/* Section 1: 常规与协作 */}
          <div className="settings-group" id="sec-general">
            <div className="settings-group-head">
              <div>
                <h3>常规与协作</h3>
                <p className="settings-group-desc">窗口关闭行为、任务标题自动概括、多 CLI 委派开关及注入给会话的分工与评审规则</p>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-item">
                <div className="settings-item-info">
                  <div className="settings-item-title">关闭主窗口时</div>
                  <span className="settings-item-desc">点击桌面窗口关闭按钮时的动作；缩小到托盘后可从系统托盘（macOS 也可从菜单栏或 Dock）点击恢复，或右键选择退出</span>
                </div>
                <div className="cli-perm-seg" role="group" aria-label="关闭主窗口时" data-testid="setting-close-action">
                  <button
                    type="button"
                    className={`cli-perm-btn ${closeAction === 'tray' ? 'on is-full' : ''}`}
                    aria-pressed={closeAction === 'tray'}
                    data-testid="setting-close-action-tray"
                    onClick={() => setCloseActionNow('tray')}
                  >缩小到托盘</button>
                  <button
                    type="button"
                    className={`cli-perm-btn ${closeAction === 'quit' ? 'on is-normal' : ''}`}
                    aria-pressed={closeAction === 'quit'}
                    data-testid="setting-close-action-quit"
                    onClick={() => setCloseActionNow('quit')}
                  >直接退出</button>
                </div>
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <div className="settings-item-title setting-row">
                    <label htmlFor="setting-ai-titles-input" className="settings-item-label">用 AI 自动起任务标题</label>
                    <span className="help">
                      <button type="button" className="help-btn" data-testid="setting-ai-titles-help" aria-label="说明" aria-describedby="tip-ai-titles">?</button>
                      <span role="tooltip" id="tip-ai-titles" className="help-tip" data-testid="setting-ai-titles-tip">{AI_TITLES_TIP}</span>
                    </span>
                  </div>
                  <span className="settings-item-desc">首句需求发出后在后台调用短模型概括标题，手动修改过的标题不会被覆盖</span>
                </div>
                <input
                  id="setting-ai-titles-input"
                  type="checkbox"
                  className="switch-input"
                  data-testid="setting-ai-titles"
                  checked={settings.aiTitles}
                  onChange={(e) => void patchSettings({ aiTitles: e.target.checked })}
                />
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <div className="settings-item-title setting-row">
                    <label htmlFor="setting-auto-delegate-input" className="settings-item-label">允许主 agent 主动委派</label>
                    <span className="help">
                      <button type="button" className="help-btn" data-testid="setting-auto-delegate-help" aria-label="说明" aria-describedby="tip-auto-delegate">?</button>
                      <span role="tooltip" id="tip-auto-delegate" className="help-tip" data-testid="setting-auto-delegate-tip">{AUTO_DELEGATE_TIP}</span>
                    </span>
                  </div>
                  <span className="settings-item-desc">启动会话时告知可使用 shoal delegate 跨 CLI 委派，并注入下方分工与评审规则</span>
                </div>
                <input
                  id="setting-auto-delegate-input"
                  type="checkbox"
                  className="switch-input"
                  data-testid="setting-auto-delegate"
                  checked={autoDelegate}
                  onChange={(e) => setAutoDelegateNow(e.target.checked)}
                />
              </div>

              <div className="settings-item">
                <div className="settings-item-info">
                  <div className="settings-item-title setting-row">
                    <label htmlFor="setting-rich-output-hints-input" className="settings-item-label">引导 AI 输出图表与提示卡片</label>
                    <span className="help">
                      <button type="button" className="help-btn" data-testid="setting-rich-output-hints-help" aria-label="说明" aria-describedby="tip-rich-output-hints">?</button>
                      <span role="tooltip" id="tip-rich-output-hints" className="help-tip" data-testid="setting-rich-output-hints-tip">{RICH_OUTPUT_HINTS_TIP}</span>
                    </span>
                  </div>
                  <span className="settings-item-desc">启动新会话时告知支持 Mermaid 流程图、ECharts 数据图、GitHub 提示卡片与数学公式</span>
                </div>
                <input
                  id="setting-rich-output-hints-input"
                  type="checkbox"
                  className="switch-input"
                  data-testid="setting-rich-output-hints"
                  checked={richOutputHints}
                  onChange={(e) => setRichOutputHintsNow(e.target.checked)}
                />
              </div>
            </div>

            <div className="settings-card settings-subcard delegation-rules">
              <div className="settings-subcard-head">
                <div className="settings-subcard-title-row">
                  <label htmlFor="setting-delegation-rules-input" className="settings-subcard-title">分工与评审规则</label>
                  {!autoDelegate && <span className="settings-inline-badge is-warn">当前未注入</span>}
                  {settings.delegationRules !== undefined && <span className="settings-inline-badge">已自定义</span>}
                  {rulesDirty && <span className="settings-inline-badge is-warn">未保存</span>}
                  {rulesSavedNotice && !rulesDirty && <span className="settings-inline-badge is-ok">已保存</span>}
                </div>
                <span className={`delegation-rules-count ${rulesTooLong ? 'over' : ''}`} data-testid="setting-delegation-rules-count">
                  {rulesLen} / {DELEGATION_RULES_MAX}
                </span>
              </div>
              <div className="settings-subcard-body">
                <textarea
                  id="setting-delegation-rules-input"
                  data-testid="setting-delegation-rules"
                  rows={11}
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                />
              </div>
              <div className="settings-card-foot settings-rules-foot">
                <span className="field-hint">
                  告诉每个会话哪类工作交给哪个 CLI、什么时候请另外两个 CLI 一起评审。只对之后新启动的会话生效；关闭「允许主 agent 主动委派」时不注入。
                </span>
                <div className="delegation-rules-bar">
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
                    disabled={busy || rulesTooLong || !rulesDirty}
                    onClick={() => void patchSettings({ delegationRules: rules }, true)}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: CLI 工具与权限 */}
          <CliToolsSection visible={visible} settings={settings} cliTools={cliTools} onClisUpdated={onClisUpdated} />

          {/* Section 3: Antigravity CLI */}
          <div className="settings-group" id="sec-agy">
            <div className="settings-group-head">
              <div>
                <h3 className="settings-title-with-icon">
                  <AgentIcon agent="agy" />
                  Antigravity CLI
                </h3>
                <p className="settings-group-desc">默认模型档位及终端排版降噪、fast-tools MCP 一键优化</p>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-item settings-select-item">
                <div className="settings-item-info">
                  <label htmlFor="setting-agy-model-select" className="settings-item-title">Antigravity 默认模型档位</label>
                  {activeAgyDesc && <span className="settings-item-desc">{activeAgyDesc}</span>}
                </div>
                <select
                  id="setting-agy-model-select"
                  className="settings-select"
                  data-testid="setting-agy-model"
                  value={settings.agyModel ?? ''}
                  disabled={busy}
                  onChange={(e) => void patchSettings({ agyModel: e.target.value })}
                >
                  {AGY_MODELS.map((m) => (
                    <option key={m.slug} value={m.slug}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <AgyOptimizeSection visible={visible} onTone={setAgyTone} />
          </div>

          {/* Sections 3, 4, 5: 手机远程连接 / 出门公网隧道 / 锁屏提醒 */}
          <MobileSettingsSection visible={visible} onSummary={setMobileSummary} />
        </div>
      </div>
    </section>
  );
}
