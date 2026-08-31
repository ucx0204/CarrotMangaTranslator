import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LibraryPageRecord, MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
  TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
  type TranslationCheckpointMetadata,
} from "../../shared/translationCheckpoint";
import {
  MAX_TRANSLATION_CHECKPOINT_BYTES,
  PreparedTranslationCheckpointSchema,
  type PreparedTranslationCheckpoint,
} from "../pipeline/preparedTranslationCheckpointContract";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";

const MANAGED_DIRECTORY_PREFIX = ".translation-checkpoint-";
const CHECKPOINT_FILE_NAME = "checkpoint.json";

export type LoadedTranslationCheckpoint = Readonly<{
  metadata: TranslationCheckpointMetadata;
  artifact: PreparedTranslationCheckpoint;
}>;

export async function loadTranslationCheckpointArtifact(
  chapterDir: string,
  page: MangaPage,
): Promise<LoadedTranslationCheckpoint> {
  const metadata = page.translationCheckpoint;
  if (!metadata) throw new Error("페이지에 번역 체크포인트가 없습니다.");
  assertMetadataBinding(page, metadata);
  const artifactPath = resolveManagedCheckpointPath(chapterDir, metadata);
  await assertRegularManagedFile(chapterDir, artifactPath);
  const stats = await lstat(artifactPath);
  if (stats.size !== metadata.byteSize) {
    throw new Error("번역 체크포인트 파일 크기가 저장 정보와 다릅니다.");
  }
  if (stats.size <= 0 || stats.size > MAX_TRANSLATION_CHECKPOINT_BYTES) {
    throw new Error("번역 체크포인트 파일 크기가 허용 범위를 벗어났습니다.");
  }
  const bytes = await readFile(artifactPath);
  if (bytes.byteLength !== metadata.byteSize) {
    throw new Error("번역 체크포인트를 완전하게 읽지 못했습니다.");
  }
  if (sha256(bytes) !== metadata.sha256) {
    throw new Error("번역 체크포인트 해시가 저장 정보와 다릅니다.");
  }
  const artifact = PreparedTranslationCheckpointSchema.parse(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
  assertArtifactBinding(metadata, artifact, page.id);
  return { metadata, artifact };
}

export async function saveTranslationCheckpointUnlocked({
  chapterId,
  checkpoint,
  expectedRevision,
}: {
  chapterId: string;
  checkpoint: PreparedTranslationCheckpoint;
  expectedRevision: PageRevision;
}): Promise<boolean> {
  const payload = prepareCheckpointPayload(checkpoint, expectedRevision);

  const locator = await findChapterLocation(chapterId);
  if (!locator) return false;
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) return false;
  const pageIndex = chapter.pages.findIndex(
    (page) => page.id === payload.checked.pageId,
  );
  const currentPage = chapter.pages[pageIndex];
  if (!currentPage || createPageRevision(currentPage) !== expectedRevision) {
    return false;
  }
  const work = await readWorkFile(locator.workId);
  if (!work) return false;

  const chapterDir = resolve(
    join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
  );
  const publication = createCheckpointPublication(
    chapterDir,
    currentPage,
    payload,
    expectedRevision,
  );
  const now = new Date().toISOString();
  chapter.pages[pageIndex] = {
    ...currentPage,
    translationCheckpoint: publication.metadata,
  };
  chapter.updatedAt = now;
  await publishCheckpoint(publication, chapter, work, now);
  return true;
}

type CheckpointPayload = Readonly<{
  bytes: Buffer;
  checked: PreparedTranslationCheckpoint;
}>;

type CheckpointPublication = CheckpointPayload &
  Readonly<{
    finalDirectory: string;
    metadata: TranslationCheckpointMetadata;
    previousDirectory?: string;
  }>;

function prepareCheckpointPayload(
  checkpoint: PreparedTranslationCheckpoint,
  expectedRevision: PageRevision,
): CheckpointPayload {
  const checked = PreparedTranslationCheckpointSchema.parse(checkpoint);
  const bytes = Buffer.from(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAX_TRANSLATION_CHECKPOINT_BYTES
  ) {
    throw new Error("번역 체크포인트가 허용 크기를 초과했습니다.");
  }
  if (checked.inputRevision !== expectedRevision) {
    throw new Error(
      "번역 체크포인트 입력 revision이 작업 시작 시점과 다릅니다.",
    );
  }
  return { bytes, checked };
}

function createCheckpointPublication(
  chapterDir: string,
  currentPage: LibraryPageRecord,
  payload: CheckpointPayload,
  expectedRevision: PageRevision,
): CheckpointPublication {
  const directoryName = `${MANAGED_DIRECTORY_PREFIX}${randomUUID()}`;
  const finalDirectory = join(chapterDir, directoryName);
  const metadata: TranslationCheckpointMetadata = {
    schemaVersion: TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
    pipelineContractVersion: TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
    artifactPath: join(directoryName, CHECKPOINT_FILE_NAME),
    sha256: sha256(payload.bytes),
    byteSize: payload.bytes.byteLength,
    inputRevision: expectedRevision,
    sourceLanguage: payload.checked.sourceLanguage,
    targetLanguage: payload.checked.targetLanguage,
    blockMode: payload.checked.blockMode,
    savedAt: payload.checked.savedAt,
  };
  const previousDirectory = resolveReplaceableCheckpointDirectory(
    chapterDir,
    currentPage.translationCheckpoint,
  );
  return { ...payload, finalDirectory, metadata, previousDirectory };
}

function resolveReplaceableCheckpointDirectory(
  chapterDir: string,
  metadata: TranslationCheckpointMetadata | undefined,
): string | undefined {
  if (!metadata) return undefined;
  try {
    return resolveManagedCheckpointDirectory(chapterDir, metadata);
  } catch (error) {
    void error;
    // An invalid legacy/corrupt reference must not block a safe fresh result.
    // It is overwritten by the new metadata and maintenance removes any
    // unreferenced managed directory without following the rejected path.
    return undefined;
  }
}

async function publishCheckpoint(
  publication: CheckpointPublication,
  chapter: ChapterFile,
  work: WorkFile,
  now: string,
): Promise<void> {
  await runLibraryTransaction(
    "save-translation-checkpoint",
    async (transaction) => {
      const published = await transaction.createPublishedDirectory(
        publication.finalDirectory,
      );
      const stagedFile = join(published.stagingDirectory, CHECKPOINT_FILE_NAME);
      await writeFile(stagedFile, publication.bytes, { flag: "wx" });
      const stagedBytes = await readFile(stagedFile);
      if (
        stagedBytes.byteLength !== publication.metadata.byteSize ||
        sha256(stagedBytes) !== publication.metadata.sha256
      ) {
        throw new Error("번역 체크포인트 staging 검증에 실패했습니다.");
      }
      await stageChapterFile(transaction, chapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
      if (
        publication.previousDirectory &&
        publication.previousDirectory !== publication.finalDirectory
      ) {
        await transaction.retireDirectory(publication.previousDirectory, {
          required: false,
        });
      }
    },
  );
}

export function resolveManagedCheckpointDirectory(
  chapterDir: string,
  metadata: TranslationCheckpointMetadata,
): string {
  return dirname(resolveManagedCheckpointPath(chapterDir, metadata));
}

export function stripInternalPageArtifacts<
  T extends MangaPage | LibraryPageRecord,
>(page: T): Omit<T, "translationCheckpoint" | "fontContinuity"> {
  const {
    translationCheckpoint: _translationCheckpoint,
    fontContinuity: _fontContinuity,
    ...sharedPage
  } = page;
  return sharedPage;
}

function assertMetadataBinding(
  page: MangaPage,
  metadata: TranslationCheckpointMetadata,
): void {
  if (
    metadata.schemaVersion !== TRANSLATION_CHECKPOINT_SCHEMA_VERSION ||
    metadata.pipelineContractVersion !==
      TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT
  ) {
    throw new Error("번역 체크포인트 계약 버전이 현재 앱과 맞지 않습니다.");
  }
  if (metadata.inputRevision !== createPageRevision(page)) {
    throw new Error(
      "페이지가 변경되어 저장된 번역 체크포인트를 재사용할 수 없습니다.",
    );
  }
}

function assertArtifactBinding(
  metadata: TranslationCheckpointMetadata,
  artifact: PreparedTranslationCheckpoint,
  pageId: string,
): void {
  if (
    artifact.pageId !== pageId ||
    artifact.inputRevision !== metadata.inputRevision ||
    artifact.sourceLanguage !== metadata.sourceLanguage ||
    artifact.targetLanguage !== metadata.targetLanguage ||
    artifact.blockMode !== metadata.blockMode ||
    artifact.savedAt !== metadata.savedAt
  ) {
    throw new Error(
      "번역 체크포인트 파일과 페이지 메타데이터가 서로 맞지 않습니다.",
    );
  }
}

function resolveManagedCheckpointPath(
  chapterDir: string,
  metadata: TranslationCheckpointMetadata,
): string {
  const root = resolve(chapterDir);
  const target = resolve(root, metadata.artifactPath);
  const relativePath = relative(root, target);
  const directory = relativePath.split(/[\\/]/)[0] ?? "";
  if (
    !isDescendantPath(root, target) ||
    target === root ||
    !directory.startsWith(MANAGED_DIRECTORY_PREFIX) ||
    relativePath.split(/[\\/]/).length !== 2 ||
    relativePath.split(/[\\/]/)[1] !== CHECKPOINT_FILE_NAME
  ) {
    throw new Error("번역 체크포인트 경로가 관리 영역을 벗어났습니다.");
  }
  return target;
}

async function assertRegularManagedFile(
  chapterDir: string,
  artifactPath: string,
): Promise<void> {
  const directory = dirname(artifactPath);
  const [directoryStat, fileStat] = await Promise.all([
    lstat(directory),
    lstat(artifactPath),
  ]);
  if (
    !isDescendantPath(resolve(chapterDir), directory) ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink()
  ) {
    throw new Error("번역 체크포인트 경로가 안전한 일반 파일이 아닙니다.");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isDescendantPath(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..\\`) &&
    !relativePath.startsWith("../") &&
    !isAbsolute(relativePath)
  );
}
