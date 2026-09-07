import { createCodexRunContext } from "./codexTypesettingContext";
import { app, nativeImage } from "electron";
import {
  cleanIllustratedRegions,
  type TypesettingBackgroundCache,
} from "./codexTypesettingImageGeneration";
import { generateLetteringLayers } from "./codexTypesettingLettering";
import { restoreSourceRegions } from "./codexTypesettingRaster";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppPaths } from "../appPaths";
import {
  readTypesettingConfiguration,
  configuredTypesettingOptions,
} from "./codexTypesettingConfiguration";
import { CodexAppServerClient } from "../codexAppServerClient";
import {
  createPageExportRenderSession,
  type PageExportRenderSession,
} from "../pageExport";
import {
  CODEX_TYPESETTING_MODEL,
  CODEX_TYPESETTING_RECIPE,
} from "../../shared/codexTypesettingDefaults";
import type { CodexTypesettingPorts } from "../application/codexTypesettingContracts";
import { runCodexTypesetting } from "../application/codexTypesettingService";
import { askAstraJson } from "./codexTypesettingRequest";
import { createCodexErasurePreview } from "./codexTypesettingErasurePreview";
import { inspectTypesettingBackground } from "./codexTypesettingBackgroundInspection";
import type { PipelineOptions } from "./types";
import {
  cleanPlainRegions,
  pageImage,
  regionReferenceImages,
  renderFontSamples,
  measureCodexPaintedBounds,
  sourceRegionCrops,
  typesettingPageImages,
} from "./codexTypesettingRaster";

type Runtime = {
  options: PipelineOptions;
  progress: CodexTypesettingPorts["progress"];
  workContext: ReturnType<typeof createCodexRunContext>;
  directory: string;
  client: CodexAppServerClient;
  renderer: PageExportRenderSession;
  targetLanguage: string;
  effort: import("../../shared/codexSettings").CodexReasoningEffort;
  imageClient: () => Promise<Pick<CodexAppServerClient, "runEphemeralTurn">>;
  previewClient: () => Promise<CodexAppServerClient>;
  evidence: (name: string, value: unknown) => Promise<void>;
};

export async function runCodexTypesettingPipeline(options: PipelineOptions) {
  const paths = getAppPaths();
  const { settings, translation, codex } = await readTypesettingConfiguration(
    paths,
    options.codexTypesetting,
    options.regionContexts?.size
      ? "sound-effects"
      : Boolean(options.regionContext),
  );
  const directory = join(
    options.runPaths.chapterDir,
    "astra-typesetting",
    options.jobId,
  );
  await mkdir(directory, { recursive: true });
  const client = await CodexAppServerClient.start({
    paths,
    appVersion: app.getVersion(),
  });
  let renderer: PageExportRenderSession | undefined;
  const images = createLetteringClient(paths, directory, codex);
  const previews = createErasureClient(paths);
  try {
    await requireAstra(client, codex.reasoningEffort);
    renderer = await createPageExportRenderSession({
      dataRoot: paths.dataRoot,
      decodeFallback: options.decodeImage ?? (async () => null),
    });
    const evidence = async (name: string, value: unknown): Promise<void> => {
      await writeFile(
        join(directory, name.replace(/[^\w-]/g, "_") + ".json"),
        JSON.stringify(value, null, 2),
        "utf8",
      );
    };
    const workContext = createCodexRunContext(options);
    const runtime: Runtime = {
      options,
      workContext,
      progress: workContext.progress,
      directory,
      client,
      renderer,
      evidence,
      targetLanguage: translation.targetLanguage,
      effort: codex.reasoningEffort,
      previewClient: previews.get,
      imageClient: images.get,
    };
    await recordRunContract(runtime, settings.preset);
    const cancelRenderer = () => renderer?.cancel?.();
    options.signal.addEventListener("abort", cancelRenderer, { once: true });
    try {
      const result = await runCodexTypesetting(
        options.pages,
        settings,
        createPorts(runtime),
      );
      return {
        ...result,
        warnings: [...result.warnings, ...runtime.workContext.warnings],
      };
    } finally {
      options.signal.removeEventListener("abort", cancelRenderer);
    }
  } finally {
    renderer?.close();
    const cleanup = await Promise.allSettled([
      client.dispose(),
      images.dispose(),
      previews.dispose(),
    ]);
    for (const result of cleanup)
      if (result.status === "rejected")
        console.error("Astra cleanup failed", result.reason);
  }
}

async function requireAstra(
  client: CodexAppServerClient,
  effort: Runtime["effort"],
): Promise<void> {
  const account = await client.readAccount(false);
  if (account.account?.type !== "chatgpt")
    throw new Error("설정에서 ChatGPT 계정으로 로그인해 주세요.");
  const model = (await client.listModels()).find(
    (item) => item.id === CODEX_TYPESETTING_MODEL,
  );
  if (!model?.supportedReasoningEfforts.includes(effort))
    throw new Error("이 계정에서 선택한 Astra 추론 강도를 사용할 수 없습니다.");
}

function createPorts(runtime: Runtime): CodexTypesettingPorts {
  const { options, directory, renderer, evidence } = runtime;
  let sequence = 0;
  const ids = new Map<string, string>();
  const blockId = (id: string) => {
    const value = ids.get(id) ?? randomUUID();
    ids.set(id, value);
    return value;
  };
  return {
    targetLanguage: runtime.targetLanguage,
    translationContext: runtime.workContext.translationContext,
    confirmReading: options.confirmRegionReading,
    rememberReading: runtime.workContext.rememberReading,
    preview: runtime.workContext.preview,
    eraseOriginal: options.codexTypesetting?.eraseOriginal,
    regionOutput: options.codexTypesetting?.regionOutput,
    blockId,
    signal: options.signal,
    readPage: async (page) => pageImage(page),
    cropRegions: async (pages, readings, includeContext) =>
      sourceRegionCrops(pages, readings, includeContext),
    fontSamples: (preset, sample) =>
      renderFontSamples(preset, sample, directory, renderer),
    ...compositionPorts(runtime, blockId),
    inspectBackground: (composition, reading, attempt) =>
      inspectTypesettingBackground({
        composition,
        reading,
        attempt,
        directory,
        signal: options.signal,
        ask: requestPort(runtime),
        evidence,
      }),
    restoreRegions: restoreSourceRegions,
    render: async (page) => {
      const bytes = await renderer.renderPage(page, {
        format: "png",
        resolutionMode: "original",
      });
      const measured = await renderer.inspectLastLayout?.();
      if (!measured) throw new Error("실제 식자 측정 결과가 없습니다.");
      const painted = await measureCodexPaintedBounds(
        page,
        renderer,
        options.signal,
      );
      const measurements = measured.map(({ blockId: id, ...layout }) => ({
        regionId: [...ids].find((entry) => entry[1] === id)?.[0] ?? id,
        ...layout,
        paintedBounds: painted.get(id),
      }));
      await evidence(
        `render-measurements-${page.id}-${sequence + 1}`,
        measurements ?? null,
      );
      const imagePath = join(
        directory,
        "preview-" + page.id + "-" + ++sequence + ".png",
      );
      await writeFile(imagePath, bytes);
      runtime.workContext.preview(
        { ...page, imagePath, inpaintedImagePath: undefined },
        undefined,
        "review",
      );
      return typesettingPageImages(
        page,
        nativeImage.createFromBuffer(bytes),
        "Rendered " + page.name,
      ).map((image) => ({ ...image, measurements }));
    },
    saveEvidence: evidence,
    commit: runtime.workContext.commit,
    progress: runtime.progress,
    ask: requestPort(runtime),
  };
}

function createErasureClient(paths: ReturnType<typeof getAppPaths>) {
  let client: CodexAppServerClient | undefined;
  return {
    get: async () => {
      client ??= await CodexAppServerClient.start({
        paths,
        appVersion: app.getVersion(),
        capability: "typesetting-preview",
      });
      return client;
    },
    dispose: () => client?.dispose(),
  };
}

function requestPort(runtime: Runtime): CodexTypesettingPorts["ask"] {
  const { options, directory, client, evidence } = runtime;
  const references = new Map<
    string,
    ReturnType<typeof regionReferenceImages>
  >();
  return async (stage, prompt, images, erasurePreview) => {
    const page = options.pages.find(
      (item) =>
        stage.startsWith(`read-${item.id}`) ||
        stage.startsWith(`erase-${item.id}`),
    );
    const region =
      options.regionContext ?? (page && options.regionContexts?.get(page.id));
    const preview = erasurePreview
      ? createCodexErasurePreview({
          ...erasurePreview,
          stage,
          images,
          signal: options.signal,
          evidence,
        })
      : undefined;
    const result = await askAstraJson({
      client: preview ? await runtime.previewClient() : client,
      effort: runtime.effort,
      previewTool: preview?.tool,
      stage,
      prompt,
      images:
        region && (stage.startsWith("read-") || stage.startsWith("erase-"))
          ? [...images, ...(await sourceReference(region))]
          : images,
      cwd: directory,
      signal: options.signal,
      evidence,
      onRetry: (attempt, delayMs) =>
        runtime.progress({
          step: "retry",
          attempt,
          delaySeconds: delayMs / 1000,
        }),
    });
    return preview ? preview.verify(result) : result;
  };
  function sourceReference(
    region: NonNullable<PipelineOptions["regionContext"]>,
  ) {
    const key = JSON.stringify([region.sourcePage.id, region.cropRect]);
    let result = references.get(key);
    if (!result) {
      result = regionReferenceImages(region);
      references.set(key, result);
    }
    return result;
  }
}

function compositionPorts(
  runtime: Runtime,
  blockId: (id: string) => string,
): Pick<CodexTypesettingPorts, "cleanPage" | "illustrate"> {
  const { options, directory } = runtime;
  const backgroundCache: TypesettingBackgroundCache = new Map();
  return {
    cleanPage: async (page, reading, repair) => {
      runtime.progress({ step: "background" });
      const plain = await cleanPlainRegions(
        page,
        reading,
        directory,
        Boolean(repair),
      );
      if (
        !reading.regions.some(
          (region) =>
            region.action !== "keep" && region.background === "artwork",
        )
      )
        return plain;
      const illustrated = await cleanIllustratedRegions(
        plain.page,
        reading,
        await runtime.imageClient(),
        directory,
        options.signal,
        repair,
        backgroundCache,
      );
      return {
        page: illustrated.page,
        issues: [...plain.issues, ...illustrated.issues],
        backgroundCandidates: illustrated.backgroundCandidates,
      };
    },
    illustrate: async (page, reading, context) => {
      if (!reading.regions.some((region) => region.action === "image"))
        return { page, issues: [] };
      runtime.progress({ step: "sfx" });
      return generateLetteringLayers(
        page,
        reading,
        blockId,
        await runtime.imageClient(),
        directory,
        options.signal,
        context,
      );
    },
  };
}

function createLetteringClient(
  paths: ReturnType<typeof getAppPaths>,
  directory: string,
  codex: { model: string; reasoningEffort: Runtime["effort"] },
) {
  let client: CodexAppServerClient | undefined;
  return {
    get: async () => {
      client ??= await CodexAppServerClient.start({
        paths: { ...paths, codexWorkspaceDir: directory },
        appVersion: app.getVersion(),
        capability: "image-generation",
      });
      const connected = client;
      return {
        runEphemeralTurn: (
          request: Parameters<CodexAppServerClient["runEphemeralTurn"]>[0],
        ) =>
          connected.runEphemeralTurn({
            ...request,
            model: codex.model,
            effort: codex.reasoningEffort,
          }),
      };
    },
    dispose: async () => {
      await client?.dispose();
    },
  };
}

async function recordRunContract(
  runtime: Runtime,
  preset: import("../../shared/codexTypesettingTypes").CodexFontPreset,
) {
  await runtime.evidence("run-contract", {
    recipe: CODEX_TYPESETTING_RECIPE,
    model: CODEX_TYPESETTING_MODEL,
    effort: runtime.effort,
    preset,
  });
}

export function runConfiguredCodexPipeline(
  options: PipelineOptions,
  configured: Parameters<typeof configuredTypesettingOptions>[0],
) {
  const codexTypesetting = configuredTypesettingOptions(configured);
  return codexTypesetting
    ? runCodexTypesettingPipeline({ ...options, codexTypesetting })
    : undefined;
}
