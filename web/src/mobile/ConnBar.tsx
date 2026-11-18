function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Shown on the home and task pages while the live connection is down. Actions that need it are disabled meanwhile. */
export function ConnBar({ wsConnected, lastSyncAt }: { wsConnected: boolean; lastSyncAt: number | null }) {
  if (wsConnected) return null;
  return (
    <div className="mob-conn-bar" data-testid="mobile-reconnect-bar" role="status">
      重连中{lastSyncAt ? ` · 上次同步 ${hhmm(lastSyncAt)}` : ''}（发送与终端按键暂不可用）
    </div>
  );
}
