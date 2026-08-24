import { applyOutputOptions } from "./options";
import { prepareAnalysisRun } from "./prepareAnalysisRun";
import {
  safelyLoadFontMatchingCandidates,
  safelyLoadFontMatchingProfile,
  type FontMatchingOutputDependencies,
} from "./wholePagePipelinePorts";

export async function configureWholePageOutputOptions({
  autoFontMatching,
  chapterId,
  dependencies,
  naturalTextLayout,
  fontSizeAutoFit = true,
  run,
  workId,
}: {
  autoFontMatching: boolean;
  chapterId?: string;
  dependencies: FontMatchingOutputDependencies;
  naturalTextLayout: boolean;
  fontSizeAutoFit?: boolean;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  workId?: string;
}): Promise<void> {
  const profileLoad = autoFontMatching
    ? await safelyLoadFontMatchingProfile(dependencies, workId)
    : { status: "absent" as const, profile: null };
  // A missing profile is a normal first-run state. A profile read/parse error
  // is different: silently continuing would discard anchors and user locks,
  // so matching is disabled for this run.
  const fontMatchingEnabled =
    autoFontMatching && profileLoad.status !== "error";
  const candidates = fontMatchingEnabled
    ? safelyLoadFontMatchingCandidates(
        dependencies,
        run.baseOptions.targetLanguage,
      )
    : [];
  applyOutputOptions(
    run.baseOptions,
    naturalTextLayout,
    fontMatchingEnabled,
    { workId, chapterId, profile: profileLoad.profile },
    candidates,
    fontSizeAutoFit,
  );
}
