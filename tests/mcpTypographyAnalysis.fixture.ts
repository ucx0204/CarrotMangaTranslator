import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { McpTypographyAnalysisTargetSchema } from "../src/shared/mcpTypographyAnalysis";
import { McpTypographyReadService } from "../src/main/application/mcpTypographyReadService";
import { McpTypographyAnalysisService } from "../src/main/application/mcpTypographyAnalysisService";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";

type Analyze = ConstructorParameters<
  typeof McpTypographyAnalysisService
>[0]["analyze"];
export function typographyAnalysisFixture() {
  const f = translationBatchFixture();
  const controller = new AbortController();
  const guard = vi.fn(() => controller.signal.throwIfAborted());
  const context = {
    id: randomUUID(),
    signal: controller.signal,
    assertAuthorized: guard,
    progress: vi.fn(),
  };
  let catalogVersion = "initial";
  const readCatalog = vi.fn(async () => ({
    snapshot: hashStableValue(catalogVersion),
    fonts: [],
  }));
  const preparation = new McpTypographyReadService({
    openChapter: async () => structuredClone(f.chapter),
    readCatalog,
  });
  const observe: Analyze = async ({ prepared }) => ({
    environmentSnapshot: hashStableValue("runtime-profile-fixture"),
    pages: prepared.map((page) => ({
      pageId: page.pageId,
      revision: page.revision,
      sourceImageSha256: "a".repeat(64),
      items: page.blocks.map((block) => ({
        blockId: block.blockId,
        font: block.fontEligible
          ? {
              fontId: "jua",
              fontWeight: 400,
              italic: false,
              runtimeVersion: "c23.0",
              groupId: "synthetic-group",
            }
          : null,
        estimate: block.sizeEligible
          ? { facePx: 24, confidence: 0.8, method: "raster-core-v1" }
          : null,
        fontExclusion: block.fontExclusion,
        sizeExclusion: block.sizeExclusion,
      })),
    })),
  });
  const analyze = vi.fn<Analyze>(observe);
  const service = new McpTypographyAnalysisService(
    { read: f.read, preparation, analyze },
    () => 1000,
  );
  const target = async (overrides: Record<string, unknown> = {}) => {
    const options = {
      chapterId: f.chapter.id,
      mode: "font-and-size",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      allowOcr: true,
      preserveManualFontSize: true,
      ...overrides,
    };
    const prepared = await preparation.preflight(options, guard);
    return McpTypographyAnalysisTargetSchema.parse({
      ...options,
      pages: prepared.pages.map(({ pageId, revision }) => ({
        pageId,
        revision,
      })),
      snapshot: prepared.snapshot,
      catalogSnapshot: prepared.catalogSnapshot,
      allowAssetDownloads: true,
      requestId: randomUUID(),
    });
  };
  return {
    ...f,
    controller,
    context,
    guard,
    preparation,
    readCatalog,
    analyze,
    observe,
    service,
    target,
    changeCatalog: () => {
      catalogVersion = "changed";
    },
  };
}
