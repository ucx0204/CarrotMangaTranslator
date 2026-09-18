import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";
import {
  publicMcpJobResult,
  persistedMcpJobResult,
} from "../src/main/application/mcpJobJournal";
import {
  McpSelectionOcrSchema,
  McpSelectionTranslationSchema,
} from "../src/shared/mcpSelectionAnalysis";

it("expires public selection references and strips transient evidence from durable receipts", () => {
  const result = {
    kind: "selection-analysis",
    pagesChanged: 0,
    selectionAnalysis: {
      analysisId: randomUUID(),
      expiresAt: 2000,
      total: 2,
      kind: "ocr",
    },
  };
  expect(publicMcpJobResult(result, 1999)?.selectionAnalysis).toBeDefined();
  expect(publicMcpJobResult(result, 2000)).toEqual({
    kind: "selection-analysis",
    pagesChanged: 0,
    observationExpired: true,
  });
  expect(persistedMcpJobResult(result)).toEqual({
    kind: "selection-analysis",
    pagesChanged: 0,
    observationExpired: true,
  });
});

it("restores completed receipts without a model rerun or a resurrected analysis", async () => {
  const f = await selectionAppFixture();
  try {
    const input = await f.translationInput();
    const { job } = await f.run("carrot_run_selection_translation", input);
    expect(job.status).toBe("completed");
    await f.operations.close();
    const { McpOperationService } =
      await import("../src/main/application/mcpOperationService");
    const restored = new McpOperationService(vi.fn(), Date.now, f.persistence);
    try {
      await restored.ready();
      const receipt = restored.status(job.jobId, f.owner);
      expect(receipt.status).toBe("completed");
      expect(receipt.result?.selectionAnalysis).toBeUndefined();
      expect(receipt.result?.observationExpired).toBe(true);
      expect(f.request).toHaveBeenCalledTimes(2);
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

it("keeps incomplete selection retries explicit and does not use the single-page retry route", async () => {
  const f = await selectionAppFixture();
  try {
    const input = await f.ocrInput();
    const { job } = await f.run("carrot_run_selection_ocr", {
      ...input,
      allowAssetDownloads: false,
    });
    expect(job.status).toBe("failed");
    expect(() =>
      f.operations.retryTarget(job.jobId, f.owner, input.pages[0].revision),
    ).toThrow("single-page retry");
    expect(f.collect).not.toHaveBeenCalled();
    expect(() =>
      McpSelectionOcrSchema.parse({ ...input, pages: [] }),
    ).toThrow();
    expect(() =>
      McpSelectionOcrSchema.parse({ ...input, sourceLanguage: "bad code!" }),
    ).toThrow();
    expect(() =>
      McpSelectionTranslationSchema.parse({
        ...input,
        expectedEngine: "arbitrary",
        pages: [],
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it("registers selected analysis in the actual app composition and obeys processing preferences", async () => {
  const f = await selectionAppFixture();
  const { createMcpPageOperationSession } =
    await import("../src/main/mcp/mcpPageOperationSession");
  try {
    for (const allowProcessing of [false, true]) {
      const appSession = createMcpPageOperationSession({
        app: f.app,
        origin: "https://composition.test",
        preferences: {
          allowImages: false,
          allowEditing: false,
          allowProcessing,
          autoStart: false,
        },
        editing: {
          assertWritable: async () => {},
          assertClean: async () => {},
          notifySaved: vi.fn(),
        },
        reportError: vi.fn(),
      });
      try {
        await appSession.ready();
        const names = appSession.tools.map((tool) => tool.name);
        expect(names).toContain("carrot_get_selection_analysis");
        expect(names.includes("carrot_run_selection_ocr")).toBe(
          allowProcessing,
        );
        expect(names.includes("carrot_run_selection_translation")).toBe(
          allowProcessing,
        );
        expect(new Set(names).size).toBe(names.length);
      } finally {
        await appSession.close();
      }
    }
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
