import { describe, expect, it } from "vitest";
import { createPageWorkflowProgress } from "../src/main/jobs/pageWorkflowProgress";
import type { JobEvent } from "../src/shared/jobTypes";
import { makePage } from "./helpers/workspacePointerFixtures";

describe("page workflow progress ownership", () => {
  it("retains aggregate progress through nested requests, retries and finalization", () => {
    const events: JobEvent[] = [];
    const progress = createPageWorkflowProgress("outer", 68, (e) =>
      events.push(e),
    );
    const page = makePage();
    progress.begin("translate", page);
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
    progress.begin("translate", { ...page, id: "second" });
    expect(events.at(-1)).toMatchObject({
      progressCurrent: 1,
      progressTotal: 68,
    });
  });
});
