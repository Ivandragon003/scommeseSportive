import React from 'react';
import './common-feedback.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Conferma',
  cancelLabel = 'Annulla',
  tone = 'warning',
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div className="fp-confirm-dialog__backdrop" role="presentation" onClick={onCancel}>
      <div
        className="fp-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fp-confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fp-confirm-dialog__head">
          <div className={`fp-confirm-dialog__tone is-${tone}`}>{tone}</div>
          <div className="fp-confirm-dialog__title" id="fp-confirm-dialog-title">{title}</div>
        </div>
        <div className="fp-confirm-dialog__body">{message}</div>
        <div className="fp-confirm-dialog__actions">
          <button type="button" className="fp-btn fp-btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'fp-btn fp-btn-red' : 'fp-btn fp-btn-solid'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
