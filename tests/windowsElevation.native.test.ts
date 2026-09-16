import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readWindowsProcessIdentity,
  requestWindowsElevation,
} from "../src/main/windowsElevation";

describe.skipIf(process.platform !== "win32")(
  "native Windows elevation",
  () => {
    it("reads the real Windows process identity without mocking PowerShell", () => {
      const identity = readWindowsProcessIdentity();
      expect(identity.sid).toMatch(/^S-1-\d+(?:-\d+)+$/);
      expect(typeof identity.elevated).toBe("boolean");
    }, 15000);

    it("retries cleanup until a native Windows cwd lock is released", async () => {
      const root = mkdtempSync(join(tmpdir(), "carrot-uac-cleanup-"));
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
        { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = once(child, "close");
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!child.stdout) throw new Error("Missing fixture stdout");
        await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
        expect(() => rmdirSync(root)).toThrowError(
          expect.objectContaining({
            code: expect.stringMatching(/^(EBUSY|EPERM)$/),
          }),
        );
        release = setTimeout(() => {
          child.kill();
        }, 150);
        await removeElevationFixture(root);
        expect(existsSync(root)).toBe(false);
      } finally {
        clearTimeout(release);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        });
      }
    }, 20000);

    it("round-trips arguments through real runas on an already elevated runner", async ({
      skip,
    }) => {
      // Never display a UAC prompt during a developer's ordinary test run.
      if (!readWindowsProcessIdentity().elevated) return skip();
      const root = mkdtempSync(join(tmpdir(), "carrot-uac-한글 공백-"));
      const marker = join(root, "result.json");
      const script = join(root, "child.cjs");
      let childPid: number | undefined;
      const expected = [
        "",
        "plain",
        "한글 日本語 a b",
        'embedded "quote"',
        "C:\\trailing slash\\",
        "$x; & echo 'not shell code' | more",
      ];
      try {
        // Exercise the interval between result publication and process exit.
        writeFileSync(
          script,
          `const fs = require('node:fs');\n` +
            `const target = ${JSON.stringify(marker)};\n` +
            `fs.writeFileSync(target + '.tmp', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));\n` +
            `fs.renameSync(target + '.tmp', target);\n` +
            `setTimeout(() => {}, 250);\n`,
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
            expect(result.pid).toEqual(expect.any(Number));
            childPid = result.pid;
            expect(result.args).toEqual(expected);
            expect(result.cwd.toLowerCase()).toBe(root.toLowerCase());
          },
          { timeout: 15000, interval: 100 },
        );
      } finally {
        // Publishing the result does not release the child's Windows cwd lock.
        // Wait for that exact process to exit before removing its directory.
        const pid = childPid;
        if (pid !== undefined) {
          await vi.waitFor(
            () =>
              expect(() => process.kill(pid, 0)).toThrowError(
                expect.objectContaining({ code: "ESRCH" }),
              ),
            { timeout: 15000, interval: 100 },
          );
        }
        // Only this test's freshly allocated temporary directory is removed.
        await removeElevationFixture(root);
      }
    }, 30000);
  },
);

// Async rm retries an initial busy-directory failure before scanning children.
async function removeElevationFixture(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
}
