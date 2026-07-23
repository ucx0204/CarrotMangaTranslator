import { describe, expect, it } from "vitest";

type Candidate = {
  id: number;
  text: string;
  score: number | null;
  soundCandidate: boolean;
};

const { buildSemanticCandidates } =
  require("../src/main/runtime/semantic-ocr/candidates.cjs") as {
    buildSemanticCandidates: (options: Record<string, unknown>) => Candidate[];
  };

describe("semantic OCR candidates", () => {
  it("drops only low-confidence ASCII artifacts on Japanese pages", () => {
    const candidates = buildSemanticCandidates({
      sourceLanguage: "ja",
      imageWidth: 1000,
      imageHeight: 1000,
      ocrBboxHints: [
        hint(1, "uprsr", 0.7436),
        hint(2, "SALE", 0.9),
        hint(3, "noise", 0.7, "sound"),
        hint(4, "元", 0.7),
        hint(5, "Brave Hearts", 0.7),
      ],
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([2, 3, 4, 5]);
    expect(candidates.find((candidate) => candidate.id === 3)).toMatchObject({
      soundCandidate: true,
    });
  });

  it("keeps low-confidence ASCII evidence for non-Japanese sources", () => {
    expect(
      buildSemanticCandidates({
        sourceLanguage: "en",
        imageWidth: 1000,
        imageHeight: 1000,
        ocrBboxHints: [hint(1, "uprsr", 0.5)],
      }).map((candidate) => candidate.id),
    ).toEqual([1]);
  });
});

function hint(
  id: number,
  ocrText: string,
  score: number,
  textRole?: string,
): Record<string, unknown> {
  return {
    id,
    label: "ocr_textline",
    x1: 100 + id * 50,
    y1: 100,
    x2: 140 + id * 50,
    y2: 180,
    ocrText,
    score,
    ...(textRole ? { textRole } : {}),
  };
}
