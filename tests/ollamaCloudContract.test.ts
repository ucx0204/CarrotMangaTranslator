import { describe, expect, it, vi } from "vitest";

const { repairInvalidFixedBlockTranslations } =
  require("../src/main/runtime/transport/fixed-block-repair-loop.cjs") as {
    repairInvalidFixedBlockTranslations: (
      context: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };

function buildRepairContext(apiModel: string) {
  const requestPass = vi.fn(async () => {
    throw Object.assign(new Error("items array missing"), {
      code: "fixed-block-translations-invalid",
    });
  });
  return {
    requestPass,
    context: {
      server: { baseUrl: "http://localhost:11434/v1" },
      options: {
        modelProvider: "openai-api",
        apiBaseUrl: "http://localhost:11434/v1",
        apiModel,
        sourceLanguage: "ja",
        targetLanguage: "ko",
      },
      imageVariants: [],
      plan: {
        version: 6,
        blocks: [
          {
            blockId: "B001",
            jp: "日本語",
            direction: "vertical",
            bbox: { x1: 0, y1: 0, x2: 100, y2: 100 },
          },
        ],
      },
      initialPartial: {
        translations: { items: [] },
        retryBlockIds: ["B001"],
        retryReasons: { B001: ["fixed-block-translations-invalid"] },
      },
      requestSummary: {},
      requestStartedAt: 0,
      requestPass,
    },
  };
}

describe("Ollama Cloud fixed-block contract", () => {
  it.each(["gemma4:31b-cloud", "glm-5.3-flash:cloud"])(
    "fails visibly instead of copying Japanese source text for %s",
    async (apiModel) => {
      const { context, requestPass } = buildRepairContext(apiModel);

      await expect(
        repairInvalidFixedBlockTranslations(context),
      ).rejects.toMatchObject({
        code: "fixed-block-translation-ollama-cloud-contract-invalid",
        unresolvedBlockIds: ["B001"],
      });
      expect(requestPass).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps the established local Ollama recovery policy", async () => {
    const { context, requestPass } = buildRepairContext("gemma4:latest");

    const result = await repairInvalidFixedBlockTranslations(context);

    expect(result).toMatchObject({
      translations: { items: [{ blockId: "B001", ko: "日本語" }] },
      sourceTextFallbackBlockIds: ["B001"],
    });
    expect(requestPass).toHaveBeenCalledTimes(3);
  });
});
