/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusDockButton } from "../src/renderer/src/components/StatusDockButton";
import type { JobState } from "../src/shared/jobTypes";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("install progress in the Work Center", () => {
  it("shows download bytes without a dialog or verbose install log", () => {
    const lines = Array.from(
      { length: 30 },
      (_, index) => `setup ${index + 1}`,
    );
    render(
      <StatusDockButton
        jobState={makeDownloadJob(lines)}
        progressSnapshot={{
          current: 5,
          mode: "determinate",
          ratio: 0.5,
          total: 10,
        }}
        showProgressBar
        statusLines={["모델을 내려받는 중"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "5",
    );
    expect(screen.getByText("5.00 MB / 10.0 MB")).not.toBeNull();
    expect(screen.queryByText("다운로드·설치 상세")).toBeNull();
    expect(screen.queryByText("setup 30")).toBeNull();
    expect(screen.getAllByText("모델 다운로드 중")).toHaveLength(1);
  });

  it("shows internet research stage, query, and credits in the same center", () => {
    render(
      <StatusDockButton
        jobState={{
          id: "research-1",
          kind: "internet-research",
          status: "running",
          progressText: "웹 근거 수집 중",
          research: {
            stage: "searching",
            query: "작품명 공식 캐릭터",
            creditsUsed: 2,
            creditLimit: 10,
          },
        }}
        progressSnapshot={{ mode: "indeterminate" }}
        showProgressBar
        statusLines={["자료 출처와 인용을 검토하는 중"]}
        onCancelJob={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    const center = screen.getByRole("region", { name: "작업 센터" });
    expect(within(center).getByText("조사 진행 상황")).not.toBeNull();
    expect(within(center).getByText("작품명 공식 캐릭터")).not.toBeNull();
    expect(within(center).getByText("크레딧 2 / 10")).not.toBeNull();
    expect(within(center).queryByText("웹 근거 수집 중")).toBeNull();
    expect(center.querySelector(".job-pill")).toBeNull();
    expect(center.querySelector(".progress-card")).toBeNull();
    expect(within(center).queryByText("상태 기록")).toBeNull();
    expect(
      within(center).queryByText("자료 출처와 인용을 검토하는 중"),
    ).toBeNull();
  });
});

function makeDownloadJob(installLogLines: string[]): JobState {
  return {
    id: "download-1",
    installLogLines,
    kind: "gemma-analysis",
    phase: "model_downloading",
    progressBytes: 5 * 1024 * 1024,
    progressTotalBytes: 10 * 1024 * 1024,
    progressText: "모델 다운로드 중",
    status: "running",
  };
}
