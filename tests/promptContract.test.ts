import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("prompt contracts", () => {
  it("keeps the retry prompt aligned with tight Japanese glyph bbox rules", () => {
    const source = readFileSync(join(process.cwd(), "src/main/wholePagePipeline.ts"), "utf8");
    const retryPromptSource = source.slice(source.indexOf("function buildRetryPrompt"));

    expect(retryPromptSource).toContain("Detect each visible Japanese text group");
    expect(retryPromptSource).toContain("bbox means the tight rectangle around the visible Japanese glyphs only.");
    expect(retryPromptSource).toContain("Do not enlarge or move a bbox to make the Korean replacement easier to fit.");
    expect(retryPromptSource).toContain("For sfx, box only the visible sound-effect glyph strokes");
  });
});
