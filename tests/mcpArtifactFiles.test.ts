import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  assertReadableMcpArtifact,
  removeFailedMcpArtifact,
} from "../src/main/mcp/mcpArtifactFiles";

it("checks readability and closes its handle after either successful or rejected access", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-artifact-file-"));
  const file = join(root, "output.jpg");
  try {
    await writeFile(file, "owned output");
    await assertReadableMcpArtifact(file, async () => {});
    const revoked = new Error("revoked");
    await expect(
      assertReadableMcpArtifact(file, async () => {
        throw revoked;
      }),
    ).rejects.toBe(revoked);
    expect(await readFile(file, "utf8")).toBe("owned output");
    await rm(file);
    await expect(
      assertReadableMcpArtifact(file, async () => {}),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes an unpublished artifact while preserving the original operation error", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-artifact-rollback-"));
  const file = join(root, "output.webp");
  try {
    await writeFile(file, "owned unfinished output");
    const failure = new Error("encode failed");
    await expect(
      removeFailedMcpArtifact(file, failure, "write rollback"),
    ).rejects.toBe(failure);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      removeFailedMcpArtifact(file, failure, "write rollback"),
    ).rejects.toBe(failure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves both operation and cleanup errors rather than recursively deleting unexpected contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-artifact-rollback-denied-"));
  const path = join(root, "output.png");
  try {
    await mkdir(path);
    const preserved = join(path, "unexpected.txt");
    await writeFile(preserved, "must survive");
    const operation = new Error("write failed");
    const error = await removeFailedMcpArtifact(
      path,
      operation,
      "rollback failed",
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError))
      throw new Error("Expected combined failure");
    expect(error.errors[0]).toBe(operation);
    expect(error.cause).toBe(error.errors[1]);
    expect(await readFile(preserved, "utf8")).toBe("must survive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
