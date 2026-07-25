import { logError, logInfo, logWarn } from "../logger";

export function logAnimeTextInfo(message: string, detail?: unknown): void {
  logInfo(message, detail);
}

export function logAnimeTextWarning(message: string, detail?: unknown): void {
  logWarn(message, detail);
}

export function logAnimeTextError(message: string, detail?: unknown): void {
  logError(message, detail);
}
