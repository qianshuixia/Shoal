import { memo, useMemo, useState } from 'react';
import type { StreamToolEntry } from '../../../shared/protocol.ts';
import { SmoothText } from '../StreamMarkdown.tsx';
import { fileBase, fmtSec } from './format.ts';
import { classifyTool, formatStepSummary, summarizeStepGroup, type StepBlock, type ToolClass } from './steps.ts';

function ToolGlyph({ cls }: { cls: ToolClass }) {
  return (
    <svg className={`sv-tool-glyph is-${cls}`} viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      {cls === 'read' && <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z" />}
      {cls === 'command' && <path d="M3 4.5l3.5 3.5L3 11.5M8 12h5" />}
      {cls === 'edit' && <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2zM9.3 4.2l2.5 2.5" />}
      {cls === 'other' && <circle cx="8" cy="8" r="1.6" />}
    </svg>
  );
}

function ToolRow({
  tool,
  expanded,
  privacy,
  runningSubagentIds,
  onInspectFile,
}: {
  tool: StreamToolEntry;
  expanded: boolean;
  privacy: boolean;
  runningSubagentIds?: ReadonlySet<string>;
  onInspectFile?: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailOpen = expanded || open;
  const subRunning = Boolean(tool.subagentId && runningSubagentIds?.has(tool.subagentId));
  const effectiveStatus = subRunning ? 'running' : tool.status;
  return (
    <div className={`sv-tool-item is-${effectiveStatus}`} data-testid="sv-tool-item">
      <div className="sv-tool-row" onClick={() => tool.detail && setOpen((v) => !v)}>
        <span className={`sv-tool-mark is-${effectiveStatus}`} aria-hidden="true">
          {effectiveStatus === 'running' ? '' : effectiveStatus === 'error' ? '!' : '✓'}
        </span>
        <ToolGlyph cls={classifyTool(tool.name)} />
        <span className="sv-tool-summary" data-private="">{tool.summary}</span>
        {subRunning && <span className="sv-tool-sub-badge">后台运行中</span>}
        {tool.files && tool.files.length > 0 && onInspectFile && (
          <span className="sv-tool-files" onClick={(e) => e.stopPropagation()}>
            {tool.files.slice(0, 3).map((fp) => (
              <button
                key={fp}
                type="button"
                className="sv-file-chip"
                data-testid="sv-file-chip"
                data-file-path={fp}
                data-private=""
                title={privacy ? undefined : `在右侧面板打开 ${fp}`}
                onClick={() => onInspectFile(fp)}
              >
                {fileBase(fp)}
              </button>
            ))}
          </span>
        )}
      </div>
      {detailOpen && tool.detail && <div className="sv-tool-detail" data-private="">{tool.detail}</div>}
    </div>
  );
}

export const StepBlockView = memo(function StepBlockView({
  block,
  privacy,
  fresh = false,
  runningSubagentIds,
  onInspectFile,
}: {
  block: StepBlock;
  privacy: boolean;
  fresh?: boolean; // newly arrived block: glide in and animate the thinking text
  runningSubagentIds?: ReadonlySet<string>;
  onInspectFile?: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasThinking = !!block.thinking?.trim();
  const toolCount = block.tools.length;
  const isActive = !!block.active;

  let heading = '';
  if (isActive) {
    heading = toolCount > 0 ? `正在调用 ${toolCount} 个工具` : '正在思考…';
  } else if (hasThinking && toolCount > 0) {
    heading = block.thinkingSec
      ? `思考了 ${fmtSec(block.thinkingSec)}，调用了 ${toolCount} 次工具`
      : `已完成思考，调用了 ${toolCount} 次工具`;
  } else if (hasThinking) {
    heading = block.thinkingSec ? `思考了 ${fmtSec(block.thinkingSec)}` : '思考过程';
  } else {
    heading = `调用了 ${toolCount} 次工具`;
  }

  // Show a generous 5-line reasoning preview by default; expand smoothly on click when longer.
  const thinkingLines = block.thinking ? block.thinking.split(/\r?\n/) : [];
  const isLongThinking = (block.thinking?.length ?? 0) > 420 || thinkingLines.length > 6;

  return (
    <section
      className={`sv-step ${isActive ? 'is-active' : 'is-done'} ${fresh ? 'sv-block-enter' : ''}`}
      data-testid="sv-step"
      data-active={isActive ? 'true' : 'false'}
    >
      <button
        type="button"
        className="sv-step-head"
        data-testid="sv-step-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {isActive && <span className="sv-pulse-dot" aria-hidden="true" />}
        <span className="sv-step-title">{heading}</span>
        {(hasThinking || toolCount > 0) && (
          <svg className={`sv-chev ${expanded ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 6.5l3 3 3-3" />
          </svg>
        )}
      </button>

      {(hasThinking || toolCount > 0) && (
        <div className="sv-step-rail">
          {hasThinking && (
            <div
              className={`sv-thought-text ${!expanded && isLongThinking ? 'is-clamped' : ''}`}
              data-testid="sv-step-thinking"
              data-private=""
              onClick={() => isLongThinking && setExpanded((v) => !v)}
              title={!expanded && isLongThinking ? '点击展开完整思考过程' : undefined}
            >
              {fresh ? <SmoothText text={block.thinking!} active /> : block.thinking}
            </div>
          )}

          {toolCount > 0 && (
            <div className="sv-tool-list" data-testid="sv-tool-list">
              {block.tools.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  expanded={expanded}
                  privacy={privacy}
                  runningSubagentIds={runningSubagentIds}
                  onInspectFile={onInspectFile}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

function sameBlocks(a: StepBlock[], b: StepBlock[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// One-line capsule for a run of finished steps: "思考与执行 · 8 步 · 读取 3 个文件 · … · 14s". Click to expand the timeline.
export const StepGroup = memo(
  function StepGroup({
    blocks,
    privacy,
    fresh = false,
    runningSubagentIds,
    onInspectFile,
  }: {
    blocks: StepBlock[];
    privacy: boolean;
    fresh?: boolean;
    runningSubagentIds?: ReadonlySet<string>;
    onInspectFile?: (filePath: string) => void;
  }) {
    const [open, setOpen] = useState(false);
    const summary = useMemo(() => summarizeStepGroup(blocks), [blocks]);
    return (
      <section
        className={`sv-step-group ${open ? 'is-open' : ''} ${summary.failed > 0 ? 'has-failed' : ''} ${fresh ? 'sv-block-enter' : ''}`}
        data-testid="sv-step-group"
        data-failed={summary.failed > 0 ? 'true' : 'false'}
      >
        <button
          type="button"
          className="sv-step-group-head"
          data-testid="sv-step-group-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg className={`sv-chev sv-chev-lead ${open ? 'on' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 5l3 3-3 3" />
          </svg>
          <span className="sv-step-group-text">{formatStepSummary(summary)}</span>
          {summary.failed > 0 && <span className="sv-warn-dot" aria-hidden="true" />}
        </button>
        {open && (
          <div className="sv-step-group-body">
            {blocks.map((b) => (
              <StepBlockView
                key={b.id}
                block={b}
                privacy={privacy}
                runningSubagentIds={b.tools.some((t) => t.subagentId) ? runningSubagentIds : undefined}
                onInspectFile={onInspectFile}
              />
            ))}
          </div>
        )}
      </section>
    );
  },
  (a, b) =>
    sameBlocks(a.blocks, b.blocks) &&
    a.privacy === b.privacy &&
    a.fresh === b.fresh &&
    a.runningSubagentIds === b.runningSubagentIds &&
    a.onInspectFile === b.onInspectFile,
);
