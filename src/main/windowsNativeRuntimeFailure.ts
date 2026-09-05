import { existsSync } from "node:fs";
import { win32 } from "node:path";

const VC_RUNTIME_DLLS = [
  "MSVCP140.dll",
  "VCRUNTIME140.dll",
  "VCRUNTIME140_1.dll",
  "CONCRT140.dll",
];

type NativeRuntimeProbe = {
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  systemRoot: string;
  fileExists: (path: string) => boolean;
};

/** Only diagnose missing dependencies when the named native addon exists. */
export function describeWindowsNativeRuntimeFailure(
  error: unknown,
  probe: NativeRuntimeProbe = {
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    systemRoot: process.env.SystemRoot || "C:\\Windows",
    fileExists: existsSync,
  },
): { title: string; detail: string; missingDlls: string[] } | null {
  if (
    probe.platform !== "win32" ||
    probe.arch !== "x64" ||
    !(error instanceof Error)
  )
    return null;
  if (!("code" in error) || error.code !== "ERR_DLOPEN_FAILED") return null;
  const bindingPath = error.message.match(
    /((?:[a-z]:[\\/]|\\\\)[^\r\n]*onnxruntime_binding\.node)/i,
  )?.[1];
  if (!bindingPath || !probe.fileExists(bindingPath)) return null;
  const directories = [
    win32.dirname(probe.execPath),
    win32.dirname(bindingPath),
    win32.join(probe.systemRoot, "System32"),
  ];
  const missing = VC_RUNTIME_DLLS.filter(
    (dll) =>
      !directories.some((directory) =>
        probe.fileExists(win32.join(directory, dll)),
      ),
  );
  if (missing.length === 0) return null;
  return {
    title: "Microsoft Visual C++ x64 런타임 필요",
    detail: [
      "아래 Microsoft 설치 파일을 실행한 뒤 앱을 다시 실행해 주세요.",
      "https://aka.ms/vc14/vc_redist.x64.exe",
    ].join("\n\n"),
    missingDlls: missing,
  };
}
