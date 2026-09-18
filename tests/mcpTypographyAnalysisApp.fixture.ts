import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { editingChapter } from "./mcpEditing.fixture";
import type { FontChapterC18Port } from "../src/main/pipeline/fontChapterC18Types";

export async function typographyAnalysisAppFixture() {
  const env = await mcpAppEnvironment();
  const directory = join(
    env.libraryDir,
    "works",
    "work",
    "chapters",
    "chapter",
  );
  await mkdir(join(directory, "pages"), { recursive: true });
  const chapter = editingChapter();
  chapter.pages = ["page", "second"].map((id) => ({
    ...structuredClone(chapter.pages[0]),
    id,
    width: 100,
    height: 100,
    imagePath: join(directory, "pages", `${id}.png`),
    inpaintedImagePath: undefined,
    inpaintMaskPath: undefined,
    dataUrl: "",
    blocks: chapter.pages[0].blocks.map((block, index) => ({
      ...block,
      textRole: "ordinary",
      sourceText: String.fromCodePoint(0x3042),
      sourceDirection: "horizontal",
      generatedLettering: undefined,
      backgroundColor: "#ffffff",
      bbox: { x: 10 + index * 40, y: 20, w: 30, h: 30 },
      fontSizeIntent: index === 1 ? "manual" : undefined,
    })),
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const png = new PNG({ width: 100, height: 100 });
  png.data.fill(255);
  for (let y = 25; y < 45; y++)
    for (let x = 15; x < 35; x++)
      png.data.fill(0, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
  const bytes = PNG.sync.write(png);
  for (const page of chapter.pages) await writeFile(page.imagePath, bytes);
  const chapterPath = join(directory, "chapter.json");
  await writeFile(chapterPath, JSON.stringify(chapter));
  await writeFile(
    join(env.libraryDir, "index.json"),
    JSON.stringify({ workOrder: ["work"] }),
  );
  await writeFile(
    join(env.libraryDir, "works", "work", "work.json"),
    JSON.stringify({
      id: "work",
      title: "Synthetic typography",
      chapterOrder: ["chapter"],
      createdAt: "same-time",
      updatedAt: "same-time",
    }),
  );
  const library = await import("../src/main/library");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { libraryMutationCoordinator } =
    await import("../src/main/libraryStore/libraryMutationCoordinator");
  const { estimatePageSourceFontSizes } =
    await import("../src/main/pipeline/sourceFontSizeEstimator");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  libraryMutationCoordinator.configureActivityGate(jobs.gate);
  // Emulate only the renderer acknowledgement boundary for clean fixture pages.
  // Production handoff, activity ownership and library transactions remain real.
  const handoffPages: string[] = [];
  const detach = jobs.pageHandoffs.subscribe(() => {
    for (const page of jobs.pageHandoffs.activities) {
      if (page.phase === "finishing-edits" && page.requestId) {
        const requestId = page.requestId;
        queueMicrotask(() => {
          if (jobs.pageHandoffs.respond({ requestId }))
            handoffPages.push(page.pageId);
        });
      }
    }
  });
  const app = {
    jobs,
    appPaths: getAppPaths(),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const prepare = vi.fn<FontChapterC18Port["prepare"]>(async () => () => ({
    fontId: "jua",
    fontWeight: 400,
    italic: false,
    groupId: "synthetic-source-group",
    runtimeVersion: "c23.0",
  }));
  const measure: typeof estimatePageSourceFontSizes = (options) =>
    estimatePageSourceFontSizes({
      ...options,
      loadRaster: async (page) => {
        const image = PNG.sync.read(await readFile(page.imagePath));
        return { width: image.width, height: image.height, bgra: image.data };
      },
    });
  return {
    env,
    chapter,
    chapterPath,
    bytes,
    library,
    app,
    prepare,
    runtime: { chapter: { prepare }, measure },
    handoffPages,
    close: async () => {
      detach();
      await env.close();
    },
  };
}
