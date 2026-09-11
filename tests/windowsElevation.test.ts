import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));

import {
  readWindowsProcessIdentity,
  requestWindowsElevation,
} from "../src/main/windowsElevation";

afterEach(() => {
  vi.unstubAllEnvs();
  execFileSync.mockReset();
});

function lastScript(): string {
  const call = execFileSync.mock.calls.at(-1);
  if (!call) throw new Error("PowerShell was not invoked.");
  return Buffer.from(call[1].at(-1), "base64").toString("utf16le");
}

function decodedRequest(): {
  executablePath: string;
  arguments: string;
  workingDirectory: string;
} {
  const match = lastScript().match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  if (!match) throw new Error("Missing encoded elevation payload.");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function prepareResult(result: unknown): void {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  execFileSync.mockReturnValue(JSON.stringify(result));
}

const request = {
  executablePath: "C:\\Program Files\\당근 번역기\\CarrotMangaTranslator.exe",
  workingDirectory: "D:\\작업 폴더",
  arguments: ["--updated"],
};

describe("Windows elevation process boundary", () => {
  it("checks the current token through system PowerShell with a bounded timeout", () => {
    prepareResult({ sid: "S-1-5-21-42", elevated: false });
    expect(readWindowsProcessIdentity()).toEqual({
      sid: "S-1-5-21-42",
      elevated: false,
    });
    expect(execFileSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        expect.any(String),
      ],
      expect.objectContaining({
        timeout: 10000,
        windowsHide: true,
        encoding: "utf8",
      }),
    );
    expect(lastScript()).toContain("$principal.IsInRole");
    expect(lastScript()).not.toContain("-ExecutionPolicy");
  });

  it.each([
    null,
    {},
    { sid: "not-a-sid", elevated: true },
    { sid: "S-1-5-21-42", elevated: "true" },
  ])("rejects malformed identity results: %j", (value) => {
    prepareResult(value);
    expect(() => readWindowsProcessIdentity()).toThrow("invalid process identity");
  });

  it("preserves Unicode paths and quotes arguments without interpolating them as code", () => {
    prepareResult({ status: "launched" });
    const arguments_ = [
      "",
      "plain",
      "a b",
      'say "hello"',
      "C:\\folder\\",
      "$x; & calc.exe | echo 'not code'",
    ];
    expect(requestWindowsElevation({ ...request, arguments: arguments_ })).toBe(
      "launched",
    );
    expect(decodedRequest()).toEqual({
      executablePath: request.executablePath,
      workingDirectory: request.workingDirectory,
      arguments: [
        '""',
        '"plain"',
        '"a b"',
        '"say \\"hello\\""',
        '"C:\\folder\\\\"',
        '"$x; & calc.exe | echo \'not code\'"',
      ].join(" "),
    });
    expect(lastScript()).toContain("$start.UseShellExecute = $true");
    expect(lastScript()).toContain("$start.Verb = 'runas'");
    expect(lastScript()).not.toContain("calc.exe");
    expect(execFileSync.mock.calls[0][2].timeout).toBeUndefined();
  });

  it("returns cancellation without starting a retry", () => {
    prepareResult({ status: "cancelled" });
    expect(requestWindowsElevation(request)).toBe("cancelled");
    expect(lastScript()).toContain("$failure.NativeErrorCode -eq 1223");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { status: "failed" }])(
    "does not mistake malformed process results for a successful launch: %j",
    (value) => {
      prepareResult(value);
      expect(() => requestWindowsElevation(request)).toThrow(
        "invalid elevation result",
      );
    },
  );

  it.each(["relative.exe", "C:relative.exe", "\\relative.exe", "C:\\bad\0.exe"])(
    "rejects non-qualified or invalid executable paths: %s",
    (executablePath) => {
      prepareResult({ status: "launched" });
      expect(() =>
        requestWindowsElevation({ ...request, executablePath }),
      ).toThrow("fully qualified path");
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it("rejects NUL arguments before invoking a process", () => {
    prepareResult({ status: "launched" });
    expect(() =>
      requestWindowsElevation({ ...request, arguments: ["bad\0argument"] }),
    ).toThrow("NUL");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("fails without a system directory instead of looking up PowerShell on PATH", () => {
    vi.stubEnv("SystemRoot", "");
    vi.stubEnv("WINDIR", "");
    expect(() => readWindowsProcessIdentity()).toThrow(
      "system directory is unavailable",
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("propagates process failures instead of reporting cancellation or success", () => {
    prepareResult(null);
    execFileSync.mockImplementation(() => {
      throw new Error("PowerShell denied by policy");
    });
    expect(() => requestWindowsElevation(request)).toThrow(
      "PowerShell denied by policy",
    );
  });
});
