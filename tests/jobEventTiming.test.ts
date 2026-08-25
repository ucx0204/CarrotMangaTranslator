import { describe, expect, it } from "vitest";
import { createAnalysisJobEventTimer } from "../src/main/jobs/jobEvents";
import type { JobEvent } from "../src/shared/jobTypes";

describe("analysis job event timing", () => {
  it("measures a page across retries and the complete job independently", () => {
    let currentTime = 1_000;
    const addTiming = createAnalysisJobEventTimer(() => currentTime);

    currentTime = 2_000;
    expect(addTiming(makeEvent("page_running", 1))).not.toHaveProperty(
      "pageElapsedMs",
    );
    currentTime = 6_000;
    addTiming(makeEvent("page_retry", 1));
    currentTime = 9_500;
    expect(addTiming(makeEvent("page_done", 1))).toMatchObject({
      pageElapsedMs: 7_500,
    });

    currentTime = 125_000;
    expect(
      addTiming({
        ...makeEvent("done"),
        status: "completed",
      }),
    ).toMatchObject({ jobElapsedMs: 124_000 });
  });

  it("uses page-specific OCR activity for pages completed without translation", () => {
    let currentTime = 0;
    const addTiming = createAnalysisJobEventTimer(() => currentTime);
    currentTime = 400;
    addTiming(makeEvent("ocr_running", 2));
    currentTime = 875;

    expect(addTiming(makeEvent("page_done", 2))).toMatchObject({
      pageElapsedMs: 475,
    });
  });

  it("leaves unrelated or incomplete timing events unchanged", () => {
    const currentTime = 100;
    const addTiming = createAnalysisJobEventTimer(() => currentTime);
    const noPage = makeEvent("page_done");
    const noStart = makeEvent("page_done", 3);
    const noPhase = makeEvent(undefined, 1);

    expect(addTiming(noPage)).toBe(noPage);
    expect(addTiming(noStart)).toBe(noStart);
    expect(addTiming(noPhase)).toBe(noPhase);
    expect(addTiming(makeEvent("done", 0))).not.toHaveProperty("pageElapsedMs");
    expect(addTiming(makeEvent("done", Number.NaN))).not.toHaveProperty(
      "pageElapsedMs",
    );
    expect(
      addTiming({ ...makeEvent("page_running", 1), status: "completed" }),
    ).not.toHaveProperty("jobElapsedMs");
  });

  it("keeps the first translation start and clamps a backwards clock", () => {
    let currentTime = 500;
    const addTiming = createAnalysisJobEventTimer(() => currentTime);
    currentTime = 1_000;
    addTiming(makeEvent("page_running", 1));
    currentTime = 2_000;
    addTiming(makeEvent("page_running", 1));
    currentTime = 900;

    expect(addTiming(makeEvent("page_done", 1))).toMatchObject({
      pageElapsedMs: 0,
    });
  });
});

function makeEvent(phase: JobEvent["phase"], pageIndex?: number): JobEvent {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    status: "running",
    progressText: phase ?? "running",
    phase,
    ...(pageIndex === undefined ? {} : { pageIndex, pageTotal: 3 }),
  };
}
