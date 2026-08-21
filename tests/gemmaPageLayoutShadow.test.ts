import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type LayoutIntent = "auto" | "horizontal" | "vertical";
type LayoutRole = "default" | "exterior_editorial";
type CompositionRole = "independent" | "anchor" | "source_erase_only";
type LayoutBlock = {
  blockId: string;
  layoutIntent: LayoutIntent;
  layoutRole: LayoutRole;
  layoutRoleConfidence: number;
  compositionRole: CompositionRole;
  compositionAnchorBlockId: string;
};
type PageLayoutResult = {
  pageLayout: {
    contractVersion: string;
    blocks: LayoutBlock[];
  };
};

const contract =
  require("../scripts/library-full-pipeline-qa/gemma-page-layout-shadow-contract.cjs") as {
    PAGE_LAYOUT_CONTRACT_VERSION: string;
    PAGE_LAYOUT_PROMPT_VERSION: string;
    PAGE_LAYOUT_ARTIFACT_VERSION: string;
    PAGE_LAYOUT_SHADOW_NAMESPACE: string;
    MIN_EXTERIOR_VERTICAL_LAYOUT_ROLE_CONFIDENCE: number;
    buildPageLayoutShadowPrompt: (
      blocks: Array<{
        blockId: string;
        sourceText: string;
        translatedText: string;
      }>,
    ) => string;
    buildPageLayoutShadowResponseFormat: (
      blockIds: string[],
    ) => Record<string, unknown>;
    parsePageLayoutShadowResponse: (
      raw: string,
      blockIds: string[],
    ) => PageLayoutResult;
    buildPageLayoutShadowArtifact: (input: {
      pageKey: string;
      blockIds: string[];
      plan: Record<string, unknown>;
      prompt: string;
      responseFormat: Record<string, unknown>;
      rawResponse: string;
      geometry: { preSha256: string; postSha256: string };
      mask: { preSha256: string; postSha256: string };
    }) => Record<string, unknown>;
    validatePageLayoutShadowArtifact: (value: unknown) => string[];
    resolvePageLayoutShadowArtifactPath: (
      root: string,
      pageKey: string,
    ) => string;
  };

const blockIds = ["B001", "B002", "B003"];

describe("Gemma fixed-block page-layout shadow contract", () => {
  it("keeps the second-pass prompt coordinate-free and role-independent", () => {
    const prompt = contract.buildPageLayoutShadowPrompt([
      promptBlock("B001", "ひとつ", "하나"),
      promptBlock("B002", "ふたつ", "둘"),
    ]);

    expect(prompt).toContain(contract.PAGE_LAYOUT_PROMPT_VERSION);
    expect(prompt).toContain("layoutRole is independent of fontRole");
    expect(prompt).toContain('"source_erase_only" extremely conservatively');
    expect(prompt).toContain("ordinary split speech remains independent");
    expect(prompt).toContain("cannot change rendering, suppression, masks");
    expect(prompt).toContain("Return no coordinates, boxes, regions");

    const supplied = JSON.parse(prompt.split("fixedBlocks=")[1] ?? "[]") as
      | Array<Record<string, unknown>>
      | undefined;
    expect(supplied).toEqual([
      { blockId: "B001", sourceText: "ひとつ", translatedText: "하나" },
      { blockId: "B002", sourceText: "ふたつ", translatedText: "둘" },
    ]);
    expect(JSON.stringify(supplied)).not.toMatch(/bbox|x1|y1|x2|y2/u);
  });

  it("seals the exact pageLayout schema and encodes the vertical safety branch", () => {
    const format = contract.buildPageLayoutShadowResponseFormat(blockIds) as {
      schema: {
        properties: {
          pageLayout: {
            properties: {
              contractVersion: { const: string };
              blocks: {
                minItems: number;
                maxItems: number;
                items: { oneOf: Array<Record<string, unknown>> };
              };
            };
          };
        };
      };
    };
    const pageLayout = format.schema.properties.pageLayout;
    const blocks = pageLayout.properties.blocks;
    const verticalBranch = blocks.items.oneOf[1] as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(pageLayout.properties.contractVersion.const).toBe(
      "fixed-block-page-layout-v1",
    );
    expect([blocks.minItems, blocks.maxItems]).toEqual([3, 3]);
    expect(verticalBranch.required).toEqual([
      "blockId",
      "layoutIntent",
      "layoutRole",
      "layoutRoleConfidence",
      "compositionRole",
      "compositionAnchorBlockId",
    ]);
    expect(verticalBranch.properties.layoutIntent.const).toBe("vertical");
    expect(verticalBranch.properties.layoutRole.const).toBe(
      "exterior_editorial",
    );
    expect(verticalBranch.properties.layoutRoleConfidence.minimum).toBe(0.82);
    expect(verticalBranch.properties.compositionAnchorBlockId.enum).toEqual(
      blockIds,
    );
    expect(JSON.stringify(format)).not.toMatch(/bbox|coordinates|fontRole/u);
  });

  it("accepts one direct composition group and a high-confidence exterior vertical", () => {
    const parsed = contract.parsePageLayoutShadowResponse(
      response([
        layoutBlock("B001", "anchor", "B001"),
        layoutBlock("B002", "independent", "B001"),
        layoutBlock("B003", "source_erase_only", "B001", {
          layoutIntent: "vertical",
          layoutRole: "exterior_editorial",
          layoutRoleConfidence: 0.82,
        }),
      ]),
      blockIds,
    );

    expect(parsed.pageLayout.contractVersion).toBe(
      contract.PAGE_LAYOUT_CONTRACT_VERSION,
    );
    expect(parsed.pageLayout.blocks.map((block) => block.blockId)).toEqual(
      blockIds,
    );
  });

  it.each([
    {
      name: "low-confidence vertical",
      blocks: [
        layoutBlock("B001", "independent", "B001", {
          layoutIntent: "vertical",
          layoutRole: "exterior_editorial",
          layoutRoleConfidence: 0.819,
        }),
        layoutBlock("B002", "independent", "B002"),
        layoutBlock("B003", "independent", "B003"),
      ],
      error: "vertical requires exterior_editorial confidence >= 0.82",
    },
    {
      name: "default-role vertical",
      blocks: [
        layoutBlock("B001", "independent", "B001", {
          layoutIntent: "vertical",
          layoutRole: "default",
          layoutRoleConfidence: 1,
        }),
        layoutBlock("B002", "independent", "B002"),
        layoutBlock("B003", "independent", "B003"),
      ],
      error: "vertical requires exterior_editorial confidence >= 0.82",
    },
    {
      name: "anchor pointing away",
      blocks: [
        layoutBlock("B001", "anchor", "B002"),
        layoutBlock("B002", "anchor", "B002"),
        layoutBlock("B003", "independent", "B003"),
      ],
      error: "anchor must point to itself",
    },
    {
      name: "self-erasing source",
      blocks: [
        layoutBlock("B001", "source_erase_only", "B001"),
        layoutBlock("B002", "independent", "B002"),
        layoutBlock("B003", "independent", "B003"),
      ],
      error: "must point to a distinct anchor",
    },
    {
      name: "pointer chain",
      blocks: [
        layoutBlock("B001", "anchor", "B001"),
        layoutBlock("B002", "independent", "B001"),
        layoutBlock("B003", "independent", "B002"),
      ],
      error: "must target one direct anchor",
    },
  ])("rejects $name", ({ blocks, error }) => {
    expect(() =>
      contract.parsePageLayoutShadowResponse(response(blocks), blockIds),
    ).toThrow(error);
  });

  it("rejects missing, duplicate, reordered, and extra-field output", () => {
    const valid = [
      layoutBlock("B001", "independent", "B001"),
      layoutBlock("B002", "independent", "B002"),
      layoutBlock("B003", "independent", "B003"),
    ];
    expect(() =>
      contract.parsePageLayoutShadowResponse(
        response(valid.slice(0, 2)),
        blockIds,
      ),
    ).toThrow(/IDs\/order differ/i);
    expect(() =>
      contract.parsePageLayoutShadowResponse(
        response([valid[0], valid[1], { ...valid[1] }]),
        blockIds,
      ),
    ).toThrow(/IDs\/order differ/i);
    expect(() =>
      contract.parsePageLayoutShadowResponse(
        response([valid[1], valid[0], valid[2]]),
        blockIds,
      ),
    ).toThrow(/IDs\/order differ/i);
    expect(() =>
      contract.parsePageLayoutShadowResponse(
        response([{ ...valid[0], fontRole: "narration" }, valid[1], valid[2]]),
        blockIds,
      ),
    ).toThrow(/fields are invalid/i);
  });

  it("accepts only raw JSON or the exact official empty-thought prefix", () => {
    const raw = response([
      layoutBlock("B001", "independent", "B001"),
      layoutBlock("B002", "independent", "B002"),
      layoutBlock("B003", "independent", "B003"),
    ]);
    expect(
      contract.parsePageLayoutShadowResponse(
        `<|channel>thought\n<channel|>${raw}`,
        blockIds,
      ).pageLayout.blocks,
    ).toHaveLength(3);
    expect(() =>
      contract.parsePageLayoutShadowResponse(` ${raw}`, blockIds),
    ).toThrow(/envelope is invalid/i);
    expect(() =>
      contract.parsePageLayoutShadowResponse(
        `\`\`\`json\n${raw}\n\`\`\``,
        blockIds,
      ),
    ).toThrow(/not valid JSON/i);
  });

  it("produces a sealed mutation-forbidden receipt in a dedicated shadow namespace", () => {
    const prompt = contract.buildPageLayoutShadowPrompt([
      promptBlock("B001", "一", "하나"),
      promptBlock("B002", "二", "둘"),
      promptBlock("B003", "三", "셋"),
    ]);
    const format = contract.buildPageLayoutShadowResponseFormat(blockIds);
    const raw = response([
      layoutBlock("B001", "anchor", "B001"),
      layoutBlock("B002", "independent", "B001"),
      layoutBlock("B003", "source_erase_only", "B001"),
    ]);
    const artifact = contract.buildPageLayoutShadowArtifact({
      pageKey: "baseline40-page-24",
      blockIds,
      plan: fixedPlan(),
      prompt,
      responseFormat: format,
      rawResponse: raw,
      geometry: unchangedHashes("a"),
      mask: unchangedHashes("b"),
    });

    expect(contract.validatePageLayoutShadowArtifact(artifact)).toEqual([]);
    expect(artifact).toMatchObject({
      artifactVersion: contract.PAGE_LAYOUT_ARTIFACT_VERSION,
      shadowOnly: true,
      reviewOnly: true,
      promotionEligible: false,
      productionMutationAllowed: false,
      renderMutationAllowed: false,
      renderSuppressionAllowed: false,
      geometryMutationAllowed: false,
      maskMutationAllowed: false,
      inpaintingMutationAllowed: false,
      completionMutationAllowed: false,
      rawResponse: raw,
      rawResponseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      normalizedAdvisory: JSON.parse(raw).pageLayout,
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      blockOrderSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      inputBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      geometry: { ...unchangedHashes("a"), unchanged: true },
      mask: { ...unchangedHashes("b"), unchanged: true },
      sealed: true,
    });

    const tampered = { ...artifact, renderSuppressionAllowed: true };
    expect(contract.validatePageLayoutShadowArtifact(tampered)).toEqual(
      expect.arrayContaining([
        "artifact-binding-sha-mismatch",
        "mutation-flags-invalid",
      ]),
    );

    const outputRoot = resolve("artifacts", "bubble-opacity-layout-qa-v1");
    expect(
      contract.resolvePageLayoutShadowArtifactPath(
        outputRoot,
        "baseline40-page-24",
      ),
    ).toBe(
      resolve(
        outputRoot,
        contract.PAGE_LAYOUT_SHADOW_NAMESPACE,
        "pages",
        "baseline40-page-24",
        "page-layout-advisory.json",
      ),
    );
    expect(() =>
      contract.resolvePageLayoutShadowArtifactPath(outputRoot, "../escape"),
    ).toThrow(/page key is invalid/i);
  });

  it("refuses to seal a drifted plan order, geometry snapshot, or mask snapshot", () => {
    const prompt = contract.buildPageLayoutShadowPrompt([
      promptBlock("B001", "一", "하나"),
      promptBlock("B002", "二", "둘"),
      promptBlock("B003", "三", "셋"),
    ]);
    const base = {
      pageKey: "baseline40-page-24",
      blockIds,
      plan: fixedPlan(),
      prompt,
      responseFormat: contract.buildPageLayoutShadowResponseFormat(blockIds),
      rawResponse: response([
        layoutBlock("B001", "independent", "B001"),
        layoutBlock("B002", "independent", "B002"),
        layoutBlock("B003", "independent", "B003"),
      ]),
      geometry: unchangedHashes("a"),
      mask: unchangedHashes("b"),
    };

    expect(() =>
      contract.buildPageLayoutShadowArtifact({
        ...base,
        plan: {
          blocks: [...blockIds].reverse().map((blockId) => ({ blockId })),
        },
      }),
    ).toThrow(/does not match the immutable block order/i);
    expect(() =>
      contract.buildPageLayoutShadowArtifact({
        ...base,
        geometry: {
          preSha256: "a".repeat(64),
          postSha256: "c".repeat(64),
        },
      }),
    ).toThrow(/geometry pre\/post hashes must be identical/i);
    expect(() =>
      contract.buildPageLayoutShadowArtifact({
        ...base,
        mask: {
          preSha256: "b".repeat(64),
          postSha256: "d".repeat(64),
        },
      }),
    ).toThrow(/mask pre\/post hashes must be identical/i);
  });
});

function promptBlock(
  blockId: string,
  sourceText: string,
  translatedText: string,
) {
  return { blockId, sourceText, translatedText };
}

function layoutBlock(
  blockId: string,
  compositionRole: CompositionRole,
  compositionAnchorBlockId: string,
  overrides: Partial<LayoutBlock> = {},
): LayoutBlock {
  return {
    blockId,
    layoutIntent: "horizontal",
    layoutRole: "default",
    layoutRoleConfidence: 0.9,
    compositionRole,
    compositionAnchorBlockId,
    ...overrides,
  };
}

function response(
  blocks: Array<Record<string, unknown> | LayoutBlock>,
): string {
  return JSON.stringify({
    pageLayout: {
      contractVersion: "fixed-block-page-layout-v1",
      blocks,
    },
  });
}

function fixedPlan(): Record<string, unknown> {
  return {
    version: 6,
    blocks: blockIds.map((blockId) => ({ blockId })),
  };
}

function unchangedHashes(character: string) {
  const hash = character.repeat(64);
  return { preSha256: hash, postSha256: hash };
}
