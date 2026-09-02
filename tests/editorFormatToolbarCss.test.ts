import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/renderer/src/styles/formatting.css"),
  "utf8",
);

describe("editor format toolbar responsive layout", () => {
  it("uses deliberate semantic rows instead of incidental flex wrapping", () => {
    expect(css).toMatch(
      /@container editor-panel \(max-width: 360px\)[\s\S]*?\.format-toolbar\s*{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*max-content max-content;/,
    );
    expect(css).toMatch(
      /@container editor-panel \(max-width: 360px\)[\s\S]*?\.format-emphasis-control\s*{[\s\S]*?grid-column:\s*1 \/ -1;/,
    );
    expect(css).toMatch(
      /@container editor-panel \(max-width: 260px\)[\s\S]*?\.format-toolbar\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
  });

  it("uses the shared segmented control skin for writing direction", () => {
    expect(css).toContain(".editor-direction-toggle");
    expect(css).not.toContain(".dir-toggle button");
  });
});
