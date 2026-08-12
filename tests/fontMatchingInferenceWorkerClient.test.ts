import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { AutoMatchActiveCandidateSelection } from "../src/main/pipeline/autoMatchActiveCatalogTypes";
import type {
  FontMatchingPageInferencePort,
  FontMatchingPageInferenceRequest,
} from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import { USER_PAGE_FONT_MATCHING_BOUNDARY } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "../src/main/pipeline/fontMatchingPagePixelPreprocessing";
import type { FontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import type { FontMatchingWorkerInboundMessage } from "../src/main/pipeline/fontMatchingInferenceWorker";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import type { OverlayItem } from "../src/main/pipeline/types";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

/**
 * node:worker_threads 를 in-process EventEmitter 기반 FakeWorker 로 치환해
 * 워커 클라이언트의 init/infer/cancel 프로토콜과 폴백/abort 동작을 검증한다.
 * FakeWorker 는 실제 워커 스레드를 띄우지 않고 postMessage/emit("message") 로
 * 클라이언트의 메시지 핸드셰이크를 시뮬레이션한다. 정적 플래그로 스폰/init/infer
 * 실패 시나리오를 제어한다.
 */
const { FakeWorker } = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;
  class FakeWorker {
    static instances: FakeWorker[] = [];
    /** 다음 생성자 호출이 throw 하도록(스폰 실패 폴백 검증). */
    static failSpawn = false;
    /** 다음 init 을 init-error 로 응답(init 실패 폴백 검증). */
    static failNextInit = false;
    /**
     * 다음 init에서 ready/init-error 대신 error 또는 exit 이벤트로 워커가
     * 죽는다(runInit error/exit 미처리 시 Promise 영원히 pending → 90초 타임아웃
     * 조용히 삼켜짐 회귀 검증).
     */
    static crashBeforeInit: "error" | "exit" | null = null;
    /** infer 에 자동 응답하지 않음(abort 검증용 대기). */
    static holdInfer = false;
    public posted: FontMatchingWorkerInboundMessage[] = [];
    public terminateCount = 0;
    public readonly scriptPath: string;
    private listeners = new Map<string, Set<Listener>>();
    constructor(scriptPath: string) {
      this.scriptPath = scriptPath;
      if (FakeWorker.failSpawn) {
        FakeWorker.failSpawn = false;
        throw new Error("FakeWorker spawn failure.");
      }
      FakeWorker.instances.push(this);
    }
    on(event: string, listener: Listener): this {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
      return this;
    }
    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    emit(event: string, payload: unknown): boolean {
      const set = this.listeners.get(event);
      if (!set) return false;
      for (const listener of set) listener(payload);
      return true;
    }
    postMessage(data: FontMatchingWorkerInboundMessage): void {
      this.posted.push(data);
      if (data.type === "init") {
        const id = data.id;
        const fail = FakeWorker.failNextInit;
        const crash = FakeWorker.crashBeforeInit;
        FakeWorker.failNextInit = false;
        FakeWorker.crashBeforeInit = null;
        queueMicrotask(() => {
          if (crash === "error") {
            this.emit("error", new Error("worker died before ready"));
          } else if (crash === "exit") {
            this.emit("exit", 1);
          } else if (fail) {
            this.emit("message", {
              type: "init-error",
              id,
              error: { name: "Error", message: "boom" },
            });
          } else {
            this.emit("message", { type: "ready", id, status: readyStatus() });
          }
        });
      } else if (data.type === "infer" && !FakeWorker.holdInfer) {
        const id = data.id;
        queueMicrotask(() =>
          this.emit("message", {
            type: "infer-done",
            id,
            ok: true as const,
            result: new Map(),
          }),
        );
      }
    }
    async terminate(): Promise<void> {
      this.terminateCount += 1;
    }
  }
  function readyStatus(): FontMatchingRuntimeArtifactStatus {
    return {
      state: "ready",
      automaticMutationAllowed: true,
      semanticBootstrapAllowed: false,
      modelVersion: "font-matching-runtime-v1-toy",
      catalogVersion: "active-catalog-toy",
      candidateIds: ["dohyeon", "jua", "gaegu"],
      candidateOrderSha256: "a".repeat(64),
      calibration: { temperature: 1, noneThreshold: 0.5 },
      policy: {
        automaticMutation: {
          minimumAutomaticConfidence: 0.86,
          minimumRoleConfidence: 0.82,
          minimumIntentionalOverrideConfidence: 0.86,
          intentionalOverrideMinimumScoreMargin: 0.1,
        },
        chapterPrior: {
          maximumScoreContribution: 0.06,
          minimumAnchorEvidenceCount: 2,
          localOverrideMinimumScoreMargin: 0.1,
        },
      },
    };
  }
  return { FakeWorker };
});

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

const { createWorkerFontMatchingPageInferencePort } =
  await import("../src/main/pipeline/fontMatchingInferenceWorkerClient");

afterEach(() => {
  FakeWorker.instances.length = 0;
  FakeWorker.failSpawn = false;
  FakeWorker.failNextInit = false;
  FakeWorker.crashBeforeInit = null;
  FakeWorker.holdInfer = false;
});

const PATHS: Pick<AppPaths, "dataRoot" | "runtimeDir"> = {
  runtimeDir: "/fake/runtime",
  dataRoot: "/fake/data",
};

function candidates(): AutomaticFontCandidate[] {
  return ["dohyeon", "jua", "gaegu"].map((fontId, index) =>
    makeAutomaticFontCandidate({
      fontId,
      source: "built-in",
      unicodeRanges: [[0, 0x10ffff]],
      preferenceRank: index,
      defaultFont: index === 0,
      serif: index % 2 === 0,
      weight: 100 + index * 100,
      width: 1 + index,
    }),
  );
}

function selection(): Pick<
  AutoMatchActiveCandidateSelection,
  "candidates" | "installedCandidates"
> {
  return {
    candidates: candidates(),
    installedCandidates: [],
  };
}

function makeRaster(): FontMatchingRasterPage {
  const width = 100;
  const height = 100;
  const bgra = new Uint8Array(width * height * 4).fill(255);
  return { width, height, bgra };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function makeItem(): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: "sound",
    fontRole: "sfx_impact",
    fontRoleConfidence: 0.98,
    bbox: { x: 10, y: 10, w: 80, h: 80 },
    jp: "ドン",
    ko: "쾅",
    confidence: 1,
  };
}

function makeRequest(
  overrides: Partial<FontMatchingPageInferenceRequest> = {},
): FontMatchingPageInferenceRequest {
  return {
    page: makePage(),
    blocks: [{ blockId: "block-1", item: makeItem() }],
    candidates: candidates(),
    targetLanguage: "ko",
    boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
    ...overrides,
  };
}

type PortOverrides = {
  resolveWorkerScript?: () => string;
  loadRaster?: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
  resolveWasmAssets?: () => Promise<{
    wasmBinaryPath: string;
    wasmModulePath: string;
  }>;
  createFallbackPort?: () => FontMatchingPageInferencePort;
  reportWarning?: (message: string, detail: unknown) => void;
};

function makePort(
  overrides: PortOverrides = {},
): FontMatchingPageInferencePort {
  return createWorkerFontMatchingPageInferencePort({
    paths: PATHS,
    loadSelection: () => selection(),
    resolveWorkerScript:
      overrides.resolveWorkerScript ?? (() => "/fake/worker.js"),
    loadRaster: overrides.loadRaster ?? (async () => makeRaster()),
    resolveWasmAssets:
      overrides.resolveWasmAssets ??
      (async () => ({
        wasmBinaryPath: "/fake.wasm",
        wasmModulePath: "/fake.mjs",
      })),
    createFallbackPort: overrides.createFallbackPort,
    reportWarning: overrides.reportWarning,
  });
}

describe("font matching worker client protocol", () => {
  it("runs init handshake then returns the worker inference result", async () => {
    const port = makePort();
    const result = await port.inferPage(makeRequest());

    const worker = FakeWorker.instances[0];
    expect(worker).toBeDefined();
    expect(worker.scriptPath).toBe("/fake/worker.js");

    const types = worker.posted.map((msg) => msg.type);
    expect(types[0]).toBe("init");
    expect(types).toContain("infer");

    expect(result.runtimeArtifactStatus?.state).toBe("ready");
    expect(result.pixelInferenceByBlockId).toBeInstanceOf(Map);
  });

  it("transfers the decoded raster buffer to the worker", async () => {
    const raster = makeRaster();
    const loadRaster = vi.fn(async () => raster);
    const port = makePort({ loadRaster });
    const sourceGeometryDirection = {
      contractVersion: "font-matching-ocr-geometry-direction-v2" as const,
      source: "semantic_ocr_candidate_bbox_majority" as const,
      direction: "vertical" as const,
      candidateIds: [1],
      candidateMembership: {
        contractVersion: "font-matching-ocr-candidate-membership-v2" as const,
        source: "sealed_font_input_request_block_v2" as const,
        bindingId: "block-1",
        originalCandidateIds: [1],
        voterCandidateIds: [1],
      },
    };
    await port.inferPage(
      makeRequest({
        blocks: [
          {
            blockId: "block-1",
            item: makeItem(),
            sourceCandidateMembership:
              sourceGeometryDirection.candidateMembership,
            sourceGeometryDirection,
          },
        ],
      }),
    );

    const worker = FakeWorker.instances[0];
    const inferMsg = worker.posted.find((msg) => msg.type === "infer");
    if (!inferMsg || inferMsg.type !== "infer") {
      throw new Error("infer message was not posted");
    }
    expect(inferMsg.raster.width).toBe(100);
    expect(inferMsg.raster.height).toBe(100);
    // 메인에서 디코드한 raster 버퍼가 그대로 전달된다.
    expect(inferMsg.raster.bgra).toBe(raster.bgra);
    expect(inferMsg.blocks[0]?.sourceGeometryDirection).toEqual(
      sourceGeometryDirection,
    );
    expect(inferMsg.blocks[0]?.sourceCandidateMembership).toEqual(
      sourceGeometryDirection.candidateMembership,
    );
    expect(loadRaster).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending infer and posts cancel to the worker", async () => {
    FakeWorker.holdInfer = true;
    const controller = new AbortController();
    const port = makePort();
    const pending = port.inferPage(makeRequest({ signal: controller.signal }));

    // 클라이언트가 워커에 infer 메시지를 보낼 때까지 대기.
    await vi.waitFor(() => {
      const worker = FakeWorker.instances[0];
      expect(worker).toBeDefined();
      expect(worker.posted.some((msg) => msg.type === "infer")).toBe(true);
    });

    controller.abort();

    await expect(pending).rejects.toThrow("Aborted");
    const worker = FakeWorker.instances[0];
    expect(worker.posted.some((msg) => msg.type === "cancel")).toBe(true);
  });

  it("returns an empty result without spawning a worker for non-Korean targets", async () => {
    const port = makePort();
    const result = await port.inferPage(makeRequest({ targetLanguage: "en" }));

    expect(FakeWorker.instances.length).toBe(0);
    expect(result.pixelInferenceByBlockId.size).toBe(0);
    expect(result.runtimeArtifactStatus).toBeUndefined();
  });

  it("falls back to the in-process port when worker spawn fails", async () => {
    FakeWorker.failSpawn = true;
    const fallback = vi.fn(
      (): FontMatchingPageInferencePort => ({
        inferPage: async (request) => ({
          pixelInferenceByBlockId: new Map([
            [request.blocks[0]?.blockId ?? "x", {} as never],
          ]),
        }),
      }),
    );
    const reportWarning = vi.fn();
    const port = makePort({ createFallbackPort: fallback, reportWarning });

    const result = await port.inferPage(makeRequest());

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.pixelInferenceByBlockId.size).toBe(1);
    expect(reportWarning).toHaveBeenCalledTimes(1);
  });

  it("falls back to the in-process port when worker init fails", async () => {
    FakeWorker.failNextInit = true;
    const fallbackInfer = vi.fn(
      async (request: FontMatchingPageInferenceRequest) => ({
        pixelInferenceByBlockId: new Map([
          [request.blocks[0]?.blockId ?? "x", {} as never],
        ]),
      }),
    );
    const fallback = vi.fn(
      (): FontMatchingPageInferencePort => ({
        inferPage: fallbackInfer,
      }),
    );
    const reportWarning = vi.fn();
    const port = makePort({ createFallbackPort: fallback, reportWarning });

    const result = await port.inferPage(makeRequest());

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.pixelInferenceByBlockId.size).toBe(1);
    expect(reportWarning).toHaveBeenCalledTimes(1);
    // 이후 호출은 영구 폴백 — 워커를 다시 스폰하지 않고 캐시된 폴백 포트를 재사용.
    FakeWorker.failNextInit = false;
    await port.inferPage(makeRequest());
    expect(fallbackInfer).toHaveBeenCalledTimes(2);
    expect(FakeWorker.instances.length).toBe(1);
  });

  it.each(["error", "exit"] as const)(
    "falls back to the in-process port when the worker %ss before init completes (no 90s hang)",
    async (crash) => {
      FakeWorker.crashBeforeInit = crash;
      const fallbackInfer = vi.fn(
        async (request: FontMatchingPageInferenceRequest) => ({
          pixelInferenceByBlockId: new Map([
            [request.blocks[0]?.blockId ?? "x", {} as never],
          ]),
        }),
      );
      const fallback = vi.fn(
        (): FontMatchingPageInferencePort => ({
          inferPage: fallbackInfer,
        }),
      );
      const reportWarning = vi.fn();
      const port = makePort({ createFallbackPort: fallback, reportWarning });

      // runInit 가 error/exit 를 reject 로 처리하지 않으면 이 await 는
      // 영원히 pending → 페이지 단계 90초 타임아웃까지 걸리고 그 에러마저
      // 조용히 삼켜져 "폰트 맞춤 조용히 미적용" 증상이 된다.
      const result = await port.inferPage(makeRequest());

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(result.pixelInferenceByBlockId.size).toBe(1);
      expect(reportWarning).toHaveBeenCalled();
    },
  );

  it("reports a catalog mismatch as a disabled empty result", async () => {
    const port = makePort();
    const mismatchedCandidates: AutomaticFontCandidate[] = [
      ...candidates(),
      makeAutomaticFontCandidate({
        fontId: "extra-font",
        source: "built-in",
        unicodeRanges: [[0, 0x10ffff]],
        preferenceRank: 99,
        defaultFont: false,
      }),
    ];
    const result = await port.inferPage(
      makeRequest({ candidates: mismatchedCandidates }),
    );

    expect(result.runtimeArtifactStatus?.state).toBe("disabled");
    expect(result.pixelInferenceByBlockId.size).toBe(0);
  });
});
