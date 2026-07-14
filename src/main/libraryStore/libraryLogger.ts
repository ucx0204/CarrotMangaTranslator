import { logWarn } from "../logger";

export function logLibraryWarning(message: string, detail?: unknown): void {
  logWarn(message, detail);
}
