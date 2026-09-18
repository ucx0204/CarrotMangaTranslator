import { hashStableValue } from "../../shared/blockFingerprint";
import type { MangaPage } from "../../shared/libraryTypes";
import type { OverlayItem } from "../pipeline/types";
import type { McpTypographyAnalysisService } from "../application/mcpTypographyAnalysisService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import type {
  FontChapterC18Page,
  FontChapterC18Port,
} from "../pipeline/fontChapterC18Types";
import { getRunPaths, readWorkTypographyProfile } from "../library";
import { getAppSettings } from "../settingsStore";
import { logError } from "../logger";
import { buildBaseOptions } from "../pipeline/options";
import { resolveFontChapterRuntimeManifest } from "../pipeline/fontChapterRuntimeAssets";
import { loadBuiltInFontMatchingCandidates } from "../builtInFontMatchingCatalog";
import { McpEditError } from "../application/mcpEditPolicy";

type Input = Parameters<
  ConstructorParameters<typeof McpTypographyAnalysisService>[0]["analyze"]
>[0];

export async function readMcpTypographyFontEnvironment(input: Input) {
  if (input.request.mode === "size")
    return {
      snapshot: hashStableValue("raster-core-v1"),
      fontIds: new Set<string>(),
    };
  const profile = await readWorkTypographyProfile(input.saved.workId);
  const candidates = loadBuiltInFontMatchingCandidates(
    "ko",
    (_message, detail) =>
      logError("MCP typography font inspection failed", detail),
  );
  const { manifest } = resolveFontChapterRuntimeManifest();
  return {
    snapshot: hashStableValue({ profile, candidates, manifest }),
    fontIds: new Set(candidates.map((font) => font.fontId)),
  };
}

export async function runMcpTypographyFontAnalysis(
  app: InpaintingJobContext,
  input: Input,
  prepared: readonly { page: MangaPage; items: OverlayItem[] }[],
  context: McpOperationContext,
  chapter: FontChapterC18Port,
) {
  if (!input.request.allowOcr || !input.request.allowAssetDownloads)
    throw new McpEditError(
      "invalid_edit",
      "C23 requires explicit OCR and app-managed asset download permission.",
    );
  const settings = await getAppSettings(app.appPaths);
  const paths = await getRunPaths(input.request.chapterId, context.id);
  context.assertAuthorized();
  const options = {
    ...buildBaseOptions(context.id, paths.runDir, settings, app.appPaths),
    sourceLanguage: input.request.sourceLanguage,
    targetLanguage: input.request.targetLanguage,
    autoFontMatching: true,
    naturalTextLayout: false,
    ocrPipeline: "hayai" as const,
    ocrCpuWorkers: 1,
    abortSignal: context.signal,
    onProgress: () => {
      context.assertAuthorized();
      context.progress({ phase: "c23_source_analysis" });
    },
  };
  const pages: FontChapterC18Page[] = prepared.map((entry) => ({
    page: entry.page,
    items: entry.items,
    pageOptions: {
      ...options,
      imagePath: entry.page.imagePath,
      pageId: entry.page.id,
    },
  }));
  if (pages.every((page) => !page.items.length)) return undefined;
  context.progress({
    phase: "c23_source_analysis",
    completed: 0,
    total: pages.length,
  });
  const result = await chapter.prepare(pages, context.signal);
  context.assertAuthorized();
  if (!result)
    throw new McpEditError(
      "invalid_edit",
      "C23 returned no source font analysis.",
    );
  return result;
}
