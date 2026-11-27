import { memo, useState } from 'react';
import type { StreamBlock } from '../../../shared/protocol.ts';
import { StreamMarkdown } from '../StreamMarkdown.tsx';

type CardStreamBlock = Extract<StreamBlock, { kind: 'card' }>;

const COLLAPSED_CHARS = 280;
const COLLAPSED_LINES = 4;

function needsCollapse(body: string): boolean {
  return body.length > COLLAPSED_CHARS || body.split('\n').length > COLLAPSED_LINES;
}

// Handoff / forward context cards: Markdown body, clamped to ~4 lines until expanded.
export const CardBlock = memo(function CardBlock({
  block,
  privacy,
  projectPath,
  onInspectFile,
}: {
  block: CardStreamBlock;
  privacy: boolean;
  projectPath?: string;
  onInspectFile?: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const body = block.card.body;
  const collapsible = needsCollapse(body);
  return (
    <div className={`sv-card-note ${collapsible && !open ? 'is-clamped' : ''}`} data-testid="sv-card">
      <div className="sv-card-tag">{block.card.kind === 'handoff' ? '交接上下文' : '转发上下文'}</div>
      <div className="sv-card-body" data-private="">
        <StreamMarkdown content={body} projectPath={projectPath} onInspectFile={onInspectFile} privacy={privacy} />
      </div>
      {collapsible && (
        <button type="button" className="sv-card-more" data-testid="sv-card-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
});
