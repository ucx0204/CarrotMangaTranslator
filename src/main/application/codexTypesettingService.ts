import { keepFirstResultOnReviewFailure } from "./codexTypesettingReview";
import type {
  CodexPageReading,
  CodexTypesettingOptions,
} from "../../shared/codexTypesettingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { refineCodexSourceRegion } from "../../shared/codexTypesettingMask";
import type {
  CodexChapterPlan,
  CodexTypesettingPorts,
} from "./codexTypesettingContracts";
import {
  buildCodexTypesetPage,
  withCodexReadingReview,
  withCodexTypesettingReview,
} from "./codexTypesettingBlocks";
import { prepareCodexBackground } from "./codexTypesettingBackground";
import { inspectGeneratedLettering } from "./codexTypesettingReadback";
import { readCodexPage } from "./codexTypesettingReading";
import { applyCodexLayoutTreatment } from "./codexTypesettingTreatment";
import {
  codexBatchStage,
  partitionCodexReading,
} from "./codexTypesettingBatches";
import {
  planCodexPageLayouts,
  reviewCodexPageBatches,
} from "./codexTypesettingPlanning";
import {
  fontAssignmentPrompt,
  erasurePrompt,
  SOURCE_FAMILIES_PROMPT,
} from "./codexTypesettingPrompts";
import {
  assertExactMembership,
  erasurePlansSchema,
  fontAssignmentsSchema,
  fontGroupsSchema,
  validateFontGroups,
} from "./codexTypesettingValidation";

export async function runCodexTypesetting(
  pages: MangaPage[],
  options: CodexTypesettingOptions,
  ports: CodexTypesettingPorts,
): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  const readings = await readChapter(pages, ports);
  const activeIds = [...readings.values()].flatMap((reading) =>
    reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => region.id),
  );
  if (!activeIds.length) return finishEmptyChapter(pages, readings, ports);
  ports.progress({ stage: "fonts", step: "groupFonts" });
  const crops = await ports.cropRegions(pages, readings);
  const { groups } = fontGroupsSchema.parse(
    await ports.ask("source-families", SOURCE_FAMILIES_PROMPT, crops),
  );
  validateFontGroups(groups, activeIds);
  await ports.saveEvidence("source-families", groups);
  ports.progress({ step: "matchFonts" });
  const sample =
    [...readings.values()]
      .flatMap((reading) => reading.regions)
      .find((region) => region.action === "text")?.translatedText ?? "Hello";
  const samples = await ports.fontSamples(options, sample);
  const { fonts } = fontAssignmentsSchema.parse(
    await ports.ask(
      "font-assignment",
      fontAssignmentPrompt(options, { groups }),
      [...samples, ...crops],
    ),
  );
  assertExactMembership(
    groups.map((group) => group.id),
    fonts.map((font) => font.groupId),
    "Font assignment",
  );
  if (
    fonts.some(
      (font) =>
        !options.preset.fonts.some((allowed) => allowed.fontId === font.fontId),
    )
  )
    throw new Error("프리셋 밖 폰트를 선택했습니다.");
  const plan = { groups, fonts, sfxRendering: options.sfxRendering ?? "image" };
  await ports.saveEvidence("chapter-plan", plan);
  const completed: MangaPage[] = [];
  const warnings: string[] = [];
  for (const [index, page] of pages.entries()) {
    ports.signal.throwIfAborted();
    ports.progress({
      stage: "typesetting",
      step: "layout",
      page: index + 1,
      completed: completed.length,
    });
    const reading = readings.get(page.id);
    if (!reading) throw new Error("페이지 판독 결과가 없습니다.");
    const result = withCodexReadingReview(
      await typesetPage(page, reading, plan, samples, ports),
      reading,
      ports.blockId,
    );
    await commitReviewedPage(result, reading, ports, completed, warnings);
  }
  return { pages: completed, warnings };
}

async function planPageErasure(
  page: MangaPage,
  reading: CodexPageReading,
  ports: CodexTypesettingPorts,
): Promise<CodexPageReading> {
  const active = reading.regions.filter((region) => region.action !== "keep");
  if (!active.length) return reading;
  const batches = partitionCodexReading(reading, 12);
  const result: {
    regions: ReturnType<typeof erasurePlansSchema.parse>["regions"];
  } = { regions: [] };
  for (const [index, batch] of batches.entries()) {
    ports.signal.throwIfAborted();
    ports.progress({
      step: "erasurePlan",
      part: index + 1,
      parts: batches.length,
    });
    const response = erasurePlansSchema.parse(
      await ports.ask(
        codexBatchStage(`erase-${page.id}`, index, batches.length),
        erasurePrompt(batch),
        await ports.cropRegions([page], new Map([[page.id, batch]]), true),
        { page, reading: batch },
      ),
    );
    assertExactMembership(
      batch.regions
        .filter((region) => region.action !== "keep")
        .map((region) => region.id),
      response.regions.map((region) => region.regionId),
      "Erasure batch",
    );
    result.regions.push(...response.regions);
  }
  assertExactMembership(
    active.map((region) => region.id),
    result.regions.map((region) => region.regionId),
    "Erasure plan",
  );
  const refined = {
    ...reading,
    regions: reading.regions.map((region) => {
      const plan = result.regions.find((item) => item.regionId === region.id);
      return plan
        ? {
            ...refineCodexSourceRegion(region, page, plan.erasePolygons),
            background: plan.background,
          }
        : region;
    }),
  };
  await ports.saveEvidence(`erasure-${page.id}`, { result, reading: refined });
  return refined;
}

async function readChapter(
  pages: MangaPage[],
  ports: CodexTypesettingPorts,
): Promise<Map<string, CodexPageReading>> {
  const readings = new Map<string, CodexPageReading>();
  let context = "";
  for (const [index, page] of pages.entries()) {
    ports.signal.throwIfAborted();
    ports.progress({
      stage: "reading",
      step: "reading",
      page: index + 1,
      completed: index,
    });
    const detected = await readCodexPage(page, context, ports);
    const initial = (await ports.confirmReading?.(detected)) ?? detected;
    ports.preview?.(page, initial, "reading");
    ports.progress({ step: "erasurePlan" });
    const planned =
      ports.eraseOriginal === false
        ? initial
        : await planPageErasure(page, initial, ports);
    const reading = applyRegionOutput(planned, ports.regionOutput);
    readings.set(page.id, reading);
    ports.rememberReading?.(page, reading);
    context = `${context}\n${reading.summary}`.slice(-24000);
    await ports.saveEvidence(`reading-${page.id}`, reading);
    ports.progress({ step: "reading", completed: index + 1 });
  }
  return readings;
}

async function typesetPage(
  page: MangaPage,
  reading: CodexPageReading,
  plan: CodexChapterPlan,
  samples: Awaited<ReturnType<CodexTypesettingPorts["fontSamples"]>>,
  ports: CodexTypesettingPorts,
): Promise<{ page: MangaPage; warning?: string }> {
  if (!reading.regions.some((region) => region.action !== "keep"))
    return { page: clearTypesetting(page) };
  const background =
    ports.eraseOriginal === false
      ? { page, reading, failedIds: [], issues: [] }
      : await prepareCodexBackground(page, reading, ports);
  const result = await typesetCleanPage(
    background.page,
    background.reading,
    plan,
    samples,
    ports,
  );
  return withCodexTypesettingReview(result, background.issues, ports.blockId);
}

async function typesetCleanPage(
  page: MangaPage,
  reading: CodexPageReading,
  plan: CodexChapterPlan,
  samples: Awaited<ReturnType<CodexTypesettingPorts["fontSamples"]>>,
  ports: CodexTypesettingPorts,
): Promise<{ page: MangaPage; warning?: string }> {
  const source = await ports.readPage(page);
  const layouts = await planCodexPageLayouts(
    page,
    reading,
    plan,
    { source, samples },
    { attempt: 0, issues: [] },
    ports,
  );
  const rendering = ports.regionOutput
    ? ports.regionOutput === "image"
      ? "image"
      : "font"
    : plan.sfxRendering;
  const treatment = applyRegionOutput(
    applyCodexLayoutTreatment(reading, layouts, rendering),
    ports.regionOutput,
  );
  const composition = await ports.illustrate(
    buildCodexTypesetPage(page, treatment, plan, layouts, ports.blockId),
    treatment,
    { attempt: 0, issues: [], plan },
  );
  const review = await keepFirstResultOnReviewFailure(
    treatment,
    ports,
    "text",
    `layout-${page.id}`,
    async () => {
      const readback = await inspectGeneratedLettering(
        composition.page,
        treatment,
        0,
        ports,
      );
      const preview = await ports.render(composition.page);
      const result = await reviewCodexPageBatches(
        composition.page,
        treatment,
        source,
        preview,
        0,
        ports,
      );
      result.issues.push(...readback);
      return result;
    },
    {},
  );
  review.issues.push(...composition.issues);
  await ports.saveEvidence(`layout-${page.id}-0`, {
    layouts,
    reading: treatment,
    review,
  });
  return withCodexTypesettingReview(
    { page: composition.page },
    review.issues,
    ports.blockId,
  );
}

async function finishEmptyChapter(
  pages: MangaPage[],
  readings: Map<string, CodexPageReading>,
  ports: CodexTypesettingPorts,
) {
  const completed: MangaPage[] = [];
  const warnings: string[] = [];
  for (const page of pages) {
    ports.signal.throwIfAborted();
    const reading = readings.get(page.id);
    if (!reading) throw new Error("페이지 판독 결과가 없습니다.");
    const result = withCodexReadingReview(
      { page: clearTypesetting(page) },
      reading,
      ports.blockId,
    );
    await commitReviewedPage(result, reading, ports, completed, warnings);
  }
  return { pages: completed, warnings };
}

function clearTypesetting(page: MangaPage): MangaPage {
  return {
    ...page,
    blocks: [],
    blockOrder: [],
    inpaintedImagePath: undefined,
    inpaintMaskPath: undefined,
    typesettingMethod: "codex",
    analysisStatus: "completed",
  };
}

function applyRegionOutput(
  reading: CodexPageReading,
  output: CodexTypesettingPorts["regionOutput"],
): CodexPageReading {
  if (!output) return reading;
  return {
    ...reading,
    regions: reading.regions.map((region) =>
      region.action === "keep"
        ? region
        : {
            ...region,
            action: output,
            role: output === "image" ? "sound" : region.role,
          },
    ),
  };
}

async function commitReviewedPage(
  result: ReturnType<typeof withCodexReadingReview>,
  reading: CodexPageReading,
  ports: CodexTypesettingPorts,
  completed: MangaPage[],
  warnings: string[],
) {
  if (result.warning) warnings.push(result.warning);
  ports.progress({ stage: "typesetting", step: "saving" });
  const accepted = (await ports.commit(result.page, reading)) !== false;
  if (accepted) completed.push(result.page);
  ports.progress({
    step: "saving",
    completed: completed.length,
    pageCommitted: accepted,
  });
}
