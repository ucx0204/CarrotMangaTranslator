import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(__dirname, "..");
const installer = readFileSync(join(root, "build/installer.nsh"), "utf8");
const removal = readFileSync(
  join(root, "build/windows-uninstall-elevation.nsh"),
  "utf8",
);
const { nsisTemplatesDir } =
  require("app-builder-lib/out/targets/nsis/nsisUtil") as {
    nsisTemplatesDir: string;
  };
const { copyTemplateDirectory, patchNsisTemplates } =
  require("../scripts/build-windows-installer.cjs") as {
    copyTemplateDirectory: (source: string, destination: string) => void;
    patchNsisTemplates: (directory: string) => void;
  };

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Windows installer permission policy", () => {
  it("elevates setup without elevating the uninstaller-generation executable", () => {
    const header = section(installer, "!macro customHeader", "!macroend");
    expect(header).toMatch(
      /!ifndef BUILD_UNINSTALLER[\s\S]*RequestExecutionLevel admin[\s\S]*!endif/,
    );
    expect(removal).toContain("!macro customUnInit");
    expect(removal).toContain('ExecShellWait "runas"');
    expect(installer).toContain(
      '!include "${__FILEDIR__}\\windows-uninstall-elevation.nsh"',
    );
  });

  it("retains the builder's unelevated finish-page application launch", () => {
    const assisted = readFileSync(
      join(nsisTemplatesDir, "assistedInstaller.nsh"),
      "utf8",
    );
    const start = section(assisted, "Function StartApp", "FunctionEnd");
    expect(start).toContain("${StdUtils.ExecShellAsUser}");
    expect(installer).not.toContain("!macro customFinishPage");
  });

  it("validates new directories lexically before creating or writing them", () => {
    const preflight = section(
      installer,
      "Function MgtPrepareDataRoot",
      "FunctionEnd",
    );
    expect(preflight).not.toMatch(/^\s*GetFullPathName /m);
    expect(preflight.match(/kernel32::GetFullPathNameW/g)).toHaveLength(2);
    expect(preflight).toContain("$4 >= ${NSIS_MAX_STRLEN}");
    const pinned = preflight.indexOf('StrCpy $MgtDataRoot "$1"');
    expect(pinned).toBeGreaterThan(0);
    expect(preflight.indexOf("Call MgtProbeDataRootWriteAccess")).toBeGreaterThan(
      pinned,
    );
  });

  it("checks destination writes before removing the existing application", () => {
    const temporary = mkdtempSync(join(tmpdir(), "mgt-uac-templates-"));
    try {
      copyTemplateDirectory(nsisTemplatesDir, temporary);
      patchNsisTemplates(temporary);
      const patched = readFileSync(
        join(temporary, "installSection.nsh"),
        "utf8",
      );
      const prepare = patched.indexOf("Call MgtPrepareDataRoot");
      const remove = patched.indexOf(
        "!insertmacro uninstallOldVersion SHELL_CONTEXT",
      );
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(remove).toBeGreaterThan(prepare);
      const preflight = section(
        installer,
        "Function MgtPrepareDataRoot",
        "FunctionEnd",
      );
      expect(preflight).toContain("Call MgtResolveInitialDataRoot");
      expect(preflight).toContain("Call MgtProbeDataRootWriteAccess");
      expect(preflight).toContain("Call MgtValidateDataRootWriteAccess");
      expect(preflight).toContain("SetErrorLevel 2");
      expect(preflight).toContain("${GetRoot}");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("stages a new pointer instead of truncating the user's existing pointer", () => {
    const write = section(
      installer,
      "Function MgtWriteDataRootPointer",
      "FunctionEnd",
    );
    expect(write).toContain('GetTempFileName $9 "$INSTDIR"');
    expect(write).toContain('FileOpen $0 "$9" w');
    expect(write).toContain("kernel32::MoveFileExW");
    expect(write).toContain("i 9) i.r0");
    expect(write).not.toContain('FileOpen $0 "$INSTDIR\\data-root.txt" w');
    expect(write).not.toContain('Delete "$INSTDIR\\data-root.txt"');
    expect(write).toContain("MgtPointerWriteFailed:");
    expect(write).toContain("SetErrorLevel 2");
  });

  it("does not widen program directory permissions or globally elevate the app", () => {
    const config = require("../electron-builder.config.cjs") as {
      win: { requestedExecutionLevel?: string };
      nsis: { perMachine: boolean; allowElevation?: boolean };
    };
    expect(config.win.requestedExecutionLevel ?? "asInvoker").toBe("asInvoker");
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.allowElevation ?? true).toBe(true);
    expect(installer).not.toMatch(/icacls|AccessControl::GrantOnFile/i);
    expect(removal).not.toMatch(/icacls|AccessControl::GrantOnFile/i);
  });

  it("preserves uninstall scope and verifies the elevated account before deletion", () => {
    expect(removal).toContain('StrCpy $R1 "/currentuser"');
    expect(removal).toContain('StrCpy $R1 "/allusers"');
    expect(removal).toContain("WindowsIdentity]::GetCurrent().User.Value");
    expect(removal).toContain(
      "${If} $MgtUninstallOriginalSid != $MgtUninstallCurrentSid",
    );
    expect(removal).toContain("${IfNot} ${UAC_IsAdmin}");
    expect(removal).toContain("자동으로 다시 요청하지 않습니다");
    const launch = removal.indexOf('ExecShellWait "runas"');
    expect(launch).toBeGreaterThan(
      removal.indexOf("$MgtUninstallOriginalSid != $MgtUninstallCurrentSid"),
    );
    expect(removal.slice(launch)).toMatch(
      /\$\{If\} \$\{Errors\}[\s\S]*SetErrorLevel 2\s+Quit/,
    );
    expect(removal).not.toMatch(/RMDir|Delete /);
  });
});
