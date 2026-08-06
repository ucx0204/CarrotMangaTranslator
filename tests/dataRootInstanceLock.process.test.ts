import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_ROOT_INSTANCE_LOCK_DIRECTORY,
  DATA_ROOT_INSTANCE_LOCK_OWNER_FILE,
  type DataRootInstanceLockOwner,
} from "../src/main/dataRootInstanceLock";

const workerPath = join(__dirname, "fixtures", "dataRootInstanceLockWorker.ts");
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  }
  children.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("data-root instance lock process integration", () => {
  it("allows exactly one of two competing Node processes to own the data root", async () => {
    const root = makeRoot();
    const first = startWorker(root, "first");
    const second = startWorker(root, "second");

    const [firstResult, secondResult] = await Promise.all([
      waitForResult(first),
      waitForResult(second),
    ]);
    const results = [firstResult, secondResult];
    expect(
      results.filter((result) => result.status === "acquired"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "locked")).toHaveLength(
      1,
    );

    const acquiredIndex = results.findIndex(
      (result) => result.status === "acquired",
    );
    const acquired = acquiredIndex === 0 ? first : second;
    const locked = acquiredIndex === 0 ? second : first;
    const acquiredResult = results[acquiredIndex] as WorkerAcquiredResult;
    expect(readCanonicalOwner(root).token).toBe(acquiredResult.token);

    writeFileSync(acquired.releaseSignalPath, "release");
    expect(await waitForExit(acquired.child)).toBe(0);
    expect(await waitForExit(locked.child)).toBe(20);
    expect(existsSync(lockDirectory(root))).toBe(false);

    const third = startWorker(root, "third");
    const thirdResult = await waitForResult(third);
    expect(thirdResult.status).toBe("acquired");
    writeFileSync(third.releaseSignalPath, "release");
    expect(await waitForExit(third.child)).toBe(0);
    expect(existsSync(lockDirectory(root))).toBe(false);
  }, 30_000);

  it("writes canonical data-root metadata for stale-owner fixtures", () => {
    const root = makeRoot();

    writeDeadCanonicalOwner(root);

    expect(readCanonicalOwner(root).dataRoot).toBe(
      canonicalizeTestDataRoot(root),
    );
  });

  it("serializes two processes racing to reclaim the same stale owner", async () => {
    const root = makeRoot();
    writeDeadCanonicalOwner(root);
    const first = startWorker(root, "first-reclaimer");
    const second = startWorker(root, "second-reclaimer");

    const [firstResult, secondResult] = await Promise.all([
      waitForResult(first),
      waitForResult(second),
    ]);
    const results = [firstResult, secondResult];
    const diagnostic = JSON.stringify(results, null, 2);
    expect(
      results.filter((result) => result.status === "acquired"),
      diagnostic,
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "locked"),
      diagnostic,
    ).toHaveLength(1);

    const acquiredIndex = results.findIndex(
      (result) => result.status === "acquired",
    );
    const acquired = acquiredIndex === 0 ? first : second;
    const locked = acquiredIndex === 0 ? second : first;
    const acquiredResult = results[acquiredIndex] as WorkerAcquiredResult;
    expect(readCanonicalOwner(root).token).toBe(acquiredResult.token);

    writeFileSync(acquired.releaseSignalPath, "release");
    expect(await waitForExit(acquired.child)).toBe(0);
    expect(await waitForExit(locked.child)).toBe(20);
    expect(existsSync(lockDirectory(root))).toBe(false);
  }, 30_000);

  it("recovers a same-host lock left behind after the owner is force-killed", async () => {
    const root = makeRoot();
    const first = startWorker(root, "killed-owner");
    const firstResult = await waitForResult(first);
    expect(firstResult.status).toBe("acquired");
    expect(existsSync(lockDirectory(root))).toBe(true);

    first.child.kill("SIGKILL");
    await waitForExit(first.child);
    expect(existsSync(lockDirectory(root))).toBe(true);

    const successor = startWorker(root, "successor");
    const successorResult = await waitForResult(successor);
    expect(successorResult.status).toBe("acquired");
    expect((successorResult as WorkerAcquiredResult).token).not.toBe(
      (firstResult as WorkerAcquiredResult).token,
    );

    writeFileSync(successor.releaseSignalPath, "release");
    expect(await waitForExit(successor.child)).toBe(0);
    expect(existsSync(lockDirectory(root))).toBe(false);
  }, 30_000);
});

type WorkerAcquiredResult = {
  status: "acquired";
  token: string;
  pid: number;
};

type WorkerLockedResult = {
  status: "locked";
  reason: string;
  ownerToken: string;
  ownerPid: number;
};

type WorkerErrorResult = {
  status: "error";
  message: string;
};

type WorkerResult =
  | WorkerAcquiredResult
  | WorkerLockedResult
  | WorkerErrorResult;

type WorkerHandle = {
  child: ChildProcess;
  resultPath: string;
  releaseSignalPath: string;
  output: { stdout: string; stderr: string };
};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mgt-instance-process-"));
  roots.push(root);
  return root;
}

function canonicalizeTestDataRoot(root: string): string {
  return realpathSync.native(resolve(root));
}

function startWorker(root: string, name: string): WorkerHandle {
  const resultPath = join(root, `${name}-result.json`);
  const releaseSignalPath = join(root, `${name}-release.signal`);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "jiti/register",
      workerPath,
      root,
      resultPath,
      releaseSignalPath,
    ],
    {
      cwd: join(__dirname, ".."),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  if (!child.stdout || !child.stderr) {
    throw new Error("Worker pipes were not created.");
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    output.stdout += value;
  });
  child.stderr.on("data", (value: string) => {
    output.stderr += value;
  });
  children.add(child);
  return { child, resultPath, releaseSignalPath, output };
}

async function waitForResult(handle: WorkerHandle): Promise<WorkerResult> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(handle.resultPath)) {
    if (handle.child.exitCode !== null) {
      throw new Error(
        `Worker exited before writing a result (${handle.child.exitCode}).\n${handle.output.stdout}\n${handle.output.stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for worker result.\n${handle.output.stdout}\n${handle.output.stderr}`,
      );
    }
    await delay(20);
  }
  return JSON.parse(readFileSync(handle.resultPath, "utf8")) as WorkerResult;
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) {
    children.delete(child);
    return child.exitCode;
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  children.delete(child);
  return code;
}

function writeDeadCanonicalOwner(root: string): void {
  const canonicalRoot = canonicalizeTestDataRoot(root);
  const directory = lockDirectory(root);
  mkdirSync(directory);
  const owner: DataRootInstanceLockOwner = {
    schemaVersion: 1,
    token: "dead-owner",
    pid: 2_147_483_647,
    hostname: hostname(),
    startedAt: "2026-08-06T12:00:00.000Z",
    executablePath: process.execPath,
    appVersion: "process-test",
    dataRoot: canonicalRoot,
  };
  writeFileSync(
    join(directory, DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
    `${JSON.stringify(owner, null, 2)}\n`,
    "utf8",
  );
}

function readCanonicalOwner(root: string): DataRootInstanceLockOwner {
  return JSON.parse(
    readFileSync(
      join(lockDirectory(root), DATA_ROOT_INSTANCE_LOCK_OWNER_FILE),
      "utf8",
    ),
  ) as DataRootInstanceLockOwner;
}

function lockDirectory(root: string): string {
  return join(root, DATA_ROOT_INSTANCE_LOCK_DIRECTORY);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
