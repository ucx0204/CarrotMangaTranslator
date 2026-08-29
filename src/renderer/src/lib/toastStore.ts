// Lightweight, framework-agnostic toast store.
// Decoupled from the status log: use for single-shot feedback
// (save/delete/export/job complete or fail), not progress spam.

export type ToastVariant = "success" | "error" | "warn" | "info";

type ToastAction = {
  label: string;
  onClick: () => void;
};

export type Toast = {
  id: string;
  variant: ToastVariant;
  message: string;
  action?: ToastAction;
  duration: number; // ms; 0 keeps it until dismissed
};

export type ToastOptions = {
  action?: ToastAction;
  duration?: number;
};

type Listener = (toasts: Toast[]) => void;

const MAX_TOASTS = 4;
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3800,
  warn: 5200,
  info: 4200,
  error: 6500,
};

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function dismissToast(id: string): void {
  clearTimer(id);
  if (!toasts.some((toast) => toast.id === id)) {
    return;
  }
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

function scheduleRemoval(id: string, duration: number): void {
  if (duration <= 0) {
    return;
  }
  timers.set(
    id,
    setTimeout(() => dismissToast(id), duration),
  );
}

function push(
  variant: ToastVariant,
  message: string,
  options?: ToastOptions,
): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  const duplicate = toasts.find(
    (item) =>
      item.variant === variant &&
      item.message === trimmed &&
      item.action === undefined &&
      options?.action === undefined,
  );
  if (duplicate) {
    return duplicate.id;
  }
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const duration = options?.duration ?? DEFAULT_DURATION[variant];
  const next: Toast = {
    id,
    variant,
    message: trimmed,
    action: options?.action,
    duration,
  };
  const nextToasts = [next, ...toasts].slice(0, MAX_TOASTS);
  const retainedIds = new Set(nextToasts.map((item) => item.id));
  for (const item of toasts) {
    if (!retainedIds.has(item.id)) {
      clearTimer(item.id);
    }
  }
  toasts = nextToasts;
  emit();
  scheduleRemoval(id, duration);
  return id;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): Toast[] {
  return toasts;
}

export const toast = {
  success: (message: string, options?: ToastOptions): string =>
    push("success", message, options),
  error: (message: string, options?: ToastOptions): string =>
    push("error", message, options),
  warn: (message: string, options?: ToastOptions): string =>
    push("warn", message, options),
  info: (message: string, options?: ToastOptions): string =>
    push("info", message, options),
  dismiss: dismissToast,
};
