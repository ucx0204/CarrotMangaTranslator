import { afterEach, expect, it, vi } from "vitest";
import { showRendererRecoveryDialog } from "../src/main/errorReportWindow";

const runtime = vi.hoisted(() => ({
  quit: vi.fn(),
  show: vi.fn(),
  showErrorBox: vi.fn(),
  openPath: vi.fn(async () => ""),
  openExternal: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { quit: runtime.quit, isPackaged: true, relaunch: runtime.restart },
  dialog: { showMessageBox: runtime.show, showErrorBox: runtime.showErrorBox },
  shell: { openPath: runtime.openPath, openExternal: runtime.openExternal },
}));
const stoppedScreen = {
  stopping: () => false,
  canReturn: () => false,
  logDirectory: "logs",
  reportError: vi.fn(),
};
afterEach(() => vi.clearAllMocks());

it("keeps recovery available after opening logs and restarts only once for simultaneous failures", async () => {
  runtime.show
    .mockResolvedValueOnce({ response: 1 })
    .mockResolvedValueOnce({ response: 0 });
  await Promise.all([
    showRendererRecoveryDialog("main: crashed", stoppedScreen),
    showRendererRecoveryDialog("duplicate", stoppedScreen),
  ]);
  expect(runtime.openPath).toHaveBeenCalledExactlyOnceWith("logs");
  expect(runtime.show).toHaveBeenCalledTimes(2);
  expect(runtime.restart).toHaveBeenCalledExactlyOnceWith({
    args: expect.arrayContaining(["--carrot-renderer-recovery"]),
  });
  expect(runtime.quit).toHaveBeenCalledOnce();
});

it("returns to a healthy editor when only the error report failed", async () => {
  runtime.show.mockResolvedValueOnce({ response: 3 });
  await showRendererRecoveryDialog("error-report: crashed", {
    ...stoppedScreen,
    canReturn: () => true,
  });
  expect(runtime.quit).not.toHaveBeenCalled();
  expect(runtime.restart).not.toHaveBeenCalled();
});

it("lets the user exit after a failed relaunch without looping unattended", async () => {
  runtime.show
    .mockResolvedValueOnce({ response: 0 })
    .mockResolvedValueOnce({ response: 3 });
  runtime.restart.mockImplementationOnce(() => {
    throw new Error("Restart failed");
  });
  await showRendererRecoveryDialog("main: crashed", stoppedScreen);
  expect(runtime.show.mock.calls[1][0].detail).toContain("Restart failed");
  expect(runtime.quit).toHaveBeenCalledOnce();
  expect(runtime.restart).toHaveBeenCalledOnce();
});

it("keeps recovery available if the main window dies while the user is reading the report", async () => {
  runtime.show
    .mockResolvedValueOnce({ response: 2 })
    .mockResolvedValueOnce({ response: 3 })
    .mockResolvedValueOnce({ response: 3 });
  const canReturn = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  await showRendererRecoveryDialog("report", { ...stoppedScreen, canReturn });
  expect(runtime.openExternal).toHaveBeenCalledOnce();
  expect(runtime.show).toHaveBeenCalledTimes(3);
  expect(runtime.quit).toHaveBeenCalledOnce();
});

it("ignores a late restart choice once shutdown starts", async () => {
  runtime.show.mockResolvedValueOnce({ response: 0 });
  await showRendererRecoveryDialog("late", {
    ...stoppedScreen,
    stopping: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
  });
  expect(runtime.restart).not.toHaveBeenCalled();
});

it("surfaces native failures and still exits when both dialogs fail", async () => {
  runtime.show.mockRejectedValueOnce(new Error("native dialog failed"));
  runtime.showErrorBox.mockImplementationOnce(() => {
    throw new Error("native error box failed");
  });
  await showRendererRecoveryDialog("original incident", stoppedScreen);
  expect(runtime.showErrorBox).toHaveBeenCalledWith(
    expect.any(String),
    "original incident",
  );
  expect(stoppedScreen.reportError).toHaveBeenCalledTimes(2);
  expect(runtime.quit).toHaveBeenCalledOnce();
});
