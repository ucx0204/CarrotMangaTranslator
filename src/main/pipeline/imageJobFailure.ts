import { logError } from "../logger";

/** A failed durable checkpoint must stop image generation; it is never a model-quality failure. */
export class ImageCheckpointError extends Error {
  constructor(cause: unknown) {
    super(
      "생성 결과를 저장하지 못했습니다. 저장 상태를 확인한 뒤 이어서 실행해 주세요.",
      { cause },
    );
    this.name = "ImageCheckpointError";
    logError("Image checkpoint failed", { error: cause });
  }
}

export function throwImageStorageFailure(error: unknown): void {
  if (error instanceof ImageCheckpointError) throw error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    [
      "ENOSPC",
      "EDQUOT",
      "EROFS",
      "EIO",
      "EACCES",
      "EPERM",
      "EMFILE",
      "ENFILE",
    ].includes(String(error.code))
  )
    throw new ImageCheckpointError(error);
}
