import { unlink } from "node:fs/promises";

export async function removeArtifactAfterFailure(
  filePath: string,
  operationError: unknown,
): Promise<never> {
  try {
    await unlink(filePath);
  } catch (cleanupError) {
    if (isMissingFileError(cleanupError)) throw operationError;
    throw new AggregateError(
      [operationError, cleanupError],
      `작업 실패 후 불완전한 파일을 정리하지 못했습니다: ${filePath}`,
      { cause: cleanupError },
    );
  }
  throw operationError;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
