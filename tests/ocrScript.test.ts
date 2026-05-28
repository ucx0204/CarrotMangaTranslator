import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PaddleOCR-VL bbox script", () => {
  it("imports PIL Image at module scope for helper functions", () => {
    const script = readFileSync(join(process.cwd(), "src", "main", "runtime", "paddleocr-vl-bboxes.py"), "utf8");
    const importIndex = script.indexOf("from PIL import Image");
    const mainIndex = script.indexOf("def main()");
    const helperIndex = script.indexOf("def write_page_bboxes");

    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(importIndex).toBeLessThan(mainIndex);
    expect(importIndex).toBeLessThan(helperIndex);
  });
});
