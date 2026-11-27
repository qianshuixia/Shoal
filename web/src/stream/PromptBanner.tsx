import { useEffect, useRef } from 'react';
import type { PromptView } from '../../../shared/protocol.ts';

export function PromptBanner({
  prompt,
  busy,
  note,
  onAnswer,
  onOpenTerminal,
}: {
  prompt: PromptView;
  busy: boolean;
  note: string;
  onAnswer: (data: string) => void;
  onOpenTerminal: () => void;
}) {
  const linesRef = useRef<HTMLPreElement>(null);
  // Keep the bottom of the terminal prompt screen (where options live) in view whenever the prompt updates.
  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [prompt.fingerprint, prompt.lines.length]);

  return (
    <div className="sv-prompt-card" data-testid="sv-prompt-card" data-kind={prompt.kind}>
      <div className="sv-prompt-head">
        <span className="sv-prompt-dot" aria-hidden="true" />
        <span className="sv-prompt-title">CLI 正在等待你的确认</span>
        <button type="button" className="ghost sv-prompt-term" onClick={onOpenTerminal}>
          切到终端处理
        </button>
      </div>
      {prompt.lines.length > 0 && (
        <pre className="sv-prompt-lines" ref={linesRef} data-private="">{prompt.lines.slice(-12).join('\n')}</pre>
      )}
      {prompt.keys.length > 0 ? (
        <div className="sv-prompt-actions">
          {prompt.keys.map((k, idx) => (
            <button
              key={`${k.data}-${idx}`}
              type="button"
              className={`btn ${idx === 0 ? 'primary' : ''}`}
              data-testid="sv-prompt-key"
              disabled={busy}
              onClick={() => onAnswer(k.data)}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="sv-prompt-fallback">
          该交互界面需要按键操作，请点击右上角「切到终端处理」。
        </div>
      )}
      {note && <div className="sv-prompt-note">{note}</div>}
    </div>
  );
}
