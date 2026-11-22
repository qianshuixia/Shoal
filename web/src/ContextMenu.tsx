import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface FsClipboardItem {
  mode: 'copy' | 'cut';
  projectId: string;
  path: string; // POSIX relative path inside project
  name: string;
  kind: 'file' | 'dir';
}

export type ContextMenuEntry =
  | { kind: 'sep'; id?: string }
  | {
    kind?: 'item';
    id: string;
    label: string;
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    onSelect(): void;
  };

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

export interface FsMutationEvent {
  seq: number;
  kind: 'move' | 'copy';
  sourceProjectId?: string;
  sourcePath?: string;
  targetProjectId: string;
  targetDir: string;
  movedTo?: string;
}

export const isMacClient = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

const isPosixClient = (): boolean =>
  typeof navigator !== 'undefined' && !/Win/i.test(navigator.platform || navigator.userAgent);

export function joinProjectPath(projectPath: string, relPosix: string): string {
  const cleanRel = relPosix.replace(/^[/\\]+/, '');
  if (!cleanRel) return projectPath;
  const useBackslash = projectPath.includes('\\') && !projectPath.startsWith('/');
  const sep = useBackslash ? '\\' : '/';
  const base = projectPath.replace(/[/\\]+$/, '');
  const tail = useBackslash ? cleanRel.replace(/\//g, '\\') : cleanRel.replace(/\\/g, '/');
  return `${base}${sep}${tail}`;
}

// Rejects control characters (CR/LF/ESC) and shell-ambiguous interpolation characters on Windows (where cmd.exe and
// PowerShell quoting rules conflict). Safe plain/spaced paths are quoted unambiguously.
export function formatPathForTerminal(rawPath: string): string | null {
  if (!rawPath || /[\x00-\x1f\x7f]/.test(rawPath)) return null;
  if (isPosixClient()) {
    if (!/[\s"'`$&|;<>()[\]{}*?~!#\\]/.test(rawPath)) return rawPath;
    return `'${rawPath.replace(/'/g, "'\\''")}'`;
  }
  // On Windows, %VAR% (cmd) and $var / ` (PowerShell) have incompatible quoting rules across shells: refuse ambiguous chars.
  if (/[%$`"'!;|<>&()\r\n]/.test(rawPath)) return null;
  return /\s/.test(rawPath) ? `"${rawPath}"` : rawPath;
}

export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
}

export function contextMenuPointForElement(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(24, r.width / 2)), y: Math.round(r.bottom) };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback (e.g., restricted context / WebView focus quirk).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const selectedRef = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: state?.x ?? 0,
    top: state?.y ?? 0,
  }));

  useLayoutEffect(() => {
    if (!state) return;
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = state.x;
    let top = state.y;
    if (left + rect.width + pad > vw) left = Math.max(pad, state.x - rect.width);
    if (top + rect.height + pad > vh) top = Math.max(pad, state.y - rect.height);
    left = Math.max(pad, Math.min(left, Math.max(pad, vw - rect.width - pad)));
    top = Math.max(pad, Math.min(top, Math.max(pad, vh - rect.height - pad)));
    setPos({ left, top });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    selectedRef.current = false;
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });

    const restoreFocus = () => {
      if (selectedRef.current) return;
      const prev = prevFocusRef.current;
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        onClose();
        restoreFocus();
      }
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) {
        onClose();
        restoreFocus();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        restoreFocus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button.ctx-item:not(:disabled)') ?? [])];
      if (!btns.length) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Home') btns[0]?.focus();
      else if (e.key === 'End') btns[btns.length - 1]?.focus();
      else if (e.key === 'ArrowDown') btns[(idx + 1 + btns.length) % btns.length]?.focus();
      else if (e.key === 'ArrowUp') btns[(idx <= 0 ? btns.length - 1 : idx - 1)]?.focus();
    };
    const dismiss = () => {
      onClose();
      restoreFocus();
    };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('contextmenu', away, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('contextmenu', away, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [state, onClose]);

  if (!state) return null;

  // Trim leading/trailing or consecutive separators automatically.
  const normalized: ContextMenuEntry[] = [];
  for (const item of state.items) {
    if (item.kind === 'sep') {
      if (normalized.length > 0 && normalized[normalized.length - 1]?.kind !== 'sep') {
        normalized.push(item);
      }
    } else {
      normalized.push(item);
    }
  }
  while (normalized.length > 0 && normalized[normalized.length - 1]?.kind === 'sep') {
    normalized.pop();
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {normalized.map((entry, idx) =>
        entry.kind === 'sep' ? (
          <div key={entry.id ?? `sep-${idx}`} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={`ctx-item${entry.danger ? ' danger' : ''}`}
            data-testid={`ctx-${entry.id}`}
            disabled={entry.disabled}
            onClick={() => {
              selectedRef.current = true;
              const prev = prevFocusRef.current;
              onClose();
              entry.onSelect();
              // If the selected action did not move focus (e.g. Copy path / Copy / Cut), restore keyboard focus cleanly.
              queueMicrotask(() => {
                if (prev && prev.isConnected && (!document.activeElement || document.activeElement === document.body)) {
                  prev.focus({ preventScroll: true });
                }
              });
            }}
          >
            <span className="ctx-label">{entry.label}</span>
            {entry.hint && <span className="ctx-hint">{entry.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export interface NamePromptConfig {
  title: string;
  label: string;
  placeholder?: string;
  initialValue: string;
  submitLabel: string;
  selectStem?: boolean;
  onSubmit(value: string): Promise<string | null> | string | null;
}

export function NamePromptDialog({ config, onClose }: { config: NamePromptConfig | null; onClose(): void }) {
  const [value, setValue] = useState(config?.initialValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!config) return;
    setValue(config.initialValue);
    setError(null);
    setBusy(false);
    const raf = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (config.selectStem && config.initialValue) {
        const dot = config.initialValue.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : config.initialValue.length);
      } else {
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [config]);

  if (!config) return null;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('名称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const err = await config.onSubmit(trimmed);
      if (err) {
        setError(err);
        setBusy(false);
      } else {
        onClose();
      }
    } catch (e) {
      setError((e as Error).message || '操作失败');
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      data-testid="name-prompt-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="modal ctx-prompt-dialog"
        data-testid="name-prompt-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h3>{config.title}</h3>
        <label>
          <span>{config.label}</span>
          <input
            ref={inputRef}
            type="text"
            data-testid="name-prompt-input"
            placeholder={config.placeholder}
            value={value}
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
          />
        </label>
        {error && <div className="form-error" data-testid="name-prompt-error">{error}</div>}
        <div className="actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" data-testid="name-prompt-submit" disabled={busy || !value.trim()}>
            {busy ? '处理中…' : config.submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
