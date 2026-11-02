import { describe, expect, it } from "vitest";
import {
  completeWorkflowReceipt,
  failWorkflowReceipt,
} from "../src/main/application/pageWorkflowReceipts";
import { isPageFullyCompleted } from "../src/shared/pageCompletion";
import { resolveChapterStatus } from "../src/main/libraryStore/chapterRecords";
import { resolvePageDisplayStatus } from "../src/renderer/src/components/pageList/pageListStatus";
import { makePage } from "./helpers/workspacePointerFixtures";
const page = { ...makePage(), blocks: [] };
const receipt = { runId: "run", planKey: "plan", steps: {}, findings: [] };
describe("empty workflow translation completion", () => {
  it("marks a new empty translation complete and supports historical idle receipts in every status consumer", () => {
    const saved = completeWorkflowReceipt(receipt, page, page, "translate");
    expect(saved.analysisStatus).toBe("completed");
    expect(saved.pageWorkflow?.steps.translate?.status).toBe("empty");
    const legacy = { ...saved, analysisStatus: "idle" as const };
    expect(isPageFullyCompleted(legacy)).toBe(true);
    expect(resolveChapterStatus([legacy])).toBe("completed");
    expect(resolvePageDisplayStatus(legacy, "translation")).toBe("completed");
  });
  it.each(["detect", "ocr", "review"] as const)(
    "does not promote %s-only empty pages to translated",
    (stage) => {
      const saved = completeWorkflowReceipt(receipt, page, page, stage);
      expect(saved.analysisStatus).toBe("idle");
      expect(isPageFullyCompleted(saved)).toBe(false);
    },
  );
  it("does not let empty receipts mask failures, newly added blocks, or pending completion", () => {
    const saved = {
      ...completeWorkflowReceipt(receipt, page, page, "translate"),
      analysisStatus: "idle" as const,
    };
    expect(isPageFullyCompleted({ ...saved, blocks: makePage().blocks })).toBe(
      false,
    );
    expect(isPageFullyCompleted({ ...saved, analysisStatus: "failed" })).toBe(
      false,
    );
    expect(
      isPageFullyCompleted({
        ...saved,
        translationCompletion: { status: "pending" },
      }),
    ).toBe(false);
    expect(
      isPageFullyCompleted(
        failWorkflowReceipt(
          saved.pageWorkflow ?? receipt,
          saved,
          saved,
          "review",
          "failed",
        ),
      ),
    ).toBe(false);
    expect(isPageFullyCompleted(page)).toBe(false);
  });
});

it("does not mark a translated chapter complete before all selected stages finish", () => {
  const planned = {
    ...receipt,
    stages: ["translate", "erase", "review"] as const,
  };
  const first = completeWorkflowReceipt(
    { ...planned, stages: [...planned.stages] },
    page,
    page,
    "translate",
  );
  expect(first.analysisStatus).toBe("completed");
  expect(isPageFullyCompleted(first)).toBe(false);
  expect(resolveChapterStatus([first])).toBe("partial");
  const erased = completeWorkflowReceipt(
    first.pageWorkflow ?? receipt,
    first,
    first,
    "erase",
  );
  expect(isPageFullyCompleted(erased)).toBe(false);
  const reviewed = completeWorkflowReceipt(
    erased.pageWorkflow ?? receipt,
    erased,
    erased,
    "review",
  );
  expect(isPageFullyCompleted(reviewed)).toBe(true);
  expect(resolveChapterStatus([reviewed])).toBe("completed");
});
