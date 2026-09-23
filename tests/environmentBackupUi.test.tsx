// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentBackupView } from "../src/renderer/src/components/settingsModal/EnvironmentBackupSection";
import type { useEnvironmentBackup } from "../src/renderer/src/components/settingsModal/useEnvironmentBackup";

afterEach(cleanup);
function model(): ReturnType<typeof useEnvironmentBackup> {
  return {
    status: {
      summary: { works: 2, pages: 10, bytes: 20 },
      recoveries: [],
      restored: null,
    },
    preview: null,
    recoveryId: null,
    activity: null,
    busy: false,
    error: "",
    savedPath: "",
    exportBackup: vi.fn(async () => undefined),
    inspectBackup: vi.fn(async () => undefined),
    chooseRecovery: vi.fn(),
    dismiss: vi.fn(),
    apply: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
}
describe("environment backup UI", () => {
  it("requires saved settings before export or restore", () => {
    const state = model();
    render(<EnvironmentBackupView model={state} disabled={false} dirty />);
    expect(
      (
        screen.getByRole("button", {
          name: "백업 내보내기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/변경한 설정을 먼저/)).toBeTruthy();
  });
  it("shows the validated backup and waits for explicit restore confirmation", () => {
    const state = model();
    state.preview = {
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-09-24T00:00:00.000Z",
      appVersion: "2.8.0",
      works: 3,
      pages: 30,
      bytes: 100,
      recoveryPath: "D:/data/recovery",
      connections: ["E:/originals"],
    };
    render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(state.apply).not.toHaveBeenCalled();
    expect(screen.getByText("D:/data/recovery")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "기존 환경 보존 후 복원" }),
    );
    expect(state.apply).toHaveBeenCalledOnce();
  });
  it("announces failures and exposes cancellable progress", () => {
    const state = model();
    state.busy = true;
    state.error = "Disk full";
    state.activity = {
      id: "operation",
      kind: "environment-backup",
      status: "running",
      progressCurrent: 20,
      progressTotal: 100,
      cancellable: true,
      mutatesLibrary: true,
      startedAt: 0,
      updatedAt: 0,
    };
    render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "20",
    );
    expect(screen.getByRole("alert").textContent).toBe("Disk full");
    fireEvent.click(screen.getByRole("button", { name: "작업 취소" }));
    expect(state.cancel).toHaveBeenCalledOnce();
  });
});
