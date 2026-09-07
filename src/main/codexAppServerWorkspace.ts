import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Process/thread scratch space must not inherit deeply nested library paths. */
export function createCodexAppServerWorkspace() {
  const parent = resolve(tmpdir());
  const path = mkdtempSync(join(parent, "mgt-codex-"));
  let cleanup: Promise<void> | undefined;
  const remove = () => {
    if (
      dirname(resolve(path)) !== parent ||
      !basename(path).startsWith("mgt-codex-")
    )
      return Promise.reject(
        new Error("Codex 임시 폴더 경로가 올바르지 않습니다."),
      );
    return (cleanup ??= rm(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    }));
  };
  return {
    path,
    remove,
    removeAfterExit: async (child: ChildProcessWithoutNullStreams) => {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        child.pid === undefined
      ) {
        await remove();
        return;
      }
      child.once("close", () => {
        void remove().catch((error: unknown) =>
          console.error("Codex temporary workspace cleanup failed", error),
        );
      });
    },
  };
}
