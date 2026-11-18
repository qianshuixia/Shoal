import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ClientMsg, SessionInfo } from '../../../shared/protocol.ts';

export type TermStreamEvent = { kind: 'replay' | 'out'; id: string; d: string };

const THEME = {
  background: '#0f1012',
  foreground: '#f3f4f6',
  cursor: '#90b5dc',
  selectionBackground: '#34445e',
};

const QUICK_KEYS: { label: string; seq: string; testId?: string; primary?: boolean }[] = [
  { label: 'y', seq: 'y', testId: 'mobile-key-y', primary: true },
  { label: 'n', seq: 'n', testId: 'mobile-key-n' },
  { label: 'Enter', seq: '\r', testId: 'mobile-key-enter' },
  { label: 'Esc', seq: '\x1b', testId: 'mobile-key-esc' },
  { label: '↑', seq: '\x1b[A', testId: 'mobile-key-up' },
  { label: '↓', seq: '\x1b[B', testId: 'mobile-key-down' },
  { label: 'Tab', seq: '\t', testId: 'mobile-key-tab' },
  { label: '1', seq: '1', testId: 'mobile-key-1' },
  { label: '2', seq: '2', testId: 'mobile-key-2' },
  { label: '3', seq: '3', testId: 'mobile-key-3' },
];

export function EmergencyTerminalDrawer({
  session,
  wsConnected,
  subscribeTerm,
  sendMsg,
  onClose,
}: {
  session: SessionInfo;
  wsConnected: boolean;
  subscribeTerm(fn: (ev: TermStreamEvent) => void): () => void;
  sendMsg(msg: ClientMsg): void;
  onClose(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [confirmCtrlC, setConfirmCtrlC] = useState(false);
  const cols = session.cols > 0 ? session.cols : 120;
  const rows = session.rows > 0 ? session.rows : 40;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // Read-only fixed cols x rows terminal: NEVER attach FitAddon or trigger server resize from mobile.
    const term = new Terminal({
      cols,
      rows,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 2500,
      fontSize: 12,
      lineHeight: 1.2,
      fontFamily: '"Maple Mono NF CN", "Cascadia Mono", Consolas, monospace',
      theme: THEME,
    });
    term.open(el);

    const unsubscribe = subscribeTerm((ev) => {
      if (ev.id !== session.id) return;
      if (ev.kind === 'replay') {
        term.reset();
        term.write(ev.d, () => term.scrollToBottom());
      } else {
        term.write(ev.d);
      }
    });

    return () => {
      sendMsg({ t: 'unwatch-term' });
      unsubscribe();
      term.dispose();
    };
  }, [session.id, cols, rows, subscribeTerm, sendMsg]);

  useEffect(() => {
    if (!wsConnected) return;
    sendMsg({ t: 'watch-term', id: session.id });
  }, [wsConnected, session.id, cols, rows, sendMsg]);

  const sendKey = (d: string) => {
    if (!wsConnected) return;
    setConfirmCtrlC(false);
    sendMsg({ t: 'term-key', id: session.id, d });
  };

  return (
    <div className="mob-drawer" data-testid="mobile-term-drawer">
      <header className="mob-header">
        <div className="mob-title-wrap">
          <span className="mob-title">应急只读终端（{cols}×{rows}）</span>
          <span className="mob-sub">按需订阅 · 仅传按键不改变桌面排版</span>
        </div>
        <button type="button" className="mob-btn compact" data-testid="mobile-term-close" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="mob-term-scroll">
        <div ref={hostRef} style={{ width: 'max-content', minHeight: '100%' }} />
      </div>

      {!wsConnected && <div className="mob-conn-bar" data-testid="mobile-term-offline">连接中断，按键暂不可用，重连后恢复</div>}
      <div className="mob-keybar" data-testid="mobile-term-keybar">
        {QUICK_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            data-testid={k.testId}
            disabled={!wsConnected}
            style={k.primary ? { background: 'var(--signal)', color: '#111317', borderColor: 'var(--signal)' } : undefined}
            onClick={() => sendKey(k.seq)}
          >{k.label}</button>
        ))}
        <button
          type="button"
          data-testid="mobile-key-ctrlc"
          disabled={!wsConnected}
          style={confirmCtrlC ? { background: 'var(--danger)', color: '#111317', borderColor: 'var(--danger)' } : undefined}
          onClick={() => {
            if (!confirmCtrlC) {
              setConfirmCtrlC(true);
              return;
            }
            sendKey('\x03');
          }}
        >{confirmCtrlC ? '确认 Ctrl+C?' : 'Ctrl+C'}</button>
      </div>
    </div>
  );
}
