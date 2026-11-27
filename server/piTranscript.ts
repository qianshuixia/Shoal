type Entry = Record<string, unknown>;

function record(value: unknown): Entry | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Entry : undefined;
}

// Pi appends all branches to the same JSONL. Only the path to the selected leaf is visible in a conversation.
export function piConversation(raw: string, selectedLeaf?: string | null): Entry[] {
  if (selectedLeaf === null) return [];
  const entries = new Map<string, Entry>();
  let latest: string | undefined;
  for (const line of raw.split('\n')) {
    let entry;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (!entry || typeof entry.id !== 'string' || entry.type === 'session' || !('parentId' in entry)) continue;
    latest = entry.id;
    entries.set(entry.id, entry);
  }

  const branch: Entry[] = [];
  let id = selectedLeaf ?? latest;
  while (id) {
    const entry = entries.get(id);
    if (!entry) break;
    entries.delete(id); // also prevents a malformed cyclic parent chain from looping
    branch.push(entry);
    id = typeof entry.parentId === 'string' ? entry.parentId : undefined;
  }

  // Reuse the existing text, reasoning and tool-result renderers with normalized message blocks.
  return branch.reverse().map(piMessage).filter((message): message is Entry => !!message);
}

export function piMessage(entry: Entry): Entry | undefined {
  const m = record(entry.message);
  if (entry.type !== 'message' || !m) return undefined;
  if (m.role === 'toolResult') {
    return { type: 'user', timestamp: entry.timestamp, message: { content: [
      { type: 'tool_result', tool_use_id: m.toolCallId, is_error: m.isError },
    ] } };
  }
  if ((m.role !== 'user' && m.role !== 'assistant') || m.stopReason === 'error' || m.stopReason === 'aborted') return undefined;
  const content = Array.isArray(m.content) ? m.content.map((b: unknown) => {
    const block = record(b);
    return block?.type === 'toolCall' ? { ...block, type: 'tool_use', input: block.arguments } : b;
  }) : m.content;
  const model = typeof m.model === 'string' && typeof m.provider === 'string' ? `${m.provider}/${m.model}` : m.model;
  return { type: m.role, timestamp: entry.timestamp, message: { ...m, content, model } };
}
