import { logError } from "./logger";

export function logStateStoreError(message: string, detail?: unknown): void {
  logError(message, detail);
}
