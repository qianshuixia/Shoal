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
  // Once confirmed, neither a second tap nor the system back key may fire onConfirm / onCancel again.
  const confirmedRef = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const layer = useBackLayer(true, () => {
    if (!confirmedRef.current) onCancel();
  });
  return (
    <div className="mob-sheet-backdrop mob-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !confirmedRef.current && layer.close()}>
      <div className="mob-sheet" data-testid="mobile-confirm-sheet" role="alertdialog" aria-label={title}>
        <h3>{title}</h3>
        <div className="mob-sub" style={{ whiteSpace: 'normal', fontSize: '0.875rem', color: 'var(--text-2)' }} data-testid="mobile-confirm-message">{message}</div>
        <button
          type="button"
          className={`mob-btn ${danger ? 'danger' : 'primary'}`}
          data-testid="mobile-confirm-ok"
          disabled={confirmed}
          onClick={() => {
            if (confirmedRef.current) return;
            confirmedRef.current = true;
            setConfirmed(true);
            layer.popThen(onConfirm);
          }}
        >{confirmLabel}</button>
        <button type="button" className="mob-btn ghost" data-testid="mobile-confirm-cancel" disabled={confirmed} onClick={layer.close}>取消</button>
      </div>
    </div>
  );
}
