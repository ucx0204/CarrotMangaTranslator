import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  forceTerminateChildProcessTree,
  shouldSpawnInOwnProcessGroup,
} from "../runtimeSupport/processTreeTermination";
import {
  assertTailscaleListenerFree,
  readTailscaleOrigin,
  readTailscaleSetupUrl,
} from "./mcpTailscalePolicy";
const run = promisify(execFile);
export type McpTunnelLease = { close: () => Promise<void> };

/** Installed Tailscale only. No installer, login, global reset or provider fallback is executed. */
export async function inspectMcpTailscale(signal: AbortSignal) {
  const executable = await findExecutable();
  const status = await readJson(executable, ["status", "--json"], signal);
  const origin = readTailscaleOrigin(status);
  assertTailscaleListenerFree(
    await readJson(executable, ["serve", "status", "--json"], signal),
  );
  return { executable, origin };
}
export function startMcpFunnel(
  executable: string,
  port: number,
  onSetup: (url: string) => void,
  onFailure: (error: Error) => void,
): McpTunnelLease {
  const child = spawn(
    executable,
    ["funnel", "--https=443", "--yes", `http://127.0.0.1:${port}`],
    {
      shell: false,
      windowsHide: true,
      detached: shouldSpawnInOwnProcessGroup(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stopping = false;
  let closing: Promise<void> | undefined;
  let output = "";
  const observe = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-8192);
    const url = readTailscaleSetupUrl(output);
    if (url) onSetup(url);
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  child.on("error", (error) => {
    if (!stopping)
      onFailure(
        new Error("Could not start the installed Tailscale CLI.", {
          cause: error,
        }),
      );
  });
  child.once("exit", () => {
    if (!stopping)
      onFailure(
        new Error(
          "Tailscale Funnel stopped. Reconnect Tailscale and enable MCP again.",
        ),
      );
  });
  return {
    close: () => {
      stopping = true;
      closing ??= forceTerminateChildProcessTree(child).then(() => undefined);
      return closing;
    },
  };
}
export async function waitForMcpFunnel(
  origin: string,
  signal: AbortSignal,
): Promise<void> {
  let failure: unknown;
  // retry-policy-allow: the owned foreground Funnel needs time to obtain HTTPS and publish DNS; bounded and abortable.
  for (let attempt = 0; attempt < 20; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(
        `${origin}/.well-known/oauth-protected-resource/mcp`,
        {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        },
      );
      const text = await response.text();
      if (!response.ok || text.length > 16384)
        throw new Error("Funnel discovery did not respond correctly.");
      const body = JSON.parse(text);
      if (
        body.resource !== `${origin}/mcp` ||
        body.authorization_servers?.[0] !== origin
      )
        throw new Error("Funnel identity does not match this app.");
      return;
    } catch (error) {
      failure = error;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(
    "Tailscale public HTTPS is not ready. Check Funnel permission, MagicDNS, HTTPS and network connectivity.",
    { cause: failure },
  );
}
async function readJson(
  executable: string,
  args: string[],
  signal: AbortSignal,
): Promise<unknown> {
  const result = await run(executable, args, {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
    signal,
  });
  return JSON.parse(result.stdout);
}
async function findExecutable(): Promise<string> {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "Tailscale",
            "tailscale.exe",
          ),
        ]
      : [
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
          "/usr/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
  }
  throw new Error(
    "Install Tailscale from its official download page, sign in, then try again.",
  );
}
