// Options StreamView hands to the host's `onSendMessage` (App.tsx forwards them to POST /api/tasks/:id/feedback).
export interface StreamSendOpts {
  draftAction?: 'guard' | 'ignore';
  draftSeq?: number;
  filePaths?: string[];
  clientMsgId?: string; // idempotency key for retries
  expectedSessionId?: string; // the session the user was looking at; the server answers 409 if it was replaced
}
