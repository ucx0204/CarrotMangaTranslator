import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { once } from "node:events";
import type { MangaPage } from "../../shared/libraryTypes";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import {
  buildLinkedMirrorFileName,
  resolvePathInside,
} from "./linkedWorkspacePaths";
import {
  writeJsonFile,
  type AtomicFilePublication,
} from "../libraryStore/storage";

export type FileFingerprint = {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  sha256: string;
};

export async function fingerprintFile(
  filePath: string,
  previousOrMaximumBytes: FileFingerprint | number = Number.MAX_SAFE_INTEGER,
): Promise<FileFingerprint> {
  const previous =
    typeof previousOrMaximumBytes === "number"
      ? undefined
      : previousOrMaximumBytes;
  const maximumBytes =
    typeof previousOrMaximumBytes === "number"
      ? previousOrMaximumBytes
      : Number.MAX_SAFE_INTEGER;
  const metadata = await stat(filePath);
  if (!metadata.isFile())
    throw new Error("연결된 원본 이미지가 파일이 아닙니다.");
  if (metadata.size > maximumBytes)
    throw new RangeError("Linked file exceeds the fingerprint byte limit.");
  if (
    previous?.ctimeMs === metadata.ctimeMs &&
    previous.mtimeMs === metadata.mtimeMs &&
    previous.size === metadata.size
  )
    return previous;
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      stream.destroy(
        new RangeError("Linked file exceeds the fingerprint byte limit."),
      );
      return;
    }
    hash.update(chunk);
  });
  await once(stream, "end");
  return {
    size: bytes,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    sha256: hash.digest("hex"),
  };
}

export function fingerprintBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function countLinkedWorkspaceConflicts(
  rootPath: string,
): Promise<number> {
  let count = 0;
  for (const directory of ["result", "inpainted", "mask"] as const) {
    count += await countFiles(
      resolvePathInside(rootPath, `${directory}/.probe`),
      true,
    );
  }
  try {
    const mirror = await stat(
      resolvePathInside(rootPath, buildLinkedMirrorFileName(rootPath)),
    );
    if (mirror.isFile()) count += 1;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return count;
}

async function countFiles(
  probePath: string,
  useParent: boolean,
): Promise<number> {
  const directory = useParent
    ? probePath.replace(/[\\/]\.probe$/, "")
    : probePath;
  try {
    const entries = await readdir(directory, {
      withFileTypes: true,
      recursive: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if (isMissingFileError(error)) return 0;
    throw error;
  }
}

export type LinkedMirrorArtifact = {
  path: string;
  bytes: number;
  sha256: string;
};

type LinkedMirrorPage = Pick<
  MangaPage,
  | "id"
  | "name"
  | "width"
  | "height"
  | "blocks"
  | "blockOrder"
  | "maskProvenance"
  | "translationCompletion"
> & {
  sourceRelativePath: string;
  source: LinkedMirrorArtifact;
  result?: LinkedMirrorArtifact;
  inpainted?: LinkedMirrorArtifact;
  mask?: LinkedMirrorArtifact;
};

export type LinkedMirrorChapter = {
  id: string;
  workId: string;
  workTitle: string;
  title: string;
  output: LinkedWorkspaceRecordV1["output"];
  pages: LinkedMirrorPage[];
};

export async function writeLinkedWorkspaceMirror({
  rootPath,
  appVersion,
  chapters,
  beforeCommit,
  publication,
}: {
  rootPath: string;
  appVersion: string;
  chapters: LinkedMirrorChapter[];
  beforeCommit?: () => void;
  publication?: AtomicFilePublication;
}): Promise<void> {
  await writeJsonFile(
    resolvePathInside(rootPath, buildLinkedMirrorFileName(rootPath)),
    createLinkedWorkspaceMirrorPayload(appVersion, chapters),
    beforeCommit,
    publication,
  );
}

export function createLinkedWorkspaceMirrorPayload(
  appVersion: string,
  chapters: LinkedMirrorChapter[],
) {
  return {
    schemaVersion: 1,
    appVersion,
    updatedAt: new Date().toISOString(),
    chapters,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
