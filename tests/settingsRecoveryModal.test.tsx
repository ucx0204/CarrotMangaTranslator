/** @vitest-environment jsdom */
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeAppI18n } from "../src/renderer/src/appI18n";
import { SettingsModal } from "../src/renderer/src/components/SettingsModal";
import { SETTINGS_CREDENTIALS_UNAVAILABLE } from "../src/shared/settingsSecrets";

afterEach(cleanup);

it("keeps an unloaded settings dialog usable when recovery actions are unavailable", async () => {
  await initializeAppI18n("ko");
  const onCancel = vi.fn();
  render(
    <SettingsModal
      initialSettings={null}
      busy={false}
      jobActive={false}
      onCancel={onCancel}
      onOpenErrorReport={vi.fn()}
      onOpenLogFolder={vi.fn()}
      onOpenModelFolder={vi.fn()}
      onReset={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  expect(screen.getByRole("dialog", { name: "설정 복구" })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it("renders the production settings failure view and requires confirmation before resetting credentials", async () => {
  await initializeAppI18n("ko");
  const onRecover = vi.fn();
  const onRetry = vi.fn();
  render(
    <SettingsModal
      initialSettings={null}
      busy={false}
      jobActive={false}
      recovery={{
        failure: SETTINGS_CREDENTIALS_UNAVAILABLE,
        onRetry,
        onRecover,
      }}
      onCancel={vi.fn()}
      onOpenErrorReport={vi.fn()}
      onOpenLogFolder={vi.fn()}
      onOpenModelFolder={vi.fn()}
      onReset={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  expect(screen.getByRole("dialog", { name: "설정 복구" })).toBeTruthy();
  const recover = screen.getByRole("button", {
    name: "백업 후 인증정보 초기화",
  }) as HTMLButtonElement;
  expect(recover.disabled).toBe(true);
  fireEvent.click(recover);
  expect(onRecover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(recover);
  expect(onRecover).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("does not offer credential reset for an unrelated read failure", async () => {
  await initializeAppI18n("ko");
  render(
    <SettingsModal
      initialSettings={null}
      busy={false}
      jobActive={false}
      recovery={{
        failure: "permission denied",
        onRetry: vi.fn(),
        onRecover: vi.fn(),
      }}
      onCancel={vi.fn()}
      onOpenErrorReport={vi.fn()}
      onOpenLogFolder={vi.fn()}
      onOpenModelFolder={vi.fn()}
      onReset={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "백업 후 인증정보 초기화" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeTruthy();
});
