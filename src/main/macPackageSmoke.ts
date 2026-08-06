import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { releaseDataRootInstanceLockLease } from "./dataRootInstanceLockState";
import { exitMacPackageSmoke } from "./macPackageSmokeExit";

const MAC_PACKAGE_SMOKE_MARKER = "mac-package-smoke.json";
const MAC_PACKAGE_SMOKE_DIR = "mac-package-smoke";
const MAC_PACKAGE_SMOKE_CLI_TOKEN = "--mgt-mac-package-smoke=alpha-ci-v1";
const MAC_PACKAGE_SMOKE_STAGE_PREFIX = "--mgt-mac-package-smoke-stage=";
const SMOKE_SOURCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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
    exitMacPackageSmokeProcess(0);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    await writeSmokeMarker(markerPath, {
      ok: false,
      stage,
      dataRoot: appPaths.dataRoot,
      error: message,
    });
    console.error("Mac package application smoke failed", error);
    exitMacPackageSmokeProcess(1);
  }
  return true;
}

function exitMacPackageSmokeProcess(code: number): void {
  exitMacPackageSmoke(code, {
    releaseDataRootLock: releaseDataRootInstanceLockLease,
    exit: (exitCode) => app.exit(exitCode),
    reportReleaseFailure: (error) => {
      console.error(
        "Failed to release data-root lock before mac package smoke exit",
        error,
      );
    },
  });
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
  await writeSmokeProgress(
    markerPath,
    "preparing",
    "reset-workspace",
    appPaths,
  );
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(smokeRoot, { recursive: true });
  const sourcePath = join(smokeRoot, "import-source.png");
  await writeSmokeProgress(markerPath, "preparing", "write-source", appPaths);
  await writeSmokeSourcePng(sourcePath);

  await writeSmokeProgress(markerPath, "preparing", "preview-import", appPaths);
  const preview = await previewImages([sourcePath]);
  const draft = preview.chapters[0];
  if (!draft) throw new Error("Mac package smoke import preview was empty.");
  await writeSmokeProgress(markerPath, "preparing", "create-import", appPaths);
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

  await writeSmokeProgress(markerPath, "preparing", "save-page", appPaths);
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
  await writeSmokeProgress(markerPath, "preparing", "export-page", appPaths);
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
  await writeSmokeMarker(markerPath, prepared);
}

async function verifyRestartedPackageSmoke(
  appPaths: AppPaths,
  markerPath: string,
): Promise<void> {
  const prepared = parsePreparedSmoke(await readFile(markerPath, "utf8"));
  await writeSmokeProgress(markerPath, "verifying", "reload-library", appPaths);
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
  await writeSmokeProgress(markerPath, "verifying", "export-page", appPaths);
  await writeRenderedPage(restartedExportPath, page, appPaths.dataRoot);
  await writeSmokeProgress(markerPath, "verifying", "cleanup", appPaths);
  await deleteWork(prepared.workId);
  await rm(join(appPaths.dataRoot, MAC_PACKAGE_SMOKE_DIR), {
    recursive: true,
    force: true,
  });
  await writeSmokeMarker(markerPath, {
    ok: true,
    stage: "verified",
    platform: process.platform,
    arch: process.arch,
    dataRoot: appPaths.dataRoot,
    imported: true,
    saved: true,
    restarted: true,
    exported: true,
  });
}

async function writeSmokeSourcePng(filePath: string): Promise<void> {
  if (!isPng(SMOKE_SOURCE_PNG)) {
    throw new Error("Mac package smoke source fixture is not a PNG.");
  }
  await writeFile(filePath, SMOKE_SOURCE_PNG);
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
  if (!isPng(png)) throw new Error("Mac package smoke export is not a PNG.");
}

async function writeSmokeProgress(
  markerPath: string,
  stage: "preparing" | "verifying",
  phase: string,
  appPaths: AppPaths,
): Promise<void> {
  await writeSmokeMarker(markerPath, {
    ok: true,
    stage,
    phase,
    platform: process.platform,
    arch: process.arch,
    dataRoot: appPaths.dataRoot,
  });
}

async function writeSmokeMarker(
  markerPath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporaryPath = `${markerPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, markerPath);
}

function isPng(value: Buffer): boolean {
  return (
    value.length >= PNG_SIGNATURE.length &&
    value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
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
