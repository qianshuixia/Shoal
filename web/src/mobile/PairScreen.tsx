import { useCallback, useEffect, useState } from 'react';
import type { MobilePairClaimResult, MobilePairRedeemResult } from '../../../shared/protocol.ts';
import { mobilePost } from './api.ts';

function parsePairTokenInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const hashIdx = s.indexOf('#pair=');
  if (hashIdx >= 0) {
    return s.slice(hashIdx + 6).split('&')[0].trim();
  }
  return s;
}

export function PairScreen({
  initialPairToken,
  notice,
  onClearInitialToken,
  onPaired,
}: {
  initialPairToken: string | null;
  notice: string;
  onClearInitialToken(): void;
  onPaired(): void;
}) {
  const [manualInput, setManualInput] = useState('');
  const [deviceName, setDeviceName] = useState(() => (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) ? 'Android Chrome' : ''));
  const [claim, setClaim] = useState<MobilePairClaimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const submitClaim = useCallback(async (rawToken: string) => {
    const pairToken = parsePairTokenInput(rawToken);
    if (!pairToken) {
      setError('请粘贴桌面设置中展示的配对链接或口令');
      return;
    }
    setBusy(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await mobilePost<MobilePairClaimResult>('/api/mobile/pair/claim', {
        pairToken,
        ...(deviceName.trim() ? { deviceName: deviceName.trim() } : {}),
      });
      setClaim(res);
      setStatusMsg('请在电脑桌面端输入下方 6 位配对码并点击确认放行…');
    } catch (e) {
      setClaim(null);
      setError((e as Error).message);
    } finally {
      onClearInitialToken();
      setBusy(false);
    }
  }, [deviceName, onClearInitialToken]);

  useEffect(() => {
    if (initialPairToken && !claim && !busy) {
      void submitClaim(initialPairToken);
    }
  }, [initialPairToken, claim, busy, submitClaim]);

  useEffect(() => {
    if (!claim) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One request at a time: the next poll is scheduled only after the previous one finished.
    const poll = async () => {
      let next = true;
      try {
        const res = await mobilePost<MobilePairRedeemResult>('/api/mobile/pair/redeem', {
          claimId: claim.claimId,
          claimSecret: claim.claimSecret,
        });
        if (!alive) return;
        setStatusMsg('请在电脑桌面端输入下方 6 位配对码并点击确认放行…');
        if (res.status === 'approved') {
          next = false;
          onPaired();
        }
      } catch (e) {
        if (!alive) return;
        const err = e as Error & { code?: string };
        // Only an explicit expiry / mismatch drops the claim; everything else (flaky link, 5xx, plain 403/4xx) keeps polling.
        if (err.code === 'pair-expired' || err.code === 'pair-mismatch') {
          next = false;
          setClaim(null);
          setError(err.message || '配对已过期或被拒绝，请重新扫码');
        } else {
          setStatusMsg(err.message ? `${err.message}，正在重试…` : '网络波动，正在重试…');
        }
      }
      if (alive && next) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [claim, onPaired]);

  return (
    <div className="mob-root" data-testid="mobile-pair-screen">
      <div className="mob-pair-shell">
        <div>
          <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.25rem' }}>Shoal 手机控制台</h2>
          <div className="mob-sub" style={{ whiteSpace: 'normal', fontSize: '0.8125rem' }}>
            使用前需通过电脑端设置中的「手机远程连接」扫码或输入一次性配对链接完成授权。
          </div>
        </div>

        {notice && <div className="mob-banner is-blocked">{notice}</div>}

        {claim ? (
          <div className="mob-pair-card">
            <div className="mob-sub">本次配对验证码（请核对电脑端确认）</div>
            <div className="mob-claim-digits" data-testid="mobile-claim-code">{claim.code}</div>
            <div className="mob-sub" style={{ whiteSpace: 'normal' }}>{statusMsg}</div>
            <button
              type="button"
              className="mob-btn ghost"
              onClick={() => {
                setClaim(null);
                setError('');
              }}
            >改用其他配对码</button>
          </div>
        ) : (
          <div className="mob-pair-card">
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
              <span>设备备注名（可选）</span>
              <input
                className="mob-input"
                value={deviceName}
                maxLength={48}
                placeholder="例如：主力 Android 手机"
                onChange={(e) => setDeviceName(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
              <span>配对链接或令牌</span>
              <input
                className="mob-input"
                data-testid="mobile-pair-manual-input"
                value={manualInput}
                placeholder="粘贴 #pair=... 完整链接或配对令牌"
                onChange={(e) => setManualInput(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="mob-btn primary"
              data-testid="mobile-pair-claim-btn"
              disabled={busy}
              onClick={() => void submitClaim(manualInput)}
            >{busy ? '正在认领…' : '发起配对确认'}</button>
          </div>
        )}

        {error && <div className="form-error" data-testid="mobile-pair-error">{error}</div>}
      </div>
    </div>
  );
}
