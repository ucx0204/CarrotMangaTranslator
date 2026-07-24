import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBootstrapLogger } from "../src/main/bootstrapLogger";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootstrap logger", () => {
  it("retains only a bounded tail when an old bootstrap log is oversized", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-bootstrap-log-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "bootstrap.log");
    mkdirSync(join(dir, "logs"), { recursive: true });
    const oldPrefix = "old line\n".repeat(512);
    const recentTail = "recent startup failure\n".repeat(8);
    writeFileSync(logPath, `${oldPrefix}${recentTail}`, "utf8");
    const logger = createBootstrapLogger({
      resolveLogPath: () => logPath,
      maxBytes: 1024,
      retainedBytes: 256,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });

    logger.write("bootstrap:start", { test: true });
    logger.write("bootstrap:loaded-main");

    const current = readFileSync(logPath, "utf8");
    const previousPath = join(dir, "logs", "bootstrap.previous.log");
    const previous = readFileSync(previousPath, "utf8");
    expect(current).toContain("oversized bootstrap.log rotated");
    expect(current).toContain("bootstrap:start");
    expect(current).toContain("bootstrap:loaded-main");
    expect(previous).toContain("retained tail from oversized bootstrap.log");
    expect(previous).toContain("recent startup failure");
    expect(statSync(previousPath).size).toBeLessThan(512);
    expect(statSync(logPath).size).toBeLessThan(512);
  });
});
