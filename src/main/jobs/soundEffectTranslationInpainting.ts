import type {
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { inpaintCreatedSoundEffectBlocks } from "./soundEffectTargetedInpainting";
import type { TranslationJobContext } from "./translationJobTypes";

export async function maybeInpaintTranslatedSoundEffectBlocks({
  abortController,
  context,
  emit,
  id,
  inpaintCreatedBlocks,
  pageTotal,
  request,
  state,
}: {
  abortController: AbortController;
  context: TranslationJobContext;
  emit: (event: JobEvent) => void;
  id: string;
  inpaintCreatedBlocks: typeof inpaintCreatedSoundEffectBlocks;
  pageTotal: number;
  request: StartSoundEffectTranslationRequest;
  state: {
    createdBlocksByPage: StartSoundEffectTranslationResult["createdBlocksByPage"];
    warnings: string[];
  };
}): Promise<void> {
  if (
    !request.inpaintAfterTranslation ||
    state.createdBlocksByPage.length === 0
  ) {
    return;
  }
  emit({
    id,
    kind: "sound-effect-translation",
    status: "running",
    progressText: "효과음 원문 지우는 중",
    phase: "inpainting_running",
    progressCurrent: pageTotal,
    progressTotal: pageTotal,
    pageTotal,
  });
  const result = await inpaintCreatedBlocks(
    request.chapterId,
    state.createdBlocksByPage,
    context.decodeImage,
    abortController.signal,
  );
  state.warnings.push(...result.warnings);
}
