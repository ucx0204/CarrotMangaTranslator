import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAppPaths } from "./appPaths";
import { isPathInside } from "./libraryStore/storage";

export async function cleanupLegacyLogs(): Promise<void> {
  const logsRoot = resolve(getAppPaths().logsDir);
  const targets = [
    join(logsRoot, "app-jobs"),
    join(logsRoot, "bench"),
    join(logsRoot, "debug"),
    join(logsRoot, "runtime")
  ];

  for (const target of targets) {
    if (!existsSync(target)) {
      continue;
    }
    const resolved = resolve(target);
    if (!isPathInside(logsRoot, resolved) || resolved === logsRoot) {
      continue;
    }
    await rm(resolved, { recursive: true, force: true });
  }
}
