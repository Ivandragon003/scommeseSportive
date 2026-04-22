import React from 'react';
import './common-feedback.css';

interface ErrorBannerProps {
  title?: string;
  message: string;
  onDismiss?: () => void;
}

const ErrorBanner: React.FC<ErrorBannerProps> = ({
  title = 'Errore operativo',
  message,
  onDismiss,
}) => {
  if (!message) return null;

  return (
    <div className="fp-error-banner" role="alert">
      <div>
        <div className="fp-error-banner__title">{title}</div>
        <div className="fp-error-banner__message">{message}</div>
      </div>
      {onDismiss && (
        <button type="button" className="fp-error-banner__dismiss" onClick={onDismiss}>
          Chiudi
        </button>
      )}
    </div>
  );
};

export default ErrorBanner;
