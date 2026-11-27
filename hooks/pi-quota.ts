import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isOfficialOpenCodeGoUrl, OPENCODE_GO_USAGE_URL, parseOpenCodeGoUsage, PI_QUOTA_RESULT } from '../shared/openCodeGo.ts';

async function readUsage(ctx: ExtensionContext) {
  const model = ctx.modelRegistry.getAll().find(m => m.provider === 'opencode-go' && isOfficialOpenCodeGoUrl(m.baseUrl));
  if (!model) return [];
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey || !isOfficialOpenCodeGoUrl(auth.baseUrl ?? model.baseUrl)) return [];
  const response = await fetch(OPENCODE_GO_USAGE_URL, {
    headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  return response.ok ? parseOpenCodeGoUsage(await response.json()) : [];
}

export default function shoalPiQuota(pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    if (ctx.mode !== 'rpc' || event.reason !== 'startup') return;
    const windows = await readUsage(ctx).catch(() => []);
    // Keep credentials and provider error bodies inside Pi. This channel carries normalized windows only.
    process.stderr.write(`${PI_QUOTA_RESULT}${JSON.stringify(windows)}\n`, () => ctx.shutdown());
  });
}
