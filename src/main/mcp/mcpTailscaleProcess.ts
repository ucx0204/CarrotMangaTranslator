import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  createChildExitReceipt,
  forceTerminateChildProcessTree,
  shouldSpawnInOwnProcessGroup,
} from "../runtimeSupport/processTreeTermination";

const execute = promisify(execFile);
export async function findTailscaleBinary(): Promise<string> {
  const override = process.env.CARROT_TAILSCALE_PATH;
  const candidates = override
    ? [override]
    : process.platform === "win32"
      ? [
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Tailscale",
            "tailscale.exe",
          ),
        ]
      : [
          "/usr/bin/tailscale",
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate))
      throw new Error("The Tailscale executable path must be absolute.");
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  throw new Error("Tailscale을 설치하고 로그인한 뒤 다시 시도하세요.");
}
export async function tailscaleJson(
  binary: string,
  args: string[],
): Promise<unknown> {
  const { stdout } = await execute(binary, args, {
    windowsHide: true,
    shell: false,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}
/** Own only this foreground CLI process. Never stop tailscaled or reset Serve. */
export function spawnTailscale(binary: string, port: number) {
  if (
    !isAbsolute(binary) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid Tailscale executable or local port.");
  const child = spawn(
    binary,
    ["funnel", "--https=443", `http://127.0.0.1:${port}`],
    {
      shell: false,
      windowsHide: true,
      detached: shouldSpawnInOwnProcessGroup(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let failure: Error | undefined;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const receipt = createChildExitReceipt(child);
  child.on("error", (error) => {
    failure = error;
  });
  const receive = (bytes: Buffer) => {
    output = (output + bytes.toString("utf8")).slice(-8192);
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  return {
    output: () => output,
    assertAlive: () => {
      if (failure || receipt.hasExited())
        throw new Error("Tailscale Funnel 연결이 종료되었습니다.", {
          cause: failure,
        });
    },
    onUnexpectedExit: (callback: () => void) => {
      void receipt.promise.then(() => {
        if (!stopping) callback();
      });
    },
    close: (): Promise<void> => {
      stopping = true;
      closePromise ??= forceTerminateChildProcessTree(child).then(
        () => undefined,
        (error) => {
          // Keep the error visible but permit an explicit local shutdown retry.
          closePromise = undefined;
          throw error;
        },
      );
      return closePromise;
    },
  };
}
