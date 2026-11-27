// Shared user-turn / feedback matching utilities used by both desktop StreamView and mobile ConversationView.

export const PENDING_USER_CLOCK_SKEW_MS = 2_500;
export const PENDING_TRANSCRIPT_ADVANCE_MS = 1_500;
export const FALLBACK_CARD_SKEW_MS = 2_000;

export const normalizeUserTextForMatch = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function feedbackMatchesUserText(feedbackText: string, transcriptUserText: string): boolean {
  const normFb = normalizeUserTextForMatch(feedbackText);
  const normTurn = normalizeUserTextForMatch(transcriptUserText);
  if (!normFb || !normTurn) return false;
  const headFb = normFb.slice(0, 80);
  const headTurn = normTurn.slice(0, 80);
  if (normTurn.includes(headFb)) return true;
  if (normFb.includes(headTurn) && headTurn.length >= 12) return true;
  const firstLine = normalizeUserTextForMatch(feedbackText.split(/\r?\n/)[0] ?? '').slice(0, 80);
  if (firstLine.length >= 8 && normTurn.includes(firstLine)) return true;
  return false;
}
