// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  it("attaches an orphan glossary only to the work chosen for this preview", () => {
    const state = model();
    state.preview = {
      id: "one",
      works: 1,
      pages: 0,
      bytes: 1,
      createdAt: "2026-11-28",
      appVersion: "3.8.15",
      recoveryPath: "",
      connections: [],
      partial: {
        items: [
          {
            sourceId: "terms",
            title: "원래 작품",
            chapters: 0,
            pages: 0,
            terms: 7,
          },
        ],
        targets: [{ id: "current", title: "현재 작품" }],
        issues: ["terms/work.json"],
        issueCount: 1,
      },
    };
    render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    const dialog = screen.getByRole("dialog", { name: "부분 복구" });
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "현재 작품" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "누락·손상된 항목 1개" }),
    );
    expect(within(dialog).getByText("terms/work.json")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "추가하고 앱 다시 시작" }),
    );
    expect(state.apply).toHaveBeenCalledWith([
      { sourceId: "terms", workId: "current" },
    ]);
  });
  it("allows export while the informational library summary is still loading", () => {
    const state = model();
    state.status = null;
    render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    const button = screen.getByRole("button", {
      name: "백업 내보내기",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(state.exportBackup).toHaveBeenCalledOnce();
  });
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
    const view = render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    const trigger = screen.getByRole("button", { name: "백업 가져오기" });
    trigger.focus();
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
    view.rerender(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(state.apply).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "환경 복원 확인" });
    expect(view.container.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    expect(
      within(dialog).getByText("현재 보관함과 설정을 이 백업으로 바꿀까요?"),
    ).toBeTruthy();
    const details = within(dialog).getByRole("button", { name: "자세히" });
    const panel = document.getElementById(
      details.getAttribute("aria-controls") ?? "",
    );
    if (!panel) throw new Error("Missing backup details panel");
    expect(panel.hidden).toBe(true);
    fireEvent.click(details);
    expect(panel.hidden).toBe(false);
    expect(within(panel).getByText("D:/data/recovery")).toBeTruthy();
    expect(within(panel).getByText("E:/originals")).toBeTruthy();
    fireEvent.click(details);
    expect(panel.hidden).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "복원하고 앱 다시 시작" }),
    );
    expect(state.apply).toHaveBeenCalledOnce();
    state.busy = true;
    view.rerender(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(within(dialog).getByRole("progressbar")).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "복원하고 앱 다시 시작",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(state.dismiss).not.toHaveBeenCalled();
    state.busy = false;
    state.error = "Restore failed";
    view.rerender(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Restore failed",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(state.dismiss).toHaveBeenCalledOnce();
    state.preview = null;
    view.rerender(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    expect(document.activeElement).toBe(trigger);
  });
  it("shows the selected backup location only when previous-environment details are expanded", () => {
    const state = model();
    state.recoveryId = "previous";
    if (!state.status) throw new Error("Missing test status");
    state.status.recoveries = [
      { id: "previous", createdAt: "2026-09-24", path: "D:/previous" },
    ];
    render(
      <EnvironmentBackupView model={state} disabled={false} dirty={false} />,
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "환경 복원 확인" }),
    );
    const details = dialog.getByRole("button", { name: "자세히" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(dialog.getByText("복원할 백업 위치")).toBeTruthy();
    expect(dialog.getByText("D:/previous")).toBeTruthy();
    expect(dialog.queryByText("다시 연결할 폴더")).toBeNull();
  });

  it("announces failures and exposes cancellable progress", () => {
    const state = model();
    state.busy = true;
    state.error = "Disk full";
    state.activity = {
      id: "operation",
      kind: "environment-backup-preview",
      status: "running",
      phase: "import-finalizing",
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
    expect(
      screen
        .getByRole("progressbar", { name: "가져오기를 마무리하는 중…" })
        .getAttribute("aria-valuenow"),
    ).toBe("20");
    expect(screen.getByRole("alert").textContent).toBe("Disk full");
    fireEvent.click(screen.getByRole("button", { name: "작업 취소" }));
    expect(state.cancel).toHaveBeenCalledOnce();
  });
});
