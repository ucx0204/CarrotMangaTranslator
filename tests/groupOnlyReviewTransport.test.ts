import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTempDir,
  requestTranslation,
} from "./helpers/runtimeModelContracts";

type JsonRecord = Record<string, unknown>;
type RequestBody = JsonRecord & {
  messages?: Array<{
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      image_url?: { url?: string };
    }>;
  }>;
};

const electronModulePath = require.resolve("electron");
const originalElectronModule = require.cache[electronModulePath];
const {
  buildPageReviewFingerprint,
  clearGroupOnlyPageReviewCache,
  requestGroupOnlyPageReview,
} = require("../src/main/runtime/transport/group-only-review-request.cjs") as {
  buildPageReviewFingerprint: (
    server: JsonRecord & { baseUrl: string },
    options: JsonRecord & { ocrBboxHints: JsonRecord[] },
  ) => string;
  clearGroupOnlyPageReviewCache: () => void;
  requestGroupOnlyPageReview: (
    server: JsonRecord & { baseUrl: string },
    options: JsonRecord & { ocrBboxHints: JsonRecord[] },
    ocr: { hints: unknown[]; diagnostics: unknown[] },
  ) => Promise<unknown>;
};
const { deleteCachedPageReview, getOrCreateCachedPageReview } =
  require("../src/main/runtime/transport/group-only-review-cache.cjs") as {
    deleteCachedPageReview: (
      key: string,
      expected: Promise<unknown>,
    ) => boolean;
    getOrCreateCachedPageReview: <T>(
      server: JsonRecord & { baseUrl: string },
      options: JsonRecord & { ocrBboxHints: JsonRecord[] },
      create: () => Promise<T>,
    ) => {
      key: string;
      cacheHit: boolean;
      promise: Promise<T>;
    };
  };
const { buildReviewCropImageOptions } =
  require("../src/main/runtime/transport/group-only-review-image-options.cjs") as {
    buildReviewCropImageOptions: (original: JsonRecord) => JsonRecord;
  };

beforeEach(() => {
  clearGroupOnlyPageReviewCache();
  installCropCapableElectron();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearGroupOnlyPageReviewCache();
  if (originalElectronModule) {
    require.cache[electronModulePath] = originalElectronModule;
  } else {
    delete require.cache[electronModulePath];
  }
});

describe("axis-v4 group-only review transport", () => {
  it("forwards only ffmpeg-hydrated WebP PNG data to crop preparation", () => {
    const dataUrl = "data:image/png;base64,d2VicA==";
    expect(
      buildReviewCropImageOptions({
        role: "original",
        path: "legacy.webp",
        dataUrl,
        convertedFromMime: "image/webp",
      }),
    ).toEqual({
      imagePath: "legacy.webp",
      sourceImageDataUrl: dataUrl,
    });
    expect(
      buildReviewCropImageOptions({
        role: "original",
        path: "normal.png",
        dataUrl,
        convertedFromMime: null,
      }),
    ).toEqual({ imagePath: "normal.png" });
  });

  it("reviews four staggered columns in one crop and emits one final block", async () => {
    const request = makeStaggeredRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({
              labels: Array.from({ length: 4 }, () => ({
                group: 1,
                role: "body",
              })),
            });
      }),
    );

    const result = await requestTranslation(request.server, request.options);

    expect(bodies).toHaveLength(2);
    expect(readUserText(bodies[0])).toContain("candidateOrder=[1,2,3,4]");
    expect(result.requestBody).toMatchObject({
      semanticGroupReviewRequestVersion: 5,
      semanticGroupReviewCropPlanVersion: 2,
      semanticGroupReviewRegionCount: 1,
      semanticGroupReviewRequestCount: 1,
      semanticGroupReviewSingletonSkipCount: 0,
      fixedBlockCandidateIds: [[1, 2, 3, 4]],
      fixedBlockDirectionVoterCandidateIds: [[1, 2, 3, 4]],
    });
  });

  it("keeps nearby columns from separate balloons in separate final groups", async () => {
    const request = makeStaggeredRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({
              labels: [
                { group: 1, role: "body" },
                { group: 1, role: "body" },
                { group: 2, role: "body" },
                { group: 2, role: "body" },
              ],
            });
      }),
    );

    const result = await requestTranslation(request.server, request.options);

    expect(bodies).toHaveLength(2);
    expect(result.requestBody).toMatchObject({
      semanticGroupReviewStatus: "reviewed",
      semanticGroupReviewRegionCount: 1,
      fixedBlockCandidateIds: [
        [1, 2],
        [3, 4],
      ],
      fixedBlockDirectionVoterCandidateIds: [
        [1, 2],
        [3, 4],
      ],
    });
  });

  it("keeps the original staggered fragments when context review fails", async () => {
    const request = makeStaggeredRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({ labels: [{ group: 1, role: "body" }] });
      }),
    );

    const result = await requestTranslation(request.server, request.options);

    expect(bodies).toHaveLength(2);
    expect(result.requestBody).toMatchObject({
      semanticGroupReviewStatus: "upstream-fallback",
      semanticGroupReviewFallbackCount: 1,
      fixedBlockCandidateIds: [[1, 2], [3], [4]],
      fixedBlockDirectionVoterCandidateIds: [[1, 2], [3], [4]],
    });
  });

  it("reviews crops, skips old split/merge audits, then translates immutable blocks", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({
              labels: [
                { group: 1, role: "body" },
                { group: 1, role: "body" },
              ],
            });
      }),
    );

    const result = await requestTranslation(request.server, request.options);

    expect(bodies).toHaveLength(2);
    expect(readUserText(bodies[0])).toContain("candidateOrder=[1,2]");
    expect(readUserText(bodies[0])).not.toContain("edges=");
    expect(
      (bodies[0].response_format as { schema: { properties: JsonRecord } })
        .schema.properties,
    ).toEqual({ labels: expect.any(Object) });
    expect(readPayload(bodies[1], "fixedBlocks")).toEqual([
      expect.objectContaining({
        blockId: "B001",
        jp: "右列左列",
      }),
    ]);
    expect(result.requestBody).toMatchObject({
      semanticGroupReviewStatus: "reviewed",
      semanticGroupReviewRegionCount: 1,
      semanticGroupReviewRequestCount: 1,
      semanticGroupReviewFallbackCount: 0,
      semanticGroupReviewCacheHit: false,
      fixedBlockCandidateIds: [[2, 1]],
      fixedBlockDirectionVoterCandidateIds: [[2, 1]],
    });
    expect(result.requestBody).not.toHaveProperty("semanticSplitAuditStatus");
    expect(result.requestBody).not.toHaveProperty("semanticMergeAuditStatus");
    expect(result.rawResponse).toMatchObject({
      semanticGroupReviewStatus: "reviewed",
      groupingReview: {
        status: "reviewed",
        crops: [
          {
            status: "reviewed",
            groupCandidateIds: [[2, 1]],
          },
        ],
      },
      translation: expect.any(Object),
    });
  });

  it("reuses the same image/hints/model review across translation retries", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({
              labels: [
                { group: 1, role: "body" },
                { group: 1, role: "body" },
              ],
            });
      }),
    );

    await requestTranslation(request.server, request.options);
    const retried = await requestTranslation(request.server, {
      ...request.options,
      translationAttempt: 2,
    });

    expect(bodies.filter((body) => !isFixedTranslation(body))).toHaveLength(1);
    expect(bodies.filter(isFixedTranslation)).toHaveLength(2);
    expect(retried.requestBody).toMatchObject({
      semanticGroupReviewCacheHit: true,
      semanticGroupReviewStatus: "reviewed",
    });
  });

  it("includes review context metadata in the page review cache identity", () => {
    const request = makeStaggeredRequest();
    const first = buildPageReviewFingerprint(request.server, request.options);
    const second = buildPageReviewFingerprint(request.server, {
      ...request.options,
      ocrBboxHints: request.options.ocrBboxHints.map((item) => ({
        ...item,
        reviewContextId: "RC002",
      })),
    });

    expect(second).not.toBe(first);
  });

  it("includes inferred review roles in the page review cache identity", () => {
    const request = makeStaggeredRequest();
    const first = buildPageReviewFingerprint(request.server, request.options);
    const withReviewRole = buildPageReviewFingerprint(request.server, {
      ...request.options,
      ocrBboxHints: request.options.ocrBboxHints.map((item, index) => ({
        ...item,
        reviewRole: index === 0 ? "ruby" : "body",
      })),
    });
    const withLegacyRole = buildPageReviewFingerprint(request.server, {
      ...request.options,
      ocrBboxHints: request.options.ocrBboxHints.map((item, index) => ({
        ...item,
        role: index === 0 ? "ruby" : "body",
      })),
    });

    expect(withReviewRole).not.toBe(first);
    expect(withLegacyRole).not.toBe(first);
    expect(withLegacyRole).not.toBe(withReviewRole);
  });

  it("includes request-body settings in the page review cache identity", () => {
    const request = makeStaggeredRequest();
    const first = buildPageReviewFingerprint(request.server, request.options);
    const withTokenLimit = buildPageReviewFingerprint(request.server, {
      ...request.options,
      maxTokens: Number(request.options.maxTokens) + 1024,
    });
    const withSampling = buildPageReviewFingerprint(request.server, {
      ...request.options,
      temperature: 0.1,
    });

    expect(withTokenLimit).not.toBe(first);
    expect(withSampling).not.toBe(first);
  });

  it("coalesces concurrent page reviews onto the same pending promise", async () => {
    const request = makeRequest();
    const pending = createDeferred<JsonRecord>();
    let createCount = 0;
    const create = () => {
      createCount += 1;
      return pending.promise;
    };

    const first = getOrCreateCachedPageReview(
      request.server,
      request.options,
      create,
    );
    const second = getOrCreateCachedPageReview(
      request.server,
      request.options,
      create,
    );

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.promise).toBe(first.promise);
    expect(createCount).toBe(1);

    pending.resolve({ status: "reviewed" });
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(
      [{ status: "reviewed" }, { status: "reviewed" }],
    );
  });

  it("evicts a rejected page review so the next attempt can retry", async () => {
    const request = makeRequest();
    let createCount = 0;
    const failed = getOrCreateCachedPageReview(
      request.server,
      request.options,
      () => {
        createCount += 1;
        return Promise.reject(new Error("review unavailable"));
      },
    );

    await expect(failed.promise).rejects.toThrow("review unavailable");

    const retried = getOrCreateCachedPageReview(
      request.server,
      request.options,
      async () => {
        createCount += 1;
        return { status: "reviewed" };
      },
    );

    expect(retried.cacheHit).toBe(false);
    expect(createCount).toBe(2);
    await expect(retried.promise).resolves.toEqual({ status: "reviewed" });
  });

  it("does not let a late aborted review evict its newer replacement", async () => {
    const request = makeRequest();
    const older = createDeferred<JsonRecord>();
    const newer = createDeferred<JsonRecord>();
    const first = getOrCreateCachedPageReview(
      request.server,
      request.options,
      () => older.promise,
    );

    expect(deleteCachedPageReview(first.key, first.promise)).toBe(true);
    const replacement = getOrCreateCachedPageReview(
      request.server,
      request.options,
      () => newer.promise,
    );
    older.reject(new DOMException("Aborted", "AbortError"));

    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(deleteCachedPageReview(first.key, first.promise)).toBe(false);

    let unexpectedCreateCount = 0;
    const joined = getOrCreateCachedPageReview(
      request.server,
      request.options,
      async () => {
        unexpectedCreateCount += 1;
        return { status: "unexpected" };
      },
    );

    expect(joined.cacheHit).toBe(true);
    expect(joined.promise).toBe(replacement.promise);
    expect(unexpectedCreateCount).toBe(0);

    newer.resolve({ status: "reviewed" });
    await expect(joined.promise).resolves.toEqual({ status: "reviewed" });
  });

  it("falls back to exact upstream fragments and still uses fixed translation", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse(fixedReply(body))
          : chatResponse({ labels: [{ group: 1, role: "body" }] });
      }),
    );

    const result = await requestTranslation(request.server, request.options);

    expect(bodies).toHaveLength(2);
    expect(readPayload<JsonRecord[]>(bodies[1], "fixedBlocks")).toHaveLength(2);
    expect(result.requestBody).toMatchObject({
      semanticGroupReviewStatus: "upstream-fallback",
      semanticGroupReviewFallbackCount: 1,
      fixedBlockCandidateIds: [[1], [2]],
      fixedBlockDirectionVoterCandidateIds: [[1], [2]],
    });
    expect(result.rawResponse).toMatchObject({
      groupingReview: {
        crops: [{ status: "fallback", usedFallback: true }],
      },
    });
  });

  it("propagates malformed internal review state instead of reporting fallback", async () => {
    const request = makeRequest();
    delete request.options.ocrBboxHints[0].reviewFragmentId;

    await expect(
      requestGroupOnlyPageReview(request.server, request.options, {
        hints: request.options.ocrBboxHints,
        diagnostics: [],
      }),
    ).rejects.toThrow(/missing reviewFragmentId/);
  });

  it("repairs only malformed block ids while preserving valid initial translations", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    let fixedRequestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        if (!isFixedTranslation(body)) {
          return chatResponse({ labels: [{ group: 1, role: "body" }] });
        }
        fixedRequestCount += 1;
        if (fixedRequestCount === 1) {
          return chatResponse({
            items: [
              { blockId: "B001", ko: "처음부터 정상" },
              { blockId: "B002", ko: "중복 하나" },
              { blockId: "B002", ko: "중복 둘" },
            ],
          });
        }
        return chatResponse(fixedReply(body));
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const fixedBodies = bodies.filter(isFixedTranslation);
    const output = JSON.parse(result.outputText) as {
      items: Array<{ ko: string }>;
    };

    expect(
      readPayload<JsonRecord[]>(fixedBodies[0], "fixedBlocks"),
    ).toHaveLength(2);
    expect(readPayload<JsonRecord[]>(fixedBodies[1], "fixedBlocks")).toEqual([
      expect.objectContaining({ blockId: "B002" }),
    ]);
    expect(output.items.map((item) => item.ko)).toEqual([
      "처음부터 정상",
      "번역 B002",
    ]);
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 1,
      fixedBlockRepairHistory: [
        {
          blockIds: ["B002"],
          remainingBlockIds: [],
        },
      ],
    });
  });

  it("preserves the exact page-3 translations and falls back only their invalid vertical advisories", async () => {
    const request = makePage3RegressionRequest();
    const bodies: RequestBody[] = [];
    let fixedRequestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        if (!isFixedTranslation(body)) {
          const candidateOrder = readPayload<number[]>(body, "candidateOrder");
          return chatResponse({
            labels: candidateOrder.map((_, index) => ({
              group: index + 1,
              role: "body",
            })),
          });
        }
        fixedRequestCount += 1;
        const requestedIds = new Set(
          readPayload<Array<{ blockId: string }>>(body, "fixedBlocks").map(
            (block) => block.blockId,
          ),
        );
        const exact = exactPage3RegressionReply();
        return chatResponse({
          items: exact.items.filter((item) => requestedIds.has(item.blockId)),
          ...(fixedRequestCount === 1
            ? { pageContext: exact.pageContext }
            : {}),
        });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const fixedBodies = bodies.filter(isFixedTranslation);
    const output = JSON.parse(result.outputText) as {
      items: Array<{
        ko: string;
        layoutIntent?: string;
        candidateIds: number[];
      }>;
      pageContext?: JsonRecord;
    };

    expect(fixedBodies).toHaveLength(4);
    expect(
      readPayload<JsonRecord[]>(fixedBodies[0], "fixedBlocks"),
    ).toHaveLength(10);
    for (const repairBody of fixedBodies.slice(1)) {
      expect(readPayload<JsonRecord[]>(repairBody, "fixedBlocks")).toHaveLength(
        9,
      );
      expect(readUserText(repairBody)).toContain(
        "correct the previous translation, layout advisory",
      );
    }
    expect(output.items).toHaveLength(10);
    expect(output.items.map((item) => item.ko)).toEqual(
      exactPage3RegressionReply().items.map((item) => item.ko),
    );
    expect(output.items.slice(0, 9)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateIds: expect.any(Array),
          layoutIntent: "horizontal",
        }),
      ]),
    );
    expect(
      output.items
        .slice(0, 9)
        .every((item) => item.layoutIntent === "horizontal"),
    ).toBe(true);
    expect(output.pageContext).toEqual(exactPage3RegressionReply().pageContext);
    expect(result.requestBody).toMatchObject({
      fixedBlockCount: 10,
      fixedBlockRepairAttempts: 3,
      fixedBlockHorizontalFallbackIds: [
        "B001",
        "B002",
        "B003",
        "B004",
        "B005",
        "B006",
        "B007",
        "B008",
        "B009",
      ],
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockOmittedIds");
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
  });

  it("preserves valid translation text with neutral audit-only font metadata after bounded repairs", async () => {
    const request = makeRequest();
    request.options.autoFontMatching = true;
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        if (!isFixedTranslation(body)) {
          return chatResponse({ labels: [{ group: 1, role: "body" }] });
        }
        const blocks = readPayload<Array<{ blockId: string }>>(
          body,
          "fixedBlocks",
        );
        return chatResponse({
          items: blocks.map((block) => ({
            blockId: block.blockId,
            textRole: "ordinary",
            layoutIntent: "horizontal",
            fontRole: block.blockId === "B002" ? "sfx_impact" : "dialogue",
            fontRoleConfidence: 0.96,
            ko: block.blockId === "B002" ? "정상 번역문" : "첫 번역문",
          })),
        });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const output = JSON.parse(result.outputText) as {
      items: Array<{
        blockId?: string;
        ko: string;
        fontRole?: string;
        fontRoleConfidence?: number;
      }>;
    };

    expect(bodies.filter(isFixedTranslation)).toHaveLength(4);
    expect(output.items[1]).toMatchObject({
      ko: "정상 번역문",
      fontRole: "unknown_needs_review",
      fontRoleConfidence: 0,
    });
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 3,
      fixedBlockFontIntentFallbackIds: ["B002"],
      fixedBlockRepairHistory: [
        {
          rejectionReasons: {
            B002: ["fixed-block-translation-font-role-conflict"],
          },
        },
        {
          rejectionReasons: {
            B002: ["fixed-block-translation-font-role-conflict"],
          },
        },
        {
          rejectionReasons: {
            B002: ["fixed-block-translation-font-role-conflict"],
          },
        },
      ],
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
  });

  it("normalizes target-side Japanese elongation only after bounded repairs", async () => {
    const request = makeRequest();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        if (!isFixedTranslation(body)) {
          return chatResponse({ labels: [{ group: 1, role: "body" }] });
        }
        const blocks = readPayload<Array<{ blockId: string }>>(
          body,
          "fixedBlocks",
        );
        return chatResponse({
          items: blocks.map((block) => ({
            blockId: block.blockId,
            ko: block.blockId === "B002" ? "무리예요ーー!!" : "첫 번역문",
          })),
        });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const output = JSON.parse(result.outputText) as {
      items: Array<{ ko: string }>;
    };

    expect(output.items.map((item) => item.ko)).toEqual([
      "첫 번역문",
      "무리예요~~!!",
    ]);
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 3,
      fixedBlockTargetTypographyFallbackIds: ["B002"],
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
  });

  it("keeps the last readable translation for review when source script remains after bounded repairs", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        if (!isFixedTranslation(body)) {
          return chatResponse({ labels: [{ group: 1, role: "body" }] });
        }
        const blocks = readPayload<Array<{ blockId: string }>>(
          body,
          "fixedBlocks",
        );
        return chatResponse({
          items: blocks.map((block) => ({
            blockId: block.blockId,
            ko:
              block.blockId === "B002"
                ? "메리나국에서 爪紅의 전매권을 원합니다"
                : "살아남는 번역",
          })),
        });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const output = JSON.parse(result.outputText) as {
      items: Array<{ ko: string }>;
    };

    expect(output.items.map((item) => item.ko)).toEqual([
      "살아남는 번역",
      "메리나국에서 爪紅의 전매권을 원합니다",
    ]);
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 3,
      fixedBlockSourceScriptFallbackIds: ["B002"],
      fixedBlockNeedsReviewIds: ["B002"],
      fixedBlockNeedsReviewReasons: {
        B002: ["fixed-block-translation-source-script-leak"],
      },
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
    expect(bodies.filter(isFixedTranslation)).toHaveLength(4);
  });

  it("preserves the immutable source for review when a malformed block has no readable translation", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        if (!isFixedTranslation(body)) {
          return chatResponse({ labels: [{ group: 1, role: "body" }] });
        }
        const blocks = readPayload<Array<{ blockId: string }>>(
          body,
          "fixedBlocks",
        );
        return chatResponse({
          items: blocks.map((block) => ({
            blockId: block.blockId,
            ko: block.blockId === "B001" ? "살아남는 번역" : "",
          })),
        });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const output = JSON.parse(result.outputText) as {
      items: Array<{ jp: string; ko: string }>;
    };

    expect(output.items[0]?.ko).toBe("살아남는 번역");
    expect(output.items[1]?.ko).toBe(output.items[1]?.jp);
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 3,
      fixedBlockSourceTextFallbackIds: ["B002"],
      fixedBlockNeedsReviewIds: ["B002"],
      fixedBlockNeedsReviewReasons: {
        B002: ["fixed-block-translation-empty-text"],
      },
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
    expect(bodies.filter(isFixedTranslation)).toHaveLength(4);
  });

  it("degrades an unreadable fixed-block response to reviewable source blocks instead of failing the page", async () => {
    const request = makeRequest();
    const bodies: RequestBody[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const body = postedBody(init);
        bodies.push(body);
        return isFixedTranslation(body)
          ? chatResponse("not a JSON object")
          : chatResponse({ labels: [{ group: 1, role: "body" }] });
      }),
    );

    const result = await requestTranslation(request.server, request.options);
    const output = JSON.parse(result.outputText) as {
      items: Array<{ jp: string; ko: string }>;
    };

    expect(output.items).toHaveLength(2);
    expect(output.items.every((item) => item.ko === item.jp)).toBe(true);
    expect(result.requestBody).toMatchObject({
      fixedBlockInitialResponseError: {
        code: "semantic-ocr-json-invalid",
      },
      fixedBlockRepairAttempts: 3,
      fixedBlockSourceTextFallbackIds: ["B001", "B002"],
      fixedBlockNeedsReviewIds: ["B001", "B002"],
    });
    expect(result.requestBody).not.toHaveProperty("fixedBlockUnresolvedIds");
    expect(bodies.filter(isFixedTranslation)).toHaveLength(4);
  });
});

function makeRequest() {
  const outputDir = createTempDir("group-only-review-transport-");
  const imagePath = join(outputDir, "page.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    server: { baseUrl: "http://127.0.0.1:18180/v1" },
    options: {
      modelProvider: "gemma",
      modelRepo: "test/gemma-4-26b",
      modelFile: "gemma-4-26b.gguf",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      ocrQualityMode: "full",
      ocrMergeMode: "semantic",
      ocrBboxHints: [
        hint(1, 100, 100, 150, 260, "左列", "B001"),
        hint(2, 140, 100, 190, 260, "右列", "B002"),
      ],
      imagePath,
      outputDir,
      imageWidth: 1000,
      imageHeight: 1000,
      maxTokens: 1024,
      autoFontMatching: false,
      temperature: 0.2,
      topP: 0.95,
      topK: 64,
      translationAttempt: 1,
      disableUnused49LogitBias: true,
    },
  };
}

function makeStaggeredRequest() {
  const request = makeRequest();
  request.options.ocrBboxHints = [
    staggeredHint(1, 700, 200, 732, 390, "右の本文", "B001", 1),
    staggeredHint(2, 660, 220, 692, 430, "中右本文", "B001", 2),
    staggeredHint(3, 620, 252, 652, 462, "中左本文", "B002", 1),
    staggeredHint(4, 580, 286, 612, 476, "左の本文", "B003", 1),
  ];
  return request;
}

function makePage3RegressionRequest() {
  const request = makeRequest();
  const sourceTexts = [
    "アルドリッジさん壇上へ。",
    "私の成績い知ってるでしょう!?",
    "ま待ってください！",
    "ですよね！？",
    "魔法もまともに使えないのに、足手まといになるだけですわ！？",
    "私もそう思ったんだけどね…",
    "指名…",
    "そんな感じなの！？",
    "されちゃったからねえ。",
    "切",
  ];
  Object.assign(request.options, {
    autoFontMatching: true,
    collectPageContext: true,
  });
  request.options.ocrBboxHints = sourceTexts.map((sourceText, index) => {
    const id = index + 1;
    const x1 = 40 + (index % 5) * 190;
    const y1 = 60 + Math.floor(index / 5) * 420;
    return hint(
      id,
      x1,
      y1,
      x1 + (index === 9 ? 140 : 50),
      y1 + (index === 9 ? 55 : 130),
      sourceText,
      `B${String(id).padStart(3, "0")}`,
    );
  });
  return request;
}

function exactPage3RegressionReply() {
  return {
    items: [
      {
        blockId: "B001",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "알드리치 씨, 단상으로.",
      },
      {
        blockId: "B002",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "제 성적 알고 계시잖아요!?",
      },
      {
        blockId: "B003",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "기, 기다려 주세요!",
      },
      {
        blockId: "B004",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "그렇죠!?",
      },
      {
        blockId: "B005",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "마법도 제대로 못 쓰면서, 방해만 될 뿐이잖아요!?",
      },
      {
        blockId: "B006",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "나도 그렇게 생각했지만 말이야...",
      },
      {
        blockId: "B007",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "thought",
        fontRoleConfidence: 1,
        ko: "지명...",
      },
      {
        blockId: "B008",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "shout",
        fontRoleConfidence: 1,
        ko: "그런 느낌이야!?",
      },
      {
        blockId: "B009",
        textRole: "ordinary",
        layoutIntent: "vertical",
        fontRole: "dialogue",
        fontRoleConfidence: 1,
        ko: "되어 버렸으니까 말이야.",
      },
      {
        blockId: "B010",
        textRole: "sound",
        layoutIntent: "horizontal",
        fontRole: "sfx_impact",
        fontRoleConfidence: 1,
        ko: "절",
        visualClusterId: "V001",
      },
    ],
    pageContext: {
      visualSummary:
        "학장이 영웅 지명을 선포하자 학생들이 술렁이고, 당황한 학생들 사이에서 긴장감이 흐르는 가운데 주인공이 상황을 살피는 장면입니다.",
      glossary: [],
      characters: [],
    },
  };
}

function staggeredHint(
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  ocrText: string,
  reviewFragmentId: string,
  reviewOrder: number,
): JsonRecord {
  return {
    ...hint(id, x1, y1, x2, y2, ocrText, reviewFragmentId),
    reviewOrder,
    reviewContextId: "RC001",
  };
}

function hint(
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  ocrText: string,
  reviewFragmentId: string,
): JsonRecord {
  return {
    id,
    label: "ocr_textline",
    x1,
    y1,
    x2,
    y2,
    ocrText,
    score: 0.99,
    groupId: `G00${id}`,
    orderInGroup: 1,
    groupSize: 1,
    semanticGroup: true,
    rolePrior: "ordinary_mergeable",
    containerType: "same_text_container",
    reviewFragmentId,
    reviewStatus: "confirmed",
    reviewReasons: [],
    reviewOrder: 1,
    paddleGroupId: `G00${id}`,
    paddleOrder: 1,
    paddleGroupSize: 1,
  };
}

function installCropCapableElectron(): void {
  const size = { width: 1000, height: 1000 };
  const crop = {
    isEmpty: () => false,
    getSize: () => size,
    crop: () => crop,
    toPNG: () => Buffer.from("clean-crop"),
  };
  require.cache[electronModulePath] = {
    id: electronModulePath,
    path: originalElectronModule?.path ?? "",
    exports: { nativeImage: { createFromPath: () => crop } },
    filename: electronModulePath,
    loaded: true,
    children: [],
    paths: originalElectronModule?.paths ?? [],
    parent: originalElectronModule?.parent ?? null,
    isPreloading: false,
    require: originalElectronModule?.require ?? require,
  } as NodeJS.Module;
}

function postedBody(init: RequestInit | undefined): RequestBody {
  return JSON.parse(String(init?.body ?? "{}")) as RequestBody;
}

function readUserText(body: RequestBody): string {
  return (
    body.messages?.find((message) => message.role === "user")?.content ?? []
  )
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

function readPayload<T = unknown>(body: RequestBody, key: string): T {
  const prefix = `${key}=`;
  const line = readUserText(body)
    .split(/\r?\n/)
    .find((text) => text.startsWith(prefix));
  if (!line) throw new Error(`Missing ${key}.`);
  return JSON.parse(line.slice(prefix.length)) as T;
}

function isFixedTranslation(body: RequestBody): boolean {
  return readUserText(body).includes("fixedBlocks=");
}

function fixedReply(body: RequestBody): JsonRecord {
  const blocks = readPayload<Array<{ blockId: string }>>(body, "fixedBlocks");
  return {
    items: blocks.map((block) => ({
      blockId: block.blockId,
      ko: `번역 ${block.blockId}`,
    })),
  };
}

function chatResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200 },
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
