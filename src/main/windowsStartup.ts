import { win32 } from "node:path";
import {
  probeStartupWriteAccess,
  type StartupWriteAccessResult,
} from "./startupWriteAccess";
import {
  readWindowsProcessIdentity,
  requestWindowsElevation,
  type WindowsElevationRequest,
  type WindowsProcessIdentity,
} from "./windowsElevation";

const RELAUNCH_PREFIX = "--mgt-uac-relaunch=";

type ElevationHandoff = {
  version: 1;
  dataRoot: string;
  originalSid: string;
};

export type WindowsStartupOptions = {
  executablePath: string;
  workingDirectory: string;
  arguments: readonly string[];
  resolveDataRoot: () => string | null;
};

export type WindowsStartupRuntime = {
  probeWriteAccess: (dataRoot: string) => StartupWriteAccessResult;
  readIdentity: () => WindowsProcessIdentity;
  relaunch: (request: WindowsElevationRequest) => "launched" | "cancelled";
};

export type WindowsStartupResult =
  | { status: "continue"; dataRoot: string | null }
  | { status: "relaunched" | "cancelled" };

const productionRuntime: WindowsStartupRuntime = {
  probeWriteAccess: probeStartupWriteAccess,
  readIdentity: readWindowsProcessIdentity,
  relaunch: requestWindowsElevation,
};

/** Call before configuring Electron storage, loading main, or taking locks. */
export function prepareWindowsStartup(
  options: WindowsStartupOptions,
  runtime: WindowsStartupRuntime = productionRuntime,
): WindowsStartupResult {
  const handoff = readElevationHandoff(options.arguments);
  const identity = handoff ? runtime.readIdentity() : null;
  if (handoff && identity) {
    validateRelaunchedIdentity(handoff, identity);
  }

  const dataRoot = handoff?.dataRoot ?? options.resolveDataRoot();
  if (!dataRoot) {
    return { status: "continue", dataRoot: null };
  }
  const access = runtime.probeWriteAccess(dataRoot);
  if (access.status === "writable") {
    return { status: "continue", dataRoot };
  }
  if (access.status !== "permission-denied") {
    throw startupAccessError(access, "데이터 저장 위치를 사용할 수 없습니다.");
  }

  const currentIdentity = identity ?? runtime.readIdentity();
  if (currentIdentity.elevated || handoff) {
    throw startupAccessError(
      access,
      "관리자 권한으로도 데이터를 저장할 수 없습니다. 폴더 권한과 디스크 상태를 확인해 주세요.",
    );
  }
  const result = runtime.relaunch({
    executablePath: options.executablePath,
    workingDirectory: options.workingDirectory,
    arguments: [
      ...options.arguments,
      encodeElevationHandoff({
        version: 1,
        dataRoot,
        originalSid: currentIdentity.sid,
      }),
    ],
  });
  return { status: result === "launched" ? "relaunched" : "cancelled" };
}

function validateRelaunchedIdentity(
  handoff: ElevationHandoff,
  identity: WindowsProcessIdentity,
): void {
  if (identity.sid !== handoff.originalSid) {
    throw new Error(
      "다른 Windows 계정으로 관리자 실행되어 시작을 중단했습니다.\n" +
        "기존 API 키와 설정을 보호하기 위해 데이터를 변경하지 않았습니다.\n" +
        "같은 계정으로 승인하거나 설치 프로그램에서 일반 권한으로 쓸 수 있는 데이터 폴더를 선택해 주세요.",
    );
  }
  if (!identity.elevated) {
    throw new Error(
      "재실행한 프로세스가 관리자 권한을 얻지 못했습니다. 자동 재시도하지 않습니다.",
    );
  }
}

function encodeElevationHandoff(handoff: ElevationHandoff): string {
  if (!isElevationHandoff(handoff)) {
    throw new Error("Cannot relaunch with an invalid Windows data-root handoff.");
  }
  return RELAUNCH_PREFIX + Buffer.from(JSON.stringify(handoff), "utf8").toString("base64url");
}

function readElevationHandoff(arguments_: readonly string[]): ElevationHandoff | null {
  const markers = arguments_.filter((argument) => argument.startsWith(RELAUNCH_PREFIX));
  if (markers.length === 0) {
    return null;
  }
  if (markers.length !== 1) {
    throw new Error("Duplicate Windows elevation handoff arguments.");
  }
  const encoded = markers[0].slice(RELAUNCH_PREFIX.length);
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid Windows elevation handoff encoding.");
  }
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!isElevationHandoff(value)) {
    throw new Error("Invalid Windows elevation handoff contents.");
  }
  return value;
}

function isElevationHandoff(value: unknown): value is ElevationHandoff {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ElevationHandoff>;
  return (
    candidate.version === 1 &&
    typeof candidate.originalSid === "string" &&
    /^S-\d+(?:-\d+)+$/.test(candidate.originalSid) &&
    typeof candidate.dataRoot === "string" &&
    win32.isAbsolute(candidate.dataRoot) &&
    win32.parse(candidate.dataRoot).root.length > 1 &&
    !/[\0\r\n]/.test(candidate.dataRoot)
  );
}

function startupAccessError(
  access: Exclude<StartupWriteAccessResult, { status: "writable" }>,
  message: string,
): Error {
  return new Error(
    `${message}\n\n${access.path}\n${describeProbeFailure(access.error)}`,
    { cause: access.error },
  );
}

function describeProbeFailure(error: unknown): string {
  return error instanceof AggregateError
    ? error.errors.map(describeProbeFailure).join("\n")
    : String(error);
}
