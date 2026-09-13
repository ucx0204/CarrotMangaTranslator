import { describe, expect, it, vi } from "vitest";
import {
  prepareWindowsStartup,
  type WindowsStartupOptions,
  type WindowsStartupRuntime,
} from "../src/main/windowsStartup";

const DATA_ROOT = "C:\\Program Files\\당근망가번역기\\data";
const SID = "S-1-5-21-1001";

function fixture() {
  const resolveDataRoot = vi.fn(() => DATA_ROOT);
  const options: WindowsStartupOptions = {
    executablePath:
      "C:\\Program Files\\당근망가번역기\\CarrotMangaTranslator.exe",
    workingDirectory: "D:\\원고 폴더",
    arguments: ["D:\\원고 폴더\\page 1.png"],
    resolveDataRoot,
  };
  const runtime: WindowsStartupRuntime = {
    probeWriteAccess: vi.fn(() => ({ status: "writable" as const })),
    readIdentity: vi.fn(() => ({ sid: SID, elevated: false })),
    relaunch: vi.fn(() => "launched" as const),
  };
  return { options, runtime, resolveDataRoot };
}

function denyWrites(runtime: WindowsStartupRuntime): Error {
  const error = Object.assign(new Error("access denied"), { code: "EACCES" });
  vi.mocked(runtime.probeWriteAccess).mockReturnValue({
    status: "permission-denied",
    path: DATA_ROOT,
    error,
  });
  return error;
}

function relaunchedArguments(): readonly string[] {
  const { options, runtime } = fixture();
  denyWrites(runtime);
  prepareWindowsStartup(options, runtime);
  return vi.mocked(runtime.relaunch).mock.calls[0][0].arguments;
}

describe("Windows startup permission gate", () => {
  it("does not inspect tokens or prompt for a writable data location", () => {
    const { options, runtime } = fixture();
    expect(prepareWindowsStartup(options, runtime)).toEqual({
      status: "continue",
      dataRoot: DATA_ROOT,
    });
    expect(runtime.readIdentity).not.toHaveBeenCalled();
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("leaves unresolved roots to the existing bootstrap failure handling", () => {
    const { options, runtime } = fixture();
    options.resolveDataRoot = () => null;
    expect(prepareWindowsStartup(options, runtime)).toEqual({
      status: "continue",
      dataRoot: null,
    });
    expect(runtime.probeWriteAccess).not.toHaveBeenCalled();
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("relaunches the exact executable once with original arguments and cwd", () => {
    const { options, runtime } = fixture();
    denyWrites(runtime);
    expect(prepareWindowsStartup(options, runtime)).toEqual({
      status: "relaunched",
    });
    expect(runtime.relaunch).toHaveBeenCalledTimes(1);
    const request = vi.mocked(runtime.relaunch).mock.calls[0][0];
    expect(request.executablePath).toBe(options.executablePath);
    expect(request.workingDirectory).toBe(options.workingDirectory);
    expect(request.arguments.slice(0, -1)).toEqual(options.arguments);
    expect(request.arguments).toHaveLength(options.arguments.length + 1);
  });

  it("treats a declined UAC prompt as cancellation, without another attempt", () => {
    const { options, runtime } = fixture();
    denyWrites(runtime);
    vi.mocked(runtime.relaunch).mockReturnValue("cancelled");
    expect(prepareWindowsStartup(options, runtime)).toEqual({
      status: "cancelled",
    });
    expect(runtime.relaunch).toHaveBeenCalledTimes(1);
  });

  it("preserves the parent data root instead of resolving under a new environment", () => {
    const arguments_ = relaunchedArguments();
    const { options, runtime, resolveDataRoot } = fixture();
    options.arguments = arguments_;
    resolveDataRoot.mockReturnValue("D:\\different-data");
    vi.mocked(runtime.readIdentity).mockReturnValue({
      sid: SID,
      elevated: true,
    });
    expect(prepareWindowsStartup(options, runtime)).toEqual({
      status: "continue",
      dataRoot: DATA_ROOT,
    });
    expect(resolveDataRoot).not.toHaveBeenCalled();
    expect(runtime.probeWriteAccess).toHaveBeenCalledWith(DATA_ROOT);
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("rejects a different administrator before resolving or touching data", () => {
    const arguments_ = relaunchedArguments();
    const { options, runtime, resolveDataRoot } = fixture();
    options.arguments = arguments_;
    vi.mocked(runtime.readIdentity).mockReturnValue({
      sid: "S-1-5-21-2002",
      elevated: true,
    });
    expect(() => prepareWindowsStartup(options, runtime)).toThrow(
      "다른 Windows 계정",
    );
    expect(resolveDataRoot).not.toHaveBeenCalled();
    expect(runtime.probeWriteAccess).not.toHaveBeenCalled();
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("does not trust a relaunch marker as proof of elevation", () => {
    const arguments_ = relaunchedArguments();
    const { options, runtime } = fixture();
    options.arguments = arguments_;
    expect(() => prepareWindowsStartup(options, runtime)).toThrow(
      "관리자 권한을 얻지 못했습니다",
    );
    expect(runtime.probeWriteAccess).not.toHaveBeenCalled();
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("does not loop if an already elevated process still cannot write", () => {
    const { options, runtime } = fixture();
    denyWrites(runtime);
    vi.mocked(runtime.readIdentity).mockReturnValue({
      sid: SID,
      elevated: true,
    });
    expect(() => prepareWindowsStartup(options, runtime)).toThrow(
      "관리자 권한으로도",
    );
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("does not elevate non-permission failures and preserves their cause", () => {
    const { options, runtime } = fixture();
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(runtime.probeWriteAccess).mockReturnValue({
      status: "unavailable",
      path: DATA_ROOT,
      error,
    });
    expect(() => prepareWindowsStartup(options, runtime)).toThrow(
      expect.objectContaining({ cause: error }),
    );
    expect(runtime.readIdentity).not.toHaveBeenCalled();
    expect(runtime.relaunch).not.toHaveBeenCalled();
  });

  it("propagates an OS launch failure without retrying", () => {
    const { options, runtime } = fixture();
    denyWrites(runtime);
    vi.mocked(runtime.relaunch).mockImplementation(() => {
      throw new Error("OS launch failed");
    });
    expect(() => prepareWindowsStartup(options, runtime)).toThrow(
      "OS launch failed",
    );
    expect(runtime.relaunch).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate handoffs before inspecting an identity or data", () => {
    const arguments_ = relaunchedArguments();
    const { options, runtime, resolveDataRoot } = fixture();
    options.arguments = [...arguments_, arguments_[arguments_.length - 1]];
    expect(() => prepareWindowsStartup(options, runtime)).toThrow("Duplicate");
    expect(runtime.readIdentity).not.toHaveBeenCalled();
    expect(resolveDataRoot).not.toHaveBeenCalled();
    expect(runtime.probeWriteAccess).not.toHaveBeenCalled();
  });

  it.each([
    { name: "invalid encoding", encoded: "!invalid!" },
    { name: "invalid schema", encoded: "e30" },
    { name: "oversized", encoded: "a".repeat(8193) },
  ])("rejects $name handoff before data access", ({ encoded }) => {
    const { options, runtime, resolveDataRoot } = fixture();
    options.arguments = [`--mgt-uac-relaunch=${encoded}`];
    expect(() => prepareWindowsStartup(options, runtime)).toThrow();
    expect(resolveDataRoot).not.toHaveBeenCalled();
    expect(runtime.probeWriteAccess).not.toHaveBeenCalled();
  });
});
