import {
  prepareExternalImageFile,
  externalImageRegionIsHidden,
} from "./imageRedactionContext";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MangaPage } from "../shared/libraryTypes";
import type { CodexPageReading } from "../shared/codexTypesettingTypes";
import type { CodexProgressUpdate } from "../shared/codexTypesettingProgress";
import { getAppPaths } from "./appPaths";
import { getAppSettings } from "./settingsStore";
import { startCodexImageSession } from "./codexImageSession";
import {
  eraseTranslatedPage,
  CodexImageErasureError,
} from "./codexImageErasure";
import {
  ImageCheckpointError,
  throwImageStorageFailure,
} from "./pipeline/imageJobFailure";
import type { ImageDecodeFallback } from "./regionCrop";
import {
  CodexLetteringGenerationError,
  generateLetteringLayers,
} from "./pipeline/codexTypesettingLettering";
import { createPageExportRenderSession } from "./pageExport";
import { readingEditProtection } from "./regionEditProtection";
import {
  needsCodexRegionPlanning,
  planCodexImageRegions,
} from "./codexImageRegionPlanning";

export type CodexImageEdit = {
  erasedBlockIds?: readonly string[];
  onCheckpoint?: (page: MangaPage, erasedBlockId?: string) => Promise<void>;
  page: MangaPage;
  directory: string;
  signal: AbortSignal;
  eraseOriginal: boolean;
  output: "text" | "image";
  invertColors?: boolean;
  decode: ImageDecodeFallback;
  progress: (update: CodexProgressUpdate) => void;
  confirmReading?: (reading: CodexPageReading) => Promise<CodexPageReading>;
  reviewedReading?: CodexPageReading;
  regionContext?: import("./inpainting/codexNativePageContext").CodexNativePageContext;
};

/** Receives translated blocks. It never translates, chooses chapter fonts, or writes memory. */
export async function editTranslatedPageWithCodex(
  input: CodexImageEdit,
): Promise<MangaPage> {
  const { signal, progress } = input;
  signal.throwIfAborted();
  let page = input.page;
  if (!page.blocks.length) return page;
  assertVisibleRegions(page);
  let reading = input.reviewedReading ?? (await prepareImageReading(input));
  if (input.confirmReading) {
    reading = await input.confirmReading(reading);
  }
  page = applyReviewedRegions(page, reading);
  assertVisibleRegions(page);
  const protection = readingEditProtection(reading, page);
  progress({ stage: "images", step: "reading" });
  preview(input, page, reading, "reading");
  if (!input.eraseOriginal && input.output === "text") return page;
  const directory = join(input.directory, "codex-image", page.id);
  await mkdir(directory, { recursive: true });
  const paths = getAppPaths();
  let client: Awaited<ReturnType<typeof startCodexImageSession>> | undefined;
  let erasureFailure: CodexImageErasureError | undefined;
  try {
    client = await startCodexImageSession(
      paths,
      await getAppSettings(paths),
      directory,
      signal,
    );
    if (input.eraseOriginal) {
      progress({ step: "background" });
      const erased = await eraseWithPartialResults(
        page,
        input,
        client,
        directory,
        protection,
        reading,
      );
      page = erased.page;
      erasureFailure = erased.failure;
      preview(input, page, reading, "background");
    }
    signal.throwIfAborted();
    if (input.output === "image") {
      progress({ step: "sfx" });
      page = await illustrateTranslatedPage(
        page,
        {
          ...reading,
          regions: reading.regions.filter(
            (region) =>
              !erasureFailure?.failures.some(
                ({ blockId }) => blockId === region.id,
              ),
          ),
        },
        input,
        client,
        directory,
      );
    }
    signal.throwIfAborted();
    await previewFinishedPage(input, page, directory);
    if (erasureFailure) throw erasureFailure;
    return page;
  } catch (error) {
    signal.throwIfAborted();
    throwImageStorageFailure(error);
    throw new CodexImageEditError(page, error);
  } finally {
    await client?.dispose();
  }
}

async function checkpoint(
  input: CodexImageEdit,
  page: MangaPage,
  erasedBlockId?: string,
): Promise<void> {
  try {
    await input.onCheckpoint?.(page, erasedBlockId);
  } catch (error) {
    throw new ImageCheckpointError(error);
  }
}

function assertVisibleRegions(page: MangaPage): void {
  if (
    page.blocks.some((block) => externalImageRegionIsHidden(page, block.bbox))
  )
    throw new CodexImageRedactionOverlapError();
}

export class CodexImageRedactionOverlapError extends Error {
  constructor() {
    super(
      "가리기와 겹치는 효과음은 생성하지 않습니다. 가리기를 수정한 뒤 이미지 작업을 이어서 실행해 주세요.",
    );
    this.name = "CodexImageRedactionOverlapError";
  }
}

async function prepareImageReading(input: CodexImageEdit) {
  const reading = translatedPageReading(input.page, input.output);
  if (input.output !== "image" || !needsCodexRegionPlanning(input.page))
    return reading;
  input.progress({ stage: "images", step: "erasurePlan" });
  const directory = join(input.directory, "codex-image", input.page.id);
  await mkdir(directory, { recursive: true });
  const paths = getAppPaths();
  const planner = await startCodexImageSession(
    paths,
    await getAppSettings(paths),
    directory,
    input.signal,
    "isolated",
  );
  try {
    return await planCodexImageRegions(
      input.page,
      reading,
      planner,
      directory,
      input.signal,
      !!input.confirmReading,
    );
  } finally {
    await planner.dispose();
  }
}

export function applyReviewedRegions(
  page: MangaPage,
  reading: CodexPageReading,
): MangaPage {
  const originals = new Map(page.blocks.map((block) => [block.id, block]));
  return {
    ...page,
    blocks: reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => {
        const block =
          originals.get(region.id) ??
          originals.get(region.parentRegionId ?? region.id);
        if (!block) throw new Error("이미지 영역의 원본 블록이 없습니다.");
        return {
          ...block,
          id: region.id,
          sourceText: region.sourceText,
          translatedText: region.translatedText,
          bbox: region.sourceBbox,
          renderBbox: region.renderBbox,
        };
      }),
  };
}

async function previewFinishedPage(
  input: CodexImageEdit,
  page: MangaPage,
  directory: string,
  fileName = "preview-finished.png",
  step: "sfx" | "review" = "review",
) {
  const renderer = await createPageExportRenderSession({
    dataRoot: getAppPaths().dataRoot,
    decodeFallback: input.decode,
    lowPriority: true,
  });
  const cancel = () => renderer.cancel?.();
  input.signal.addEventListener("abort", cancel, { once: true });
  try {
    input.signal.throwIfAborted();
    const bytes = await renderer.renderPage(page);
    input.signal.throwIfAborted();
    const imagePath = join(directory, fileName);
    await writeFile(imagePath, bytes);
    input.signal.throwIfAborted();
    input.progress({
      step,
      preview: {
        pageId: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        imagePath,
        stage: "review",
        regions: [],
      },
    });
  } finally {
    input.signal.removeEventListener("abort", cancel);
    renderer.close();
  }
}

export function translatedPageReading(
  page: MangaPage,
  output: "text" | "image",
): CodexPageReading {
  return {
    summary: "",
    regions: page.blocks.map((block) => ({
      id: block.id,
      action: output,
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      sourceBbox: block.bbox,
      renderBbox: block.renderBbox ?? block.bbox,
      role: "sound",
      direction: "horizontal",
      background: "artwork",
      reason: "",
      translationLocked: true,
    })),
  };
}

function preview(
  input: CodexImageEdit,
  page: MangaPage,
  reading: CodexPageReading,
  stage: "reading" | "background",
) {
  input.progress({
    step: stage,
    preview: {
      pageId: page.id,
      name: page.name,
      width: page.width,
      height: page.height,
      imagePath:
        stage === "reading"
          ? page.imagePath
          : (page.inpaintedImagePath ?? page.imagePath),
      stage,
      regions: reading.regions.map((region) => ({
        source: region.sourceText,
        translation: region.translatedText,
        bbox: region.sourceBbox,
      })),
    },
  });
}

export class CodexImageEditError extends Error {
  constructor(
    readonly page: MangaPage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    if (cause instanceof CodexLetteringGenerationError)
      this.page = { ...cause.page, imagePath: page.imagePath };
    this.name = "CodexImageEditError";
  }
}

async function illustrateTranslatedPage(
  page: MangaPage,
  reading: CodexPageReading,
  input: CodexImageEdit,
  client: Awaited<ReturnType<typeof startCodexImageSession>>,
  directory: string,
): Promise<MangaPage> {
  const signal = input.signal;
  const originalPath = page.imagePath;
  const result = (
    await generateLetteringLayers(
      {
        ...page,
        imagePath: await prepareExternalImageFile(page.imagePath),
      },
      reading,
      (id) => id,
      client,
      directory,
      signal,
      {
        attempt: 1,
        previousPage: page,
        issues: [],
        invertColors: input.invertColors,
        plan: {
          groups: reading.regions.map((region) => ({
            id: region.styleGroupId ?? region.id,
            description: region.styleDescription ?? "",
            members: [{ regionId: region.id, bold: false, italic: false }],
          })),
          fonts: [],
          sfxRendering: "image",
        },
        onGenerated: async (updated) => {
          const previewPage = { ...updated, imagePath: originalPath };
          await checkpoint(input, previewPage);
          await previewFinishedPage(
            input,
            previewPage,
            directory,
            `preview-${randomUUID()}.png`,
            "sfx",
          );
        },
      },
    )
  ).page;
  return { ...result, imagePath: originalPath };
}

async function eraseWithPartialResults(
  page: MangaPage,
  input: CodexImageEdit,
  client: Awaited<ReturnType<typeof startCodexImageSession>>,
  directory: string,
  protection: Uint8Array | undefined,
  reading: CodexPageReading,
): Promise<{ page: MangaPage; failure?: CodexImageErasureError }> {
  try {
    return {
      page: await eraseTranslatedPage(
        page,
        {
          ...input,
          onErased: (updated, blockId) => checkpoint(input, updated, blockId),
        },
        client,
        directory,
        protection,
        reading,
      ),
    };
  } catch (error) {
    if (!(error instanceof CodexImageErasureError)) throw error;
    return { page: error.page, failure: error };
  }
}
