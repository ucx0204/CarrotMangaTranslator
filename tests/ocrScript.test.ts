import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pythonProcessTimeoutMs =
  process.platform === "win32" && process.env.CI ? 90_000 : 30_000;
const testTimeoutMs = pythonProcessTimeoutMs + 30_000;

describe("PaddleOCR-VL bbox script", () => {
  it(
    "passes its dependency-free Python behavior suite",
    () => {
      const testFile = join(
        process.cwd(),
        "tests",
        "python",
        "test_paddleocr_vl_bboxes.py",
      );
      const defaultPython = process.platform === "win32" ? "python" : "python3";
      const result = spawnSync(
        process.env.PYTHON ?? defaultPython,
        [testFile],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
          },
          timeout: pythonProcessTimeoutMs,
        },
      );

      if (result.error) {
        throw result.error;
      }

      const diagnostics = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n");
      expect(result.status, diagnostics).toBe(0);
      expect(diagnostics).toContain("OK");
    },
    testTimeoutMs,
  );
});
