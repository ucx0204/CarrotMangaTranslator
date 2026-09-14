import type { MangaPage } from "../shared/libraryTypes";
import type { CodexPageReading } from "../shared/codexTypesettingTypes";
import { normalizedRegionToPixelRect } from "../shared/region";
import type { ImageDecodeFallback } from "./regionCrop";
import type { CodexNativePageContext } from "./inpainting/codexNativePageContext";
import { createCodexInpaintingEngine } from "./inpainting/codexInpaintingEngine";
import { inpaintPatternPage } from "./inpainting";
import { isSexualImageRefusal } from "./codexImageModeration";
import { throwImageStorageFailure } from "./pipeline/imageJobFailure";

export class CodexImageErasureError extends Error {
  constructor(
    readonly page: MangaPage,
    readonly failures: Array<{ blockId: string; error: unknown }>,
  ) {
    super(
      failures
        .map(
          ({ blockId, error }) =>
            `${blockId}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("\n"),
    );
    this.name = "CodexImageErasureError";
  }
}

export async function eraseTranslatedPage(
  page: MangaPage,
  input: {
    signal: AbortSignal;
    decode: ImageDecodeFallback;
    regionContext?: CodexNativePageContext;
    erasedBlockIds?: readonly string[];
    onErased?: (page: MangaPage, blockId: string) => Promise<void>;
  },
  client: Parameters<typeof createCodexInpaintingEngine>[0],
  directory: string,
  protection?: Uint8Array,
  reading?: CodexPageReading,
): Promise<MangaPage> {
  const engine = createCodexInpaintingEngine(
    client,
    directory,
    input.signal,
    async () => {},
    protection,
    input.regionContext,
    reading?.regions
      .filter((region) => region.action !== "keep")
      .map((region) => ({
        sourceText: region.sourceText,
        appearance: region.styleDescription,
        bounds: normalizedRegionToPixelRect(region.sourceBbox, page),
      })),
  );
  const failures: Array<{ blockId: string; error: unknown }> = [];
  for (const block of page.blocks) {
    if (
      block.imageGenerationBlocked ||
      input.erasedBlockIds?.includes(block.id)
    )
      continue;
    input.signal.throwIfAborted();
    try {
      const result = await inpaintPatternPage(page, {
        blockIds: [block.id],
        signal: input.signal,
        decodeFallback: input.decode,
        inpaintingEngine: engine,
        preserveExistingInpainting: true,
      });
      if (!result.erasedBlockIds?.includes(block.id))
        throw new Error("일부 원문을 지우지 못했습니다. 결과를 확인해 주세요.");
      page = result.page;
      await input.onErased?.(page, block.id);
    } catch (error) {
      input.signal.throwIfAborted();
      throwImageStorageFailure(error);
      if (!isSexualImageRefusal(error)) {
        failures.push({ blockId: block.id, error });
        continue;
      }
      page = {
        ...page,
        blocks: page.blocks.map((item) =>
          item.id === block.id
            ? {
                ...item,
                imageGenerationBlocked: "sexual",
                generatedLettering: undefined,
              }
            : item,
        ),
      };
    }
  }
  if (failures.length) throw new CodexImageErasureError(page, failures);
  return page;
}
