import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './http.ts';
import {
  agyHookDisposition, agyPrimaryWorkspaces, CODEX_NEWLINE, deliverable, enterReady, isAgyIntermediateStop,
  isTerminalReportSequence, modePrefix, nativeIdUpdate, pasteFrame, prependEnvPath, sanitizePaste,
  SessionManager, STARTUP_BLOCK_RE, stripAnsiForMatch, trackModes,
} from './sessions.ts';
import type { DeliveryState } from './sessions.ts';
import { createFileStore } from './store.ts';
import { createUsage } from './usage.ts';

describe('nativeIdUpdate', () => {
  it('takes the first id from any event', () => {
    expect(nativeIdUpdate(null, 'UserPromptSubmit', 'a', undefined)).toEqual({ id: 'a' });
    expect(nativeIdUpdate(null, 'SessionStart', 'a', 'startup')).toEqual({ id: 'a' });
  });

  it('SessionStart source resume switches the id and makes it resumable', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'resume')).toEqual({ id: 'b', resumable: true });
  });

  it('SessionStart from clear/startup/compact switches the id but waits for a prompt', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'b', 'clear')).toEqual({ id: 'b', resumable: false });
    expect(nativeIdUpdate('a', 'SessionStart', 'b', undefined)).toEqual({ id: 'b', resumable: false });
  });

  it('ignores the same id, empty ids and non-SessionStart events with another id', () => {
    expect(nativeIdUpdate('a', 'SessionStart', 'a', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', '', 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'SessionStart', 42, 'resume')).toBeUndefined();
    expect(nativeIdUpdate('a', 'UserPromptSubmit', 'b', undefined)).toBeUndefined();
    expect(nativeIdUpdate('a', 'Stop', 'b', 'resume')).toBeUndefined();
  });
});

describe('pasteFrame', () => {
  it('bracketed: wraps the text, newlines become \\n and never \\r (a \\r submits in Codex)', () => {
    expect(pasteFrame('a\nb\r\nc\rd', true)).toBe('\x1b[200~a\nb\nc\nd\x1b[201~');
  });

  it('codex: every newline becomes the Ctrl+J key record', () => {
    expect(pasteFrame('一\r\n二\n三', true, CODEX_NEWLINE)).toBe(`\x1b[200~一${CODEX_NEWLINE}二${CODEX_NEWLINE}三\x1b[201~`);
  });

  it('plain: collapses newlines into single spaces', () => {
    expect(pasteFrame('a\n\nb\r\nc', false)).toBe('a b c');
  });

  it('strips paste markers and control characters but keeps tabs and newlines', () => {
    const evil = 'x\x1b[201~rm -rf\x1b[200~\x03\x07\x1b[31my\ttab\nz\x7f';
    expect(sanitizePaste(evil)).toBe('xrm -rf[31my\ttab\nz');
    expect(pasteFrame(evil, true)).not.toContain('\x1b[201~rm');
    expect(pasteFrame(evil, true).match(/\x1b/g)).toHaveLength(2);
  });
});

describe('deliverable', () => {
  const base: DeliveryState = { status: 'needs_you', statusSince: 0, permBlocked: false, lastInputAt: 0, lastDeliveryAt: 0 };
  const now = 100_000;

  it('is true for an idle session with no recent typing or delivery', () => {
    expect(deliverable(base, now)).toBe(true);
  });

  it.each([
    ['working', { status: 'working' }],
    ['starting', { status: 'starting' }],
    ['exited', { status: 'exited' }],
    ['turn ended 1.4 s ago (Codex is still settling)', { statusSince: now - 1400 }],
    ['permission prompt open', { permBlocked: true }],
    ['typed 4.9 s ago', { lastInputAt: now - 4900 }],
    ['delivered 1.9 s ago', { lastDeliveryAt: now - 1900 }],
  ] as [string, Partial<DeliveryState>][])('is false: %s', (_n, patch) => {
    expect(deliverable({ ...base, ...patch }, now)).toBe(false);
  });

  it('becomes true exactly at the 5 s / 2 s / 1.5 s boundaries', () => {
    expect(deliverable({ ...base, lastInputAt: now - 5000, lastDeliveryAt: now - 2000, statusSince: now - 1500 }, now)).toBe(true);
  });

  it.each([
    ['initialPromptPending', { initialPromptPending: true }],
    ['startupBlocked', { startupBlocked: true }],
    ['deliveringUntil in-flight lock', { deliveringUntil: now + 1 }],
    ['hasDraft', { hasDraft: true }],
    ['interruptedByUser', { interruptedByUser: true }],
  ] as [string, Partial<DeliveryState>][])('is false for new PTY safety gates: %s', (_n, patch) => {
    expect(deliverable({ ...base, ...patch }, now)).toBe(false);
  });

  it('unlocks once deliveringUntil expires', () => {
    expect(deliverable({ ...base, deliveringUntil: now }, now)).toBe(true);
  });
});

describe('PTY input guards & env Path normalization', () => {
  async function withFakePty(run: (mgr: SessionManager, session: ReturnType<SessionManager['spawn']>, writes: ReturnType<typeof vi.fn<(data: string) => void>>) => Promise<void>) {
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-draft-'));
    const writes = vi.fn<(data: string) => void>();
    vi.spyOn(pty, 'spawn').mockImplementation((() => ({
      pid: 9001, write: writes, onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; }, kill() {},
    })) as unknown as typeof pty.spawn);
    const mgr = new SessionManager({ port: 47899, token: 't', stateDir: tmp });
    try {
      const session = mgr.spawn({ taskId: 't1', projectId: 'p1', agent: 'fake', cwd: tmp, prompt: '' });
      mgr.hook({ sessionId: session.id, agent: 'fake', event: 'SessionStart', at: Date.now(), payload: { session_id: 'native' } });
      await run(mgr, session, writes);
    } finally {
      const closing = mgr.killAll();
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
      vi.useRealTimers();
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('releases a simple Backspace-cleared draft and debounces version-only events', async () => {
    await withFakePty(async (mgr, session, write) => {
      const broadcast = vi.fn();
      mgr.subscribe(broadcast);
      mgr.input(session.id, '草稿a');
      const seq = session.terminalDraftSeq!;
      mgr.input(session.id, '\x7f');
      mgr.input(session.id, '\x08');
      expect(session.terminalDraftSeq).toBe(seq + 2);
      expect(broadcast).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(broadcast).toHaveBeenCalledTimes(2);
      mgr.enqueue(session.id, 'wait for the draft');
      expect(mgr.getPendingInputs(session.id)).toMatchObject([{ state: 'queued', reason: 'terminal-draft' }]);
      mgr.input(session.id, '\x7f');
      expect(session.hasTerminalDraft).toBeUndefined();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(write).toHaveBeenCalledWith('wait for the draft');
    });
  });

  it('rejects stale edits before PTY writes and requires proof for a complex empty draft', async () => {
    await withFakePty(async (mgr, session, write) => {
      mgr.input(session.id, 'a');
      const stale = session.terminalDraftSeq!;
      mgr.input(session.id, '\x1b[D');
      mgr.input(session.id, '\x7f');
      const current = session.terminalDraftSeq!;
      expect(session.hasTerminalDraft).toBe(true);
      write.mockClear();
      expect(mgr.clearInput(session.id, '\x05\x15', stale)).toEqual({ ok: false, reason: 'stale', draftSeq: current });
      expect(mgr.clearInput(session.id, '\x05\x15', undefined, true)).toEqual({ ok: false, reason: 'stale', draftSeq: current });
      expect(mgr.sendDraft(session.id, stale)).toEqual({ ok: false, reason: 'stale', draftSeq: current });
      expect(mgr.sendDraft(session.id, undefined, true)).toEqual({ ok: false, reason: 'stale', draftSeq: current });
      expect(write).not.toHaveBeenCalled();
      expect(mgr.confirmEmptyDraft(session.id, stale)).toBe(false);
      expect(mgr.confirmEmptyDraft(session.id, current)).toBe(true);
      mgr.input(session.id, 'new draft');
      const next = session.terminalDraftSeq!;
      expect(mgr.sendDraft(session.id, next)).toMatchObject({ ok: true });
      expect(write.mock.calls).toEqual([['new draft'], ['\r']]);
      expect(session.hasTerminalDraft).toBeUndefined();
    });
  });

  it('stops on paste failure and retains interrupted inputs until cancellation', async () => {
    await withFakePty(async (mgr, session, write) => {
      write.mockImplementationOnce(() => { throw new Error('synthetic PTY write failure'); });
      const delivered = vi.fn();
      mgr.enqueue(session.id, 'failed first', { onDelivered: delivered });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(write.mock.calls).toEqual([['failed first']]);
      expect(delivered).not.toHaveBeenCalled();
      const [failed] = mgr.getPendingInputs(session.id);
      expect(failed).toMatchObject({ state: 'failed', reason: 'write-error', text: 'failed first' });
      expect(session.queued).toBe(0);
      mgr.enqueue(session.id, 'next to paste');
      await vi.advanceTimersByTimeAsync(250);
      expect(write).toHaveBeenCalledWith('next to paste');
      mgr.input(session.id, 'x');
      await vi.advanceTimersByTimeAsync(16_000);
      const [, interrupted] = mgr.getPendingInputs(session.id);
      expect(interrupted).toMatchObject({ state: 'uncertain', reason: 'interrupted', text: 'next to paste' });
      expect(write).not.toHaveBeenCalledWith('\r');
      expect(mgr.cancelPendingInput(session.id, failed.id)).toBe(true);
      expect(mgr.cancelPendingInput(session.id, interrupted.id)).toBe(true);
      expect(mgr.getPendingInputs(session.id)).toEqual([]);

      // Lossless server-side retry preserves full >64KB payload + attachment paths and only removes failed entry after re-enqueue.
      const hugePayload = `${'A'.repeat(70_000)}\nC:\\work\\attachments\\demo.png`;
      write.mockImplementationOnce(() => { throw new Error('synthetic PTY write failure'); });
      mgr.enqueue(session.id, hugePayload, { draftAction: 'ignore', draftSeq: session.terminalDraftSeq });
      await vi.advanceTimersByTimeAsync(3_500);
      const [hugeFailed] = mgr.getPendingInputs(session.id);
      expect(hugeFailed).toMatchObject({ state: 'failed', reason: 'write-error' });
      expect(hugeFailed.text).toBe(hugePayload);
      write.mockClear();
      expect(mgr.retryPendingInput(session.id, hugeFailed.id)).toBe(true);
      const pendingAfterRetry = mgr.getPendingInputs(session.id);
      expect(pendingAfterRetry).toHaveLength(1);
      expect(pendingAfterRetry[0]).toMatchObject({ state: 'queued', text: hugePayload });
    });
  });

  it('filters xterm focus, mouse, CPR, DA, and OSC responses while keeping real keys', () => {
    for (const seq of ['', '\x1b[I', '\x1b[O', '\x1b[I\x1b[O', '\x1b[<35;12;8M', '\x1b[<0;10;5m', '\x1b[12;40R', '\x1b[?62;22c', '\x1b]11;rgb:1111/1111/1111\x1b\\']) {
      expect(isTerminalReportSequence(seq)).toBe(true);
    }
    for (const real of ['a', '\r', '\x03', '\x1b', '\x1b[A', '\x1b[200~hello\x1b[201~', '\x1b[74;36;10;1;8;1_']) {
      expect(isTerminalReportSequence(real)).toBe(false);
    }
  });

  it('matches startup blocking dialogs through ConPTY ANSI cursor positioning', () => {
    expect(STARTUP_BLOCK_RE.test(stripAnsiForMatch('\x1b[32mHooks\x1b[1Cneed\x1b[1Creview\x1b[39m'))).toBe(true);
    expect(STARTUP_BLOCK_RE.test(stripAnsiForMatch('Do\x1b[1Cyou trust the files in this folder?'))).toBe(true);
    expect(STARTUP_BLOCK_RE.test(stripAnsiForMatch('1. Yes, continue\r\n2. No, exit'))).toBe(true);
    expect(STARTUP_BLOCK_RE.test(stripAnsiForMatch('FAKE AGENT 1234\n> '))).toBe(false);
  });

  it('prependEnvPath deduplicates case-variant Path keys on Windows', () => {
    const win = process.platform === 'win32';
    const [sys, legacy, shoal] = win ? ['C:\\Windows', 'C:\\Legacy', 'C:\\Shoal\\bin'] : ['/usr/bin', '/legacy', '/shoal/bin'];
    const env: Record<string, string> = { Path: sys, PATH: legacy };
    prependEnvPath(env, shoal);
    const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
    expect(pathKeys).toHaveLength(1);
    expect(env[pathKeys[0]]).toBe(`${shoal}${path.delimiter}${sys}`);
    prependEnvPath(env, shoal);
    expect(env[pathKeys[0]]).toBe(`${shoal}${path.delimiter}${sys}`);
  });

  it('blocks queued delivery on Ctrl+C / startup prompt, cancels 300ms Enter on typing, and marks systemInjected', async () => {
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sess-guard-'));
    const writes: string[] = [];
    let dataCb: (d: string) => void = () => {};
    let exitCb: (e: { exitCode: number }) => void = () => {};
    vi.spyOn(pty, 'spawn').mockImplementation((() => ({
      pid: 9001, cols: 120, rows: 36, process: 'codex', handleFlowControl: false,
      onData: (cb: (d: string) => void) => { dataCb = cb; return { dispose() {} }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; return { dispose() {} }; },
      write: (d: string) => { writes.push(d); },
      resize() {}, kill() { exitCb({ exitCode: 0 }); },
      pause() {}, resume() {}, clear() {},
    })) as typeof pty.spawn);

    const mgr = new SessionManager({ port: 47899, token: 't', stateDir: tmp });
    try {
      const s = mgr.spawn({ taskId: 't1', projectId: 'p1', agent: 'fake', cwd: tmp, prompt: '' });
      // Startup trust prompt blocks delivery until user confirms with Enter.
      dataCb('Do you trust the files in this folder?\n1. Yes\n2. No, exit');
      expect(mgr.enqueue(s.id, 'queued-msg', { system: true })).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toEqual([]);

      // User confirms trust prompt and waits past settle/typing windows -> delivery fires text, then user types in 300ms gap -> Enter cancelled!
      mgr.input(s.id, '\r');
      mgr.hook({ sessionId: s.id, agent: 'fake', event: 'SessionStart', at: Date.now(), payload: { session_id: 'n1', source: 'startup' } });
      await vi.advanceTimersByTimeAsync(5200);
      expect(writes).toContain('queued-msg');
      mgr.input(s.id, 'x'); // interrupts the 300ms Enter timer!
      await vi.advanceTimersByTimeAsync(500);
      expect(writes.filter(w => w === '\r')).toHaveLength(1); // only the user's earlier \r, NOT injected Enter!

      // Ctrl+C while a message is queued freezes queue until explicit Enter or non-system enqueue.
      expect(mgr.enqueue(s.id, 'after-ctrlc', { system: true })).toBe(true);
      mgr.input(s.id, '\x03');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).not.toContain('after-ctrlc');
      // Pressing Enter unfreezes and drains the queued item after typing quiet.
      mgr.input(s.id, '\r');
      await vi.advanceTimersByTimeAsync(5600);
      expect(writes).toContain('after-ctrlc');
      mgr.hook({ sessionId: s.id, agent: 'fake', event: 'UserPromptSubmit', at: Date.now(), payload: { session_id: 'n1', prompt: 'after-ctrlc' } });
      mgr.hook({ sessionId: s.id, agent: 'fake', event: 'Stop', at: Date.now(), payload: { session_id: 'n1' } });

      // Focus/mouse reports must NOT disturb typing quiet or cancel Enter.
      mgr.input(s.id, '\r');
      let delivered = false;
      expect(mgr.enqueue(s.id, 'clean-system', { system: true, onDelivered: () => { delivered = true; } })).toBe(true);
      await vi.advanceTimersByTimeAsync(5260);
      mgr.input(s.id, '\x1b[I\x1b[<0;1;1M'); // focus + mouse while waiting for 300ms Enter
      await vi.advanceTimersByTimeAsync(400);
      expect(writes).toContain('clean-system');
      expect(delivered).toBe(true);
      const hk = mgr.hook({ sessionId: s.id, agent: 'fake', event: 'UserPromptSubmit', at: Date.now(), payload: { session_id: 'n1', prompt: 'clean-system' } });
      expect(hk).toEqual({ userTurn: false, systemInjected: true });

      // StreamView terminal draft collision guard: hasTerminalDraft + terminalDraftSeq track uncommitted typing,
      // `draftAction: 'guard'` refuses to stomp on it, stale draftSeq is rejected, and two-phase `clearInput` ->
      // `confirmClearInput` keeps hasDraft locked on write error or unverified clear!
      mgr.hook({ sessionId: s.id, agent: 'fake', event: 'Stop', at: Date.now(), payload: { session_id: 'n1' } });
      await vi.advanceTimersByTimeAsync(2000);
      mgr.input(s.id, 'partial-draft');
      const draftInfo = mgr.list().find(x => x.id === s.id);
      expect(draftInfo?.hasTerminalDraft).toBe(true);
      expect(typeof draftInfo?.terminalDraftSeq).toBe('number');
      const seq1 = draftInfo!.terminalDraftSeq!;

      expect(mgr.enqueue(s.id, 'must-wait-for-draft', { draftAction: 'guard', immediate: true })).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).not.toContain('must-wait-for-draft');

      // Unsafe clearInput payloads (Enter, Ctrl+C, printable text) are rejected.
      expect(mgr.clearInput(s.id, '\r')).toBe(false);
      expect(mgr.clearInput(s.id, '\x03')).toBe(false);
      expect(mgr.clearInput(s.id, 'rm -rf')).toBe(false);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBe(true);

      // Phase 2 cannot unlock without a prior matching clearInput() or without an explicit draftSeq.
      expect(mgr.confirmClearInput(s.id)).toBe(false);
      expect(mgr.confirmClearInput(s.id, seq1)).toBe(false);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBe(true);

      // Enqueue without draftAction or with unversioned/stale ignore must NOT unlock a live draft!
      expect(mgr.enqueue(s.id, 'default-still-guarded')).toBe(true);
      expect(mgr.enqueue(s.id, 'unversioned-ignore', { draftAction: 'ignore' })).toBe(true);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBe(true);

      // Phase 1 clearInput writes control sequence ONLY and does NOT unlock hasDraft until verified!
      expect(mgr.clearInput(s.id, '\x05\x15')).toBe(true);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(writes).not.toContain('must-wait-for-draft');

      // Newer user typing invalidates both the prior clearInput() and seq1: confirmClearInput must reject seq1 AND seq2!
      mgr.input(s.id, '2');
      const seq2 = mgr.list().find(x => x.id === s.id)!.terminalDraftSeq!;
      expect(seq2).toBeGreaterThan(seq1);
      expect(mgr.confirmClearInput(s.id, seq1)).toBe(false);
      expect(mgr.confirmClearInput(s.id, seq2)).toBe(false);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBe(true);

      // Fresh Phase 1 clearInput + matching seq2 in Phase 2 unlocks hasTerminalDraft and drains immediately!
      expect(mgr.clearInput(s.id, '\x05\x15')).toBe(true);
      expect(mgr.confirmClearInput(s.id, seq2)).toBe(true);
      expect(mgr.list().find(x => x.id === s.id)?.hasTerminalDraft).toBeUndefined();
      expect(mgr.list().find(x => x.id === s.id)?.terminalDraftSeq).toBeUndefined();
      await vi.advanceTimersByTimeAsync(400);
      expect(writes).toContain('must-wait-for-draft');
    } finally {
      await mgr.killAll();
      vi.useRealTimers();
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('enterReady scales floor for Codex, waits for PTY echo silence, and caps at max wait', () => {
    expect(enterReady({ agent: 'claude', chars: 5000, injectAt: 1000, lastOutAt: 1000, now: 1000 })).toEqual({ ready: false, nextDelayMs: 300 });
    expect(enterReady({ agent: 'claude', chars: 5000, injectAt: 1000, lastOutAt: 1000, now: 1300 })).toEqual({ ready: true, nextDelayMs: 0 });
    expect(enterReady({ agent: 'claude', chars: 5000, injectAt: 1000, lastOutAt: 1220, now: 1300 })).toEqual({ ready: false, nextDelayMs: 70 });
    expect(enterReady({ agent: 'claude', chars: 5000, injectAt: 1000, lastOutAt: 1220, now: 1370 })).toEqual({ ready: true, nextDelayMs: 0 });

    expect(enterReady({ agent: 'codex', chars: 1747, injectAt: 1000, lastOutAt: 900, now: 1000 })).toEqual({ ready: false, nextDelayMs: 1174 });
    expect(enterReady({ agent: 'codex', chars: 1747, injectAt: 1000, lastOutAt: 1280, now: 1300 })).toEqual({ ready: false, nextDelayMs: 874 });
    expect(enterReady({ agent: 'codex', chars: 1747, injectAt: 1000, lastOutAt: 1746, now: 2174 })).toEqual({ ready: true, nextDelayMs: 0 });
    expect(enterReady({ agent: 'codex', chars: 1747, injectAt: 1000, lastOutAt: 2100, now: 2174 })).toEqual({ ready: false, nextDelayMs: 176 });
    expect(enterReady({ agent: 'codex', chars: 1747, injectAt: 1000, lastOutAt: 2100, now: 2350 })).toEqual({ ready: true, nextDelayMs: 0 });
    expect(enterReady({ agent: 'codex', chars: 20_000, injectAt: 1000, lastOutAt: 12_990, now: 13_000 })).toEqual({ ready: true, nextDelayMs: 0 });
  });

  it('holds Codex rework Enter until paste echo drains, blocks queued interleave, and cancels on user input', async () => {
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codex-rework-'));
    const writes: string[] = [];
    let dataCb: (d: string) => void = () => {};
    let exitCb: (e: { exitCode: number }) => void = () => {};
    vi.spyOn(pty, 'spawn').mockImplementation((() => ({
      pid: 9002, cols: 114, rows: 51, process: 'codex', handleFlowControl: false,
      onData: (cb: (d: string) => void) => { dataCb = cb; return { dispose() {} }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; return { dispose() {} }; },
      write: (d: string) => { writes.push(d); },
      resize() {}, kill() { exitCb({ exitCode: 0 }); },
      pause() {}, resume() {}, clear() {},
    })) as typeof pty.spawn);

    const mgr = new SessionManager({ port: 47899, token: 't', stateDir: tmp });
    try {
      const s = mgr.spawn({ taskId: 'tc', projectId: 'p1', agent: 'codex', cwd: tmp, prompt: 'round1' });
      dataCb('\x1b[?2004h');
      mgr.hook({ sessionId: s.id, agent: 'codex', event: 'SessionStart', at: Date.now(), payload: { session_id: 'c1', source: 'startup' } });
      mgr.hook({ sessionId: s.id, agent: 'codex', event: 'UserPromptSubmit', at: Date.now(), payload: { session_id: 'c1' } });
      mgr.hook({ sessionId: s.id, agent: 'codex', event: 'Stop', at: Date.now(), payload: { session_id: 'c1' } });
      await vi.advanceTimersByTimeAsync(2000);

      const reworkText = '返工复核意见\n' + 'x'.repeat(1740);
      let firstDelivered = false;
      expect(mgr.enqueue(s.id, reworkText, { system: true, onDelivered: () => { firstDelivered = true; } })).toBe(true);
      expect(mgr.enqueue(s.id, 'second-queued', { system: true })).toBe(true);

      await vi.advanceTimersByTimeAsync(260);
      expect(writes).toHaveLength(1);
      // Codex only needs the win32-input-mode newline under ConPTY; elsewhere a plain \n separates lines.
      expect(writes[0]).toContain(process.platform === 'win32' ? CODEX_NEWLINE : '\n');

      for (let step = 0; step < 14; step++) {
        await vi.advanceTimersByTimeAsync(100);
        dataCb('echo-chunk');
      }
      expect(writes).toHaveLength(1);
      expect(firstDelivered).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(writes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toBe('\r');
      expect(firstDelivered).toBe(true);
      const hk = mgr.hook({ sessionId: s.id, agent: 'codex', event: 'UserPromptSubmit', at: Date.now(), payload: { session_id: 'c1' } });
      expect(hk).toEqual({ userTurn: false, systemInjected: true });

      mgr.hook({ sessionId: s.id, agent: 'codex', event: 'Stop', at: Date.now(), payload: { session_id: 'c1' } });
      // Codex sandbox init temporarily disables the composer right after Stop; queue must hold until Sandbox ready + settle.
      dataCb('• Setting up sandbox... (0s)\r\n› Input disabled until setup completes.');
      await vi.advanceTimersByTimeAsync(5000);
      expect(writes.some(w => w.includes('second-queued'))).toBe(false);

      dataCb('\r\n• Sandbox ready');
      await vi.advanceTimersByTimeAsync(300);
      expect(writes.some(w => w.includes('second-queued'))).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(writes.some(w => w.includes('second-queued'))).toBe(true);
      const countBeforeType = writes.filter(w => w === '\r').length;
      mgr.input(s.id, 'a');
      await vi.advanceTimersByTimeAsync(2000);
      expect(writes.filter(w => w === '\r')).toHaveLength(countBeforeType);
    } finally {
      await mgr.killAll();
      vi.useRealTimers();
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('trackModes / modePrefix', () => {
  it('keeps the last state of replay-relevant modes, across combined and repeated sequences', () => {
    const modes = new Map<number, boolean>();
    trackModes(modes, '\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[?1000;1006h\x1b[?1003h');
    trackModes(modes, 'text\x1b[?1003l\x1b[?25h');
    expect(modePrefix(modes)).toBe('\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[?1006h');
    trackModes(modes, '\x1b[?1049l\x1b[?1000;1006l');
    expect(modePrefix(modes)).toBe('\x1b[?2004h');
  });
});

describe('agy hook filtering, intermediate Stop, and self-healing resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('agyPrimaryWorkspaces requires both project cwd and <stateDir>/agy-hooks across slash/case variants', () => {
    // Host-shaped absolute paths: normPath resolves against the host, so Windows drive paths mean nothing on POSIX.
    const win = process.platform === 'win32';
    const proj = win ? 'G:\\Workspace\\agent-workbench' : '/Workspace/agent-workbench';
    const game = win ? 'G:\\H5-game\\x' : '/H5-game/x';
    const state = win ? 'C:\\Users\\Admin\\AppData\\Local\\wb' : '/Users/Admin/Library/wb';
    const fwd = (p: string) => p.replaceAll('\\', '/');
    const hooks = `${fwd(state)}/agy-hooks`;
    expect(agyPrimaryWorkspaces(proj, state, [hooks, fwd(proj)])).toBe(true);
    // Nested `agy -p` run from agy-hooks lacks project cwd.
    expect(agyPrimaryWorkspaces(proj, state, [hooks])).toBe(false);
    // Branched worker workspace lacks main project cwd.
    expect(agyPrimaryWorkspaces(proj, state, [hooks, `${fwd(proj)}-share-1`])).toBe(false);
    // A folder agy does not trust yet is left out of workspacePaths: only the folders Shoal added remain.
    const collab = `${state}${win ? '\\' : '/'}collab${win ? '\\' : '/'}p1`;
    const untrusted = [hooks, `${fwd(state)}/collab/p1`];
    expect(agyPrimaryWorkspaces(game, state, untrusted, collab)).toBe(true);
    expect(agyPrimaryWorkspaces(game, state, [...untrusted, `${fwd(state)}/agy-instructions`], collab)).toBe(true);
    // ...but not when the collab folder is another project's, missing, or joined by a folder Shoal did not add.
    expect(agyPrimaryWorkspaces(game, state, untrusted, collab.replace('p1', 'p2'))).toBe(false);
    expect(agyPrimaryWorkspaces(game, state, untrusted)).toBe(false);
    expect(agyPrimaryWorkspaces(game, state, [...untrusted, `${fwd(game)}-share-1`], collab)).toBe(false);
    expect(agyPrimaryWorkspaces(game, state, [`${fwd(state)}/collab/p1`], collab)).toBe(false);
    expect(isAgyIntermediateStop({ fullyIdle: false, continuationActive: false, error: '' })).toBe(true);
    expect(isAgyIntermediateStop({ fullyIdle: true, continuationActive: true, error: '' })).toBe(true);
    expect(isAgyIntermediateStop({ fullyIdle: false, error: 'RESOURCE_EXHAUSTED (code 429)' })).toBe(false);
    expect(isAgyIntermediateStop({ fullyIdle: true, continuationActive: false, error: '' })).toBe(false);
  });

  it('keeps main conversation across subagents/swarm/nested CLI, suppresses intermediate Stop, counts subagent tokens, and resumes cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agy-e2e-'));
    const stateDir = path.join(tmp, 'state');
    const projDir = path.join(tmp, 'proj');
    const agyCfg = path.join(tmp, 'agy-cfg');
    const fakeLocal = path.join(tmp, 'local');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(fakeLocal, 'agy', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fakeLocal, 'agy', 'bin', 'agy.exe'), '');

    const prevAgy = process.env.AGY_CONFIG_DIR;
    const prevLocal = process.env.LOCALAPPDATA;
    const prevPath = process.env.PATH;
    process.env.AGY_CONFIG_DIR = agyCfg;
    process.env.LOCALAPPDATA = fakeLocal;
    if (process.platform !== 'win32') {
      // POSIX finds agy on PATH, not under LOCALAPPDATA.
      const agyBin = path.join(fakeLocal, 'agy', 'bin');
      fs.writeFileSync(path.join(agyBin, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = `${agyBin}${path.delimiter}${prevPath ?? ''}`;
    }

    const MAIN = 'ae1cac0a-c6a3-47d3-968f-06ba2f139408';
    const REV3 = '27e3af25-4cf9-449a-abb1-a1a9067c3ee7';
    const FORKED = '55555555-5555-4555-8555-555555555555';
    const NESTED = '8d41fe36-576f-43a3-ba8f-23781cf46302';
    const SWITCHED = 'bca98099-0a5e-4cc7-9669-b66e40a5b579';

    const writeBrain = (id: string, entries: unknown[]) => {
      const full = path.join(agyCfg, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      return full;
    };

    const nowIso = new Date().toISOString();
    const mainTp = writeBrain(MAIN, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>三角度评审</USER_REQUEST>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, input_tokens: 1000, output_tokens: 200, content: '已派生3个评审子代理' },
    ]);
    const rev3Tp = writeBrain(REV3, [
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: nowIso, content: `[Message] sender=${MAIN} content=Audit Angle 3` },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, input_tokens: 500, output_tokens: 100, content: 'VERDICT: REVISE（子代理内部汇报）' },
    ]);
    // Forked swarm worker copies step 0 USER_EXPLICIT from coordinator, so only live lastUserInput="" distinguishes it!
    const forkedTp = writeBrain(FORKED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>三角度评审</USER_REQUEST>' },
      { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', created_at: nowIso, content: `[Message] sender=${MAIN} content=You have just started.` },
    ]);
    const nestedTp = writeBrain(NESTED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>Do not use any tools.</USER_REQUEST>' },
    ]);
    const switchedTp = writeBrain(SWITCHED, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>手动切到的新主会话</USER_REQUEST>' },
    ]);

    const spawns: { file: string; args: string[]; exit: (code: number) => void }[] = [];
    vi.spyOn(pty, 'spawn').mockImplementation(((file: string, args: string[]) => {
      let exitCb: ((e: { exitCode: number }) => void) | null = null;
      const rec = { file, args: [...args], exit: (exitCode: number) => exitCb?.({ exitCode }) };
      spawns.push(rec);
      return {
        pid: 1000 + spawns.length, cols: 120, rows: 36, process: 'agy', handleFlowControl: false,
        onData: () => ({ dispose() {} }),
        onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb; return { dispose() {} }; },
        write() {}, resize() {}, kill() { exitCb?.({ exitCode: 0 }); },
        pause() {}, resume() {}, clear() {},
      } as unknown as pty.IPty;
    }) as typeof pty.spawn);

    const token = 'test-hook-token';
    const store = createFileStore(path.join(stateDir, 'state.json'));
    // Probe ephemeral port via server.listen(0): build sessions with placeholder port and bind once known.
    const sessions = new SessionManager({ port: 0, token, stateDir });
    const usage = createUsage({
      stateDir,
      source: {
        sessions: () => sessions.list(),
        tasks: () => store.tasks(),
        projects: () => store.projects(),
      },
    });
    // Listen on port 0 by reading dynamic host after bind; createApp checks Host against cfg.port, so pick a free port first.
    const net = await import('node:net');
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(err => (err ? reject(err) : resolve(p)));
      });
    });
    const app = createApp({ port: freePort, token, store, sessions, stateDir, usage });
    await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${freePort}`;
    const api = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: res.status === 204 ? null : await res.json() };
    };
    const postHook = (sessionId: string, event: string, payload: Record<string, unknown>) =>
      fetch(`${base}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, agent: 'agy', event, at: Date.now(), payload }),
      });

    try {
      const ws = [projDir.replaceAll('\\', '/'), path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')];
      const proj = (await api('POST', '/api/projects', { name: 'AgyProj', path: projDir })).json;
      const created = (await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', title: '评审优化', prompt: '三角度评审' })).json;
      const taskId: string = created.task.id;
      const sid1: string = created.session.id;

      // 1. Main conversation starts and enters working state.
      await postHook(sid1, 'SessionStart', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      await postHook(sid1, 'PreInvocation', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      expect(store.getSession(sid1)?.nativeSessionId).toBe(MAIN);
      expect(store.getSession(sid1)?.status).toBe('working');

      // 2. Main pauses turn to wait on async subagents (`fullyIdle: false`) -> stays `working`, no premature review card!
      await postHook(sid1, 'Stop', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, fullyIdle: false, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium' });
      expect(store.getSession(sid1)?.status).toBe('working');
      expect(store.getTask(taskId)?.phase).toBe('active');
      expect(store.cards()).toHaveLength(0);

      // 3. Subagent (`reviewer-3`), forked swarm worker (`lastUserInput: ""`), and nested `agy -p` all fire hooks.
      for (const ev of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']) {
        await postHook(sid1, ev, {
          conversationId: REV3, lastUserInput: '', transcriptPath: rev3Tp, workspacePaths: ws,
          fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium',
        });
        await postHook(sid1, ev, {
          conversationId: FORKED, lastUserInput: '', transcriptPath: forkedTp, workspacePaths: ws,
          fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-argon-medium',
        });
      }
      await postHook(sid1, 'SessionStart', {
        conversationId: NESTED, lastUserInput: 'Do not use any tools.', transcriptPath: nestedTp,
        workspacePaths: [path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')], modelName: 'gemini-3.8-flash-high',
      });
      await postHook(sid1, 'Stop', {
        conversationId: NESTED, lastUserInput: 'Do not use any tools.', transcriptPath: nestedTp,
        workspacePaths: [path.join(stateDir, 'agy-hooks').replaceAll('\\', '/')], fullyIdle: true, error: '', modelName: 'gemini-3.8-flash-high',
      });

      // Primary session & task remain 100% anchored on MAIN!
      expect(store.getSession(sid1)?.nativeSessionId).toBe(MAIN);
      expect(store.getSession(sid1)?.transcriptPath).toBe(mainTp);
      expect(store.getSession(sid1)?.status).toBe('working');
      expect(store.getTask(taskId)?.phase).toBe('active');
      expect(store.cards()).toHaveLength(0);

      // Yet token usage still includes BOTH MAIN (1000+200) and REV3 (500+100)!
      const report = (await api('GET', '/api/usage')).json;
      expect(report.total.input + report.total.output).toBe(1800);

      // 4. Main wakes up when subagents complete, writes final synthesis, and emits terminal Stop (`fullyIdle: true`).
      const activeBeforeLoop = store.getTask(taskId)?.lastActiveAt ?? 0;
      fs.appendFileSync(mainTp, JSON.stringify({
        step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, content: '三轮汇总完毕，请验收。',
      }) + '\n');
      await postHook(sid1, 'PreInvocation', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      await postHook(sid1, 'Stop', { conversationId: MAIN, lastUserInput: '三角度评审', transcriptPath: mainTp, workspacePaths: ws, fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium' });
      // Mid-turn PreInvocation and Stop must NOT bump lastActiveAt (prevents sidebar rows jumping while agents work).
      expect(store.getTask(taskId)?.lastActiveAt).toBe(activeBeforeLoop);

      // A genuine follow-up user turn once idle (`needs_you` -> `working`) DOES bump lastActiveAt.
      await new Promise(r => setTimeout(r, 5));
      await postHook(sid1, 'PreInvocation', { conversationId: MAIN, lastUserInput: '再补一个单测', transcriptPath: mainTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium' });
      expect((store.getTask(taskId)?.lastActiveAt ?? 0) > activeBeforeLoop).toBe(true);
      await postHook(sid1, 'Stop', { conversationId: MAIN, lastUserInput: '再补一个单测', transcriptPath: mainTp, workspacePaths: ws, fullyIdle: true, continuationActive: false, error: '', modelName: 'gemini-4-carbon-medium' });

      expect(store.getSession(sid1)?.status).toBe('needs_you');
      expect(store.getTask(taskId)?.phase).toBe('review');
      expect(store.cards()).toHaveLength(2);
      expect(store.cards()[0].body).toContain('三轮汇总完毕，请验收。');

      // 5. Server restart / process exit -> clicking Resume passes `--conversation <MAIN>`, NOT reviewer-3!
      spawns[0].exit(0);
      const resumed = await api('POST', `/api/tasks/${taskId}/resume`, {});
      expect(resumed.status).toBe(200);
      expect(spawns[1].args.slice(0, 2)).toEqual(['--conversation', MAIN]);
      const sid2: string = resumed.json.session.id;

      // 6. Genuine interactive `/resume` inside agy TUI (fires PreInvocation with non-empty lastUserInput & full workspaces) tracks!
      await postHook(sid2, 'PreInvocation', {
        conversationId: SWITCHED, lastUserInput: '继续新会话', transcriptPath: switchedTp, workspacePaths: ws, modelName: 'gemini-4-carbon-medium',
      });
      expect(store.getSession(sid2)?.nativeSessionId).toBe(SWITCHED);

      // 7. Historical poisoned session in state.json (`nativeSessionId = REV3`) self-heals to MAIN on Resume!
      const poisonedTaskId = 'poisoned-task';
      const poisonedSid = 'poisoned-session';
      store.addTask({
        id: poisonedTaskId, projectId: proj.id, title: '旧污染任务', titleAuto: false, prompt: 'x', color: '#888',
        agent: 'agy', sessionId: poisonedSid, createdAt: Date.now(), phase: 'review', phaseSince: Date.now(),
      });
      const poisonedSession = {
        id: poisonedSid, taskId: poisonedTaskId, agent: 'agy' as const, nativeSessionId: REV3, resumable: true,
        transcriptPath: rev3Tp, status: 'exited' as const, statusSince: Date.now(), startedAt: Date.now(), exitCode: 0, cols: 120, rows: 36,
      };
      store.saveSession(poisonedSession);
      sessions.restore([poisonedSession]);

      const healed = await api('POST', `/api/tasks/${poisonedTaskId}/resume`, {});
      expect(healed.status).toBe(200);
      expect(spawns[2].args.slice(0, 2)).toEqual(['--conversation', MAIN]);

      // 8. A project folder agy does not trust yet is missing from workspacePaths (only agy-hooks + collab remain).
      //    The session is still the primary one: it gets the conversation id (resumable) and its Stop becomes a result.
      const UNTRUSTED = '413ef5ee-9aab-45e1-bc22-28731c5ac250';
      const untrustedTp = writeBrain(UNTRUSTED, [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>跑一批视频</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: nowIso, content: 'Colab 只分到 L4，任务未运行。' },
      ]);
      const fresh = (await api('POST', '/api/tasks', { projectId: proj.id, agent: 'agy', title: '新文件夹', prompt: '跑一批视频' })).json;
      const sidU: string = fresh.session.id;
      const wsU = [path.join(stateDir, 'agy-hooks'), path.join(stateDir, 'collab', proj.id)].map(p => p.replaceAll('\\', '/'));
      const base8 = { conversationId: UNTRUSTED, lastUserInput: '跑一批视频', transcriptPath: untrustedTp, workspacePaths: wsU, cwd: path.join(stateDir, 'agy-hooks') };
      await postHook(sidU, 'SessionStart', base8);
      await postHook(sidU, 'PreInvocation', base8);
      expect(store.getSession(sidU)?.nativeSessionId).toBe(UNTRUSTED);
      expect(store.getSession(sidU)?.status).toBe('working');
      await postHook(sidU, 'Stop', { ...base8, fullyIdle: true, continuationActive: false, error: '' });
      expect(store.getSession(sidU)?.status).toBe('needs_you');
      expect(store.getTask(fresh.task.id)?.phase).toBe('review');
      expect(store.cards().some(c => c.taskId === fresh.task.id && c.body.includes('Colab 只分到 L4'))).toBe(true);
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
      if (prevAgy === undefined) delete process.env.AGY_CONFIG_DIR; else process.env.AGY_CONFIG_DIR = prevAgy;
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
      if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('agyHookDisposition handles RateLimits and initial subagent guard', () => {
    expect(agyHookDisposition({ currentId: null, event: 'RateLimits', payload: {}, cwd: '/p', stateDir: '/s' })).toEqual({ kind: 'primary' });
    expect(agyHookDisposition({ currentId: null, event: 'SessionStart', payload: {}, cwd: '/p', stateDir: '/s' })).toEqual({ kind: 'ignore' });
  });
});

describe('shutdown & Windows ConPTY process-tree cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/shutdown returns 202 with server pid', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shutdown-'));
    const net = await import('node:net');
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(err => (err ? reject(err) : resolve(p)));
      });
    });
    const store = createFileStore(path.join(tmp, 'state.json'));
    const sessions = new SessionManager({ port: freePort, token: 't', stateDir: tmp });
    const usage = createUsage({
      stateDir: tmp,
      source: { sessions: () => sessions.list(), tasks: () => store.tasks(), projects: () => store.projects() },
    });
    const onShutdown = vi.fn();
    const app = createApp({ port: freePort, token: 't', store, sessions, stateDir: tmp, usage, onShutdown });
    await new Promise<void>(resolve => app.server.listen(freePort, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${freePort}/api/shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ pid: process.pid });
      await new Promise(r => setImmediate(r));
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await sessions.killAll();
      await new Promise<void>(resolve => app.server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it.runIf(process.platform === 'win32')('killAll terminates real ConPTY tree and resolves promptly', async () => {
    vi.restoreAllMocks();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-conpty-kill-'));
    const binDir = path.join(tmp, 'bin');
    const pidFile = path.join(tmp, 'grandchild.pid');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'shoal.cmd'),
      `@echo off\r\n"%WORKBENCH_NODE%" -e "require('fs').writeFileSync(process.env.TEST_PID_FILE, String(process.pid)); setTimeout(() => {}, 30000);"\r\n`,
    );

    const prevPidFile = process.env.TEST_PID_FILE;
    process.env.TEST_PID_FILE = pidFile;

    const origSpawn = pty.spawn;
    let realProc: pty.IPty | undefined;
    vi.spyOn(pty, 'spawn').mockImplementation(((...args: Parameters<typeof pty.spawn>) => {
      realProc = origSpawn(...args);
      return realProc;
    }) as typeof pty.spawn);

    const mgr = new SessionManager({ port: 47898, token: 't', stateDir: tmp });
    let buf = '';
    const unsub = mgr.subscribe(m => {
      if (m.t === 'out') buf += m.d;
    });

    const waitFor = async (pred: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ConPTY state');
        await new Promise(r => setTimeout(r, 50));
      }
    };
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const info = mgr.spawn({ taskId: 't-conpty', projectId: 'p-conpty', agent: 'fake', cwd: os.tmpdir(), prompt: '' });
      await waitFor(() => buf.includes('FAKE AGENT'));
      mgr.input(info.id, 'shoal hold\r');
      await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8').trim()) > 0);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(isAlive(realProc!.pid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      const started = Date.now();
      await mgr.killAll();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(info.exitCode).not.toBeNull();
      await waitFor(() => !isAlive(realProc!.pid) && !isAlive(grandchildPid), 1500);
      expect(isAlive(realProc!.pid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      unsub();
      await mgr.killAll();
      if (prevPidFile === undefined) delete process.env.TEST_PID_FILE; else process.env.TEST_PID_FILE = prevPidFile;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  });
});
