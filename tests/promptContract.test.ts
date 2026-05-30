import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("prompt contracts", () => {
  it("keeps one canonical overlay prompt with tight Japanese glyph bbox rules", () => {
    const runtimeSource = readFileSync(join(process.cwd(), "src/main/runtime/simple-page-translate.cjs"), "utf8");
    const pipelineSource = readFileSync(join(process.cwd(), "src/main/wholePagePipeline.ts"), "utf8");

    expect(runtimeSource).toContain("const OVERLAY_PROMPT_SECTIONS");
    expect(runtimeSource).toContain("x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.");
    expect(runtimeSource).toContain("Return x1, y1, x2, y2 as integer pixel coordinates");
    expect(runtimeSource).toContain("fontSize is the apparent Japanese glyph size in Image 1 pixels.");
    expect(runtimeSource).toContain("Each speech bubble is one dialogue item.");
    expect(runtimeSource).toContain("If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck");
    expect(runtimeSource).toContain("For SFX, box only the sound-effect glyph strokes");
    expect(runtimeSource).toContain("For type sfx, ko must be bare Korean sound-effect lettering only");
    expect(runtimeSource).toContain("do not wrap it in parentheses/brackets/quotes");
    expect(runtimeSource).toContain("Coordinate calibration");
    expect(runtimeSource).toContain("Use the full visible Image 1 frame as the coordinate frame");
    expect(runtimeSource).toContain("detail: \"original\"");
    expect(runtimeSource).toContain("bboxCoordinateSpace");
    expect(runtimeSource).toContain("Use exactly these keys, one per line: id, type, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.");
    expect(runtimeSource).toContain("confidence is your confidence from 0.00 to 1.00");
    expect(runtimeSource).toContain("You are directly OCR-reading and translating only the low-confidence manga crop images listed below.");
    expect(runtimeSource).toContain("The crop image itself is the authority.");
    expect(runtimeSource).toContain("OCR bbox candidates");
    expect(runtimeSource).toContain("low-trust OCR text hints for slot matching only");
    expect(runtimeSource).toContain("Use Image 1 as the authority");
    expect(runtimeSource).toContain("Treat each candidate as a locked geometry slot.");
    expect(runtimeSource).toContain("Do not merge two candidates into one record");
    expect(runtimeSource).toContain("classify ordinary handwritten notes, diagram labels, search terms, captions, and explanatory text as narration/name, not sfx");
    expect(runtimeSource).not.toContain("buildPointDetectionPrompt");
    expect(runtimeSource).not.toContain("buildPointExpansionPrompt");
    expect(pipelineSource).not.toContain("function buildRetryPrompt");
    expect(pipelineSource).not.toContain("promptOverrideText: attempt > 1");
  });
});
