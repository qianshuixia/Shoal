import { memo, useMemo } from 'react';
import type { PendingInputReason, StreamBlock } from '../../../shared/protocol.ts';
import { splitExplicitFilePaths } from '../linkParse.ts';
import { AttachmentIcon } from './AttachmentIcon.tsx';
import { parseUserMessage } from './attachments.ts';
import { fileBase } from './format.ts';
import { useCopy } from './useCopy.ts';

export type UserBlock = Extract<StreamBlock, { kind: 'user' }>;

const QUEUED_REASON: Record<PendingInputReason, string> = {
  'terminal-draft': '排队中 · 等待终端草稿清空',
  working: '排队中 · 等待当前回答完成',
  blocked: '排队中 · 等待权限确认',
  'write-error': '排队中',
  interrupted: '排队中',
};

export function pendingLabel(block: UserBlock): string {
  switch (block.pending) {
    case 'queued':
      return block.pendingReason ? QUEUED_REASON[block.pendingReason] : '排队中';
    case 'sending':
      return '投递中…';
    case 'failed':
      return block.pendingReason === 'write-error' ? '写入终端失败，消息未送达' : '发送失败，消息未送达';
    case 'uncertain':
      return block.pendingReason === 'interrupted'
        ? '已粘贴但被终端按键打断，可能未提交'
        : '投递结果不确定，可能未提交';
    default:
      return '';
  }
}

export const UserBubble = memo(function UserBubble({
  block,
  fresh,
  privacy,
  projectPath,
  onInspectFile,
  onReuse,
  onCancelPending,
  onRetryPending,
}: {
  block: UserBlock;
  fresh: boolean;
  privacy: boolean;
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
  onReuse: (text: string) => void;
  onCancelPending: (pendingId: string) => void;
  onRetryPending: (block: UserBlock) => void;
}) {
  const parsed = useMemo(() => parseUserMessage(block.text), [block.text]);
  const bodySegments = useMemo(
    () => (parsed.body ? splitExplicitFilePaths(parsed.body, projectPath) : []),
    [parsed.body, projectPath],
  );
  const { copied, copy } = useCopy();
  const pending = block.pending;
  const isWaiting = pending === 'queued' || pending === 'sending';
  const isTroubled = pending === 'failed' || pending === 'uncertain';

  return (
    <div
      className={`sv-user-row ${pending ? `is-${pending}` : ''} ${isWaiting ? 'is-queued' : ''} ${fresh ? 'sv-block-enter' : ''}`}
      data-testid="sv-user"
      data-pending={pending ?? ''}
    >
      <div className="sv-user-col">
        <div className="sv-user-bubble" data-private="">
          {parsed.body && (
            <span className="sv-user-text">
              {onInspectFile && bodySegments.some((s) => s.kind === 'file')
                ? bodySegments.map((seg, i) =>
                    seg.kind === 'file' ? (
                      <span
                        key={i}
                        role="button"
                        tabIndex={0}
                        className="sv-path-link"
                        data-testid="sv-path-link"
                        data-file-path={seg.path}
                        title={privacy ? `在右侧面板查看 ${fileBase(seg.path) || '文件'}` : `在右侧面板查看：${seg.path}`}
                        onClick={() => {
                          if (window.getSelection()?.toString()) return;
                          onInspectFile(seg.path);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onInspectFile(seg.path);
                          }
                        }}
                      >
                        {seg.text}
                      </span>
                    ) : (
                      seg.text
                    ),
                  )
                : parsed.body}
            </span>
          )}
          {parsed.files.length > 0 && (
            <div className="sv-user-files">
              {parsed.files.map((f, i) => {
                const inner = (
                  <>
                    <span className="sv-msg-chip-icon"><AttachmentIcon category={f.category} /></span>
                    <span className="sv-chip-dir">{f.dirPrefix}</span>
                    <span className="sv-chip-name">{f.name}</span>
                  </>
                );
                return onInspectFile ? (
                  <button
                    key={`${f.path}-${i}`}
                    type="button"
                    className={`sv-msg-chip is-${f.category}`}
                    data-testid="sv-user-file"
                    data-category={f.category}
                    title={privacy ? undefined : f.path}
                    onClick={() => onInspectFile(f.path)}
                  >
                    {inner}
                  </button>
                ) : (
                  <span key={`${f.path}-${i}`} className={`sv-msg-chip is-${f.category}`} data-testid="sv-user-file" data-category={f.category}>
                    {inner}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {pending && (
          <div className={`sv-user-status ${isTroubled ? 'is-trouble' : ''}`} data-testid="sv-user-status" role="status">
            <span className="sv-user-status-dot" aria-hidden="true" />
            <span className="sv-user-status-text">{pendingLabel(block)}</span>
            {pending === 'queued' && block.pendingId && (
              <button type="button" className="sv-msg-btn" data-testid="sv-pending-cancel" onClick={() => onCancelPending(block.pendingId!)}>
                取消
              </button>
            )}
            {isTroubled && (
              <>
                <button type="button" className="sv-msg-btn is-primary" data-testid="sv-pending-retry" onClick={() => onRetryPending(block)}>
                  重试
                </button>
                {block.pendingId && (
                  <button type="button" className="sv-msg-btn" data-testid="sv-pending-dismiss" onClick={() => onCancelPending(block.pendingId!)}>
                    关闭提示
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {!isTroubled && (
          <div className="sv-msg-actions">
            <button
              type="button"
              className={`sv-icon-btn ${copied ? 'is-ok' : ''}`}
              data-testid="sv-user-copy"
              title={copied ? '已复制' : '复制'}
              aria-label="复制消息"
              onClick={() => copy(block.text)}
            >
              {copied ? (
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" /></svg>
              )}
            </button>
            <button
              type="button"
              className="sv-icon-btn"
              data-testid="sv-user-reuse"
              title="填回输入框"
              aria-label="填回输入框"
              onClick={() => onReuse(parsed.body || block.text)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 12.5H6.5a3 3 0 010-6H13M10.5 4l2.8 2.5-2.8 2.5" transform="translate(0 0)" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
