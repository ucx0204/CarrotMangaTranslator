import { app, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "./appPaths";
import {
  createImport,
  deleteWork,
  listLibrary,
  openChapter,
  previewImages,
  savePageBlocks,
} from "./library";
import { renderPageWithTranslationBlocksForExport } from "./pageExport";

const MAC_PACKAGE_SMOKE_MARKER = "mac-package-smoke.json";
const MAC_PACKAGE_SMOKE_DIR = "mac-package-smoke";
const MAC_PACKAGE_SMOKE_CLI_TOKEN = "--mgt-mac-package-smoke=alpha-ci-v1";
const MAC_PACKAGE_SMOKE_STAGE_PREFIX = "--mgt-mac-package-smoke-stage=";

type PreparedSmoke = {
  ok: true;
  stage: "prepared";
  dataRoot: string;
  workId: string;
  chapterId: string;
  pageId: string;
  firstExportPath: string;
  imported: true;
  saved: true;
  exported: true;
};

/** CI-only packaged-app probe. It never runs without the exact opt-in flag. */
export async function runMacPackageSmokeExit(
  appPaths: AppPaths,
): Promise<boolean> {
  if (!shouldRunMacPackageSmoke()) {
    return false;
  }

  const stage =
    process.env.MGT_MAC_PACKAGE_SMOKE_STAGE || readPackageSmokeStageArgument();
  const markerPath = join(appPaths.dataRoot, MAC_PACKAGE_SMOKE_MARKER);
  try {
    if (stage === "prepare") {
      await preparePackageSmoke(appPaths, markerPath);
    } else if (stage === "verify") {
      await verifyRestartedPackageSmoke(appPaths, markerPath);
    } else {
      throw new Error(`Unknown Mac package smoke stage: ${stage ?? ""}`);
    }
    app.exit(0);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    await writeFile(
      markerPath,
      `${JSON.stringify({ ok: false, stage, dataRoot: appPaths.dataRoot, error: message }, null, 2)}\n`,
      "utf8",
    );
    console.error("Mac package application smoke failed", error);
    app.exit(1);
  }
  return true;
}

function shouldRunMacPackageSmoke(): boolean {
  const requested =
    process.env.MGT_MAC_PACKAGE_SMOKE_EXIT === "1" ||
    process.argv.includes(MAC_PACKAGE_SMOKE_CLI_TOKEN);
  return (
    requested &&
    app.isPackaged &&
    process.platform === "darwin" &&
    process.arch === "arm64"
  );
}

function readPackageSmokeStageArgument(): string | undefined {
  const argument = process.argv.find((value) =>
    value.startsWith(MAC_PACKAGE_SMOKE_STAGE_PREFIX),
  );
  return argument?.slice(MAC_PACKAGE_SMOKE_STAGE_PREFIX.length);
}

async function preparePackageSmoke(
  appPaths: AppPaths,
  markerPath: string,
): Promise<void> {
  const smokeRoot = join(appPaths.dataRoot, MAC_PACKAGE_SMOKE_DIR);
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(smokeRoot, { recursive: true });
  const sourcePath = join(smokeRoot, "import-source.png");
  await writeSmokeSourcePng(sourcePath);

  const preview = await previewImages([sourcePath]);
  const draft = preview.chapters[0];
  if (!draft) throw new Error("Mac package smoke import preview was empty.");
  const imported = await createImport({
    preview,
    target: { mode: "new", title: "Mac Alpha Package Smoke" },
    selections: [{ draftId: draft.draftId, title: "Smoke", enabled: true }],
  });
  const chapter = imported.openedChapter;
  const page = chapter?.pages[0];
  if (!chapter || !page) {
    throw new Error("Mac package smoke did not import a page.");
  }

  const saved = await savePageBlocks({
    chapterId: chapter.id,
    pageId: page.id,
    baseUpdatedAt: page.updatedAt,
    saveReason: "manual",
    blocks: page.blocks,
  });
  const savedPage = saved.pages.find((candidate) => candidate.id === page.id);
  if (!savedPage)
    throw new Error("Mac package smoke page save was not persisted.");

  const firstExportPath = join(smokeRoot, "first-export.png");
  await writeRenderedPage(firstExportPath, savedPage, appPaths.dataRoot);
  const prepared: PreparedSmoke = {
    ok: true,
    stage: "prepared",
    dataRoot: appPaths.dataRoot,
    workId: imported.workId,
    chapterId: chapter.id,
    pageId: page.id,
    firstExportPath,
    imported: true,
    saved: true,
    exported: true,
  };
  await writeFile(markerPath, `${JSON.stringify(prepared, null, 2)}\n`, "utf8");
}

async function verifyRestartedPackageSmoke(
  appPaths: AppPaths,
  markerPath: string,
): Promise<void> {
  const prepared = parsePreparedSmoke(await readFile(markerPath, "utf8"));
  if (prepared.dataRoot !== appPaths.dataRoot) {
    throw new Error("Mac package smoke data root changed after restart.");
  }
  if (!existsSync(prepared.firstExportPath)) {
    throw new Error(
      "Mac package smoke first export disappeared after restart.",
    );
  }
  const library = await listLibrary();
  if (!library.works.some((work) => work.id === prepared.workId)) {
    throw new Error("Mac package smoke imported work was not reloaded.");
  }
  const chapter = await openChapter(prepared.chapterId);
  const page = chapter.pages.find(
    (candidate) => candidate.id === prepared.pageId,
  );
  if (!page) throw new Error("Mac package smoke saved page was not reloaded.");

  const restartedExportPath = join(
    appPaths.dataRoot,
    MAC_PACKAGE_SMOKE_DIR,
    "restart-export.png",
  );
  await writeRenderedPage(restartedExportPath, page, appPaths.dataRoot);
  await deleteWork(prepared.workId);
  await rm(join(appPaths.dataRoot, MAC_PACKAGE_SMOKE_DIR), {
    recursive: true,
    force: true,
  });
  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        ok: true,
        stage: "verified",
        platform: process.platform,
        arch: process.arch,
        dataRoot: appPaths.dataRoot,
        imported: true,
        saved: true,
        restarted: true,
        exported: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeSmokeSourcePng(filePath: string): Promise<void> {
  const width = 256;
  const height = 192;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  const image = nativeImage.createFromBitmap(bitmap, { width, height });
  if (image.isEmpty())
    throw new Error("Mac package smoke source image is empty.");
  await writeFile(filePath, image.toPNG());
}

async function writeRenderedPage(
  filePath: string,
  page: Awaited<ReturnType<typeof openChapter>>["pages"][number],
  dataRoot: string,
): Promise<void> {
  const png = await renderPageWithTranslationBlocksForExport(page, {
    dataRoot,
    decodeFallback: () => Promise.resolve(null),
  });
  if (!png.length) throw new Error("Mac package smoke export was empty.");
  await writeFile(filePath, png);
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty())
    throw new Error("Mac package smoke export is not a PNG.");
}

function parsePreparedSmoke(value: string): PreparedSmoke {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Partial<PreparedSmoke>).ok !== true ||
    (parsed as Partial<PreparedSmoke>).stage !== "prepared"
  ) {
    throw new Error("Mac package smoke prepare marker is invalid.");
  }
  return parsed as PreparedSmoke;
}
