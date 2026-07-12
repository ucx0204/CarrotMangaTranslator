import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PaddleOCR-VL bbox script", () => {
  it("passes its dependency-free Python behavior suite", () => {
    const testFile = join(
      process.cwd(),
      "tests",
      "python",
      "test_paddleocr_vl_bboxes.py",
    );
    const result = spawnSync(process.env.PYTHON ?? "python", [testFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
      },
      timeout: 30_000,
    });

    if (result.error) {
      throw result.error;
    }

    const diagnostics = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");
    expect(result.status, diagnostics).toBe(0);
    expect(diagnostics).toContain("OK");
  });
});
