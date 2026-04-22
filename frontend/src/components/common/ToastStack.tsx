import React from 'react';
import './common-feedback.css';
import { ToastItem } from '../../hooks/useToastState';

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const TOAST_ICONS: Record<ToastItem['tone'], string> = {
  success: '✓',
  error: '!',
  warning: '!',
  info: 'i',
};

const ToastStack: React.FC<ToastStackProps> = ({ toasts, onDismiss }) => {
  if (!toasts.length) return null;

  return (
    <div className="fp-toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`fp-toast is-${toast.tone}`}>
          <div className="fp-toast__icon" aria-hidden="true">{TOAST_ICONS[toast.tone]}</div>
          <div className="fp-toast__content">
            {toast.title && <div className="fp-toast__title">{toast.title}</div>}
            <div className="fp-toast__message">{toast.message}</div>
          </div>
          <button
            type="button"
            className="fp-toast__close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Chiudi notifica"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastStack;
