import { useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { StreamAttachment } from '../streamDrafts.ts';
import { AttachmentIcon } from './AttachmentIcon.tsx';
import { attachmentCategoryOf } from './attachments.ts';

export function StreamComposer({
  termBar,
  hasTermDraft,
  attachments,
  uploadingCount,
  privacy,
  thumbFor,
  onRemoveAttachment,
  onPickFiles,
  textareaRef,
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  disabled,
  placeholder,
  working,
  onInterrupt,
  sendDisabled,
  sendTitle,
  onSend,
  modelLabel,
  onSwitchToTerminal,
}: {
  termBar: ReactNode;
  hasTermDraft: boolean;
  attachments: StreamAttachment[];
  uploadingCount: number;
  privacy: boolean;
  thumbFor: (att: StreamAttachment) => string | undefined;
  onRemoveAttachment: (index: number) => void;
  onPickFiles: (files: File[]) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder: string;
  working: boolean;
  onInterrupt?: () => void;
  sendDisabled: boolean;
  sendTitle: string;
  onSend: () => void;
  modelLabel: string;
  onSwitchToTerminal: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`sv-composer ${hasTermDraft ? 'has-term-draft' : ''}`} data-testid="sv-composer">
      {termBar}
      {(attachments.length > 0 || uploadingCount > 0) && (
        <div className="sv-attach-list" data-testid="sv-attach-list">
          {attachments.map((att, i) => {
            const cat = attachmentCategoryOf(att.label);
            const thumb = cat === 'image' ? thumbFor(att) : undefined;
            return (
              <span
                key={`${att.kind}-${att.value}-${i}`}
                className={`sv-attach-chip is-${cat} ${thumb ? 'has-thumb' : ''}`}
                data-testid="sv-attach-chip"
                data-kind={att.kind}
                data-category={cat}
                title={privacy ? undefined : att.kind === 'local' ? att.value : `已上传附件 · ${att.label}`}
              >
                {thumb ? (
                  <img className="sv-attach-thumb" src={thumb} alt="" width={36} height={36} draggable={false} />
                ) : (
                  <span className="sv-attach-icon">
                    <AttachmentIcon category={cat} />
                  </span>
                )}
                <span className="sv-attach-name" data-private="">{att.label}</span>
                <button type="button" aria-label={`移除附件 ${att.label}`} onClick={() => onRemoveAttachment(i)}>
                  ×
                </button>
              </span>
            );
          })}
          {uploadingCount > 0 && (
            <span className="sv-attach-chip is-uploading" data-testid="sv-attach-uploading">
              正在添加附件…
            </span>
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="sv-textarea"
        data-testid="sv-input"
        data-private=""
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="sv-composer-bar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-testid="sv-attach-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) onPickFiles(files);
          }}
        />
        <button
          type="button"
          className="sv-attach-add"
          data-testid="sv-attach-add"
          title="添加图片或文件（也可粘贴、拖入）"
          aria-label="添加附件"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" /></svg>
        </button>
        <span className="sv-composer-hint">Enter 发送 · Shift+Enter 换行</span>
        <div className="sv-composer-btns">
          {working && onInterrupt && (
            <button
              type="button"
              className="sv-stop-btn"
              data-testid="sv-stop"
              title="向原生 CLI 发送 Esc 中断当前步骤（不关闭会话）"
              onClick={onInterrupt}
            >
              <span className="sv-stop-sq" aria-hidden="true" />
              停止
            </button>
          )}
          <button
            type="button"
            className="sv-send-btn"
            data-testid="sv-send"
            disabled={sendDisabled}
            title={sendTitle}
            onClick={onSend}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="sv-composer-meta">
        <span className="sv-meta-model" data-private="">{modelLabel}</span>
        <span className="sv-meta-right">
          <span className="sv-meta-badge">原生 CLI 双源视图</span>
          <button type="button" className="sv-meta-link" onClick={onSwitchToTerminal}>
            切到终端 (Alt+M)
          </button>
        </span>
      </div>
    </div>
  );
}
