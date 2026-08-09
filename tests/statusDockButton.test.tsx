/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import type { JobState } from "../src/shared/jobTypes";

afterEach(cleanup);

describe("status dock", () => {
  it("shows unread state without forcing open and exposes the latest line", async () => {
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });

    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    await waitFor(() => expect(button.classList.contains("unread")).toBe(true));
    expect(button.getAttribute("title")).toBe("최근 상태: 가장 최근");
  });

  it("opens accessibly, clears history, and closes on Escape or outside click", () => {
    const onClear = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState()}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={["가장 최근", "이전 상태"]}
        onCancelJob={vi.fn()}
        onClear={onClear}
      />,
    );
    const button = screen.getByRole("button", {
      name: "작업 센터 열기",
    });
    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "작업 센터" })).not.toBeNull();
    expect(screen.getAllByText(/상태|최근/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "상태 기록 지우기" }));
    expect(onClear).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "작업 센터" })).toBeNull();
  });

  it("keeps a failed job visibly red independently of unread history", () => {
    render(
      <StatusDockButton
        jobState={makeJobState({ status: "failed", detail: "raw failure" })}
        progressSnapshot={null}
        showProgressBar={false}
        statusLines={[]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "작업 센터 열기" })
        .classList.contains("failed"),
    ).toBe(true);
  });

  it("keeps job progress and cancellation in the activity center", () => {
    const onCancelJob = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState({
          progressText: "OCR 처리 중",
          status: "running",
        })}
        progressSnapshot={{
          current: 2,
          mode: "determinate",
          ratio: 0.5,
          total: 4,
        }}
        showProgressBar
        statusLines={["2 / 4페이지"]}
        onCancelJob={onCancelJob}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
    fireEvent.click(screen.getByRole("button", { name: "현재 작업 취소" }));
    expect(onCancelJob).toHaveBeenCalledOnce();
  });
});

function makeJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "job-1",
    kind: "inpainting",
    progressText: "대기",
    status: "idle",
    ...overrides,
  };
}
