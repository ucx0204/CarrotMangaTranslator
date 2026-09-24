import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type { LinkedWorkspaceRecordV1 } from "../../shared/linkedWorkspaceTypes";
import type {
  LinkedMirrorArtifact,
  LinkedMirrorChapter,
} from "./linkedWorkspaceFiles";

/** Shared shape for automatic and explicitly reviewed native recovery mirrors. */
export function buildLinkedMirrorChapter(
  record: LinkedWorkspaceRecordV1,
  chapter: ChapterSnapshot,
  workTitle: string,
): LinkedMirrorChapter {
  return {
    id: chapter.id,
    workId: chapter.workId,
    workTitle,
    title: chapter.title,
    output: record.output,
    pages: chapter.pages.map((page) => {
      const sourceRelativePath =
        record.sourceRelativePaths?.[page.id] ??
        record.pageRelativePaths[page.id];
      if (!sourceRelativePath)
        throw new Error("페이지의 원본 상대 경로가 없습니다.");
      return {
        id: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        blocks: page.blocks,
        blockOrder: page.blockOrder,
        translationCompletion: page.translationCompletion,
        maskProvenance: page.maskProvenance,
        sourceRelativePath,
        source: sourceArtifactFromRecord(record, page.id, sourceRelativePath),
        ...toMirrorArtifacts(record.artifacts[page.id]),
      };
    }),
  };
}

function sourceArtifactFromRecord(
  record: LinkedWorkspaceRecordV1,
  pageId: string,
  path: string,
): LinkedMirrorArtifact {
  const fingerprint = record.sourceFingerprints[pageId];
  if (!fingerprint)
    throw new Error("복구 미러에 기록할 원본 이미지 해시가 없습니다.");
  return { path, bytes: fingerprint.size, sha256: fingerprint.sha256 };
}

function toMirrorArtifacts(
  artifacts: LinkedWorkspaceRecordV1["artifacts"][string] | undefined,
) {
  if (!artifacts) return {};
  return {
    ...(artifacts.result
      ? { result: stripLocalArtifact(artifacts.result) }
      : {}),
    ...(artifacts.inpainted
      ? { inpainted: stripLocalArtifact(artifacts.inpainted) }
      : {}),
    ...(artifacts.mask ? { mask: stripLocalArtifact(artifacts.mask) } : {}),
  };
}

function stripLocalArtifact(
  artifact: LinkedMirrorArtifact,
): LinkedMirrorArtifact {
  return {
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
}
