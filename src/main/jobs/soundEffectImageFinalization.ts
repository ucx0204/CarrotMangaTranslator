import { createPageRevision } from "../../shared/pageRevision";
import {
  runSoundEffectImageRecovery,
  type SoundEffectImageRecoveryDependencies,
} from "./soundEffectImageRecoveryRunner";
import type { SoundEffectImageRecoveryPlan } from "../soundEffectImageRecoveryStore";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import type { DeferredSoundEffectPage } from "./soundEffectTranslationReview";

export async function saveConfirmedSoundEffectImages(
  input: SoundEffectTranslationJobInput,
  dependencies: Pick<
    SoundEffectImageRecoveryDependencies,
    "openChapter" | "getRunPaths"
  > &
    Partial<
      Pick<SoundEffectImageRecoveryDependencies, "editImages" | "saveImages">
    > & {
      saveImageRecovery?: SoundEffectImageRecoveryDependencies["saveRecovery"];
    },
  pages: readonly DeferredSoundEffectPage[],
  persistText: (page: DeferredSoundEffectPage) => Promise<void>,
): Promise<void> {
  // Once the user confirms, save every approved text/box before any image call.
  for (const page of pages) {
    await persistText(page);
  }
  const chapter = input.state.chapter;
  if (!chapter) return;
  const plan: SoundEffectImageRecoveryPlan = {
    version: 1,
    chapterId: chapter.id,
    runId: input.id,
    eraseOriginal: input.request.inpaintAfterTranslation,
    output:
      input.request.codexTypesetting?.sfxRendering === "font"
        ? "text"
        : "image",
    pages: pages.flatMap((page) => {
      const stored = chapter.pages.find(
        (item) => item.id === page.target.page.id,
      );
      if (!stored || !page.reading || !page.items.length) return [];
      return [
        {
          pageId: stored.id,
          revision: createPageRevision(stored),
          reading: page.reading,
          blockIds: page.reading.regions
            .filter((region) => region.action !== "keep")
            .map((region) => region.id),
          erasedBlockIds: [],
          completed: false,
        },
      ];
    }),
  };
  if (
    !dependencies.editImages ||
    !dependencies.saveImages ||
    !dependencies.saveImageRecovery
  )
    throw new Error(
      "효과음 이미지 저장 서비스를 사용할 수 없습니다. 번역문과 영역은 저장했습니다.",
    );
  const errors = await runSoundEffectImageRecovery(input, plan, {
    editImages: dependencies.editImages,
    saveImages: dependencies.saveImages,
    saveRecovery: dependencies.saveImageRecovery,
    openChapter: dependencies.openChapter,
    getRunPaths: dependencies.getRunPaths,
  });
  input.state.warnings.push(...errors);
  if (errors.length)
    throw new Error(
      `번역문과 지정 영역은 저장했습니다. 이미지 작업 ${errors.length}페이지를 보류했습니다. 효과음 창에서 이미지 작업을 이어서 실행할 수 있습니다.\n${errors.slice(0, 10).join("\n")}`,
    );
}
