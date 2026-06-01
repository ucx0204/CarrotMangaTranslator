import React from "react";

export type ConfirmDialogState = {
  title: string;
  message: string;
  detail?: string;
};

export function useConfirmDialog(): {
  confirmDialog: ConfirmDialogState | null;
  askConfirm: (title: string, message: string, detail?: string) => Promise<boolean>;
  resolveConfirmDialog: (confirmed: boolean) => void;
} {
  const [confirmDialog, setConfirmDialog] = React.useState<ConfirmDialogState | null>(null);
  const confirmResolverRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  const resolveConfirmDialog = React.useCallback((confirmed: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    resolver?.(confirmed);
  }, []);

  const askConfirm = React.useCallback((title: string, message: string, detail?: string) => {
    confirmResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message, detail });
    });
  }, []);

  return { confirmDialog, askConfirm, resolveConfirmDialog };
}
