import { logWarn } from "../logger";

export function logPipelineWarning(message: string, detail?: unknown): void {
  try {
    logWarn(message, detail);
  } catch (error) {
    void error;
    // A diagnostic must never turn a fail-closed typography stage into a page
    // failure, including isolated test and shutdown environments.
  }
}
