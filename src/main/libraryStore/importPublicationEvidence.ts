import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { throwIfAborted } from "../abortSignal";
import { sha256File } from "./libraryTransactionStorage";

type ImageFormat = "png" | "jpeg" | "webp";
type NativeImportDigest = { bytes: number; sha256: string };
export type NativeImportedPageEvidence = {
  source: NativeImportDigest & {
    kind: "image" | "work-file";
    chapterId: string;
    pageIndex: number;
    pageId?: string;
    format: ImageFormat;
  };
  page: {
    workId: string;
    chapterId: string;
    pageId: string;
    revision: ReturnType<typeof createPageRevision>;
    reviewRevision: ReturnType<typeof createSoundEffectReviewPageRevision>;
    blockCount: number;
    blockIdsSha256: string;
    filesSha256: string;
  };
  original: NativeImportDigest & { format: ImageFormat };
};
/** Native-only observation; no public request can supply an observer or saved IDs. */
export type NativeImportPageObserver = (
  evidence: NativeImportedPageEvidence,
  verify: () => Promise<void>,
) => void;
export type NativeImportMetadataEvidence =
  | { kind: "work"; workId: string; sha256: string }
  | { kind: "work-guide"; workId: string; sha256: string | null }
  | {
      kind: "chapter";
      workId: string;
      chapterId: string;
      sha256: string;
      memorySha256: string | null;
    };
export type NativeImportMetadataObserver = (
  evidence: NativeImportMetadataEvidence,
  verify: () => Promise<void>,
) => void;
export type NativeImportPublicationMetadata = {
  workId: string;
  workSha256: string;
  guideSha256: string | null;
  chapters: Array<{
    chapterId: string;
    sha256: string;
    memorySha256: string | null;
  }>;
};
export type NativeImportPageObservation = {
  observe: NativeImportPageObserver;
  kind: "image" | "work-file";
  workId: string;
  chapterId: string;
  sourceChapterId: string;
};
export type NativeImportFileDigest = NativeImportDigest & {
  role: "original" | "inpainted" | "mask";
};
type PageFiles = {
  page: Pick<LibraryPageRecord, "inpaintedImagePath" | "inpaintMaskPath">;
  originalPath: string;
  inpaintedPath?: string;
  maskPath?: string;
  signal?: AbortSignal;
};

/** Fixed role order, independent of caller object key order; paths never enter this digest. */
export function fingerprintNativeImportFiles(
  files: readonly NativeImportFileDigest[],
) {
  const roles = ["original", "inpainted", "mask"] as const;
  if (
    !files.length ||
    files.length > 3 ||
    !files.some((file) => file.role === "original") ||
    new Set(files.map((file) => file.role)).size !== files.length
  )
    throw new Error(
      "Imported page file evidence requires one original and distinct native roles.",
    );
  const ordered = roles.flatMap((role) => {
    const file = files.find((value) => value.role === role);
    return file ? [{ role, bytes: file.bytes, sha256: file.sha256 }] : [];
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
async function readPageFiles(input: PageFiles) {
  if (
    Boolean(input.page.inpaintedImagePath) !== Boolean(input.inpaintedPath) ||
    Boolean(input.page.inpaintMaskPath) !== Boolean(input.maskPath)
  )
    throw new Error(
      "Native imported page file roles differ from its saved metadata.",
    );
  const original = await nativeImportDigest(input.originalPath, input.signal);
  const files: NativeImportFileDigest[] = [{ role: "original", ...original }];
  if (input.inpaintedPath)
    files.push({
      role: "inpainted",
      ...(await nativeImportDigest(input.inpaintedPath, input.signal)),
    });
  if (input.maskPath)
    files.push({
      role: "mask",
      ...(await nativeImportDigest(input.maskPath, input.signal)),
    });
  return { original, filesSha256: fingerprintNativeImportFiles(files) };
}

/** Reuse the native digest reader only on already selected or materialized files. */
export async function nativeImportDigest(
  value: string | Buffer,
  signal?: AbortSignal,
): Promise<NativeImportDigest> {
  throwIfAborted(signal);
  if (Buffer.isBuffer(value))
    return {
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  const before = await lstat(value);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Import evidence requires an owned regular file.");
  const sha256 = await sha256File(value);
  const after = await lstat(value);
  throwIfAborted(signal);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs
  )
    throw new Error(
      "Native imported bytes changed while recording publication evidence.",
    );
  return { bytes: before.size, sha256 };
}

/** Called after actual image validation and ID/block remapping, before metadata publication. */
export async function observeNativeImportedPage(
  input: PageFiles & {
    observation: NativeImportPageObservation;
    page: LibraryPageRecord;
    pageIndex: number;
    sourcePageId?: string;
    source: NativeImportDigest & { format: ImageFormat };
    sourceValue: string | Buffer;
    originalFormat: ImageFormat;
  },
) {
  const files = await readPageFiles(input);
  const original = files.original;
  if (input.source.format === "webp" && input.originalFormat !== "png")
    throw new Error(
      "Native WebP import evidence requires its validated PNG working original.",
    );
  if (
    input.source.format !== "webp" &&
    (input.source.sha256 !== original.sha256 ||
      input.source.bytes !== original.bytes)
  )
    throw new Error(
      "Copied native import bytes differ from their reviewed source.",
    );
  const scope = input.observation;
  throwIfAborted(input.signal);
  const evidence: NativeImportedPageEvidence = {
    source: {
      ...input.source,
      kind: scope.kind,
      chapterId: scope.sourceChapterId,
      pageIndex: input.pageIndex,
      ...(input.sourcePageId === undefined
        ? {}
        : { pageId: input.sourcePageId }),
    },
    page: {
      workId: scope.workId,
      chapterId: scope.chapterId,
      pageId: input.page.id,
      revision: createPageRevision(input.page),
      blockCount: input.page.blocks.length,
      reviewRevision: createSoundEffectReviewPageRevision(input.page),
      filesSha256: files.filesSha256,
      blockIdsSha256: createHash("sha256")
        .update(JSON.stringify(input.page.blocks.map((block) => block.id)))
        .digest("hex"),
    },
    original: { ...original, format: input.originalFormat },
  };
  scope.observe(evidence, async () => {
    const source = await nativeImportDigest(input.sourceValue, input.signal);
    const current = await readPageFiles(input);
    if (
      source.bytes !== evidence.source.bytes ||
      source.sha256 !== evidence.source.sha256 ||
      current.filesSha256 !== evidence.page.filesSha256 ||
      createPageRevision(input.page) !== evidence.page.revision ||
      createSoundEffectReviewPageRevision(input.page) !==
        evidence.page.reviewRevision
    )
      throw new Error(
        "Native imported page changed before its publication evidence was sealed.",
      );
  });
}
