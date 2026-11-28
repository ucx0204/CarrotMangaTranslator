import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { logOutputFailure } from "../src/main/outputFailureLog";
import { logInfo, resetAppLog } from "../src/main/logger";

it("leaves the main activity log available when the diagnostic cannot be published", async () => {
  const dir = await mkdtemp(join(tmpdir(), "carrot-output-error-destination-"));
  vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", join(dir, "app.log"));
  try {
    await mkdir(join(dir, "last-output-error.log"));
    logOutputFailure("Output cleanup failed", {
      operationError: new Error("output locked"),
      cleanupError: "cleanup failed",
    });
    expect(await readFile(join(dir, "app.log"), "utf8")).toContain(
      "Could not retain the output error diagnostic",
    );
    expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains the underlying save error after repeated startup log rotation without retaining selection contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "carrot-output-diagnostic-"));
  vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", join(dir, "app.log"));
  try {
    logOutputFailure("Page image export failed", {
      jobId: "example",
      request: { sourceText: "private dialogue" },
      error: Object.assign(new Error("Disk is full"), { code: "ENOSPC" }),
    });
    for (let launch = 0; launch < 3; launch++) {
      resetAppLog();
      logInfo("Application process starting");
    }
    const retained = await readFile(join(dir, "last-output-error.log"), "utf8");
    expect(retained).toContain("ENOSPC");
    expect(retained).toContain("example");
    expect(retained).not.toContain("private dialogue");
    expect(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
