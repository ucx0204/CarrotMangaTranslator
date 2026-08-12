import { join } from "node:path";
import { tMain } from "./localization";
import type { PageImageExportDependencies } from "./pageImageExportPorts";
import { sanitizeOutputPathSegment } from "./pageImageExportNaming";

export async function createPageImageExportOutputDir(
  parentDir: string,
  workTitle: string,
  dependencies: PageImageExportDependencies,
): Promise<string> {
  const workName = sanitizeOutputPathSegment(workTitle, "work");
  const baseName = `${workName}-${dependencies.runtime.createTimestamp()}`;
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const outputDir = join(
      parentDir,
      suffix === 1 ? baseName : `${baseName}-${suffix}`,
    );
    try {
      await dependencies.runtime.createDirectory(outputDir);
      return outputDir;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
  throw new Error(tMain("export.errors.outputDirectory"));
}

export async function removeFailedOutput(
  outputDir: string,
  operationError: unknown,
  dependencies: PageImageExportDependencies,
): Promise<never> {
  try {
    await dependencies.runtime.removeDirectory(outputDir);
  } catch (cleanupError) {
    dependencies.logger.error("Page image export cleanup failed", {
      outputDir,
      operationError,
      cleanupError,
    });
    throw new AggregateError(
      [operationError, cleanupError],
      "페이지 이미지 출력 정리에 실패했습니다.",
      { cause: cleanupError },
    );
  }
  throw operationError;
}

export async function openExportOutputDirectory(
  outputDir: string,
  dependencies: PageImageExportDependencies,
): Promise<string> {
  try {
    return await dependencies.runtime.openDirectory(outputDir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
