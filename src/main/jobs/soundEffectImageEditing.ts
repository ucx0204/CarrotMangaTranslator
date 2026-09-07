import type { TranslationBlock } from "../../shared/textTypes";
import {
  CodexImageEditError,
  type CodexImageEdit,
  type editTranslatedPageWithCodex,
} from "../codexImageEditing";

type Entry = { regionId: string; block: TranslationBlock };
type Result = {
  entries: Entry[];
  image?: { inpaintedImagePath: string; inpaintMaskPath?: string };
  error?: unknown;
};

/** Keep the normal translation when the auxiliary image operation fails. */
export async function applySoundEffectImageEdit(
  entries: Entry[],
  input: CodexImageEdit,
  edit?: typeof editTranslatedPageWithCodex,
): Promise<Result> {
  try {
    if (!edit) throw new Error("Codex 이미지 작업을 사용할 수 없습니다.");
    const page = await edit(input);
    const blocks = new Map(page.blocks.map((block) => [block.id, block]));
    return {
      entries: entries.map((entry) => ({
        ...entry,
        block: blocks.get(entry.block.id) ?? entry.block,
      })),
      image: page.inpaintedImagePath
        ? {
            inpaintedImagePath: page.inpaintedImagePath,
            inpaintMaskPath: page.inpaintMaskPath,
          }
        : undefined,
    };
  } catch (error) {
    input.signal.throwIfAborted();
    let image: Result["image"];
    if (error instanceof CodexImageEditError) {
      const blocks = new Map(
        error.page.blocks.map((block) => [block.id, block]),
      );
      entries = entries.map((entry) => ({
        ...entry,
        block: blocks.get(entry.block.id) ?? entry.block,
      }));
      if (error.page.inpaintedImagePath)
        image = {
          inpaintedImagePath: error.page.inpaintedImagePath,
          inpaintMaskPath: error.page.inpaintMaskPath,
        };
    }
    return { entries, image, error };
  }
}
