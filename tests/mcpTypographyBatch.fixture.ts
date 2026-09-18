import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { vi } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import {
  builtIn,
  makeProfile,
} from "./helpers/automaticFontMatchingV2Fixtures";
import { McpPageBatchService } from "../src/main/application/mcpPageBatchService";
import {
  createMcpTypographyBatchPolicy,
  assertTypographyEvidence,
  type TypographySnapshotRequest,
  type TypographyPlanningPorts,
} from "../src/main/application/mcpTypographyBatchPolicy";
import type { BatchPorts } from "../src/main/application/mcpPageBatchTypes";
import { projectMcpTypographyApplication } from "../src/main/mcp/mcpTypographyApplyProjection";
import { McpTypographyBatchPreviewSchema } from "../src/shared/mcpTypographyBatch";
import { McpTypographyAnalysisObservationSchema } from "../src/shared/mcpTypographyAnalysis";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { mcpBatchMembership } from "../src/main/application/mcpPageBatchPolicy";

export function typographyBatchFixture() {
  const f = translationBatchFixture();
  let time = 1000;
  const candidates = [builtIn("jua"), builtIn("dohyeon")];
  const environment = {
    snapshot: "a".repeat(16),
    fontIds: new Set(["jua", "dohyeon"]),
    candidates,
    profile: makeProfile({ workId: f.saved.workId }),
  };
  const evidence = () =>
    McpTypographyAnalysisObservationSchema.parse({
      expiresAt: time + 1800000,
      workId: f.saved.workId,
      membership: mcpBatchMembership(f.chapter),
      contextRevision: mcpContextRevision(f.saved),
      inputSnapshot: "a".repeat(16),
      catalogSnapshot: "a".repeat(16),
      environmentSnapshot: environment.snapshot,
      mode: "font-and-size",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      preserveManualFontSize: false,
      pages: f.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        sourceImageSha256: "a".repeat(64),
        items: page.blocks.map((block) => ({
          blockId: block.id,
          font: {
            fontId: "jua",
            fontWeight: 400,
            italic: false,
            runtimeVersion: "c23.0",
            groupId: "test-source-group",
          },
          estimate: {
            facePx: 25.83,
            confidence: 0.9,
            method: "raster-core-v1",
          },
          fontExclusion: null,
          sizeExclusion: null,
        })),
      })),
      notes: [],
    });
  let observation = evidence();
  const prepare = vi.fn<TypographyPlanningPorts["prepare"]>(
    async (saved, input, access) => {
      access.guard();
      return {
        observation: structuredClone(observation),
        project: (page, block, item, edit) =>
          projectMcpTypographyApplication(
            page,
            block,
            item,
            edit,
            input.preserveManualFontSize,
            { workId: saved.workId, chapterId: input.chapterId },
            environment,
          ),
      };
    },
  );
  const validateRuntime = vi.fn(
    async (_request: TypographySnapshotRequest) => {},
  );
  const commits: TypographySnapshotRequest[] = [];
  const ports: BatchPorts<TypographySnapshotRequest> = {
    read: f.read,
    reportError: f.ports.reportError,
    commit: async (request, expected, guard, committed) => {
      commits.push(structuredClone(request));
      await f.edits.commitTypographyBatch(
        request,
        expected.membership,
        guard,
        committed,
        async (run) => {
          guard();
          if (request.direction !== "undo") {
            assertTypographyEvidence(
              f.saved,
              request.observation,
              request.dependencies,
            );
            await validateRuntime(request); // Explicit external boundary, not production file validation.
            guard();
          }
          return run();
        },
      );
    },
  };
  const policy = createMcpTypographyBatchPolicy({ prepare }, () => time);
  const service = new McpPageBatchService(
    ports,
    policy,
    () => time,
    f.lifetime.signal,
  );
  const request = () =>
    McpTypographyBatchPreviewSchema.parse({
      chapterId: f.chapter.id,
      contextRevision: mcpContextRevision(f.saved),
      analysisJobId: randomUUID(),
      requestId: randomUUID(),
      reason: "Use owned C23 evidence on explicit dialogue blocks",
      pages: f.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          {
            blockId: "a",
            mode: "font-and-size",
            reason: "Match only font and source-size intent",
          },
        ],
      })),
    });
  const inspect = (batchId: string) =>
    service.inspect(f.owner, { batchId }, f.guard);
  const done = async (batchId: string) => {
    for (let i = 0; i < 100; i++) {
      await tick();
      const result = await inspect(batchId);
      if (result.status !== "running") return result;
    }
    throw new Error("Typography action did not settle");
  };
  return {
    ...f,
    environment,
    prepare,
    ports,
    policy,
    service,
    request,
    inspect,
    done,
    validateRuntime,
    commits,
    refreshEvidence: () => {
      observation = evidence();
    },
    setEvidence: (value: typeof observation) => {
      observation = value;
    },
    evidence: () => structuredClone(observation),
    advance: (ms: number) => {
      time += ms;
    },
    start: (
      batchId: string,
      direction: "apply" | "undo" | "redo",
      requestId = randomUUID(),
    ) => service.start(f.owner, { batchId, requestId }, direction, f.guard),
    close: async () => {
      await service.close();
      await f.service.close();
    },
  };
}
