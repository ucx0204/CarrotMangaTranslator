import { describe, expect, it } from "vitest";
import { describeWindowsNativeRuntimeFailure } from "../src/main/windowsNativeRuntimeFailure";

const binding = "C:\\Carrot\\resources\\o\\b\\onnxruntime_binding.node";
const dlls = [
  "MSVCP140.dll",
  "VCRUNTIME140.dll",
  "VCRUNTIME140_1.dll",
  "CONCRT140.dll",
];
const loadError = Object.assign(
  new Error(`The specified module could not be found.\n${binding}`),
  {
    code: "ERR_DLOPEN_FAILED",
  },
);

function probe(files: string[] = [binding]) {
  return {
    platform: "win32" as const,
    arch: "x64",
    execPath: "C:\\Carrot\\Carrot.exe",
    systemRoot: "C:\\Windows",
    fileExists: (path: string) => files.includes(path),
  };
}

describe("Windows native runtime startup diagnosis", () => {
  it("identifies absent VC++ dependencies even though the ONNX addon exists", () => {
    const result = describeWindowsNativeRuntimeFailure(loadError, probe());
    expect(result?.title).toContain("Microsoft Visual C++");
    expect(result?.missingDlls).toEqual(dlls);
    expect(result?.detail).toContain("https://aka.ms/vc14/vc_redist.x64.exe");
    expect(result?.detail).toContain("다시 실행");
  });

  it("does not misdiagnose a missing addon, unrelated error, or other platform", () => {
    expect(
      describeWindowsNativeRuntimeFailure(loadError, probe([])),
    ).toBeNull();
    expect(
      describeWindowsNativeRuntimeFailure(new Error("missing module"), probe()),
    ).toBeNull();
    expect(
      describeWindowsNativeRuntimeFailure(loadError, {
        ...probe(),
        platform: "darwin",
      }),
    ).toBeNull();
    expect(
      describeWindowsNativeRuntimeFailure(loadError, {
        ...probe(),
        arch: "arm64",
      }),
    ).toBeNull();
  });

  it.each([
    "C:\\Windows\\System32",
    "C:\\Carrot",
    "C:\\Carrot\\resources\\o\\b",
  ])(
    "recognizes installed or application-local dependencies in %s",
    (directory) => {
      expect(
        describeWindowsNativeRuntimeFailure(
          loadError,
          probe([binding, ...dlls.map((dll) => `${directory}\\${dll}`)]),
        ),
      ).toBeNull();
    },
  );

  it("reports only the missing dependency in a partial installation", () => {
    const result = describeWindowsNativeRuntimeFailure(
      loadError,
      probe([
        binding,
        ...dlls.slice(0, 3).map((dll) => `C:\\Windows\\System32\\${dll}`),
      ]),
    );
    expect(result?.missingDlls).toEqual(["CONCRT140.dll"]);
  });
});
