import type { MangaPage } from "../../shared/libraryTypes";
import type { BubbleLayoutRunnerFactoryOptions } from "../inpainting/bubbleLayoutRunner";
import { loadPageImage } from "../inpainting/imageIO";
import {
  contextualTextTargets,
  refineContextualText,
} from "../inpainting/qwenContextualTypography";
import { ensureKoharuLayoutAssets } from "./assets";
import { processDetectedBubbleLayouts } from "./bubbleLayoutPageProcessor";
import type { ComicPageDetectionResult } from "./contracts";
import { detectKoharuPageLayout } from "./detector";
import { logWarn } from "../logger";

type Targets = ReturnType<typeof contextualTextTargets>;
type TextMasks = Awaited<ReturnType<typeof refineContextualText>>;

function targetKey(target: Targets[number]) {
  return JSON.stringify([
    target.id,
    target.selected,
    target.effect,
    target.full?.bounds,
  ]);
}

// Spilled with the page detection and discarded with the job. A miss can occur
// when subsequent selection edits change the block geometry or its ownership.
export async function resolvePreparedContext(
  targets: Targets,
  saved: ComicPageDetectionResult["preparedText"],
  refine: (targets: Targets) => Promise<TextMasks>,
) {
  const result: TextMasks = new Map();
  const missing: Targets = [];
  for (const target of targets) {
    const cached = saved?.get(targetKey(target));
    if (cached === undefined) missing.push(target);
    else if (cached) result.set(target.id, cached);
  }
  if (missing.length)
    for (const [id, mask] of await refine(missing)) result.set(id, mask);
  return result;
}

export async function prepareCudaContext(
  page: MangaPage,
  detection: ComicPageDetectionResult,
  options: BubbleLayoutRunnerFactoryOptions,
  signal: AbortSignal,
) {
  const patches = processDetectedBubbleLayouts({
    page,
    ...detection,
    policy: "balanced",
    sourceEraseMask: true,
    pageRevision: "",
  });
  const targets = contextualTextTargets(page, detection, patches);
  if (!targets.length) return detection;
  try {
    const source = await loadPageImage(page.imagePath, options.decodeFallback);
    const assets = await ensureKoharuLayoutAssets({
      dataRoot: options.dataRoot,
      signal,
    });
    const masks = await refineContextualText(
      page,
      targets,
      (view) =>
        detectKoharuPageLayout({
          imagePath: page.imagePath,
          originalCrop: source.crop(view),
          modelPath: assets.modelPath,
          directMl: options.directMl,
          signal,
        }),
      signal,
    );
    const preparedText = new Map(
      targets.map((target) => [
        targetKey(target),
        masks.get(target.id) ?? null,
      ]),
    );
    return { ...detection, preparedText };
  } catch (error) {
    signal.throwIfAborted();
    logWarn("Koharu contextual preparation deferred", {
      pageId: page.id,
      error,
    });
    return detection;
  }
}
