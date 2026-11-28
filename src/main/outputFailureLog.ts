import { renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getLogDirectory,
  logError,
  logWarn,
  serializeLogDetail,
} from "./logger";

/** Keep the last save failure available even after several failed startups rotate app.log. */
export function logOutputFailure(message: string, detail?: unknown): void {
  logError(message, detail);
  const fields =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>)
      : {};
  const diagnostic = serializeLogDetail({
    jobId: fields.jobId,
    chapterId: fields.chapterId,
    pageId: fields.pageId,
    error: fields.error ?? fields.operationError ?? detail,
    cleanupError: fields.cleanupError,
  }).slice(0, 16_384);
  const target = join(getLogDirectory(), "last-output-error.log");
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(
      temporary,
      `[${new Date().toISOString()}] ${message}\n${diagnostic}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporary, target);
  } catch (error) {
    logWarn("Could not retain the output error diagnostic", error);
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      logWarn(
        "Could not clean the output diagnostic temporary file",
        cleanupError,
      );
    }
  }
}
