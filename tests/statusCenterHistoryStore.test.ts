/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  loadStatusCenterHistory,
  saveStatusCenterHistory,
  STATUS_CENTER_HISTORY_LIMIT,
  type StatusCenterHistoryEntry,
} from "../src/renderer/src/lib/statusCenterHistoryStore";

const STORAGE_KEY = "mangaTranslator.statusCenter.history.v1";

afterEach(() => window.localStorage.clear());

describe("status center history persistence", () => {
  it("keeps a bounded structured summary and never persists free-form status text", () => {
    const entries: StatusCenterHistoryEntry[] = Array.from(
      { length: STATUS_CENTER_HISTORY_LIMIT + 3 },
      (_, index) => ({
        id: `operation-${index}`,
        source: "operation",
        kind: "library-import",
        status: index === 0 ? "failed" : "completed",
        completedAt: index + 1,
        failureCode: index === 0 ? "IMPORT_FAILED" : undefined,
        phase: "import-library-writing",
        sourceKind: "pdf",
        progressText: `private path C:/source/${index}.pdf`,
      }),
    );

    saveStatusCenterHistory(entries);
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    const restored = loadStatusCenterHistory();

    expect(restored).toHaveLength(STATUS_CENTER_HISTORY_LIMIT);
    expect(restored[0]).toMatchObject({
      id: "operation-0",
      failureCode: "IMPORT_FAILED",
      phase: "import-library-writing",
      sourceKind: "pdf",
    });
    expect(restored[0].progressText).toBeUndefined();
    expect(raw).not.toContain("private path");
  });

  it("restores operation detail keys and upgrades older web import rows", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "web-import-preview-request-1",
          source: "operation",
          kind: "web-import-preview",
          status: "completed",
          completedAt: 10,
        },
        {
          id: "web-import-prepare-operation-2",
          source: "operation",
          kind: "web-import-preview",
          status: "completed",
          completedAt: 11,
        },
      ]),
    );

    expect(loadStatusCenterHistory()).toEqual([
      expect.objectContaining({ phase: "web-discovering" }),
      expect.objectContaining({ phase: "web-preparing" }),
    ]);
  });

  it("drops unknown kinds, mismatched statuses, unsafe codes, and invalid totals", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "valid",
          source: "operation",
          kind: "model-test",
          status: "failed",
          completedAt: 10,
          failureCode: "MODEL_TEST_FAILED",
          pageTotal: 0,
        },
        {
          id: "unknown-kind",
          source: "operation",
          kind: "arbitrary-operation",
          status: "completed",
          completedAt: 11,
        },
        {
          id: "unsafe-code",
          source: "job",
          kind: "page-export",
          status: "failed",
          completedAt: 12,
          failureCode: "C:/private/path",
        },
      ]),
    );

    expect(loadStatusCenterHistory()).toEqual([
      {
        id: "valid",
        source: "operation",
        kind: "model-test",
        status: "failed",
        completedAt: 10,
        failureCode: "MODEL_TEST_FAILED",
      },
      {
        id: "unsafe-code",
        source: "job",
        kind: "page-export",
        status: "failed",
        completedAt: 12,
      },
    ]);
  });
});
