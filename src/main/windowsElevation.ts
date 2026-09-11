import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

export type WindowsProcessIdentity = {
  sid: string;
  elevated: boolean;
};

export type WindowsElevationRequest = {
  executablePath: string;
  arguments: readonly string[];
  workingDirectory: string;
};

/** WindowsPrincipal tests the current token, not mere account membership. */
export function readWindowsProcessIdentity(): WindowsProcessIdentity {
  const result: unknown = runPowerShell(
    [
      "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
      "try {",
      "  $principal = [Security.Principal.WindowsPrincipal]::new($identity)",
      "  @{ sid = $identity.User.Value; elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress",
      "} finally { $identity.Dispose() }",
    ].join("\n"),
    10000,
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("sid" in result) ||
    typeof result.sid !== "string" ||
    !/^S-\d+(?:-\d+)+$/.test(result.sid) ||
    !("elevated" in result) ||
    typeof result.elevated !== "boolean"
  ) {
    throw new Error("Windows returned an invalid process identity.");
  }
  return { sid: result.sid, elevated: result.elevated };
}

/**
 * Use Windows ShellExecute through .NET, without cmd.exe, a PATH lookup,
 * temporary scripts, execution-policy changes, or interpolated user text.
 */
export function requestWindowsElevation(
  request: WindowsElevationRequest,
): "launched" | "cancelled" {
  assertAbsoluteWindowsPath(request.executablePath);
  assertAbsoluteWindowsPath(request.workingDirectory);
  const payload = Buffer.from(
    JSON.stringify({
      executablePath: request.executablePath,
      arguments: request.arguments.map(quoteWindowsArgument).join(" "),
      workingDirectory: request.workingDirectory,
    }),
    "utf8",
  ).toString("base64");
  const result: unknown = runPowerShell(
    [
      `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
      "$start = [Diagnostics.ProcessStartInfo]::new()",
      "$start.FileName = $request.executablePath",
      "$start.Arguments = $request.arguments",
      "$start.WorkingDirectory = $request.workingDirectory",
      "$start.UseShellExecute = $true",
      "$start.Verb = 'runas'",
      "try {",
      "  $child = [Diagnostics.Process]::Start($start)",
      "  if ($null -eq $child) { throw 'Windows did not return a launched process.' }",
      "  $child.Dispose()",
      "  @{ status = 'launched' } | ConvertTo-Json -Compress",
      "} catch {",
      "  $failure = $_.Exception",
      "  while ($null -ne $failure -and $failure -isnot [ComponentModel.Win32Exception]) { $failure = $failure.InnerException }",
      "  if ($null -ne $failure -and $failure.NativeErrorCode -eq 1223) {",
      "    @{ status = 'cancelled' } | ConvertTo-Json -Compress",
      "  } else { throw }",
      "}",
    ].join("\n"),
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("status" in result) ||
    (result.status !== "launched" && result.status !== "cancelled")
  ) {
    throw new Error("Windows returned an invalid elevation result.");
  }
  return result.status;
}

function quoteWindowsArgument(argument: string): string {
  if (argument.includes("\0")) {
    throw new Error("Windows process arguments cannot contain NUL characters.");
  }
  // CRT/CommandLineToArgvW quoting: double backslashes before a quote and
  // before the closing quote. Shell metacharacters are data, never commands.
  const escaped = argument
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/, (slashes) => `${slashes}${slashes}`);
  return `"${escaped}"`;
}

function assertAbsoluteWindowsPath(path: string): void {
  if (
    !win32.isAbsolute(path) ||
    !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path) ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error("Windows elevation requires a fully qualified path.");
  }
}

function runPowerShell(script: string, timeout?: number): unknown {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) {
    throw new Error("The Windows system directory is unavailable.");
  }
  assertAbsoluteWindowsPath(systemRoot);
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedCommand = Buffer.from(
    "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" +
      script,
    "utf16le",
  ).toString("base64");
  if (encodedCommand.length > 30000) {
    throw new Error("The Windows elevation command line is too long.");
  }
  // Do not time out an interactive UAC request: approval could otherwise start
  // the child after its parent has already reported failure. Identity reads
  // have a bounded timeout; interactive relaunches return only on an outcome.
  const output = execFileSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 65536 },
  );
  return JSON.parse(output.trim()) as unknown;
}
