import { MAX_WARNINGS } from "../../shared/ipcContractCore";
import type { JobFailureGuidance } from "../../shared/jobTypes";
import { tMain } from "./localization";
import { readJobFailureGuidance } from "./failure";

type TerminalFailureKind = JobFailureGuidance | "other";

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
  recordTerminalFailure: (error: unknown) => void;
  resolveTerminalFailureGuidance: () => JobFailureGuidance | undefined;
};

export function createWarningCollector(): WarningCollector {
  const warnings: string[] = [];
  const terminalFailureKinds = new Set<TerminalFailureKind>();
  const add = createBoundedWarningAppender(warnings);
  return {
    warnings,
    add,
    addAttemptFailure({ pageName, attempt, maxAttempts, message }) {
      add(
        tMain("translation.warnings.attemptFailed", {
          page: pageName,
          attempt,
          maxAttempts,
          message,
        }),
      );
    },
    addPageSkipped({ pageName, maxAttempts, message }) {
      add(
        tMain("translation.warnings.pageSkipped", {
          page: pageName,
          maxAttempts,
          message,
        }),
      );
    },
    recordTerminalFailure(error) {
      terminalFailureKinds.add(readJobFailureGuidance(error) ?? "other");
    },
    resolveTerminalFailureGuidance() {
      if (terminalFailureKinds.size !== 1) return undefined;
      const [kind] = terminalFailureKinds;
      return kind === "other" ? undefined : kind;
    },
  };
}

function createBoundedWarningAppender(
  warnings: string[],
): (...items: string[]) => void {
  const detailLimit = Math.max(0, MAX_WARNINGS - 1);
  let omittedCount = 0;
  return (...items) => {
    for (const item of items) {
      if (warnings.length < detailLimit && omittedCount === 0) {
        warnings.push(item);
        continue;
      }
      omittedCount += 1;
      const summary = tMain("translation.warnings.omitted", {
        count: omittedCount,
      });
      if (warnings.length < MAX_WARNINGS) warnings.push(summary);
      else warnings[MAX_WARNINGS - 1] = summary;
    }
  };
}
