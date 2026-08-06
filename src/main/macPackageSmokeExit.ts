type MacPackageSmokeExitRuntime = {
  releaseDataRootLock: () => void;
  exit: (code: number) => void;
  reportReleaseFailure: (error: unknown) => void;
};

export function exitMacPackageSmoke(
  code: number,
  runtime: MacPackageSmokeExitRuntime,
): void {
  try {
    runtime.releaseDataRootLock();
  } catch (error) {
    runtime.reportReleaseFailure(error);
    runtime.exit(1);
    return;
  }
  runtime.exit(code);
}
