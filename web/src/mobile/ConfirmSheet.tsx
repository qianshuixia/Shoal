import { useRef, useState } from 'react';
import { useBackLayer } from './useBackLayer.ts';

/**
 * In-app confirmation bottom sheet. It is one back-stack layer: the system back key cancels it and leaves the layers
 * underneath open. Render it only while a confirmation is pending; `onConfirm` runs after the layer's entry is popped.
 */
export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  // The first of confirm / cancel wins, set synchronously on the tap: neither a second tap, the other button nor the
  // system back key may fire onConfirm / onCancel after it.
  const settledRef = useRef<'confirm' | 'cancel' | null>(null);
  const [settled, setSettled] = useState(false);
  const layer = useBackLayer(true, () => {
    if (settledRef.current !== 'confirm') onCancel();
  });
  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = 'cancel';
    setSettled(true);
    layer.close();
  };
  return (
    <div className="mob-sheet-backdrop mob-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="mob-sheet" data-testid="mobile-confirm-sheet" role="alertdialog" aria-label={title}>
        <h3>{title}</h3>
        <div className="mob-sub" style={{ whiteSpace: 'normal', fontSize: '0.875rem', color: 'var(--text-2)' }} data-testid="mobile-confirm-message">{message}</div>
        <button
          type="button"
          className={`mob-btn ${danger ? 'danger' : 'primary'}`}
          data-testid="mobile-confirm-ok"
          disabled={settled}
          onClick={() => {
            if (settledRef.current) return;
            settledRef.current = 'confirm';
            setSettled(true);
            layer.popThen(onConfirm);
          }}
        >{confirmLabel}</button>
        <button type="button" className="mob-btn ghost" data-testid="mobile-confirm-cancel" disabled={settled} onClick={cancel}>取消</button>
      </div>
    </div>
  );
}
