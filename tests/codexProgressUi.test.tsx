/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexProgressReporter } from "../src/main/pipeline/codexTypesettingProgress";
import { JobEventSchema } from "../src/shared/ipcJobSchemas";
import type { JobEvent } from "../src/shared/jobTypes";
import {
  formatJobLabel,
  resolveProgressSnapshot,
} from "../src/renderer/src/lib/jobProgress";
import { RunJobFeedback } from "../src/renderer/src/components/RunStatusFeedback";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { shouldRefreshLiveChapter } from "../src/renderer/src/hooks/jobEventUtils";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import { CodexJobPreview } from "../src/renderer/src/components/CodexJobPreview";
import {
  appendCodexPreview,
  type CodexPagePreview,
} from "../src/shared/codexTypesettingProgress";

afterEach(cleanup);
it("opens retained history without a live preview and recovers image loading failure", async () => {
  const getPageImageDataUrl = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue(null);
  window.mangaApi = createTestMangaGatewayStub({ getPageImageDataUrl });
  const history: CodexPagePreview[] = [
    {
      pageId: "saved",
      name: "saved.png",
      imagePath: "saved.png",
      stage: "background",
      width: 100,
      height: 100,
      regions: [],
    },
  ];
  const view = render(<CodexJobPreview history={history} />);
  await waitFor(() => expect(getPageImageDataUrl).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: /중간 결과/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  getPageImageDataUrl.mockResolvedValue("data:image/png;base64,c2F2ZWQ=");
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(await screen.findByRole("img", { name: "saved.png" })).toBeTruthy();
  view.rerender(<CodexJobPreview history={[]} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /중간 결과/ })).toBeNull();
});

it("keeps page context through erasure, retry and stage changes with honest counts", () => {
  const events: JobEvent[] = [];
  const progress = createCodexProgressReporter("job", 34, (event) =>
    events.push(JobEventSchema.parse(event)),
  );
  progress({ stage: "reading", step: "reading", page: 12, completed: 11 });
  progress({ step: "erasurePlan", part: 1, parts: 2 });
  progress({ step: "retry", attempt: 1, delaySeconds: 10 });
  expect(events[2].codexProgress).toMatchObject({
    page: 12,
    completed: 11,
    step: "retry",
    attempt: 1,
  });
  expect(events[2].codexProgress?.part).toBeUndefined();
  progress({ stage: "fonts", step: "groupFonts" });
  expect(events[3].pageIndex).toBeUndefined();
  expect(resolveProgressSnapshot(events[3])).toEqual({ mode: "indeterminate" });
  progress({ step: "matchFonts" });
  progress({ stage: "typesetting", step: "layout", page: 1, completed: 0 });
  progress({ step: "saving", completed: 1 });
  expect(resolveProgressSnapshot(events[6])).toMatchObject({
    current: 1,
    total: 34,
    mode: "determinate",
  });
  expect(formatJobLabel(events[1])).toBe(events[1].progressText);
  expect(shouldRefreshLiveChapter(events[6])).toBe(false);
  progress({ step: "saving", completed: 1, pageCommitted: true });
  expect(shouldRefreshLiveChapter(events[7])).toBe(true);
  expect(events[7].status).toBe("running");
});

it("shows read-only live images and translations, retries failures, and closes without cancelling the job", async () => {
  const cancelJob = vi.fn();
  const getPageImageDataUrl = vi.fn(
    async (path: string) => `data:image/png;base64,${btoa(path)}`,
  );
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl,
    cancelJob,
  });
  const events: JobEvent[] = [];
  let history: CodexPagePreview[] = [];
  const report = createCodexProgressReporter("preview-job", 3, (event) => {
    events.push(JobEventSchema.parse(event));
    history = appendCodexPreview(history, event.codexProgress?.preview);
  });
  report({
    step: "reading",
    page: 1,
    preview: {
      pageId: "page",
      name: "001.png",
      imagePath: "original.png",
      width: 1000,
      height: 1500,
      stage: "reading",
      regions: [
        {
          source: "読める文字",
          translation: "읽은 문장",
          bbox: { x: 100, y: 200, w: 300, h: 100 },
        },
      ],
    },
  });
  const renderJob = () => {
    const event = events.at(-1);
    if (!event) throw new Error("Missing emitted progress");
    return (
      <StatusDockButton
        jobState={{ ...event, codexPreviewHistory: history }}
        progressSnapshot={resolveProgressSnapshot(event)}
        showProgressBar
        statusLines={[]}
        onCancelJob={cancelJob}
        onClear={() => {}}
      />
    );
  };
  const view = render(renderJob());
  fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
  fireEvent.click(screen.getByRole("button", { name: /중간 결과/ }));
  expect(await screen.findByText("읽은 문장")).toBeTruthy();
  expect(document.querySelector("svg rect")?.getAttribute("width")).toBe("300");
  fireEvent.click(screen.getByRole("button", { name: "실제 크기" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "확대" }));
  fireEvent.click(screen.getByRole("button", { name: "확대" }));
  expect(screen.getByText("125%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "축소" }));
  fireEvent.click(screen.getByRole("button", { name: "화면에 맞추기" }));
  const loadsBeforeProgress = getPageImageDataUrl.mock.calls.length;
  report({ step: "erasurePlan" });
  view.rerender(renderJob());
  expect(getPageImageDataUrl).toHaveBeenCalledTimes(loadsBeforeProgress);
  const preview = events.at(-1)?.codexProgress?.preview;
  if (!preview) throw new Error("Missing emitted preview");
  report({
    stage: "typesetting",
    step: "background",
    preview: {
      ...preview,
      stage: "background",
      imagePath: "clean.png",
      regions: [],
    },
  });
  view.rerender(renderJob());
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("img", { name: "001.png" })
        .at(-1)
        ?.getAttribute("src"),
    ).toContain(btoa("clean.png")),
  );
  expect(screen.queryByText("읽은 문장")).toBeNull();
  const historyPane = screen.getByRole("navigation", { name: "이력" });
  fireEvent.click(
    within(historyPane).getByRole("button", { name: /원문 번역/ }),
  );
  expect(await screen.findByText("읽은 문장")).toBeTruthy();
  fireEvent.click(
    within(historyPane).getByRole("button", { name: /원문 제거/ }),
  );
  await waitFor(() => expect(screen.queryByText("읽은 문장")).toBeNull());
  const entry = screen.getByRole("region", { name: "001.png · 원문 제거" });
  fireEvent.error(await within(entry).findByRole("img", { name: "001.png" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("region", { name: "작업 센터" })).toBeTruthy();
  expect(cancelJob).not.toHaveBeenCalled();
  await act(async () => {});
});

it("keeps the standard progress bar visible at the end of a nonterminal stage", () => {
  const job: JobEvent = {
    id: "job",
    kind: "gemma-analysis",
    status: "running",
    phase: "model_requesting",
    progressText: "원문 번역",
    codexProgress: {
      stage: "reading",
      step: "erasurePlan",
      page: 34,
      completed: 34,
      total: 34,
    },
  };
  render(
    <RunJobFeedback
      jobState={job}
      progressSnapshot={resolveProgressSnapshot(job)}
      showProgressBar
    />,
  );
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "34",
  );
  expect(screen.getByText("34 / 34")).toBeTruthy();
});
