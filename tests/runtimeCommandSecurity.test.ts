import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandSpec = {
  executable: string;
  args: string[];
};

type CommandError = Error & {
  command?: string;
  executable?: string;
  args?: string[];
  timeoutMs?: number;
};

const { runCommand } =
  require("../src/main/runtime/simple-page-shell-utils.cjs") as {
    runCommand: (
      command: CommandSpec,
      options?: {
        failureMessage?: string;
        onOutput?: (line: string) => void;
        signal?: AbortSignal;
        successCodes?: number[];
        timeoutMessage?: string;
        timeoutMs?: number;
      },
    ) => Promise<{ stdout: string; stderr: string }>;
  };

const { buildOcrBboxCommand } =
  require("../src/main/runtime/simple-page-ocr-commands.cjs") as {
    buildOcrBboxCommand: (
      options: Record<string, unknown>,
      provider: string,
      outputPath: string,
      runtime?: { pythonPath?: string } | null,
    ) => CommandSpec;
  };

const { buildOcrPipInstallCommand } =
  require("../src/main/runtime/ocr/runtime-installer.cjs") as {
    buildOcrPipInstallCommand: (
      pythonPath: string,
      packages: string[],
      targetDir: string | null,
      options?: Record<string, unknown>,
      pipProgressArgs?: string[],
    ) => CommandSpec;
  };

function buildExternalCommand(
  command: CommandSpec,
  options: Record<string, unknown> = {},
): CommandSpec {
  return buildOcrBboxCommand(
    {
      imagePath: "page.png",
      ...options,
      ocrBboxCommand: JSON.stringify(command),
    },
    "external-command",
    "out.json",
    null,
  );
}

function collectRuntimeSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRuntimeSourceFiles(fullPath));
      continue;
    }
    if (/\.(?:cjs|mjs|js|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("runtime command security", () => {
  it("passes shell metacharacters as one literal argv value", async () => {
    const root = mkdtempSync(join(tmpdir(), "mgt-command-security-"));
    const outputPath = join(root, "argv.json");
    const markerPath = join(root, "MUST_NOT_EXIST");
    const malicious =
      process.platform === "win32"
        ? `literal & echo injected > "${markerPath}" | rem`
        : `literal$(touch "${markerPath}")` +
          "`" +
          `touch "${markerPath}"` +
          "`" +
          `; touch "${markerPath}"; #`;
    const script = [
      'const fs = require("node:fs");',
      "const outputPath = process.argv[1];",
      "fs.writeFileSync(outputPath, JSON.stringify(process.argv.slice(2)));",
    ].join(" ");

    try {
      await runCommand({
        executable: process.execPath,
        args: ["-e", script, outputPath, malicious],
      });

      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual([malicious]);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves malicious-looking OCR paths as exact argv elements", () => {
    const pythonPath = "C:/Python path/python.exe";
    const imagePath = 'folder with spaces/"quoted"/page$(touch injected)&.png';
    const outputPath = "out & whoami | literal.json";
    const command = buildOcrBboxCommand(
      { imagePath, ocrDevice: "cpu" },
      "paddleocr-vl",
      outputPath,
      { pythonPath },
    );

    expect(command.executable).toBe(pythonPath);
    expect(command.args[command.args.indexOf("--image") + 1]).toBe(imagePath);
    expect(command.args[command.args.indexOf("--output") + 1]).toBe(outputPath);
    expect(command.args).toContain(imagePath);
    expect(command.args).toContain(outputPath);
  });

  it("rejects legacy external OCR shell command strings", () => {
    expect(() =>
      buildOcrBboxCommand(
        {
          imagePath: "page.png",
          ocrBboxCommand: "python tool.py --image {image} --output {output}",
        },
        "external-command",
        "out.json",
        null,
      ),
    ).toThrow(/no longer accepts a shell command string|JSON object/i);
  });

  it("expands a safe JSON external OCR command by argv element", () => {
    const maliciousPath = "page$(touch injected) & literal.png";
    const outputPath = "folder with spaces/out.json";
    const command = buildOcrBboxCommand(
      {
        imagePath: maliciousPath,
        sourceLanguage: "en",
        ocrBboxCommand: JSON.stringify({
          executable: process.execPath,
          args: [
            "adapter.js",
            "--image",
            "{image}",
            "--output",
            "{output}",
            "--source-language",
            "{sourceLanguage}",
          ],
        }),
      },
      "external-command",
      outputPath,
      null,
    );

    expect(command).toEqual({
      executable: process.execPath,
      args: [
        "adapter.js",
        "--image",
        maliciousPath,
        "--output",
        outputPath,
        "--source-language",
        "en",
      ],
    });
  });

  it("rejects embedded and unknown external OCR placeholders", () => {
    expect(() =>
      buildExternalCommand({
        executable: "python",
        args: ["--image={image}"],
      }),
    ).toThrow(/separate argv element/i);

    expect(() =>
      buildExternalCommand({
        executable: "python",
        args: ["{unknown}"],
      }),
    ).toThrow(/unknown.*placeholder/i);

    expect(() =>
      buildExternalCommand({
        executable: "python-{image}",
        args: [],
      }),
    ).toThrow(/executable.*placeholder/i);
  });

  it.each(["cmd.exe", "powershell.exe", "/bin/sh", "/bin/bash"])(
    "rejects shell executable %s for external OCR",
    (executable) => {
      expect(() => buildExternalCommand({ executable, args: [] })).toThrow(
        /must not be a shell/i,
      );
    },
  );

  it("preserves pip package URL and target directory argument boundaries", () => {
    const packageUrl =
      "https://example.invalid/package name.whl?x=1&literal=$(whoami)";
    const targetDir = 'C:/OCR target/"quoted" & literal';
    const cacheDir = "C:/pip cache & literal";
    const command = buildOcrPipInstallCommand(
      "C:/Python/python.exe",
      [packageUrl],
      targetDir,
      {},
      ["--cache-dir", cacheDir, "--progress-bar", "raw"],
    );

    expect(command.executable).toBe("C:/Python/python.exe");
    expect(command.args).toContain(packageUrl);
    expect(command.args).toContain(targetDir);
    expect(command.args).toContain(cacheDir);
    expect(command.args[command.args.indexOf("--target") + 1]).toBe(targetDir);
  });

  it("preserves stdout, stderr, and line-oriented output callbacks", async () => {
    const lines: string[] = [];
    const script = [
      'process.stdout.write("alpha\\n");',
      'process.stderr.write("beta\\n");',
    ].join(" ");
    const output = await runCommand(
      { executable: process.execPath, args: ["-e", script] },
      { onOutput: (line) => lines.push(line) },
    );

    expect(output.stdout).toContain("alpha");
    expect(output.stderr).toContain("beta");
    expect(lines).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("supports custom success codes", async () => {
    await expect(
      runCommand(
        {
          executable: process.execPath,
          args: ["-e", "process.exit(7)"],
        },
        { successCodes: [7] },
      ),
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("aborts a running child with AbortError", async () => {
    const controller = new AbortController();
    const promise = runCommand(
      {
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out a running child and reports the structured command", async () => {
    const command = {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    } satisfies CommandSpec;

    try {
      await runCommand(command, {
        timeoutMs: 50,
        timeoutMessage: "security timeout",
      });
      throw new Error("Expected timeout");
    } catch (error) {
      const commandError = error as CommandError;
      expect(commandError.message).toBe("security timeout");
      expect(commandError.executable).toBe(command.executable);
      expect(commandError.args).toEqual(command.args);
      expect(commandError.timeoutMs).toBe(50);
      expect(commandError.command).toContain(JSON.stringify(process.execPath));
    }
  });

  it("keeps forbidden shell execution symbols out of runtime source", () => {
    const runtimeRoot = join(process.cwd(), "src", "main", "runtime");
    const forbidden = [
      { label: "shell true", pattern: /shell\s*:\s*true/ },
      { label: "legacy runner", pattern: /\brunShellCommand\b/ },
      { label: "quote helper", pattern: /\bquoteCommandArg\b/ },
      { label: "template helper", pattern: /\brenderCommandTemplate\b/ },
    ];
    const offenders: string[] = [];

    for (const filePath of collectRuntimeSourceFiles(runtimeRoot)) {
      const text = readFileSync(filePath, "utf8");
      for (const check of forbidden) {
        if (check.pattern.test(text)) {
          offenders.push(`${check.label}: ${filePath}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
