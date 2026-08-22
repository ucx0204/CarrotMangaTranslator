import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type AuditResult = {
  status: "clean" | "residual" | "uncertain";
  reason: string;
  evidenceBlockIds: string[];
};

type AuditModelResult = {
  status: "clean" | "residual" | "uncertain";
  reason: string;
  evidenceBlockAliases: string[];
};

type BlockAlias = { alias: string; blockId: string; order: number };

type ParsedAuditResult =
  | {
      ok: true;
      modelResult: AuditModelResult;
      result: AuditResult;
      outputPrefixKind: string;
      errors: [];
    }
  | {
      ok: false;
      modelResult: null;
      result: null;
      outputPrefixKind: string;
      errors: string[];
    };

type PreparedAudit = {
  page: AuditPage;
  modelName: string;
  runtimeBinding: Record<string, unknown>;
  blockIds: string[];
  aliasMap: BlockAlias[];
  basePrompt: string;
  responseFormat: Record<string, unknown>;
  initialRequestBody: Record<string, unknown>;
  knownBlockPrompt: string;
  knownBlockResponseFormat: Record<string, unknown>;
  knownBlockInitialRequestBody: Record<string, unknown>;
  unassignedPrompt: string;
  unassignedResponseFormat: Record<string, unknown>;
  unassignedInitialRequestBody: Record<string, unknown>;
  inputBinding: Record<string, unknown> & { bindingSha256: string };
  contractPins: Record<string, unknown>;
  cacheKey: string;
};

type AuditOutcome = {
  page: AuditPage;
  prepared: PreparedAudit;
  cacheHit: boolean;
  executionStatus: string;
  transportError: string | null;
  parseContractSatisfied: boolean;
  failClosed: boolean;
  modelResult: AuditModelResult | null;
  unassignedReviewEvidence: Record<string, unknown> | null;
  passes: Record<string, unknown>;
  result: AuditResult;
  attempts: Array<Record<string, unknown> & { attemptNumber: number }>;
  recommendedDisposition: string;
};

type AuditPage = {
  selectionIndex: number;
  expectedClass: "clean" | "residual";
  pageId: string;
  workId: string;
  chapterId: string;
  originalPath: string;
  cleanedPath: string;
  fontInputPath: string;
  original: Record<string, unknown>;
  cleaned: Record<string, unknown>;
  fontInputSha256: string;
  blocks: Array<{
    blockId: string;
    order: number;
    sourceText: string;
    translatedText: string;
    bbox1000: { x: number; y: number; w: number; h: number };
    bboxSpace: "normalized_1000";
    textRole: string;
  }>;
  orderedBlockIdsSha256: string;
  sourceRunStatus: string;
  sourceRunStatusSemantics: string;
  v4ContractPins?: Record<string, unknown>;
};

const contract =
  require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-contract.cjs") as {
    MAX_REPAIR_ATTEMPTS: number;
    MAX_EVIDENCE_ALIASES: number;
    OFFICIAL_EMPTY_THOUGHT_PREFIX: string;
    assertExactTwoImageMessages: (
      messages: Array<Record<string, unknown>>,
    ) => void;
    buildBlockAliasMap: (blockIds: string[]) => BlockAlias[];
    buildCleanupAuditPrompt: (
      blocks: AuditPage["blocks"],
      aliasMap: BlockAlias[],
    ) => string;
    buildCleanupAuditResponseFormat: (
      aliasMap: BlockAlias[],
    ) => Record<string, unknown>;
    buildUnassignedAuditPrompt: (
      blocks: AuditPage["blocks"],
      aliasMap: BlockAlias[],
    ) => string;
    buildUnassignedAuditResponseFormat: () => Record<string, unknown>;
    buildExactTwoImageMessages: (options: {
      original: Record<string, unknown>;
      cleaned: Record<string, unknown>;
      prompt: string;
    }) => Array<Record<string, unknown>>;
    parseCleanupAuditOutput: (
      output: string,
      aliasMap: BlockAlias[],
      finishReason?: string,
    ) => ParsedAuditResult;
    parseUnassignedAuditOutput: (
      output: string,
      finishReason?: string,
    ) => Record<string, unknown>;
    sealRecord: (
      record: Record<string, unknown>,
    ) => Record<string, unknown> & { bindingSha256: string; sealed: true };
    sha256: (value: string | Buffer) => string;
    sha256Canonical: (value: unknown) => string;
  };

const inputs =
  require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-inputs.cjs") as {
    assertShadowWriteTargets: (options: {
      root: string;
      runRoot: string;
      outputRoot: string;
      cacheDir: string;
    }) => Promise<void>;
    loadFrozenAuditInputs: (options: {
      root: string;
      indices: number[];
    }) => Promise<{
      manifest: {
        pages: Array<{
          selectionIndex: number;
          expectedClass: "clean" | "residual";
          workId: string;
        }>;
        model: { provider: string; source: string; repo: string; file: string };
      };
      manifestSha256: string;
      runReportSha256: string;
      runRoot: string;
      pages: AuditPage[];
    }>;
    loadFrozenManifest: (root: string) => Promise<{
      manifest: {
        pages: Array<{
          selectionIndex: number;
          expectedClass: "clean" | "residual";
          workId: string;
        }>;
      };
    }>;
    readImmutableBlocks: (
      fontInput: Record<string, unknown>,
      page: Record<string, unknown>,
    ) => AuditPage["blocks"];
  };

const realFrozenAuditAssetsAvailable = existsSync(
  join(
    __dirname,
    "..",
    "artifacts",
    "bubble-opacity-layout-qa-v1",
    "runs",
    "baseline40",
    "layout-intent-baseline20",
    "r1",
    "run-report.json",
  ),
);

const runner =
  require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-runner.cjs") as {
    assertPreparedAuditPageIntegrity: (prepared: PreparedAudit) => true;
    exactCachePath: (cacheDir: string, cacheKey: string) => string;
    prepareAuditPage: (options: {
      page: AuditPage;
      modelName: string;
      runtimeBinding: Record<string, unknown>;
    }) => PreparedAudit;
    runAuditPage: (options: {
      prepared: PreparedAudit;
      requester: (options: {
        passId: "known-block" | "unassigned-source";
        attemptNumber: number;
        requestBody: Record<string, unknown>;
        requestBodySha256: string;
      }) => Promise<{
        rawResponseText: string;
        outputText: string;
        finishReason: string;
      }>;
      cacheDir?: string;
    }) => Promise<AuditOutcome>;
    validateExperimentArtifacts: (
      outputRoot: string,
      options?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    writeExperimentArtifacts: (options: {
      outputRoot: string;
      sourceBinding: Record<string, unknown>;
      runtimeBinding: Record<string, unknown>;
      outcomes: AuditOutcome[];
    }) => Promise<Record<string, unknown>>;
    verifyCacheEntry: (
      entry: Record<string, unknown>,
      cacheKey: string,
      inputBindingSha256: unknown,
      prepared: PreparedAudit,
    ) => string[];
  };

const runtime =
  require("../scripts/library-full-pipeline-qa/gemma-cleanup-audit-runtime.cjs") as {
    assertCacheDisabled: (args: string[]) => void;
    buildPreflightRuntimeBinding: (model: {
      provider: string;
      source: string;
      repo: string;
      file: string;
    }) => Record<string, unknown> & { bindingSha256: string };
  };

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Gemma cleanup audit shadow contract", () => {
  it("builds exactly Image1 original plus Image2 cleaned and no third variant", () => {
    const page = makePage();
    const aliasMap = contract.buildBlockAliasMap(
      page.blocks.map((block) => block.blockId),
    );
    const messages = contract.buildExactTwoImageMessages({
      original: page.original,
      cleaned: page.cleaned,
      prompt: contract.buildCleanupAuditPrompt(page.blocks, aliasMap),
    });

    expect(() => contract.assertExactTwoImageMessages(messages)).not.toThrow();
    const userParts = messages[1].content as Array<Record<string, unknown>>;
    const imageParts = userParts.filter((part) => part.type === "image_url");
    expect(imageParts).toHaveLength(2);
    expect(readImageUrl(imageParts[0])).toBe(page.original.dataUrl);
    expect(readImageUrl(imageParts[1])).toBe(page.cleaned.dataUrl);
    expect(JSON.stringify(messages)).not.toContain("enhanced");
  });

  it("binds normalized_1000 bbox provenance and rejects unsupported space or drift", () => {
    const bbox = { x: 100, y: 200, w: 300, h: 400 };
    const frozenPage = {
      pageId: "bbox-page",
      originalSha256: "a".repeat(64),
      blockCount: 1,
      orderedBlockIdsSha256: contract.sha256Canonical(["block-1"]),
    };
    const fontInput = {
      sourcePageId: frozenPage.pageId,
      sourcePageSha256: frozenPage.originalSha256,
      page: {
        blocks: [
          {
            id: "block-1",
            bbox: structuredClone(bbox),
            bboxSpace: "normalized_1000",
          },
        ],
      },
      requestBlocks: [
        {
          blockId: "block-1",
          item: {
            bbox: structuredClone(bbox),
            sourceText: "原文",
            translatedText: "번역",
            textRole: "sound",
          },
        },
      ],
    };
    expect(inputs.readImmutableBlocks(fontInput, frozenPage)).toEqual([
      expect.objectContaining({
        blockId: "block-1",
        bbox1000: bbox,
        bboxSpace: "normalized_1000",
        textRole: "sound",
      }),
    ]);

    const unsupported = structuredClone(fontInput);
    unsupported.page.blocks[0].bboxSpace = "pixels";
    expect(() => inputs.readImmutableBlocks(unsupported, frozenPage)).toThrow(
      "supports normalized_1000 bboxSpace only",
    );

    const drifted = structuredClone(fontInput);
    drifted.requestBlocks[0].item.bbox.x = 101;
    expect(() => inputs.readImmutableBlocks(drifted, frozenPage)).toThrow(
      "bbox binding mismatch",
    );

    const promptPage = makePage();
    (promptPage.blocks[0] as { bboxSpace: string }).bboxSpace = "pixels";
    expect(() =>
      contract.buildCleanupAuditPrompt(
        promptPage.blocks,
        contract.buildBlockAliasMap(
          promptPage.blocks.map((block) => block.blockId),
        ),
      ),
    ).toThrow("supports normalized_1000 bboxSpace only");
  });

  it("strictly maps alias evidence to immutable IDs and enforces order/invariants", () => {
    const ids = ["block-1", "block-2"];
    const aliases = contract.buildBlockAliasMap(ids);
    expect(
      contract.parseCleanupAuditOutput(
        JSON.stringify({
          status: "residual",
          reason: "known_block_source_glyphs_remain",
          evidenceBlockAliases: ["B001", "B002"],
        }),
        aliases,
      ),
    ).toMatchObject({
      ok: true,
      modelResult: { evidenceBlockAliases: ["B001", "B002"] },
      result: { evidenceBlockIds: ids },
    });

    expect(
      contract.parseCleanupAuditOutput(
        JSON.stringify({
          status: "residual",
          reason: "known_block_source_glyphs_remain",
          evidenceBlockAliases: ["B002", "B001"],
        }),
        aliases,
      ),
    ).toMatchObject({
      ok: false,
      errors: ["evidence-block-alias-order-invalid"],
    });
    expect(
      contract.parseCleanupAuditOutput(
        JSON.stringify({
          status: "clean",
          reason: "clean_no_translated_source_glyphs",
          evidenceBlockAliases: ["B001"],
          bbox: [0, 0, 1, 1],
        }),
        aliases,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "top-level-keys-invalid",
        "clean-invariant-invalid",
      ]),
    });
    expect(
      contract.parseCleanupAuditOutput(
        '{"status":"residual","reason":"known_block_source_glyphs_remain","evidenceBlockAliases":["invented"]}',
        aliases,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["evidence-block-alias-unknown"]),
    });
  });

  it("accepts only the exact pinned empty-thought prefix and no other control prose", () => {
    const aliases = contract.buildBlockAliasMap(["block-1"]);
    const json = JSON.stringify({
      status: "residual",
      reason: "known_block_source_glyphs_remain",
      evidenceBlockAliases: ["B001"],
    });
    expect(
      contract.parseCleanupAuditOutput(
        `${contract.OFFICIAL_EMPTY_THOUGHT_PREFIX}${json}`,
        aliases,
        "stop",
      ),
    ).toMatchObject({
      ok: true,
      outputPrefixKind: "gemma4-official-empty-thought-prefix-v1",
      result: { evidenceBlockIds: ["block-1"] },
    });
    for (const output of [
      `<|channel>thought\nnot-empty<channel|>${json}`,
      `${contract.OFFICIAL_EMPTY_THOUGHT_PREFIX}${contract.OFFICIAL_EMPTY_THOUGHT_PREFIX}${json}`,
    ]) {
      expect(
        contract.parseCleanupAuditOutput(output, aliases, "stop"),
      ).toMatchObject({ ok: false, errors: ["control-prefix-invalid"] });
    }
    expect(
      contract.parseCleanupAuditOutput(`prose ${json}`, aliases, "stop"),
    ).toMatchObject({ ok: false, errors: ["json-invalid"] });
  });

  it("caps evidence at three strongest aliases and schemas cross-field invariants", () => {
    const aliases = contract.buildBlockAliasMap([
      "block-1",
      "block-2",
      "block-3",
      "block-4",
    ]);
    const three = contract.parseCleanupAuditOutput(
      JSON.stringify({
        status: "residual",
        reason: "known_block_source_glyphs_remain",
        evidenceBlockAliases: ["B001", "B002", "B003"],
      }),
      aliases,
    );
    expect(three).toMatchObject({
      ok: true,
      result: { evidenceBlockIds: ["block-1", "block-2", "block-3"] },
    });
    expect(
      contract.parseCleanupAuditOutput(
        JSON.stringify({
          status: "residual",
          reason: "known_block_source_glyphs_remain",
          evidenceBlockAliases: ["B001", "B002", "B003", "B004"],
        }),
        aliases,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["evidence-block-alias-cap-exceeded"]),
    });
    expect(
      contract.parseCleanupAuditOutput(
        JSON.stringify({
          status: "residual",
          reason: "unassigned_source_glyphs_may_duplicate_translation",
          evidenceBlockAliases: ["B001"],
        }),
        aliases,
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["residual-invariant-invalid"]),
    });
    const format = contract.buildCleanupAuditResponseFormat(aliases);
    expect(format).toMatchObject({
      type: "json_object",
      schema: { oneOf: expect.any(Array) },
    });
    expect(JSON.stringify(format)).not.toContain("images_not_comparable");
  });

  it("fails closed on finish_reason=length even if the truncated body looks valid", async () => {
    const prepared = makePrepared();
    const outputText = `${contract.OFFICIAL_EMPTY_THOUGHT_PREFIX}${JSON.stringify(
      {
        status: "residual",
        reason: "known_block_source_glyphs_remain",
        evidenceBlockAliases: ["B001"],
      },
    )}`;
    let calls = 0;
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async () => {
        calls += 1;
        return { rawResponseText: "{}", outputText, finishReason: "length" };
      },
    });
    expect(calls).toBe(3);
    expect(outcome).toMatchObject({
      parseContractSatisfied: false,
      failClosed: true,
      modelResult: null,
      result: { status: "uncertain", evidenceBlockIds: [] },
    });
    expect(outcome.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finishReason: "length",
          outputPrefixKind: "gemma4-official-empty-thought-prefix-v1",
          parseErrors: ["finish-reason-length"],
        }),
      ]),
    );
  });

  it("uses at most two repairs and keeps every attempt on the exact two images", async () => {
    const prepared = makePrepared();
    expect(prepared.aliasMap).toEqual([
      { alias: "B001", blockId: "block-1", order: 0 },
      { alias: "B002", blockId: "block-2", order: 1 },
    ]);
    expect(prepared.basePrompt).not.toContain("block-1");
    expect(JSON.stringify(prepared.responseFormat)).not.toContain("block-1");
    expect(JSON.stringify(prepared.initialRequestBody)).not.toContain(
      "block-1",
    );
    expect(JSON.stringify(prepared.inputBinding)).toContain("block-1");
    const seenBodies: Array<Record<string, unknown>> = [];
    const valid = JSON.stringify({
      status: "residual",
      reason: "known_block_source_glyphs_remain",
      evidenceBlockAliases: ["B001"],
    });
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ attemptNumber, requestBody }) => {
        seenBodies.push(requestBody);
        return {
          rawResponseText: JSON.stringify({ attemptNumber }),
          outputText: attemptNumber < 3 ? "not-json" : valid,
          finishReason: "stop",
        };
      },
    });

    expect(contract.MAX_REPAIR_ATTEMPTS).toBe(2);
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome).toMatchObject({
      parseContractSatisfied: true,
      failClosed: false,
      result: { status: "residual" },
      recommendedDisposition: "shadow-would-pend-or-retry",
    });
    for (const body of seenBodies) {
      expect(() =>
        contract.assertExactTwoImageMessages(
          body.messages as Array<Record<string, unknown>>,
        ),
      ).not.toThrow();
      expect(body.cache_prompt).toBe(false);
    }
  });

  it("fails closed to uncertain after the initial request and two invalid repairs", async () => {
    let calls = 0;
    const outcome = await runner.runAuditPage({
      prepared: makePrepared(),
      requester: async () => {
        calls += 1;
        return {
          rawResponseText: "{}",
          outputText: "{}",
          finishReason: "stop",
        };
      },
    });

    expect(calls).toBe(3);
    expect(outcome).toMatchObject({
      executionStatus: "completed",
      parseContractSatisfied: false,
      failClosed: true,
      result: {
        status: "uncertain",
        reason: "visual_evidence_ambiguous",
        evidenceBlockIds: [],
      },
      recommendedDisposition: "shadow-would-pend-or-retry",
    });
  });

  it("stops after Pass A and maps known B008/B009 residue to immutable IDs", async () => {
    const page = makePage();
    page.blocks = Array.from({ length: 9 }, (_, order) => ({
      ...page.blocks[Math.min(order, page.blocks.length - 1)],
      blockId: `block-${order + 1}`,
      order,
      sourceText: `原文${order + 1}`,
      bbox1000: { x: order * 10, y: order * 10, w: 5, h: 5 },
    }));
    page.orderedBlockIdsSha256 = contract.sha256Canonical(
      page.blocks.map((block) => block.blockId),
    );
    const prepared = runner.prepareAuditPage({
      page,
      modelName: "fixture-gemma",
      runtimeBinding: makePrepared().runtimeBinding,
    });
    const seenPasses: string[] = [];
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ passId }) => {
        seenPasses.push(passId);
        return {
          rawResponseText: "{}",
          outputText: JSON.stringify({
            status: "residual",
            reason: "known_block_source_glyphs_remain",
            evidenceBlockAliases: ["B008", "B009"],
          }),
          finishReason: "stop",
        };
      },
    });
    expect(seenPasses).toEqual(["known-block"]);
    expect(outcome.result).toEqual({
      status: "residual",
      reason: "known_block_source_glyphs_remain",
      evidenceBlockIds: ["block-8", "block-9"],
    });
    expect(outcome.unassignedReviewEvidence).toBeNull();
  });

  it("keeps dense line art and intentional unprocessed SFX clean through both passes", async () => {
    const prepared = makePrepared();
    const seenPasses: string[] = [];
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ passId }) => {
        seenPasses.push(passId);
        return cleanPassResponse(passId);
      },
    });
    expect(seenPasses).toEqual(["known-block", "unassigned-source"]);
    expect(prepared.unassignedPrompt).toContain("decorative/background text");
    expect(prepared.unassignedPrompt).toContain("intentional/untranslated SFX");
    expect(outcome.result).toEqual({
      status: "clean",
      reason: "clean_no_source_glyphs",
      evidenceBlockIds: [],
    });
  });

  it("does not let Pass B override an ambiguous Pass A", async () => {
    const seenPasses: string[] = [];
    const outcome = await runner.runAuditPage({
      prepared: makePrepared(),
      requester: async ({ passId }) => {
        seenPasses.push(passId);
        return {
          rawResponseText: "{}",
          outputText: JSON.stringify({
            status: "uncertain",
            reason: "visual_evidence_ambiguous",
            evidenceBlockAliases: [],
          }),
          finishReason: "stop",
        };
      },
    });
    expect(seenPasses).toEqual(["known-block"]);
    expect(outcome).toMatchObject({
      parseContractSatisfied: true,
      failClosed: false,
      result: { status: "uncertain", evidenceBlockIds: [] },
      recommendedDisposition: "shadow-would-pend-or-retry",
    });
  });

  it("seals true unassigned tiny glyph evidence as review-only without geometry", async () => {
    const prepared = makePrepared();
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ passId }) =>
        passId === "known-block"
          ? cleanPassResponse(passId)
          : {
              rawResponseText: "{}",
              outputText: JSON.stringify({
                status: "residual",
                reason: "unassigned_source_glyph_persists",
                japaneseGlyphSnippet: "小",
                region: "bottom_right",
                category: "caption_or_annotation",
              }),
              finishReason: "stop",
            },
    });
    expect(outcome.result).toEqual({
      status: "residual",
      reason: "unassigned_source_glyph_persists",
      evidenceBlockIds: [],
    });
    expect(outcome.unassignedReviewEvidence).toEqual({
      status: "residual",
      reason: "unassigned_source_glyph_persists",
      japaneseGlyphSnippet: "小",
      region: "bottom_right",
      category: "caption_or_annotation",
    });
    expect(JSON.stringify(outcome.unassignedReviewEvidence)).not.toMatch(
      /bbox|mask|pixels|geometry/iu,
    );
  });

  it("turns empty Pass B residual evidence into uncertain after exactly two repairs", async () => {
    const calls: Record<string, number> = {};
    const outcome = await runner.runAuditPage({
      prepared: makePrepared(),
      requester: async ({ passId }) => {
        calls[passId] = (calls[passId] || 0) + 1;
        if (passId === "known-block") return cleanPassResponse(passId);
        return {
          rawResponseText: "{}",
          outputText: JSON.stringify({
            status: "residual",
            reason: "unassigned_source_glyph_persists",
            japaneseGlyphSnippet: "",
            region: "bottom_right",
            category: "caption_or_annotation",
          }),
          finishReason: "stop",
        };
      },
    });
    expect(calls).toEqual({ "known-block": 1, "unassigned-source": 3 });
    expect(outcome).toMatchObject({
      parseContractSatisfied: false,
      failClosed: true,
      result: { status: "uncertain", evidenceBlockIds: [] },
    });
    expect(outcome.unassignedReviewEvidence).toBeNull();
  });

  it("reuses only an exact sealed cache entry and rejects cache tampering", async () => {
    const cacheDir = makeTemporaryRoot();
    const prepared = makePrepared();
    await runner.runAuditPage({
      prepared,
      cacheDir,
      requester: async ({ passId }) => cleanPassResponse(passId),
    });
    const cached = await runner.runAuditPage({
      prepared,
      cacheDir,
      requester: async () => {
        throw new Error("cache miss");
      },
    });
    expect(cached.cacheHit).toBe(true);
    expect(cached.result.status).toBe("clean");

    const cachePath = runner.exactCachePath(cacheDir, prepared.cacheKey);
    const entry = JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      unknown
    >;
    const aliasTampered = structuredClone(entry);
    aliasTampered.modelResult = {
      status: "clean",
      reason: "clean_no_known_block_source_glyphs",
      evidenceBlockAliases: ["B001"],
    };
    delete aliasTampered.bindingSha256;
    delete aliasTampered.sealed;
    expect(
      runner.verifyCacheEntry(
        contract.sealRecord(aliasTampered),
        prepared.cacheKey,
        prepared.inputBinding.bindingSha256,
        prepared,
      ),
    ).toContain("aggregate-result-binding");

    const orderTampered = structuredClone(prepared);
    orderTampered.aliasMap.reverse();
    expect(() =>
      runner.assertPreparedAuditPageIntegrity(orderTampered),
    ).toThrow(/aliasMap|immutable/u);

    entry.result = {
      status: "residual",
      reason: "unassigned_source_glyph_persists",
      evidenceBlockIds: [],
    };
    delete entry.bindingSha256;
    delete entry.sealed;
    const maliciouslyResealed = contract.sealRecord(entry);
    writeFileSync(
      cachePath,
      `${JSON.stringify(maliciouslyResealed)}\n`,
      "utf8",
    );
    await expect(
      runner.runAuditPage({
        prepared,
        cacheDir,
        requester: async () => ({
          rawResponseText: "",
          outputText: "",
          finishReason: "stop",
        }),
      }),
    ).rejects.toThrow("cache validation failed");
  });

  it("seals page/report artifacts and detects a changed attempt", async () => {
    const outputRoot = join(makeTemporaryRoot(), "new-artifact");
    const prepared = makePrepared();
    const outcome = await runner.runAuditPage({
      prepared,
      requester: async ({ passId }) => cleanPassResponse(passId),
    });
    const sourceBinding = contract.sealRecord({
      contractVersion: "fixture-source-v1",
      shadowOnly: true,
      frozenManifestSha256: "1".repeat(64),
      runReportSha256: "2".repeat(64),
      runConfigSha256: "3".repeat(64),
      manualLedgerSha256: "4".repeat(64),
      selectionIndices: [prepared.page.selectionIndex],
      pageIds: [prepared.page.pageId],
    });
    const report = await runner.writeExperimentArtifacts({
      outputRoot,
      sourceBinding,
      runtimeBinding: prepared.runtimeBinding,
      outcomes: [outcome],
    });
    expect(report).toMatchObject({
      sealed: true,
      shadowOnly: true,
      promotionEligible: false,
      evaluationRole: "development-only-not-holdout",
      holdoutEligible: false,
      productionMutationAllowed: false,
      productionTranslationCompletionMutated: false,
      productionMaskMutated: false,
      productionRetryScheduled: false,
    });
    await expect(
      runner.validateExperimentArtifacts(outputRoot, {
        authoritativeInputs: makeAuthoritativeInputs(prepared.page),
      }),
    ).resolves.toMatchObject({
      status: "completed",
    });

    const attemptPath = join(
      outputRoot,
      "pages",
      "selection-14",
      "known-block-attempt-01.json",
    );
    writeFileSync(attemptPath, "{}\n", "utf8");
    await expect(
      runner.validateExperimentArtifacts(outputRoot, {
        authoritativeInputs: makeAuthoritativeInputs(prepared.page),
      }),
    ).rejects.toThrow("referenced-file-sha");
  });

  it.skipIf(!realFrozenAuditAssetsAvailable)(
    "preflights the real frozen page 14 without any live inference",
    async () => {
      const root = resolve(__dirname, "..");
      const frozen = await inputs.loadFrozenAuditInputs({
        root,
        indices: [14],
      });
      const page = frozen.pages[0];
      const preflightRuntime = runtime.buildPreflightRuntimeBinding(
        frozen.manifest.model,
      );
      const prepared = runner.prepareAuditPage({
        page,
        modelName: frozen.manifest.model.repo,
        runtimeBinding: preflightRuntime,
      });

      expect(page).toMatchObject({
        selectionIndex: 14,
        expectedClass: "residual",
        pageId: "408b0f36-aadc-4cd1-b093-79b746d866d6",
        workId: "c2e02f88-c96d-4fd0-af7e-19c4c0afa810",
        original: {
          sourceSha256:
            "ce44bfe683a060bf30f66e1535dd7170f99c14a4878ba333333b733c558f03e5",
        },
        cleaned: {
          sourceSha256:
            "c681a2d38c041031c670a569d33a4a514f9d689ea2c7eafdfa428b35cff9d1e8",
        },
        orderedBlockIdsSha256:
          "9eacec54ec161435a8e49c4bfee9fb099fbc2e110e8848bb196b781827fe191d",
      });
      expect(page.blocks).toHaveLength(12);
      expect(prepared.contractPins).toEqual(page.v4ContractPins);
      expect(prepared.aliasMap).toHaveLength(12);
      expect(prepared.aliasMap[0].alias).toBe("B001");
      expect(prepared.aliasMap[11].alias).toBe("B012");
      expect(page.original.width).toBe(page.cleaned.width);
      expect(page.original.height).toBe(page.cleaned.height);
      expect(prepared.inputBinding.page).toMatchObject({
        bbox1000ContractVersion: "full-page-normalized-1000-top-left-v1",
        bbox1000Sha256: page.v4ContractPins?.bbox1000Sha256,
      });
      expect(prepared.basePrompt).toContain(
        "bbox1000 is {x,y,w,h} in normalized 0..1000 full-page coordinates with a top-left origin",
      );
      expect(prepared.basePrompt).toContain(
        "Supplied sound/SFX aliases are translated targets",
      );
      expect(prepared.basePrompt).toContain(
        "immediately adjacent to it, or visibly continuing the same phrase",
      );
      expect(prepared.unassignedPrompt).toContain(
        "Explicitly exclude intentional/untranslated SFX, logos, book-cover art",
      );
      expect(prepared.unassignedPrompt).toContain(
        "same location from Image 1 to Image 2",
      );
      const promptMarker = "Aliased blocks in required order: ";
      const [instructions, compactJson] =
        prepared.basePrompt.split(promptMarker);
      expect(instructions).not.toContain("B008");
      expect(instructions).not.toContain("B009");
      expect(instructions).not.toMatch(
        /gold|ground.?truth|expected evidence/iu,
      );
      const compactBlocks = JSON.parse(compactJson) as Array<{
        alias: string;
        bbox1000: { x: number; y: number; w: number; h: number };
        textRole: string;
      }>;
      expect(compactBlocks[7]).toMatchObject({
        alias: "B008",
        bbox1000: {
          x: 353.7037037037037,
          y: 683.3876221498372,
          w: 60.18518518518518,
          h: 100.9771986970684,
        },
        textRole: "sound",
      });
      expect(compactBlocks[8]).toMatchObject({
        alias: "B009",
        bbox1000: { y: 700.3257328990228 },
        textRole: "sound",
      });
      expect(prepared.basePrompt).not.toContain('"bbox":');
      expect(prepared.runtimeBinding.executionAllowed).toBe(false);
      expect(() =>
        contract.assertExactTwoImageMessages(
          prepared.initialRequestBody.messages as Array<
            Record<string, unknown>
          >,
        ),
      ).not.toThrow();
    },
  );

  it("keeps the frozen 6-positive/4-negative cohort work-disjoint", async () => {
    const root = resolve(__dirname, "..");
    const frozen = await inputs.loadFrozenManifest(root);
    const pages = frozen.manifest.pages;
    expect(
      pages
        .filter((page) => page.expectedClass === "residual")
        .map((page) => page.selectionIndex),
    ).toEqual([1, 6, 8, 10, 14, 18]);
    expect(
      pages
        .filter((page) => page.expectedClass === "clean")
        .map((page) => page.selectionIndex),
    ).toEqual([3, 4, 5, 13]);
    expect(new Set(pages.map((page) => page.workId)).size).toBe(10);
  });

  it("rejects a live launch that allows prompt caching or parallel slots", () => {
    expect(() => runtime.assertCacheDisabled(["-np", "1"])).toThrow(
      "prompt cache disabled",
    );
    expect(() =>
      runtime.assertCacheDisabled(["--no-cache-prompt", "-np", "2"]),
    ).toThrow("prompt cache disabled");
    expect(() =>
      runtime.assertCacheDisabled(["--no-cache-prompt", "-np", "1"]),
    ).not.toThrow();
  });

  it("forbids writes inside the source library or frozen run", async () => {
    const root = resolve("C:/fixture-repository");
    const runRoot = join(root, "artifacts", "frozen-run", "r1");
    const safe = {
      root,
      runRoot,
      outputRoot: join(root, "artifacts", "cleanup-audit-new"),
      cacheDir: join(root, ".tmp", "cleanup-audit-cache"),
    };
    await expect(
      inputs.assertShadowWriteTargets(safe),
    ).resolves.toBeUndefined();
    await expect(
      inputs.assertShadowWriteTargets({
        ...safe,
        outputRoot: join(runRoot, "shadow-output"),
      }),
    ).rejects.toThrow("frozen run");
    await expect(
      inputs.assertShadowWriteTargets({
        ...safe,
        cacheDir: join(root, "library", "shadow-cache"),
      }),
    ).rejects.toThrow("source library");
    await expect(
      inputs.assertShadowWriteTargets({
        ...safe,
        cacheDir: join(safe.outputRoot, "cache"),
      }),
    ).rejects.toThrow("must be disjoint");
  });
});

function makePrepared(): PreparedAudit {
  const runtimeBinding = contract.sealRecord({
    contractVersion: "fixture-runtime-v1",
    bindingKind: "live-local-gemma-runtime",
    executionAllowed: true,
    shadowOnly: true,
    productionMutationAllowed: false,
    modelName: "fixture-gemma",
    configuredModel: structuredClone(FIXTURE_MODEL),
    model: { path: "C:/fixture/model.gguf", bytes: 1, sha256: "5".repeat(64) },
    mmproj: {
      path: "C:/fixture/mmproj.gguf",
      bytes: 1,
      sha256: "6".repeat(64),
    },
    serverRuntime: {
      path: "C:/fixture/server.exe",
      bytes: 1,
      sha256: "7".repeat(64),
    },
    chatTemplate: {
      path: "C:/fixture/template.jinja",
      bytes: 8,
      sha256: "8".repeat(64),
      revision: "fixture-template-revision",
    },
    launchArguments: [
      "-m",
      "C:/fixture/model.gguf",
      "--mmproj",
      "C:/fixture/mmproj.gguf",
      "-np",
      "1",
      "--no-cache-prompt",
    ],
  });
  return runner.prepareAuditPage({
    page: makePage(),
    modelName: "fixture-gemma",
    runtimeBinding,
  });
}

const FIXTURE_MODEL = {
  provider: "gemma",
  source: "huggingface",
  repo: "fixture/repo",
  file: "fixture.gguf",
  revision: "fixture-model-revision",
  expectedSha256: "5".repeat(64),
  mmproj: {
    repo: "fixture/mmproj-repo",
    file: "fixture-mmproj.gguf",
    revision: "fixture-mmproj-revision",
    expectedSha256: "6".repeat(64),
  },
  chatTemplate: {
    revision: "fixture-template-revision",
    expectedSha256: "8".repeat(64),
    expectedBytes: 8,
  },
};

function makeAuthoritativeInputs(page: AuditPage) {
  return {
    manifestSha256: "1".repeat(64),
    runReportSha256: "2".repeat(64),
    runConfigSha256: "3".repeat(64),
    ledgerSha256: "4".repeat(64),
    manifest: {
      model: structuredClone(FIXTURE_MODEL),
      evaluationRole: "development-only-not-holdout",
      holdoutEligible: false,
    },
    pages: [structuredClone(page)],
  };
}

function makePage(): AuditPage {
  const original = makeImage("original", Buffer.from("fixture-original"));
  const cleaned = makeImage("cleaned", Buffer.from("fixture-cleaned"));
  const blocks = [
    {
      blockId: "block-1",
      order: 0,
      sourceText: "原文一",
      translatedText: "번역 1",
      bbox1000: { x: 10, y: 20, w: 30, h: 40 },
      bboxSpace: "normalized_1000" as const,
      textRole: "ordinary",
    },
    {
      blockId: "block-2",
      order: 1,
      sourceText: "原文二",
      translatedText: "번역 2",
      bbox1000: { x: 50, y: 60, w: 20, h: 30 },
      bboxSpace: "normalized_1000" as const,
      textRole: "sound",
    },
  ];
  return {
    selectionIndex: 14,
    expectedClass: "clean",
    pageId: "fixture-page",
    workId: "fixture-work",
    chapterId: "fixture-chapter",
    originalPath: "C:/fixture/original.png",
    cleanedPath: "C:/fixture/cleaned.png",
    fontInputPath: "C:/fixture/font-input.json",
    original,
    cleaned,
    fontInputSha256: "a".repeat(64),
    blocks,
    orderedBlockIdsSha256: contract.sha256Canonical(
      blocks.map((block) => block.blockId),
    ),
    sourceRunStatus: "completed",
    sourceRunStatusSemantics: "legacy-execution-only",
  };
}

function makeImage(role: "original" | "cleaned", bytes: Buffer) {
  const digest = contract.sha256(bytes);
  return {
    role,
    mime: "image/png",
    sourceBytes: bytes.length,
    sourceSha256: digest,
    payloadBytes: bytes.length,
    payloadSha256: digest,
    width: 100,
    height: 200,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  };
}

function cleanPassResponse(passId: "known-block" | "unassigned-source") {
  const result =
    passId === "known-block"
      ? {
          status: "clean",
          reason: "clean_no_known_block_source_glyphs",
          evidenceBlockAliases: [],
        }
      : {
          status: "clean",
          reason: "clean_no_unassigned_source_glyphs",
          japaneseGlyphSnippet: "",
          region: "none",
          category: "none",
        };
  return {
    rawResponseText: '{"transport":"fixture"}',
    outputText: JSON.stringify(result),
    finishReason: "stop",
  };
}

function readImageUrl(part: Record<string, unknown>) {
  const imageUrl = part.image_url as Record<string, unknown>;
  return imageUrl.url;
}

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "gemma-cleanup-audit-"));
  temporaryRoots.push(root);
  return root;
}
