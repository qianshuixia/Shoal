import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

let socket: WebSocket | null = null;

// Input is dropped while disconnected; returns whether the frame was handed to an open WebSocket.
export function send(msg: ClientMsg): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

export interface Handlers {
  onMsg(msg: ServerMsg): void;
  onOpen(): void;
  onClose(): void;
}

// Connects and auto-reconnects (1s -> 5s backoff). Returns a stop function.
export function connect(h: Handlers): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      h.onOpen();
    };
    ws.onmessage = (e) => h.onMsg(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      h.onClose();
      timer = setTimeout(open, Math.min(5000, 1000 * 2 ** attempt++));
    };
  };
  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
