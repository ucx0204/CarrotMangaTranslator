import { describe, expect, it, vi } from "vitest";
import { exitMacPackageSmoke } from "../src/main/macPackageSmokeExit";

describe("mac package smoke immediate exit", () => {
  it("releases the data-root lock before exiting with the requested code", () => {
    const events: string[] = [];
    const runtime = {
      releaseDataRootLock: vi.fn(() => events.push("release")),
      exit: vi.fn((code: number) => events.push(`exit:${code}`)),
      reportReleaseFailure: vi.fn(),
    };

    exitMacPackageSmoke(0, runtime);

    expect(events).toEqual(["release", "exit:0"]);
    expect(runtime.releaseDataRootLock).toHaveBeenCalledOnce();
    expect(runtime.reportReleaseFailure).not.toHaveBeenCalled();
  });

  it("turns a nominal success into failure when lock release fails", () => {
    const events: string[] = [];
    const failure = new Error("release failed");
    const runtime = {
      releaseDataRootLock: vi.fn(() => {
        events.push("release");
        throw failure;
      }),
      exit: vi.fn((code: number) => events.push(`exit:${code}`)),
      reportReleaseFailure: vi.fn(() => events.push("report")),
    };

    exitMacPackageSmoke(0, runtime);

    expect(events).toEqual(["release", "report", "exit:1"]);
    expect(runtime.reportReleaseFailure).toHaveBeenCalledWith(failure);
    expect(runtime.exit).toHaveBeenCalledOnce();
  });
});
