import type { SessionStreamState } from '../../../shared/protocol.ts';
import { SmoothText, StreamMarkdown } from '../StreamMarkdown.tsx';
import { fmtCompactSec } from './format.ts';
import { useTick } from './useTick.ts';

export function LiveTail({
  live,
  hasActiveStepTail,
  runningSubagentCount,
  privacy,
  projectPath,
  onInspectFile,
  onFocusSubagents,
}: {
  live: NonNullable<SessionStreamState['live']>;
  hasActiveStepTail: boolean;
  runningSubagentCount: number;
  privacy: boolean;
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
  onFocusSubagents?: () => void;
}) {
  // The only per-second clock in the whole flow: it lives in this leaf, history blocks never see it.
  const now = useTick(true);
  if (live.phase === 'tool' && hasActiveStepTail && !live.thinkingText) return null;
  const elapsedSec = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  const elapsedTag = elapsedSec > 0 ? ` (${fmtCompactSec(elapsedSec)})` : '';
  const title = live.phase === 'preparing'
    ? '正在准备模型上下文…'
    : live.phase === 'subagent'
      ? `正在等待子代理完成${runningSubagentCount > 0 ? ` · ${runningSubagentCount} 个运行中` : ''}${elapsedTag}`
      : live.phase === 'tool'
        ? `正在调用工具${elapsedTag}`
        : live.phase === 'answering'
          ? `正在生成回复…${elapsedTag}`
          : `正在思考…${elapsedTag}`;

  const showStepHeader = live.phase !== 'preparing' && (live.phase !== 'answering' || !!live.thinkingText);
  const showRail = (live.phase === 'tool' && !!live.toolSummary) || !!live.thinkingText;

  return (
    <section className={`sv-live phase-${live.phase}`} data-testid="sv-live" data-phase={live.phase}>
      {live.phase === 'preparing' && (
        <div className="sv-preparing" data-testid="sv-preparing">
          <span className="sv-pulse-dot" aria-hidden="true" />
          <span className="sv-shimmer-text">{title}</span>
        </div>
      )}

      {showStepHeader && (
        <div className="sv-step is-active">
          {live.phase === 'subagent' && onFocusSubagents ? (
            <button
              type="button"
              className="sv-step-head sv-subagent-live-btn"
              data-testid="sv-live-subagent"
              onClick={onFocusSubagents}
            >
              <span className="sv-pulse-dot is-subagent" aria-hidden="true" />
              <span className="sv-step-title">{title}</span>
            </button>
          ) : (
            <div className="sv-step-head is-static">
              <span className="sv-pulse-dot" aria-hidden="true" />
              <span className="sv-step-title">{title}</span>
            </div>
          )}
          {showRail && (
            <div className="sv-step-rail">
              {live.phase === 'tool' && live.toolSummary && (
                <div className="sv-tool-item is-running">
                  <div className="sv-tool-row">
                    <span className="sv-tool-mark is-running" aria-hidden="true" />
                    <span className="sv-tool-summary" data-testid="sv-live-tool" data-private="">{live.toolSummary}</span>
                  </div>
                </div>
              )}
              {live.thinkingText && (
                <div className="sv-thought-text is-live" data-testid="sv-live-thinking" data-private="">
                  <SmoothText text={live.thinkingText} active />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {live.phase === 'answering' && live.answerText && (
        <div className="sv-assistant is-streaming" data-testid="sv-live-answer" data-private="">
          <StreamMarkdown
            content={live.answerText}
            projectPath={projectPath}
            onInspectFile={onInspectFile}
            streaming
            privacy={privacy}
          />
          <span className="sv-caret" aria-hidden="true" />
        </div>
      )}
    </section>
  );
}
