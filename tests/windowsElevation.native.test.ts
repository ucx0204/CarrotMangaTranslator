import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readWindowsProcessIdentity,
  requestWindowsElevation,
} from "../src/main/windowsElevation";

describe.skipIf(process.platform !== "win32")("native Windows elevation", () => {
  it("reads the real Windows process identity without mocking PowerShell", () => {
    const identity = readWindowsProcessIdentity();
    expect(identity.sid).toMatch(/^S-1-\d+(?:-\d+)+$/);
    expect(typeof identity.elevated).toBe("boolean");
  }, 15000);

  it("round-trips arguments through real runas on an already elevated runner", async ({ skip }) => {
    // Never display a UAC prompt during a developer's ordinary test run.
    if (!readWindowsProcessIdentity().elevated) return skip();
    const root = mkdtempSync(join(tmpdir(), "carrot-uac-한글 공백-"));
    const marker = join(root, "result.json");
    const script = join(root, "child.cjs");
    const expected = [
      "",
      "plain",
      "한글 日本語 a b",
      'embedded "quote"',
      "C:\\trailing slash\\",
      "$x; & echo 'not shell code' | more",
    ];
    try {
      writeFileSync(
        script,
        `const fs = require('node:fs');\n` +
          `const target = ${JSON.stringify(marker)};\n` +
          `fs.writeFileSync(target + '.tmp', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n` +
          `fs.renameSync(target + '.tmp', target);\n`,
      );
      expect(
        requestWindowsElevation({
          executablePath: process.execPath,
          workingDirectory: root,
          arguments: [script, ...expected],
        }),
      ).toBe("launched");
      await vi.waitFor(
        () => {
          const result = JSON.parse(readFileSync(marker, "utf8"));
          expect(result.args).toEqual(expected);
          expect(result.cwd.toLowerCase()).toBe(root.toLowerCase());
        },
        { timeout: 15000, interval: 100 },
      );
    } finally {
      // Only this test's freshly allocated temporary directory is removed.
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      });
    }
  }, 30000);
});
