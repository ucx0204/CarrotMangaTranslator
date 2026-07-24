import { toast } from "./toastStore";

export type NotificationPort = {
  success: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
};

export const toastNotificationPort: NotificationPort = toast;
