import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

describe("analysis runtime cleanup", () => {
  const indexSource = readFileSync(join(repoRoot, "src", "main", "index.ts"), "utf8");

  it("uses a single cleanup helper for cancel and app quit", () => {
    expect(indexSource).toContain("async function runJobCleanup");
    expect(indexSource).toContain('runJobCleanup(activeJob, "before-quit")');
    expect(indexSource).toContain('runJobCleanup(job, "cancel")');
  });

  it("stops the model endpoint after successful or failed jobs", () => {
    expect(indexSource).toContain('runJobCleanup(activeJob, "job-finished")');
    expect(indexSource).toMatch(/finally\s*{[\s\S]*runJobCleanup\(activeJob, "job-finished"\)[\s\S]*activeJob = null;/);
  });
});
