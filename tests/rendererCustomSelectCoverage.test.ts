import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = "src/renderer/src";
const NATIVE_SELECT_TAG = /<\s*(?:select|option|optgroup|datalist)\b/u;

describe("renderer select coverage", () => {
  it("keeps native select elements out of renderer components", () => {
    const violations = rendererSourceFiles(RENDERER_ROOT).filter((path) =>
      NATIVE_SELECT_TAG.test(readFileSync(path, "utf8")),
    );

    expect(violations).toEqual([]);
  });
});

function rendererSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}
