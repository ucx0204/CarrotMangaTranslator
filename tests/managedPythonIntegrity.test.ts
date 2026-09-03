import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const integrity =
  require("../src/main/runtime/ocr/managed-python-integrity.cjs") as {
    collectManagedPythonExecutableHashes: (
      root: string,
    ) => Record<string, string>;
    installedManagedPythonHashesMatch: (
      root: string,
      stored: unknown,
    ) => boolean;
  };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed Python integrity", () => {
  it("ignores intentionally upgraded pip files while retaining archive integrity", () => {
    const root = mkdtempSync(join(tmpdir(), "mgt-managed-python-integrity-"));
    temporaryDirectories.push(root);
    writeFixture(root, "python.exe", "python-v1");
    writeFixture(root, "python312.dll", "runtime-v1");
    writeFixture(root, "python312._pth", "python312.zip\n.\nimport site\n");
    writeFixture(root, "Scripts/pip.exe", "pip-v1");
    writeFixture(
      root,
      "Lib/site-packages/pip/_vendor/distlib/t64.exe",
      "launcher-v1",
    );

    const archiveHashes = integrity.collectManagedPythonExecutableHashes(root);
    expect(Object.keys(archiveHashes).sort()).toEqual([
      "python.exe",
      "python312._pth",
      "python312.dll",
    ]);
    const legacyMarkerHashes = {
      ...archiveHashes,
      "Scripts/pip.exe": "legacy-pip-hash",
      "Lib/site-packages/pip/_vendor/distlib/t64.exe": "legacy-launcher-hash",
    };

    writeFixture(root, "Scripts/pip.exe", "pip-v2");
    writeFixture(
      root,
      "Lib/site-packages/pip/_vendor/distlib/t64.exe",
      "launcher-v2",
    );
    expect(
      integrity.installedManagedPythonHashesMatch(root, legacyMarkerHashes),
    ).toBe(true);

    writeFixture(root, "python312.dll", "runtime-tampered");
    expect(
      integrity.installedManagedPythonHashesMatch(root, legacyMarkerHashes),
    ).toBe(false);
  });
});

function writeFixture(
  root: string,
  relativePath: string,
  contents: string,
): void {
  const destination = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}
