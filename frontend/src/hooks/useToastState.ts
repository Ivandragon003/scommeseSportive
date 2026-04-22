import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
  durationMs?: number;
}

interface ShowToastInput {
  tone?: ToastTone;
  title?: string;
  message: string;
  durationMs?: number;
}

export function useToastState() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((input: ShowToastInput) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const toast: ToastItem = {
      id,
      tone: input.tone ?? 'info',
      title: input.title,
      message: input.message,
      durationMs: input.durationMs ?? 4200,
    };

    setToasts((current) => [...current, toast]);

    const timeout = window.setTimeout(() => {
      dismissToast(id);
    }, toast.durationMs);
    timersRef.current.set(id, timeout);

    return id;
  }, [dismissToast]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer);
    }
    timersRef.current.clear();
  }, []);

  return {
    toasts,
    showToast,
    dismissToast,
  };
}
