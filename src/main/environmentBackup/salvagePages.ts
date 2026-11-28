import { randomUUID } from "node:crypto";
import { link, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  ChapterSnapshotSchema,
  LibraryChapterFileSchema,
} from "../../shared/ipcLibrarySchemas";
import { MAX_PAGES_PER_REQUEST } from "../../shared/ipcSchemaPrimitives";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { probeImageFile } from "../libraryStore/imageHeaderProbe";
import { reorderRecords } from "../libraryStore/chapterRecords";
import { buildMaterializedSharedPage } from "../libraryStore/shareImportPageRecord";
import { isSupportedImagePath } from "../libraryStore/storage";
import { portableLibraryPath } from "./library";

async function linkRecoveryFile(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(source, target);
  } catch (error) {
    if (
      !["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

const pageSchema = LibraryChapterFileSchema.shape.pages.element;
export type RecoverySource = {
  root: string;
  files: Set<string>;
  report: (detail: string) => void;
  signal: AbortSignal;
};

function imageInChapter(
  source: RecoverySource,
  prefix: string,
  value: unknown,
) {
  if (typeof value !== "string" || !isSupportedImagePath(value)) return;
  try {
    const normalized = value.replace(/\\/g, "/");
    const path = portableLibraryPath(
      /^(pages|inpainted|masks)\//.test(normalized)
        ? prefix + "/" + normalized
        : normalized,
    );
    if (path.startsWith(prefix + "/") && source.files.has(path)) return path;
  } catch (_error) {
    return undefined;
  }
}

function readPage(raw: unknown, source: RecoverySource, chapterPath: string) {
  const strict = pageSchema.safeParse(raw);
  if (strict.success) return strict.data;
  source.report(chapterPath);
  // A bad optional field or block must not discard the surviving translation.
  const shape = pageSchema.in.shape;
  const record = raw as Partial<LibraryPageRecord> | null;
  if (!record || !Array.isArray(record.blocks)) return;
  const blocks = record.blocks.flatMap((block) => {
    const result = shape.blocks.element.safeParse(block);
    return result.success ? [result.data] : [];
  });
  const result = pageSchema.safeParse({
    id: record.id,
    name: record.name,
    width: record.width,
    height: record.height,
    imagePath: record.imagePath,
    blocks,
    analysisStatus: "idle",
    createdAt: record.createdAt ?? "",
    updatedAt: record.updatedAt ?? "",
    inpaintedImagePath:
      typeof record.inpaintedImagePath === "string"
        ? record.inpaintedImagePath
        : undefined,
    inpaintMaskPath:
      typeof record.inpaintMaskPath === "string"
        ? record.inpaintMaskPath
        : undefined,
  });
  return result.data;
}

type ChapterRecovery = {
  source: RecoverySource;
  prefix: string;
  written: string;
  published: string;
  originals: string[];
  rawPages: unknown[];
  order: string[];
};
export async function salvageChapterPages(input: ChapterRecovery) {
  const { source, prefix, rawPages, order } = input;
  const records = new Map<string, LibraryPageRecord>();
  const used = new Set<string>();
  const pageIds = new Map<string, string>();
  const pages: LibraryPageRecord[] = [];
  if (rawPages.length > MAX_PAGES_PER_REQUEST)
    source.report(prefix + "/chapter.json");
  for (const raw of rawPages.slice(0, MAX_PAGES_PER_REQUEST)) {
    const record = readPage(raw, source, prefix + "/chapter.json");
    if (!record || records.has(record.id)) {
      source.report(prefix + "/chapter.json");
      continue;
    }
    if (
      !ChapterSnapshotSchema.shape.pageOrder.element.safeParse(record.id)
        .success
    )
      source.report(prefix + "/chapter.json");
    records.set(record.id, record);
    for (const optional of [
      record.inpaintedImagePath,
      record.inpaintMaskPath,
    ]) {
      const path = imageInChapter(source, prefix, optional);
      if (path) used.add(path);
    }
  }
  for (const record of reorderRecords([...records.values()], order)) {
    source.signal.throwIfAborted();
    let path = imageInChapter(source, prefix, record.imagePath);
    if (!path) {
      source.report(prefix + "/" + record.name);
      path = imageInChapter(source, prefix, record.inpaintedImagePath);
      if (!path) continue;
      record.inpaintedImagePath = undefined;
      record.inpaintMaskPath = undefined;
      record.maskProvenance = undefined;
    }
    const page = await restorePage(input, record, path);
    pages.push(page);
    used.add(path);
    pageIds.set(record.id, page.id);
  }
  await addLooseOriginals(input, used, pages);
  return { pages, pageIds };
}

async function restorePage(
  input: ChapterRecovery,
  record: LibraryPageRecord,
  path: string,
) {
  const { source, prefix, written, published } = input;
  const pageId = randomUUID();
  const copy = async (relative: string, subdirectory: string) => {
    const name = join(subdirectory, pageId + extname(relative).toLowerCase());
    await linkRecoveryFile(join(source.root, relative), join(written, name));
    return join(published, name);
  };
  const optional = async (value: string | undefined, dir: string) => {
    const found = imageInChapter(source, prefix, value);
    if (value && !found)
      source.report(prefix + "/" + record.name + " (" + dir + ")");
    return found ? copy(found, dir) : undefined;
  };
  const seen = new Set<string>();
  const blocks = record.blocks.filter((block) => {
    if (seen.has(block.id)) {
      source.report(prefix + "/" + record.name);
      return false;
    }
    seen.add(block.id);
    return true;
  });
  const page = buildMaterializedSharedPage({
    packagePage: { ...record, blocks },
    pageId,
    imagePath: await copy(path, "pages"),
    inpaintedImagePath: await optional(record.inpaintedImagePath, "inpainted"),
    width: record.width,
    height: record.height,
    now: record.updatedAt,
  });
  page.inpaintMaskPath = await optional(record.inpaintMaskPath, "masks");
  if (page.inpaintMaskPath) page.maskProvenance = record.maskProvenance;
  if (page.analysisStatus === "running") page.analysisStatus = "idle";
  return page;
}

async function addLooseOriginals(
  input: ChapterRecovery,
  used: Set<string>,
  pages: LibraryPageRecord[],
) {
  const { source } = input;
  for (const path of input.originals) {
    source.signal.throwIfAborted();
    if (used.has(path) || !isSupportedImagePath(path)) continue;
    if (pages.length >= MAX_PAGES_PER_REQUEST) {
      source.report(path);
      continue;
    }
    const name = basename(path);
    let size;
    try {
      size = await probeImageFile(
        join(source.root, path),
        name,
        undefined,
        source.signal,
      );
    } catch (error) {
      source.signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code) throw error;
      source.report(path);
      continue;
    }
    const now = new Date().toISOString();
    pages.push(
      await restorePage(
        input,
        {
          id: randomUUID(),
          name: name.slice(0, 260),
          imagePath: path,
          width: size.width,
          height: size.height,
          blocks: [],
          analysisStatus: "idle",
          createdAt: now,
          updatedAt: now,
        },
        path,
      ),
    );
  }
}
