import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { createAbortError, throwIfAborted } from "../abortSignal";
import { inspectImportImageFiles } from "./importImages";

const IMPORT_RUNNER_DIRECTORY = "mgt-import-source-runner";
const IMPORT_RUNNER_EXECUTABLE =
  process.platform === "win32"
    ? "mgt-import-source-runner.exe"
    : "mgt-import-source-runner";
const IMPORT_RUNNER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const importRunnerPageSchema = z
  .object({
    name: z.string().min(1).max(4_096),
    relativePath: z.string().regex(/^page-\d{6}\.(?:png|jpg|webp)$/),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    width: z.number().int().positive().max(65_535).nullable().optional(),
    height: z.number().int().positive().max(65_535).nullable().optional(),
  })
  .strict();
const importRunnerManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["pdf", "rar"]),
    pages: z.array(importRunnerPageSchema).min(1).max(2_000),
  })
  .strict();

type ImportRunnerManifest = z.infer<typeof importRunnerManifestSchema>;
const importRunnerProgressSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("progress"),
    current: z.number().int().nonnegative(),
    total: z.number().int().positive().max(2_000),
    unit: z.literal("items"),
  })
  .strict();
export type ImportSourceProgress = z.infer<typeof importRunnerProgressSchema>;
export type ImportSourceRunnerKind = ImportRunnerManifest["kind"];

export type StagedImportSource = {
  kind: ImportSourceRunnerKind;
  pages: Array<{
    name: string;
    filePath: string;
  }>;
  cleanup: () => Promise<void>;
};

export async function stageImportSource(
  kind: ImportSourceRunnerKind,
  inputPath: string,
  options: {
    executablePath?: string;
    onProgress?: (progress: ImportSourceProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<StagedImportSource> {
  throwIfAborted(options.signal);
  const executablePath = options.executablePath ?? resolveImportSourceRunner();
  if (!executablePath) {
    throw new Error(
      "가져오기 도우미를 찾을 수 없습니다: " +
        IMPORT_RUNNER_DIRECTORY +
        "/" +
        IMPORT_RUNNER_EXECUTABLE,
    );
  }
  const sourceInfo = await stat(inputPath);
  if (!sourceInfo.isFile()) {
    throw new Error("가져오기 원본이 파일이 아닙니다: " + basename(inputPath));
  }
  const stagingRoot = await mkdtemp(
    join(tmpdir(), "mgt-import-source-preview-"),
  );
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(stagingRoot, { recursive: true, force: true });
  };

  try {
    const stdout = await runImportSourceRunner(
      executablePath,
      [kind, "--input", inputPath, "--output", stagingRoot],
      options.signal,
      options.onProgress,
    );
    const manifest = importRunnerManifestSchema.parse(
      JSON.parse(stdout) as unknown,
    );
    if (manifest.kind !== kind) {
      throw new Error(
        "가져오기 도우미 형식 불일치: " +
          manifest.kind +
          " (예상: " +
          kind +
          ")",
      );
    }
    const pages = await validateStagedImport(stagingRoot, manifest);
    return { kind, pages, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function resolveImportSourceRunner(): string | null {
  const explicit = process.env.MGT_IMPORT_SOURCE_RUNNER;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    resourcesPath
      ? join(
          resourcesPath,
          "tools",
          IMPORT_RUNNER_DIRECTORY,
          IMPORT_RUNNER_EXECUTABLE,
        )
      : undefined,
    join(
      process.cwd(),
      "tools",
      IMPORT_RUNNER_DIRECTORY,
      IMPORT_RUNNER_EXECUTABLE,
    ),
    join(
      process.cwd(),
      "tools",
      IMPORT_RUNNER_DIRECTORY,
      "target",
      "release",
      IMPORT_RUNNER_EXECUTABLE,
    ),
    join(
      process.cwd(),
      "tools",
      IMPORT_RUNNER_DIRECTORY,
      "target",
      "debug",
      IMPORT_RUNNER_EXECUTABLE,
    ),
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && existsSync(candidate),
    ) ?? null
  );
}

async function validateStagedImport(
  stagingRoot: string,
  manifest: ImportRunnerManifest,
): Promise<StagedImportSource["pages"]> {
  const expectedNames = new Set(
    manifest.pages.map((page) => page.relativePath),
  );
  if (expectedNames.size !== manifest.pages.length) {
    throw new Error("가져오기 도우미가 중복 페이지 경로를 반환했습니다.");
  }
  const actualEntries = await readdir(stagingRoot, {
    withFileTypes: true,
  });
  if (
    actualEntries.length !== expectedNames.size ||
    actualEntries.some(
      (entry) => !entry.isFile() || !expectedNames.has(entry.name),
    )
  ) {
    throw new Error("가져오기 도우미 출력 파일 목록이 올바르지 않습니다.");
  }

  const filePaths: string[] = [];
  for (const page of manifest.pages) {
    const filePath = resolve(stagingRoot, page.relativePath);
    if (!isSameOrDescendant(stagingRoot, filePath)) {
      throw new Error("가져오기 도우미 출력 경로가 임시 폴더를 벗어났습니다.");
    }
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("가져오기 도우미 출력이 일반 파일이 아닙니다.");
    }
    if (info.size !== page.byteLength) {
      throw new Error("가져오기 도우미 출력 크기가 매니페스트와 다릅니다.");
    }
    filePaths.push(filePath);
  }

  const inspected = await inspectImportImageFiles(filePaths);
  if (
    inspected.excludedFilePaths.length > 0 ||
    inspected.filePaths.length !== filePaths.length
  ) {
    throw new Error("변환된 페이지 중 올바르지 않은 이미지가 있습니다.");
  }
  return manifest.pages.map((page, index) => ({
    name: safePageName(page.name, index, manifest.kind),
    filePath: join(stagingRoot, page.relativePath),
  }));
}

function safePageName(
  sourceName: string,
  index: number,
  kind: ImportSourceRunnerKind,
): string {
  if (kind === "pdf") {
    return "page-" + String(index + 1).padStart(6, "0") + ".png";
  }
  const normalized = sourceName
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "_");
  const name = normalized.split("/").at(-1) || "page-" + String(index + 1);
  if (name.length <= 260) {
    return name;
  }
  const extension = extname(name).slice(0, 12);
  return name.slice(0, 260 - extension.length) + extension;
}

function isSameOrDescendant(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function runImportSourceRunner(
  executablePath: string,
  args: string[],
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const stderrDecoder = new StringDecoder("utf8");
    let stderrPending = "";

    const settle = (error?: Error, stdout?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolvePromise(stdout ?? "");
      }
    };
    const stopForOutputLimit = (): void => {
      child.kill();
      settle(new Error("가져오기 도우미 출력이 허용 크기를 넘었습니다."));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stopForOutputLimit();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
      }
      stderrPending = consumeRunnerProgressChunk(
        stderrPending,
        stderrDecoder.write(chunk),
        onProgress,
      );
    });
    child.once("error", (error) => settle(error));
    child.once("close", (code, terminatedBySignal) => {
      if (settled) return;
      stderrPending += stderrDecoder.end();
      emitRunnerProgress(stderrPending, onProgress);
      settleRunnerClose(
        code,
        terminatedBySignal,
        stderrChunks,
        stdoutChunks,
        settle,
      );
    });
    const onAbort = (): void => {
      child.kill();
      settle(createAbortError("가져오기가 취소되었습니다."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      child.kill();
      settle(new Error("PDF/RAR 가져오기 시간이 초과되었습니다."));
    }, IMPORT_RUNNER_TIMEOUT_MS);
  });
}

function consumeRunnerProgressChunk(
  pending: string,
  chunk: string,
  onProgress?: (progress: ImportSourceProgress) => void,
): string {
  const lines = (pending + chunk).split(/\r?\n/);
  const nextPending = lines.pop() ?? "";
  for (const line of lines) emitRunnerProgress(line, onProgress);
  return nextPending;
}

function settleRunnerClose(
  code: number | null,
  terminatedBySignal: string | null,
  stderrChunks: Buffer[],
  stdoutChunks: Buffer[],
  settle: (error?: Error, stdout?: string) => void,
): void {
  const stderr = stripRunnerProgressLines(
    Buffer.concat(stderrChunks).toString("utf8"),
  ).trim();
  if (code === 0) {
    settle(undefined, Buffer.concat(stdoutChunks).toString("utf8"));
    return;
  }
  settle(
    new Error(
      stderr ||
        `가져오기 도우미가 실패했습니다 (code=${String(code)}, signal=${String(
          terminatedBySignal ?? "none",
        )})`,
    ),
  );
}

const IMPORT_RUNNER_PROGRESS_PREFIX = "MGT_PROGRESS ";

function emitRunnerProgress(
  line: string,
  onProgress?: (progress: ImportSourceProgress) => void,
): void {
  if (!onProgress || !line.startsWith(IMPORT_RUNNER_PROGRESS_PREFIX)) return;
  try {
    onProgress(
      importRunnerProgressSchema.parse(
        JSON.parse(line.slice(IMPORT_RUNNER_PROGRESS_PREFIX.length)),
      ),
    );
  } catch (_error) {
    // error-policy-allow: malformed advisory progress never changes import semantics.
  }
}

function stripRunnerProgressLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(IMPORT_RUNNER_PROGRESS_PREFIX))
    .join("\n");
}
