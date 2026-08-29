import { describe, expect, it } from "vitest";
import {
  parseIpcPayload,
  ResearchWorkContextRequestSchema,
  SaveWorkResearchTitleRequestSchema,
} from "../src/shared/ipcSchemas";
import { workContextIpcContracts } from "../src/shared/ipcContracts";

describe("work-context research IPC schema", () => {
  it("accepts glossary research without a chapter/work scope", () => {
    const request = {
      runId: "44444444-4444-4444-8444-444444444444",
      chapterId: "22222222-2222-4222-8222-222222222222",
      researchTitle: "  새 작품 제목  ",
      engine: "tavily" as const,
      guideSnapshot: {
        schemaVersion: 1 as const,
        workId: "11111111-1111-4111-8111-111111111111",
        glossary: [],
        characters: [],
        rules: {
          honorifics: "preserve" as const,
          sfxMode: "translate" as const,
          defaultTone: "natural_korean" as const,
        },
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    };

    expect(
      parseIpcPayload(
        ResearchWorkContextRequestSchema,
        request,
        "용어집 인터넷 조사",
      ),
    ).toEqual({ ...request, researchTitle: "새 작품 제목" });
    expect(() =>
      parseIpcPayload(
        ResearchWorkContextRequestSchema,
        { ...request, scope: "work" },
        "용어집 인터넷 조사",
      ),
    ).toThrow(/요청 형식/);
    expect(
      ResearchWorkContextRequestSchema.safeParse({
        ...request,
        researchTitle: "   ",
      }).success,
    ).toBe(false);
  });

  it("keeps the confirmed research title in a separate strict contract", () => {
    const request = {
      workId: "11111111-1111-4111-8111-111111111111",
      researchTitle: "  사용자가 고친 제목  ",
    };
    expect(SaveWorkResearchTitleRequestSchema.parse(request)).toEqual({
      ...request,
      researchTitle: "사용자가 고친 제목",
    });
    expect(
      SaveWorkResearchTitleRequestSchema.safeParse({
        ...request,
        researchTitle: " ",
      }).success,
    ).toBe(false);
    expect(
      SaveWorkResearchTitleRequestSchema.safeParse({
        ...request,
        researchTitle: "가".repeat(241),
      }).success,
    ).toBe(false);

    expect(workContextIpcContracts.getWorkResearchTitle.channel).toBe(
      "context:get-work-research-title",
    );
    expect(workContextIpcContracts.saveWorkResearchTitle.channel).toBe(
      "context:save-work-research-title",
    );
  });
});
