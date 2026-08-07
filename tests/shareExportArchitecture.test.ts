import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("share export architecture", () => {
  it("keeps production export off image buffers and AdmZip", () => {
    const source = readFileSync(
      join(repoRoot, "src/main/libraryStore/shareExportWorkflow.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\breadFile\s*\(/);
    expect(source).not.toContain("AdmZip");
    expect(source).not.toContain("writeZip");
    expect(source).toContain("writeAtomicStreamingShareArchive");
  });

  it("uses sequential stored streams and an atomic temp target", () => {
    const source = readFileSync(
      join(repoRoot, "src/main/libraryStore/shareStreamingZip.ts"),
      "utf8",
    );

    expect(source).toContain("addReadStreamLazy");
    expect(source).toContain("createReadStream");
    expect(source).toContain("createWriteStream");
    expect(source).toContain("pipeline");
    expect(source).toMatch(/compress:\s*false/);
    expect(source).toMatch(/flags:\s*"wx"/);
    expect(source).toContain("mode: 0o600");
    expect(source).toContain("handle.sync()");
    expect(source).toContain("renameWithTransientRetry");
  });
});
