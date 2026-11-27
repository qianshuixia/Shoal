import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { InteractiveKey } from '../../../shared/protocol.ts';
import type { PtyInteractivePrompt, PtyQuestionOption } from '../../../shared/ptyLive.ts';

function optionDisplayLabel(opt: PtyQuestionOption): string {
  if (opt.isWriteIn && /^write-in(?:\.{3}|…)?$/i.test(opt.label.trim())) {
    return '自定义回答（Write-in…）';
  }
  if (opt.isSubmit && /^submit(?:\s+all|\s+answers)?$/i.test(opt.label.trim())) {
    return '提交全部回答';
  }
  if (opt.isBack && /^back$/i.test(opt.label.trim())) {
    return '返回修改';
  }
  return opt.label;
}

export function QuestionCard({
  prompt,
  busy,
  stale,
  error,
  writeInDraft,
  privacy,
  onWriteInChange,
  onSendKeys,
  onSubmitText,
  onUnlock,
  onOpenTerminal,
}: {
  prompt: PtyInteractivePrompt;
  busy: boolean;
  stale?: boolean;
  error?: string;
  writeInDraft: string;
  privacy: boolean;
  onWriteInChange: (text: string) => void;
  onSendKeys: (keys: InteractiveKey[]) => void;
  onSubmitText: (text: string) => Promise<boolean>;
  onUnlock?: () => void;
  onOpenTerminal: () => void;
}) {
  const writeInRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prompt.mode === 'write-in') {
      requestAnimationFrame(() => writeInRef.current?.focus());
    }
  }, [prompt.mode, prompt.progress?.current, prompt.title]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [prompt.progress?.current, prompt.title, prompt.mode]);

  const handleOptionClick = (opt: PtyQuestionOption) => {
    if (busy) return;
    const from = prompt.selectedIndex >= 0 ? prompt.selectedIndex : 0;
    const delta = opt.index - from;
    const keys: InteractiveKey[] = [];
    if (delta > 0) {
      for (let i = 0; i < delta; i++) keys.push('down');
    } else if (delta < 0) {
      for (let i = 0; i < -delta; i++) keys.push('up');
    }
    const toggle = prompt.mode === 'multi' && opt.checked !== undefined;
    keys.push(toggle ? 'space' : 'enter');
    onSendKeys(keys);
  };

  const handleWriteInSubmit = () => {
    const text = writeInDraft.trim();
    if (!text || busy) return;
    // Draft stays intact until StreamView confirms the terminal actually left this write-in screen.
    void onSubmitText(text);
  };

  const onWriteInKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleWriteInSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onSendKeys(['esc']);
    }
  };

  const headLabel = prompt.mode === 'write-in'
    ? '输入自定义回答'
    : prompt.mode === 'review'
      ? '核对并提交'
      : prompt.mode === 'multi'
        ? '多选问题'
        : '需要你的选择';

  const pct = prompt.progress && prompt.progress.total > 0
    ? Math.min(100, Math.round((prompt.progress.current / prompt.progress.total) * 100))
    : 0;

  // Hide redundant Enter action button in review mode when Submit All is already rendered as a clickable option.
  const visibleActions = prompt.actions.filter(
    (act) => !(prompt.mode === 'review' && act.id === 'submit' && prompt.options.some((o) => o.isSubmit)),
  );

  return (
    <div
      className={`sv-qcard is-${prompt.mode}`}
      data-testid="sv-question-card"
      data-mode={prompt.mode}
      role="region"
      aria-label={headLabel}
    >
      <div className="sv-qcard-head">
        <span className="sv-qcard-dot" aria-hidden="true" />
        <span className="sv-qcard-head-title">{headLabel}</span>
        {prompt.progress && (
          <span className="sv-qcard-progress" data-testid="sv-question-progress">
            <span>{prompt.progress.current} / {prompt.progress.total}</span>
            <span className="sv-qcard-bar" aria-hidden="true">
              <span className="sv-qcard-bar-fill" style={{ width: `${pct}%` }} />
            </span>
          </span>
        )}
        <button type="button" className="ghost sv-qcard-term" data-testid="sv-question-term" onClick={onOpenTerminal}>
          切到终端处理
        </button>
      </div>

      <div className="sv-qcard-body" ref={bodyRef}>
        <div className="sv-qcard-title" data-testid="sv-question-title" data-private="">
          {prompt.title}
        </div>
        {prompt.subtitle && (
          <div className="sv-qcard-sub" data-testid="sv-question-sub" data-private="">
            {prompt.subtitle}
          </div>
        )}

        {prompt.mode === 'write-in' ? (
          <div className="sv-qcard-writein" data-testid="sv-question-writein">
            {prompt.writeInText && !privacy && writeInDraft && (
              <div className="sv-qcard-writein-live" data-private="">
                终端当前已输入：{prompt.writeInText}
              </div>
            )}
            <textarea
              ref={writeInRef}
              className="sv-qcard-writein-input"
              data-testid="sv-question-writein-input"
              data-private=""
              rows={2}
              disabled={busy}
              value={writeInDraft}
              onChange={(e) => onWriteInChange(e.target.value)}
              onKeyDown={onWriteInKeyDown}
              placeholder={prompt.writeInText && !privacy ? `当前终端已输入：${prompt.writeInText}` : '输入你的自定义回答…（Enter 提交，Esc 返回选项）'}
            />
            <div className="sv-qcard-writein-bar">
              <button
                type="button"
                className="btn primary"
                data-testid="sv-question-writein-submit"
                disabled={busy || !writeInDraft.trim()}
                onClick={handleWriteInSubmit}
              >
                提交回答
              </button>
              <button
                type="button"
                className="btn"
                data-testid="sv-question-writein-back"
                disabled={busy}
                onClick={() => onSendKeys(['esc'])}
              >
                返回选项 (Esc)
              </button>
            </div>
          </div>
        ) : prompt.options.length > 0 ? (
          <div className="sv-qcard-opts" role="listbox" aria-multiselectable={prompt.mode === 'multi' || undefined}>
            {prompt.options.map((opt) => {
              const display = optionDisplayLabel(opt);
              const isCheckbox = prompt.mode === 'multi' && opt.checked !== undefined;
              return (
                <button
                  key={`${opt.index}-${opt.number ?? ''}-${opt.label}`}
                  type="button"
                  role="option"
                  aria-selected={isCheckbox ? !!opt.checked : opt.selected}
                  className={`sv-qcard-opt ${opt.selected ? 'is-cursor' : ''} ${opt.checked ? 'is-checked' : ''} ${opt.isWriteIn ? 'is-writein' : ''} ${opt.isSubmit ? 'is-submit' : ''}`}
                  data-testid="sv-question-opt"
                  data-index={opt.index}
                  data-selected={opt.selected ? 'true' : 'false'}
                  data-checked={opt.checked === undefined ? undefined : opt.checked ? 'true' : 'false'}
                  data-write-in={opt.isWriteIn ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => handleOptionClick(opt)}
                >
                  <span className="sv-qcard-opt-lead" aria-hidden="true">
                    {isCheckbox ? (
                      <span className={`sv-qcard-check ${opt.checked ? 'on' : ''}`}>
                        {opt.checked ? '✓' : ''}
                      </span>
                    ) : opt.isWriteIn ? (
                      <span className="sv-qcard-num is-edit">✎</span>
                    ) : opt.number ? (
                      <span className="sv-qcard-num">{opt.number}</span>
                    ) : (
                      <span className="sv-qcard-num">›</span>
                    )}
                  </span>
                  <span className="sv-qcard-opt-content">
                    <span className="sv-qcard-opt-row">
                      {opt.recommended && <span className="sv-qcard-rec">推荐</span>}
                      <span className="sv-qcard-opt-label" data-private="">{display}</span>
                    </span>
                    {opt.description && (
                      <span className="sv-qcard-opt-desc" data-private="">{opt.description}</span>
                    )}
                  </span>
                  {opt.selected && <span className="sv-qcard-cursor-tag" aria-hidden="true">当前</span>}
                </button>
              );
            })}
          </div>
        ) : null}
        {error && (
          <div className="sv-qcard-err" data-testid="sv-question-err" role="alert">
            <span>{error}</span>
            {stale && onUnlock && (
              <button
                type="button"
                className="sv-qcard-err-btn"
                data-testid="sv-question-unlock"
                onClick={onUnlock}
              >
                仍要继续操作
              </button>
            )}
          </div>
        )}
      </div>

      {visibleActions.length > 0 && prompt.mode !== 'write-in' && (
        <div className="sv-qcard-foot">
          <div className="sv-qcard-actions">
            {visibleActions.map((act) => {
              const primary = act.id === 'confirm' || act.id === 'submit';
              return (
                <button
                  key={act.id}
                  type="button"
                  className={`sv-qcard-act ${primary ? 'is-primary' : ''}`}
                  data-testid={`sv-question-action-${act.id}`}
                  disabled={busy}
                  onClick={() => onSendKeys([act.key])}
                >
                  <span>{act.label}</span>
                  <kbd>{act.keyHint}</kbd>
                </button>
              );
            })}
          </div>
          <span className="sv-qcard-hint">
            {prompt.mode === 'multi'
              ? '点击勾选，选完点「确认本题」'
              : prompt.mode === 'review' && prompt.options.length === 0
                ? '确认无误后点「提交全部」'
                : '点击选项直接提交'}
          </span>
        </div>
      )}
    </div>
  );
}
