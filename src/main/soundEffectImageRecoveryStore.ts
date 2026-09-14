import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexPageReading } from "../shared/codexTypesettingTypes";
import type { ChapterSnapshot } from "../shared/libraryTypes";
import type { SoundEffectImageRecovery } from "../shared/analysisTypes";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../shared/pageRevision";
import { getRunPaths, openChapter } from "./library";
import { readJsonFile, writeJsonFile } from "./libraryStore/storage";
import { translatedPageReading } from "./codexImageEditing";

const FILE = "sound-effect-image-recovery.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SoundEffectImageRecoveryPlan = {
  version: 1;
  runId: string;
  chapterId: string;
  eraseOriginal: boolean;
  output: "text" | "image";
  pages: Array<{
    pageId: string;
    revision: string;
    blockIds: string[];
    reading: CodexPageReading;
    erasedBlockIds: string[];
    completed: boolean;
    error?: string;
  }>;
};

/** Sidecar under the existing run directory; chapter/library formats are unchanged. */
export async function saveSoundEffectImageRecovery(
  plan: SoundEffectImageRecoveryPlan,
): Promise<void> {
  if (!UUID.test(plan.runId))
    throw new Error("효과음 복구 작업 ID가 올바르지 않습니다.");
  const paths = await getRunPaths(plan.chapterId, plan.runId);
  await writeJsonFile(join(paths.runDir, FILE), plan);
}

export async function loadSoundEffectImageRecovery(
  chapter: ChapterSnapshot,
  runId: string,
): Promise<SoundEffectImageRecoveryPlan | null> {
  if (!UUID.test(runId))
    throw new Error("효과음 복구 작업 ID가 올바르지 않습니다.");
  const { runDir } = await getRunPaths(chapter.id, runId);
  const plan = await readJsonFile<SoundEffectImageRecoveryPlan | null>(
    join(runDir, FILE),
    null,
  );
  if (plan) {
    if (
      plan.version !== 1 ||
      plan.runId !== runId ||
      plan.chapterId !== chapter.id ||
      typeof plan.eraseOriginal !== "boolean" ||
      !["image", "text"].includes(plan.output) ||
      !Array.isArray(plan.pages) ||
      !plan.pages.every(validRecoveryPage) ||
      new Set(plan.pages.map((page) => page.pageId)).size !== plan.pages.length
    )
      throw new Error("효과음 복구 기록이 올바르지 않습니다.");
    return plan;
  }
  return legacySoundEffectImageRecovery(chapter, runId, runDir);
}

export async function getSoundEffectImageRecovery(
  chapterId: string,
): Promise<SoundEffectImageRecovery | null> {
  const chapter = await openChapter(chapterId);
  const { chapterDir } = await getRunPaths(chapterId, "recovery-list");
  const root = join(chapterDir, "runs");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
      .map(async (entry) => ({
        id: entry.name,
        time: (await stat(join(root, entry.name))).mtimeMs,
      })),
  );
  for (const run of runs.sort((a, b) => b.time - a.time)) {
    const plan = await loadSoundEffectImageRecovery(chapter, run.id);
    if (!plan) continue;
    const pending = plan.pages.filter((page) => !page.completed);
    if (!pending.length) continue;
    return {
      runId: plan.runId,
      chapterId,
      eraseOriginal: plan.eraseOriginal,
      output: plan.output,
      blockCount: pending.reduce((sum, page) => sum + page.blockIds.length, 0),
      targets: pending.flatMap((target) => {
        const page = chapter.pages.find((page) => page.id === target.pageId);
        return page
          ? [
              {
                pageId: page.id,
                pageRevision: createSoundEffectReviewPageRevision(page),
              },
            ]
          : [];
      }),
    };
  }
  return null;
}

/** Older runs already stored approved text/boxes in resolved SFX blocks. Never retranslate them. */
async function legacySoundEffectImageRecovery(
  chapter: ChapterSnapshot,
  runId: string,
  directory: string,
): Promise<SoundEffectImageRecoveryPlan | null> {
  const pages = chapter.pages.flatMap((page) => {
    const blocks = page.blocks.filter(
      (block) =>
        block.id.includes(`-${runId}-sfx-`) &&
        !block.generatedLettering &&
        !block.imageGenerationBlocked,
    );
    return blocks.length
      ? [
          {
            pageId: page.id,
            revision: createPageRevision(page),
            blockIds: blocks.map((block) => block.id),
            reading: translatedPageReading({ ...page, blocks }, "image"),
            erasedBlockIds: [],
            completed: false,
          },
        ]
      : [];
  });
  if (!pages.length) return null;
  const imageRoot = join(directory, "codex-image");
  const imagePages = await readdir(imageRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  let attempted = false;
  let eraseOriginal = false;
  for (const page of imagePages.filter((entry) => entry.isDirectory())) {
    for (const file of await readdir(join(imageRoot, page.name))) {
      if (!/^image-call-[\w-]+\.json$/.test(file)) continue;
      const call = await readJsonFile<{ purpose?: string }>(
        join(imageRoot, page.name, file),
      );
      attempted = true;
      eraseOriginal ||= call.purpose === "background";
    }
  }
  return attempted
    ? {
        version: 1,
        runId,
        chapterId: chapter.id,
        output: "image",
        eraseOriginal,
        pages,
      }
    : null;
}

function validRecoveryPage(
  page: SoundEffectImageRecoveryPlan["pages"][number],
): boolean {
  if (
    !page ||
    !validRecoveryIdentity(page) ||
    typeof page.completed !== "boolean" ||
    !Array.isArray(page.blockIds) ||
    !page.blockIds.every(
      (id) => typeof id === "string" && /^[\w-]+$/.test(id),
    ) ||
    new Set(page.blockIds).size !== page.blockIds.length ||
    !Array.isArray(page.erasedBlockIds) ||
    !page.erasedBlockIds.every((id) => page.blockIds.includes(id))
  )
    return false;
  const ids = page.reading.regions
    .filter((region) => region.action !== "keep")
    .map((region) => region.id);
  return (
    ids.length === page.blockIds.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => page.blockIds.includes(id))
  );
}

function validRecoveryIdentity(
  page: SoundEffectImageRecoveryPlan["pages"][number],
): boolean {
  return (
    typeof page.pageId === "string" &&
    /^page-v1:[a-f0-9]{16}$/.test(page.revision) &&
    Array.isArray(page.reading?.regions)
  );
}
