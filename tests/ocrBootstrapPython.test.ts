import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { resolveBootstrapPython } =
  require("../src/main/runtime/ocr/runtime-layout.cjs") as {
    resolveBootstrapPython: (options: { toolsDir: string }) => string | null;
  };

describe("OCR bootstrap Python resolution", () => {
  it("uses a working platform Python command during development", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-ocr-python-"));
    const toolsDir = join(temporaryRoot, "tools");
    mkdirSync(toolsDir, { recursive: true });

    try {
      const pythonCommand = resolveBootstrapPython({ toolsDir });
      const expectedCommand =
        process.platform === "win32" ? "python" : "python3";
      expect(pythonCommand).toBe(expectedCommand);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not use system Python for packaged tools by default", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "mgt-ocr-python-"));
    const toolsDir = join(temporaryRoot, "resources", "tools");
    mkdirSync(toolsDir, { recursive: true });

    try {
      expect(resolveBootstrapPython({ toolsDir })).toBeNull();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
