import { logError, logInfo, logWarn } from "../logger";

export function logInpaintingRuntimeInfo(
  message: string,
  detail?: unknown,
): void {
  logInfo(message, detail);
}

export function logInpaintingRuntimeWarn(
  message: string,
  detail?: unknown,
): void {
  logWarn(message, detail);
}

export function logInpaintingRuntimeError(
  message: string,
  detail?: unknown,
): void {
  logError(message, detail);
}
