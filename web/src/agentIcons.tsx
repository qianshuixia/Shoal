import type { AgentKind } from '../../shared/protocol.ts';
import claudeUrl from './icons/claude-color.svg?url';
import codexUrl from './icons/codex-color.svg?url';
import agyUrl from './icons/antigravity-color.svg?url';

// Brand-colored marks from lobehub/lobe-icons (@lobehub/icons-static-svg 1.102.0, MIT): claude-color.svg,
// codex-color.svg, antigravity-color.svg. Loaded as images so each one keeps its own gradient and filter ids.
// The task color is shown separately (.task-swatch), not on the icon.
const COLOR: Partial<Record<AgentKind, string>> = { claude: claudeUrl, codex: codexUrl, agy: agyUrl };

// Test agent: a plain prompt glyph in the text color.
const FAKE = 'M3 5.5L4.4 4.1 11.3 11 4.4 17.9 3 16.5 8.5 11zM12 18h9v2h-9z';

export function AgentIcon({
  agent,
  fallbackAgent,
  className = 'agent-icon',
}: {
  agent: AgentKind;
  fallbackAgent?: AgentKind;
  className?: string;
}) {
  const url = COLOR[agent] ?? (fallbackAgent ? COLOR[fallbackAgent] : undefined);
  if (url) return <img className={className} data-testid="agent-icon" data-agent={agent} src={url} alt="" draggable={false} />;
  return (
    <svg className={className} data-testid="agent-icon" data-agent={agent} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={FAKE} />
    </svg>
  );
}
