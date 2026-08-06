import {
  DataRootInstanceLockHeldError,
  DataRootInstanceLockInvalidError,
  type DataRootInstanceLockLease,
} from "./dataRootInstanceLock";

export type BootstrapInstanceGuardRuntime = {
  canonicalizeDataRoot: (dataRoot: string) => string;
  requestSingleInstanceLock: (
    additionalData: Record<string, unknown>,
  ) => boolean;
  releaseSingleInstanceLock: () => void;
  quitSecondaryInstance: () => void;
  exitStartupFailure: (code: number) => void;
  reportStartupFailure: (title: string, detail: string) => void;
  acquireDataRootLock: (dataRoot: string) => DataRootInstanceLockLease;
  installDataRootLockLease: (lease: DataRootInstanceLockLease) => void;
};

export type BootstrapInstanceGuardResult =
  | { status: "primary"; dataRoot: string }
  | { status: "secondary" }
  | { status: "failed"; error: unknown };

export function establishBootstrapInstanceGuard(
  dataRoot: string | null,
  runtime: BootstrapInstanceGuardRuntime,
): BootstrapInstanceGuardResult {
  if (!dataRoot?.trim()) {
    const error = new Error("The application data root could not be resolved.");
    reportGuardFailure(runtime, null, error);
    return { status: "failed", error };
  }

  let canonicalDataRoot: string;
  try {
    canonicalDataRoot = runtime.canonicalizeDataRoot(dataRoot);
  } catch (error) {
    reportGuardFailure(runtime, dataRoot, error);
    return { status: "failed", error };
  }

  let electronLockAcquired = false;
  let dataRootLease: DataRootInstanceLockLease | null = null;
  try {
    electronLockAcquired = runtime.requestSingleInstanceLock({
      schemaVersion: 1,
      dataRoot: canonicalDataRoot,
    });
    if (!electronLockAcquired) {
      runtime.quitSecondaryInstance();
      return { status: "secondary" };
    }

    dataRootLease = runtime.acquireDataRootLock(canonicalDataRoot);
    runtime.installDataRootLockLease(dataRootLease);
    return { status: "primary", dataRoot: canonicalDataRoot };
  } catch (error) {
    let cleanupError: unknown;
    if (dataRootLease) {
      try {
        dataRootLease.release();
      } catch (releaseError) {
        cleanupError = releaseError;
      }
    }
    if (electronLockAcquired) {
      try {
        runtime.releaseSingleInstanceLock();
      } catch (releaseError) {
        cleanupError ??= releaseError;
      }
    }
    reportGuardFailure(runtime, canonicalDataRoot, error, cleanupError);
    return { status: "failed", error };
  }
}

function reportGuardFailure(
  runtime: BootstrapInstanceGuardRuntime,
  dataRoot: string | null,
  error: unknown,
  cleanupError?: unknown,
): void {
  const report = formatBootstrapInstanceGuardFailure(dataRoot, error);
  const cleanupDetail = cleanupError
    ? `\n\n잠금 정리 중 추가 오류가 발생했습니다:\n${formatError(cleanupError)}`
    : "";
  runtime.reportStartupFailure(
    report.title,
    `${report.detail}${cleanupDetail}`,
  );
  runtime.exitStartupFailure(2);
}

function formatBootstrapInstanceGuardFailure(
  dataRoot: string | null,
  error: unknown,
): { title: string; detail: string } {
  if (error instanceof DataRootInstanceLockHeldError) {
    const owner = error.owner;
    return {
      title: "Carrot Manga Translator를 시작할 수 없습니다",
      detail: [
        "동일한 데이터 폴더를 다른 Carrot Manga Translator 프로세스가 사용 중입니다.",
        "",
        "데이터 폴더:",
        error.dataRoot,
        "",
        "락:",
        error.lockDirectory,
        "",
        "소유 프로세스:",
        `${owner.hostname} / PID ${owner.pid}`,
        `시작 시각: ${owner.startedAt}`,
        "",
        "다른 앱 창이나 백그라운드 프로세스를 종료한 뒤 다시 실행하세요.",
        "다른 컴퓨터의 락이거나 락 정보가 손상된 경우, 모든 관련 프로세스가 종료된 것을 먼저 확인한 뒤 락 디렉터리를 수동으로 정리하세요.",
      ].join("\n"),
    };
  }

  if (error instanceof DataRootInstanceLockInvalidError) {
    return {
      title: "Carrot Manga Translator 데이터 락 오류",
      detail: [
        "데이터 폴더의 인스턴스 락 정보를 안전하게 확인할 수 없어 시작을 중단했습니다.",
        "",
        `데이터 폴더: ${error.dataRoot}`,
        `락: ${error.lockDirectory}`,
        `이유: ${error.reason}`,
        "",
        "모든 관련 프로세스가 종료된 것을 먼저 확인한 뒤 락 디렉터리를 수동으로 점검하세요.",
      ].join("\n"),
    };
  }

  return {
    title: "Carrot Manga Translator 시작 오류",
    detail: [
      "인스턴스 잠금을 설정하지 못해 시작을 중단했습니다.",
      dataRoot ? `데이터 폴더: ${dataRoot}` : "데이터 폴더: 확인할 수 없음",
      "",
      formatError(error),
    ].join("\n"),
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}
