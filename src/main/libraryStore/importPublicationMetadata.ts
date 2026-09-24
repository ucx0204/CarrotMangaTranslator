import { dirname, join } from "node:path";
import { throwIfAborted } from "../abortSignal";
import { readWorkFile } from "./libraryFiles";
import { getChapterFilePath, getWorkFilePath } from "./libraryPaths";
import { readNativeMetadataFileVersion } from "./workContextMigration";
import type {
  NativeImportMetadataObserver,
  NativeImportPublicationMetadata,
} from "./importPublicationEvidence";

// A proof hashes at most one work, one guide and two files per selected chapter.
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
type Observation = {
  workId: string;
  directory: string;
  observe: NativeImportMetadataObserver;
  signal?: AbortSignal;
};

/** New-work publication hashes its actual staged work file. */
export async function observeNativeImportedWork(input: Observation) {
  const path = join(input.directory, "work.json");
  throwIfAborted(input.signal);
  const sha256 = await version(path);
  if (!sha256) throw new Error("Native imported work metadata is missing.");
  throwIfAborted(input.signal);
  input.observe({ kind: "work", workId: input.workId, sha256 }, async () => {
    throwIfAborted(input.signal);
    if ((await version(path)) !== sha256) throw changed();
    throwIfAborted(input.signal);
  });
}

/** Append uses the existing native journal digest; commit owns its staged-file recheck. */
export function nativeImportedWorkObserver(
  workId: string,
  observe?: NativeImportMetadataObserver,
  signal?: AbortSignal,
) {
  if (!observe) return undefined;
  return (sha256: string) => {
    throwIfAborted(signal);
    observe({ kind: "work", workId, sha256 }, async () => {
      throwIfAborted(signal);
    });
  };
}

/** Captures the actual written chapter bytes, including names, order and SFX review. */
export async function observeNativeImportedChapter(
  input: Observation & { chapterId: string },
) {
  const check = () => {
    throwIfAborted(input.signal);
  };
  const chapterPath = join(input.directory, "chapter.json");
  const memoryPath = join(input.directory, "story-memory.json");
  check();
  const sha256 = await version(chapterPath);
  const memorySha256 = await version(memoryPath);
  if (!sha256) throw new Error("Native imported chapter metadata is missing.");
  check();
  input.observe(
    {
      kind: "chapter",
      workId: input.workId,
      chapterId: input.chapterId,
      sha256,
      memorySha256,
    },
    async () => {
      check();
      if (
        (await version(chapterPath)) !== sha256 ||
        (await version(memoryPath)) !== memorySha256
      )
        throw changed();
      check();
    },
  );
}

/** New works use their staging directory; append observes the owned existing guide. */
export async function observeNativeImportedGuide(input: Observation) {
  const check = () => {
    throwIfAborted(input.signal);
  };
  const path = join(input.directory, "style-guide.json");
  check();
  const sha256 = await version(path);
  check();
  input.observe(
    { kind: "work-guide", workId: input.workId, sha256 },
    async () => {
      check();
      if ((await version(path)) !== sha256) throw changed();
      check();
    },
  );
}

/** Compares retained proof with final native ID-derived paths; never captures new authority. */
export async function verifyNativeImportPublicationMetadata(
  expected: NativeImportPublicationMetadata,
  guard: () => void,
): Promise<void> {
  guard();
  const workPath = getWorkFilePath(expected.workId);
  const workDirectory = dirname(workPath);
  const ids = expected.chapters.map((chapter) => chapter.chapterId);
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
    throw new Error(
      "Native import metadata requires distinct bounded chapter identities.",
    );
  if ((await version(workPath)) !== expected.workSha256) throw changed();
  const work = await readWorkFile(expected.workId);
  guard();
  if (
    !work ||
    work.id !== expected.workId ||
    work.chapterOrder.filter((id) => ids.includes(id)).join("/") !==
      ids.join("/")
  )
    throw changed();
  if (
    (await version(join(workDirectory, "style-guide.json"))) !==
    expected.guideSha256
  )
    throw changed();
  for (const chapter of expected.chapters) {
    guard();
    const path = getChapterFilePath(expected.workId, chapter.chapterId);
    if (
      (await version(path)) !== chapter.sha256 ||
      (await version(join(dirname(path), "story-memory.json"))) !==
        chapter.memorySha256
    )
      throw changed();
  }
  guard();
}

function version(path: string) {
  return readNativeMetadataFileVersion(path, MAX_METADATA_BYTES);
}
function changed() {
  return new Error(
    "Native imported metadata changed after its publication evidence was captured.",
  );
}
