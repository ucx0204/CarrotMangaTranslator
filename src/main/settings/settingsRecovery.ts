import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppPaths } from "../appPaths";
import { redactDiagnosticText } from "../errorReportRedaction";

export async function backupCorruptSettings(
  paths: AppPaths,
  error: unknown,
  diagnostics: {
    error: (message: string, detail?: unknown) => void;
    warn: (message: string, detail?: unknown) => void;
  },
): Promise<void> {
  try {
    const rawText = await readFile(paths.settingsPath, "utf8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      dirname(paths.settingsPath),
      `${basename(paths.settingsPath)}.corrupt-${timestamp}.bak`,
    );
    await mkdir(dirname(backupPath), { recursive: true });
    const redacted = redactDiagnosticText(rawText, { appPaths: paths }).text;
    await writeFile(backupPath, redacted, { encoding: "utf8", mode: 0o600 });
    diagnostics.warn(
      "Settings file is corrupt; backed it up and restored defaults",
      { settingsPath: paths.settingsPath, backupPath },
    );
  } catch (backupError) {
    diagnostics.error("Failed to back up corrupt settings file", {
      settingsPath: paths.settingsPath,
      error,
      backupError,
    });
  }
}
