import { describe, expect, it } from "vitest";
import {
  createPageWorkflowProgress,
  emitWorkflowCompletion,
} from "../src/main/jobs/pageWorkflowProgress";
import type { JobEvent } from "../src/shared/jobTypes";
import { makePage, makeChapter } from "./helpers/workspacePointerFixtures";

describe("page workflow progress ownership", () => {
  it.each(["cancelled", "failed", "partial", "completed"] as const)(
    "emits truthful %s progress",
    (status) => {
      const events: JobEvent[] = [];
      const last: JobEvent = {
        id: "run",
        kind: "gemma-analysis",
        status: "running",
        phase: "model_requesting",
        progressText: "requesting",
        progressCurrent: 12,
        progressTotal: 1062,
        pageIndex: 4,
        pageTotal: 100,
      };
      emitWorkflowCompletion(
        (event) => events.push(event),
        "run",
        { runId: "run", status, issues: [], chapters: [] },
        1062,
        last,
      );
      expect(events[0]).toMatchObject({
        status,
        phase: status === "completed" ? "done" : status,
        progressCurrent: status === "completed" ? 1062 : 12,
        progressTotal: 1062,
        pageIndex: 4,
      });
      if (status !== "completed")
        expect(events[0].progressText).not.toContain("완료");
    },
  );
  it("retains aggregate progress through nested requests, retries and finalization", () => {
    const events: JobEvent[] = [];
    const progress = createPageWorkflowProgress(
      "outer",
      { pageCount: 34, stageCount: 2 },
      (e) => events.push(e),
    );
    const page = makePage();
    progress.begin("translate", page, makeChapter(page));
    for (const phase of [
      "model_requesting",
      "page_retry",
      "finalizing",
    ] as const) {
      progress.emit({
        id: "inner",
        kind: "gemma-analysis",
        status: "running",
        phase,
        progressText: "OpenAI Codex 번역 요청 중",
        detail: "gpt-6-astra",
        progressCurrent: 1,
        progressTotal: 1,
        pageIndex: 1,
        pageTotal: 1,
        progressPercent: 1,
        progressMode: "determinate",
      });
      expect(events.at(-1)).toMatchObject({
        id: "outer",
        status: "running",
        phase,
        progressCurrent: 0,
        progressTotal: 68,
        detail: "gpt-6-astra",
        pageIndex: undefined,
        pageTotal: undefined,
        progressPercent: undefined,
      });
      expect(events.at(-1)?.progressText).toContain(page.name);
    }
    progress.settled("translate", page, makeChapter(page));
    progress.begin("translate", { ...page, id: "second" }, makeChapter(page));
    expect(events.at(-1)).toMatchObject({
      progressCurrent: 1,
      progressTotal: 68,
    });
  });
});

it("switches chapter and stage before preparation, without stale or duplicate page labels", () => {
  const events: JobEvent[] = [];
  const progress = createPageWorkflowProgress(
    "run",
    { pageCount: 232, stageCount: 7 },
    (e) => events.push(e),
  );
  const page = { ...makePage(), name: "022.jpg" };
  const chapter = { ...makeChapter(page), id: "chapter-2", title: "2화" };
  progress.begin("typography", page, chapter);
  progress.settled("typography", page, chapter);
  progress.prepare("erase", chapter);
  progress.emit({
    id: "inner",
    kind: "gemma-analysis",
    status: "running",
    phase: "inpainting_preparing",
    progressText: "021.jpg 분석 중",
  });
  expect(events.at(-1)).toMatchObject({
    progressText: "2화 · 원문 제거 · 021.jpg 분석 중",
    workflowProgress: { chapterId: "chapter-2" },
    progressCurrent: 1,
    progressTotal: 1624,
  });
  const third = { ...chapter, id: "chapter-3", title: "3화" };
  progress.begin("translate", page, third);
  progress.emit({
    id: "inner",
    kind: "gemma-analysis",
    status: "running",
    phase: "page_running",
    progressText: "022.jpg 분석 중",
  });
  expect(events.at(-1)).toMatchObject({
    progressText: "3화 · 번역 · 022.jpg 분석 중",
    workflowProgress: { chapterId: "chapter-3" },
  });
});

it("does not publish inner completion as a durable outer checkpoint", () => {
  const events: JobEvent[] = [];
  const progress = createPageWorkflowProgress(
    "run",
    { pageCount: 1, stageCount: 1 },
    (e) => events.push(e),
  );
  const page = makePage(),
    chapter = makeChapter(page);
  progress.begin("translate", page, chapter);
  for (const phase of [
    "page_done",
    "page_skipped",
    "inpainting_done",
  ] as const) {
    progress.emit({
      id: "inner",
      kind: "gemma-analysis",
      status: "running",
      phase,
      progressText: "inner result",
    });
    expect(events.at(-1)).toMatchObject({
      phase: "page_running",
      progressCurrent: 0,
    });
  }
  progress.settled("translate", page, chapter);
  expect(events.at(-1)).toMatchObject({
    phase: "page_done",
    progressCurrent: 1,
  });
});
