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
const { clearGroupOnlyPageReviewCache, requestGroupOnlyPageReview } =
  require("../src/main/runtime/transport/group-only-review-request.cjs") as {
    clearGroupOnlyPageReviewCache: () => void;
    requestGroupOnlyPageReview: (
      server: JsonRecord & { baseUrl: string },
      options: JsonRecord & { ocrBboxHints: JsonRecord[] },
      ocr: { hints: unknown[]; diagnostics: unknown[] },
    ) => Promise<unknown>;
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
      fixedBlockCandidateIds: [[1, 2]],
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
            groupCandidateIds: [[1, 2]],
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

  it("omits one persistently invalid block instead of failing its whole page", async () => {
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
      items: Array<{ ko: string; candidateIds: number[] }>;
    };

    expect(bodies.filter(isFixedTranslation)).toHaveLength(4);
    expect(output.items).toEqual([
      expect.objectContaining({
        ko: "살아남는 번역",
        candidateIds: [1],
      }),
    ]);
    expect(result.requestBody).toMatchObject({
      fixedBlockRepairAttempts: 3,
      fixedBlockOmittedIds: ["B002"],
    });
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
        hint(1, 100, 100, 150, 260, "右列", "B001"),
        hint(2, 140, 100, 190, 260, "左列", "B002"),
      ],
      imagePath,
      outputDir,
      imageWidth: 1000,
      imageHeight: 1000,
      maxTokens: 1024,
      temperature: 0.2,
      topP: 0.95,
      topK: 64,
      translationAttempt: 1,
      disableUnused49LogitBias: true,
    },
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
