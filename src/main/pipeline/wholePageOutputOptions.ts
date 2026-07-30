import { applyOutputOptions } from "./options";
import { prepareAnalysisRun } from "./prepareAnalysisRun";
import {
  safelyLoadFontMatchingCandidates,
  type WholePagePipelineDependencies,
} from "./wholePagePipelinePorts";

export function configureWholePageOutputOptions({
  autoFontMatching,
  dependencies,
  naturalTextLayout,
  run,
  workTitle,
}: {
  autoFontMatching: boolean;
  dependencies: WholePagePipelineDependencies;
  naturalTextLayout: boolean;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  workTitle?: string;
}): void {
  const candidates = autoFontMatching
    ? safelyLoadFontMatchingCandidates(
        dependencies,
        run.baseOptions.targetLanguage,
      )
    : [];
  applyOutputOptions(
    run.baseOptions,
    naturalTextLayout,
    autoFontMatching,
    workTitle,
    candidates,
  );
}
