import type { PtyPromptDraft } from '../../../shared/ptyLive.ts';
import { clipPreview } from './format.ts';

export type TermGuard =
  | { mode: 'draft'; draft: PtyPromptDraft }
  | { mode: 'unreadable' };

// Terminal-draft conflict bar. Lives inside the composer (inside the absolutely positioned .stream-view overlay),
// so it can never change the terminal container geometry.
export function TermDraftBar({
  guard,
  flash,
  busy,
  working,
  privacy,
  canPull,
  onSend,
  onPull,
  onClear,
  onDismiss,
  onGoto,
}: {
  guard: TermGuard;
  flash: boolean;
  busy: boolean;
  working: boolean;
  privacy: boolean;
  canPull: boolean;
  onSend: () => void;
  onPull: () => void;
  onClear: () => void;
  onDismiss: () => void;
  onGoto: () => void;
}) {
  const draftTitle =
    privacy || guard.mode !== 'draft'
      ? undefined
      : guard.draft.hasOpaqueToken
        ? `含图片或粘贴块，只能在终端里编辑：${guard.draft.text}`
        : guard.draft.text;
  return (
    <div
      className={`sv-term-draft-bar ${flash ? 'is-flash' : ''}`}
      data-testid="sv-term-draft-bar"
      data-mode={guard.mode}
      role="status"
    >
      <span className="sv-term-draft-dot" aria-hidden="true" />
      <span className="sv-term-draft-text" data-private="" title={draftTitle}>
        {guard.mode === 'draft'
          ? guard.draft.hasOpaqueToken
            ? `终端里有含图片或粘贴块的内容：「${clipPreview(guard.draft.text)}」`
            : `终端里有未发送的内容：「${clipPreview(guard.draft.text)}」`
          : '终端里可能有未发送的内容，无法核验'}
      </span>
      <span className="sv-term-draft-actions">
        {guard.mode === 'draft' ? (
          <>
            <button
              type="button"
              className="sv-term-btn is-primary"
              data-testid="sv-term-send"
              disabled={busy || working}
              title={working ? '当前回合运行中，请清空或去终端处理' : '把终端里已输入的内容作为消息发送'}
              onClick={onSend}
            >
              发送终端草稿
            </button>
            {canPull && (
              <button
                type="button"
                className="sv-term-btn"
                data-testid="sv-term-pull"
                disabled={busy}
                title="清空终端输入，并把文字移到下方对话输入框继续编辑"
                onClick={onPull}
              >
                移到对话编辑
              </button>
            )}
            <button
              type="button"
              className="sv-term-btn"
              data-testid="sv-term-clear"
              disabled={busy}
              title="删除终端里未发送的内容（不会发送）"
              onClick={onClear}
            >
              清空终端草稿
            </button>
            <button type="button" className="sv-term-link" data-testid="sv-term-goto" onClick={onGoto}>
              去终端
            </button>
          </>
        ) : (
          <>
            <button type="button" className="sv-term-btn is-primary" data-testid="sv-term-goto" onClick={onGoto}>
              查看终端
            </button>
            <button
              type="button"
              className="sv-term-btn"
              data-testid="sv-term-clear"
              disabled={busy}
              title="尝试清空终端输入（无法核验草稿内容）"
              onClick={onClear}
            >
              尝试清空
            </button>
            <button
              type="button"
              className="sv-term-btn"
              data-testid="sv-term-dismiss"
              disabled={busy}
              title="若终端里已删空，点此放行本次发送"
              onClick={onDismiss}
            >
              终端是空的
            </button>
          </>
        )}
      </span>
    </div>
  );
}
