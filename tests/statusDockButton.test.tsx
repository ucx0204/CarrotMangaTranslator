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
        statusLines={["가장 최근", "이전 상태"]}
        onClear={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "최근 작업 알림 열기",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(button.classList.contains("unread")).toBe(true));
    expect(button.getAttribute("title")).toBe("최근 상태: 가장 최근");
  });

  it("opens accessibly, clears history, and closes on Escape or outside click", () => {
    const onClear = vi.fn();
    render(
      <StatusDockButton
        jobState={makeJobState()}
        statusLines={["가장 최근", "이전 상태"]}
        onClear={onClear}
      />,
    );
    const button = screen.getByRole("button", {
      name: "최근 작업 알림 열기",
    });
    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("dialog", { name: "최근 작업 알림" }),
    ).not.toBeNull();
    expect(screen.getAllByText(/상태|최근/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "상태 기록 지우기" }));
    expect(onClear).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a failed job visibly red independently of unread history", () => {
    render(
      <StatusDockButton
        jobState={makeJobState({ status: "failed", detail: "raw failure" })}
        statusLines={[]}
        onClear={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "최근 작업 알림 열기" })
        .classList.contains("failed"),
    ).toBe(true);
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
