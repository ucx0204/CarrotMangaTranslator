export type WarningCollector = {
  readonly warnings: string[];
  add: (...items: string[]) => void;
  addAttemptFailure: (input: {
    pageName: string;
    attempt: number;
    maxAttempts: number;
    message: string;
  }) => void;
  addPageSkipped: (input: {
    pageName: string;
    maxAttempts: number;
    message: string;
  }) => void;
};

export function createWarningCollector(): WarningCollector {
  const warnings: string[] = [];
  return {
    warnings,
    add: (...items) => warnings.push(...items),
    addAttemptFailure({ pageName, attempt, maxAttempts, message }) {
      warnings.push(
        tMain("translation.warnings.attemptFailed", {
          page: pageName,
          attempt,
          maxAttempts,
          message,
        }),
      );
    },
    addPageSkipped({ pageName, maxAttempts, message }) {
      warnings.push(
        tMain("translation.warnings.pageSkipped", {
          page: pageName,
          maxAttempts,
          message,
        }),
      );
    },
  };
}
import { tMain } from "./localization";
