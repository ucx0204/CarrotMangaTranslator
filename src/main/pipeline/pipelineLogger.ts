import { logInfo, logWarn } from "../logger";

export function logPipelineInfo(message: string, detail?: unknown): void {
  try {
    logInfo(message, detail);
  } catch (error) {
    void error;
    // Diagnostics must never make a page fail in isolated tests or shutdown.
  }
}

export function logPipelineWarning(message: string, detail?: unknown): void {
  try {
    logWarn(message, detail);
  } catch (error) {
    void error;
    // A diagnostic must never turn a fail-closed typography stage into a page
    // failure, including isolated test and shutdown environments.
  }
}
