import { memo } from 'react';
import type { StreamBlock } from '../../../shared/protocol.ts';
import { StreamMarkdown } from '../StreamMarkdown.tsx';
import { fmtBlockTime } from './format.ts';
import { useCopy } from './useCopy.ts';

export type AssistantBlock = Extract<StreamBlock, { kind: 'assistant' }>;

// The action footer lives INSIDE the sv-assistant element so `.sv-flow` stays flat and ends with sv-assistant.
export const AssistantMessage = memo(function AssistantMessage({
  block,
  fresh,
  initialChars,
  isLatest,
  privacy,
  projectPath,
  onInspectFile,
}: {
  block: AssistantBlock;
  fresh: boolean;
  initialChars: number;
  isLatest: boolean;
  privacy: boolean;
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
}) {
  const { copied, copy } = useCopy();
  const time = fmtBlockTime(block.at);
  return (
    <div className={`sv-assistant ${isLatest ? 'is-latest' : ''}`} data-testid="sv-assistant" data-private="">
      <StreamMarkdown
        content={block.text}
        projectPath={projectPath}
        onInspectFile={onInspectFile}
        animateEntrance={fresh}
        initialRevealedChars={initialChars}
        privacy={privacy}
      />
      <div className="sv-assistant-foot" data-testid="sv-assistant-foot">
        <button
          type="button"
          className={`sv-foot-btn ${copied ? 'is-ok' : ''}`}
          data-testid="sv-assistant-copy"
          title="复制 Markdown 原文"
          onClick={() => copy(block.text)}
        >
          {copied ? (
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" /></svg>
          )}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
        {time && <span className="sv-foot-meta">{time}</span>}
        {block.model && <span className="sv-foot-meta sv-foot-model" data-private="">{block.model}</span>}
      </div>
    </div>
  );
});
