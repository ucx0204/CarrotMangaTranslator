import type { TranslationBlock } from "../../shared/textTypes";
import {
  CodexImageEditError,
  type CodexImageEdit,
  type editTranslatedPageWithCodex,
  applyReviewedRegions,
} from "../codexImageEditing";
import { createCodexProgressReporter } from "../pipeline/codexTypesettingProgress";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import type { DeferredSoundEffectPage } from "./soundEffectTranslationReview";

type Entry = {
  regionId: string;
  block: TranslationBlock;
  additionalBlocks?: TranslationBlock[];
};
type Result = {
  entries: Entry[];
  image?: { inpaintedImagePath: string; inpaintMaskPath?: string };
  error?: unknown;
};

export async function editSoundEffectPage(
  input: SoundEffectTranslationJobInput,
  directory: string,
  page: DeferredSoundEffectPage,
  entries: Entry[],
  edit: typeof editTranslatedPageWithCodex | undefined,
  skipGeneration: boolean,
): Promise<Result> {
  if (!input.request.codexTypesetting) return { entries };
  const report = createCodexProgressReporter(
    input.id,
    page.pageTotal,
    input.emit,
    "sound-effect-translation",
  );
  const imageInput: CodexImageEdit = {
    page: { ...page.target.page, blocks: entries.map((entry) => entry.block) },
    directory,
    signal: input.abortController.signal,
    eraseOriginal: input.request.inpaintAfterTranslation,
    output:
      input.request.codexTypesetting.sfxRendering === "font" ? "text" : "image",
    decode: input.context.decodeImage,
    reviewedReading: page.reading,
    progress: (update) =>
      report({
        ...update,
        stage: "images",
        page: page.pageIndex + 1,
        completed: page.pageIndex,
      }),
  };
  if (skipGeneration || input.abortController.signal.aborted) {
    const reviewed = page.reading
      ? applyReviewedRegions(imageInput.page, page.reading)
      : imageInput.page;
    return { entries: editedEntries(entries, reviewed.blocks, imageInput) };
  }
  return applySoundEffectImageEdit(entries, imageInput, edit);
}

/** Keep the normal translation when the auxiliary image operation fails. */
async function applySoundEffectImageEdit(
  entries: Entry[],
  input: CodexImageEdit,
  edit?: typeof editTranslatedPageWithCodex,
): Promise<Result> {
  try {
    if (!edit) throw new Error("Codex 이미지 작업을 사용할 수 없습니다.");
    const page = await edit(input);
    return {
      entries: editedEntries(entries, page.blocks, input),
      image: page.inpaintedImagePath
        ? {
            inpaintedImagePath: page.inpaintedImagePath,
            inpaintMaskPath: page.inpaintMaskPath,
          }
        : undefined,
    };
  } catch (error) {
    input.signal.throwIfAborted();
    if (input.reviewedReading && !(error instanceof CodexImageEditError)) {
      entries = editedEntries(
        entries,
        applyReviewedRegions(input.page, input.reviewedReading).blocks,
        input,
      );
    }
    let image: Result["image"];
    if (error instanceof CodexImageEditError) {
      entries = editedEntries(entries, error.page.blocks, input);
      if (error.page.inpaintedImagePath)
        image = {
          inpaintedImagePath: error.page.inpaintedImagePath,
          inpaintMaskPath: error.page.inpaintMaskPath,
        };
    }
    return { entries, image, error };
  }
}

function editedEntries(
  entries: Entry[],
  blocks: TranslationBlock[],
  input: CodexImageEdit,
): Entry[] {
  const parents = new Map(
    input.reviewedReading?.regions.map((region) => [
      region.id,
      region.parentRegionId ?? region.id,
    ]),
  );
  return entries.flatMap((entry) => {
    const edited = blocks.filter(
      (block) => (parents.get(block.id) ?? block.id) === entry.block.id,
    );
    if (!edited.length) return input.reviewedReading ? [] : [entry];
    return [
      {
        regionId: entry.regionId,
        block: edited[0],
        ...(edited.length > 1 ? { additionalBlocks: edited.slice(1) } : {}),
      },
    ];
  });
}
