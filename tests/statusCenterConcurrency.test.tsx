/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useStatusCenterTasks } from "../src/renderer/src/hooks/useStatusCenterTasks";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import { loadStatusCenterHistory } from "../src/renderer/src/lib/statusCenterHistoryStore";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const model: JobState = {
  id: "model-A",
  kind: "gemma-analysis",
  status: "running",
  progressText: "A 모델 처리 중",
};
function operation(
  id: string,
  status: AppOperationActivityEvent["status"] = "running",
  updatedAt = 1,
): AppOperationActivityEvent {
  return {
    id,
    kind: "web-import-preview",
    status,
    phase: "web-loading",
    startedAt: 1,
    updatedAt,
    cancellable: status === "running",
    mutatesLibrary: false,
  };
}
function bridge() {
  let emitJob: (job: JobEvent) => void = () => {};
  let emitOperation: (event: AppOperationActivityEvent) => void = () => {};
  window.mangaApi = createTestMangaGatewayStub({
    getActiveJobs: async () => [model],
    getActiveAppOperations: async () => [],
    onJobEvent: (callback) => {
      emitJob = callback;
      return () => {};
    },
    onAppOperationActivity: (callback) => {
      emitOperation = callback;
      return () => {};
    },
  });
  return {
    job: (event: JobEvent) => emitJob(event),
    operation: (event: AppOperationActivityEvent) => emitOperation(event),
  };
}
it("retains active tasks while many independent tasks finish and ignores late progress", async () => {
  const events = bridge();
  const { result } = renderHook(() => useStatusCenterTasks(model));
  await waitFor(() =>
    expect(result.current.tasks.some((t) => t.id === model.id)).toBe(true),
  );
  act(() => {
    events.operation(operation("download"));
    events.job({
      ...model,
      id: "export-B",
      kind: "page-export",
      progressText: "B export",
    });
    for (let i = 0; i < 70; i++)
      events.operation(operation(`finished-${i}`, "completed", i + 2));
  });
  expect(result.current.tasks.map((t) => t.id)).toEqual(
    expect.arrayContaining([model.id, "download", "export-B"]),
  );
  act(() => result.current.select("download"));
  act(() => events.operation(operation("download", "completed", 80)));
  act(() => events.operation(operation("download", "running", 81)));
  expect(result.current.selected.operation?.status).toBe("completed");
  expect(result.current.completed.some((t) => t.id === "download")).toBe(true);
  act(() =>
    events.job({
      ...model,
      id: "export-B",
      kind: "page-export",
      status: "completed",
    }),
  );
  act(() =>
    events.job({
      ...model,
      id: "export-B",
      kind: "page-export",
      status: "running",
    }),
  );
  expect(
    result.current.completed.find((t) => t.id === "export-B")?.job?.status,
  ).toBe("completed");
  expect(result.current.tasks.find((t) => t.id === model.id)?.job?.status).toBe(
    "running",
  );
  act(() => {
    for (let i = 0; i < 70; i++)
      events.operation(operation(`later-${i}`, "completed", 100 + i));
    events.operation(operation("download", "running", 200));
  });
  expect(result.current.tasks.some((task) => task.id === "download")).toBe(
    false,
  );
});
it("records background completions without replacing the active model and keeps clear effective", async () => {
  const events = bridge();
  render(
    <StatusDockButton
      jobState={model}
      progressSnapshot={null}
      showProgressBar={false}
      statusLines={[]}
      onCancelJob={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  act(() => {
    events.job({
      ...model,
      id: "export-B",
      kind: "page-export",
      status: "completed",
      progressText: "B 내보내기 완료",
    });
    events.operation(operation("download", "completed", 20));
  });
  await waitFor(() =>
    expect(loadStatusCenterHistory().map((e) => e.id)).toEqual(
      expect.arrayContaining(["export-B", "download"]),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
  expect(screen.getByText("B 내보내기 완료")).not.toBeNull();
  act(() => events.job({ ...model, progressText: "A 계속 처리 중" }));
  expect(screen.getByText("B 내보내기 완료")).not.toBeNull();
  const clear = screen.getByRole("button", { name: "상태 기록 지우기" });
  fireEvent.click(clear);
  await waitFor(() => expect(loadStatusCenterHistory()).toEqual([]));
  act(() => events.job({ ...model, progressText: "A 다음 페이지" }));
  expect(loadStatusCenterHistory()).toEqual([]);
});

it("does not resurrect finished tasks from stale foreground props", async () => {
  const events = bridge();
  const download = operation("download");
  const { result } = renderHook(() => useStatusCenterTasks(model, download));
  await waitFor(() => expect(result.current.tasks).toHaveLength(2));
  act(() => {
    events.operation(operation("download", "completed", 3));
    events.job({ ...model, status: "completed" });
  });
  expect(result.current.tasks).toEqual([]);
  expect(result.current.selected.job?.status).toBe("completed");
  act(() => events.operation(operation("other")));
  expect(result.current.tasks.map((task) => task.id)).toEqual(["other"]);
  expect(result.current.selected.id).toBe("other");
});
