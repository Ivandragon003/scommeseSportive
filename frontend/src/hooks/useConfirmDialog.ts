import { useCallback, useMemo, useRef, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

const DEFAULT_STATE: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirmLabel: 'Conferma',
  cancelLabel: 'Annulla',
  tone: 'warning',
};

export function useConfirmDialog() {
  const [dialog, setDialog] = useState<ConfirmState>(DEFAULT_STATE);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const closeDialog = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setDialog(DEFAULT_STATE);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setDialog({
        open: true,
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? 'Conferma',
        cancelLabel: options.cancelLabel ?? 'Annulla',
        tone: options.tone ?? 'warning',
      });
    });
  }, []);

  const dialogProps = useMemo(() => ({
    open: dialog.open,
    title: dialog.title,
    message: dialog.message,
    confirmLabel: dialog.confirmLabel,
    cancelLabel: dialog.cancelLabel,
    tone: dialog.tone,
    onConfirm: () => closeDialog(true),
    onCancel: () => closeDialog(false),
  }), [closeDialog, dialog]);

  return {
    confirm,
    dialogProps,
  };
}
