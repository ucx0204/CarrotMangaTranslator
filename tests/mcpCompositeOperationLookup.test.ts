import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { MCP_JOB_RETENTION_MS } from "../src/main/application/mcpJobJournal";

function nativeInput(execute = vi.fn(async () => ({ status: "saved" }))) {
  const requestId = randomUUID();
  const parameters = {
    chapterId: "chapter",
    pageId: "page",
    revision: `page-v1:${"a".repeat(16)}`,
    requestId,
  };
  const reference = {
    requestId,
    kind: "ocr",
    fingerprint: hashStableValue(["ocr", parameters]),
  };
  return {
    reference,
    execute,
    input: {
      owner: "owner",
      requestId,
      kind: "ocr",
      parameters,
      execute,
      assertAuthorized: () => {},
    },
  };
}

describe("exact owned native receipt lookup", () => {
  it("restores the original journal before reading and never reexecutes a completed request", async () => {
    let journal: unknown = null;
    const persistence = {
      load: vi.fn(async () => structuredClone(journal)),
      save: async (value: unknown) => {
        journal = structuredClone(value);
      },
    };
    const f = nativeInput();
    const first = new McpOperationService(() => {}, Date.now, persistence);
    const admitted = await first.start(f.input);
    await first.waitForCompletion(
      admitted.jobId,
      "owner",
      new AbortController().signal,
    );
    await first.close();
    const restored = new McpOperationService(() => {}, Date.now, persistence);
    try {
      const receipt = await restored.findOwnedOperation("owner", f.reference);
      expect(receipt).toMatchObject({
        jobId: admitted.jobId,
        requestId: f.input.requestId,
        kind: "ocr",
        status: "completed",
      });
      expect(persistence.load).toHaveBeenCalledTimes(2);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(receipt)).not.toContain("fingerprint");
    } finally {
      await restored.close();
    }
  });

  it("rejects a conflicting family or native input hash and hides another owner's request", async () => {
    const service = new McpOperationService(() => {});
    const f = nativeInput();
    try {
      const accepted = await service.start(f.input);
      await service.waitForCompletion(
        accepted.jobId,
        "owner",
        new AbortController().signal,
      );
      await expect(
        service.findOwnedOperation("other-owner", f.reference),
      ).resolves.toBeUndefined();
      await expect(
        service.findOwnedOperation("owner", {
          ...f.reference,
          requestId: randomUUID(),
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.findOwnedOperation("owner", { ...f.reference, kind: "erase" }),
      ).rejects.toThrow("different operation");
      await expect(
        service.findOwnedOperation("owner", {
          ...f.reference,
          fingerprint: "b".repeat(16),
        }),
      ).rejects.toThrow("different operation");
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });

  it("honors receipt expiry and preserves a truthful interrupted native outcome", async () => {
    let now = 1000;
    const service = new McpOperationService(
      () => {},
      () => now,
    );
    const f = nativeInput(vi.fn(async () => ({ status: "interrupted" })));
    try {
      const accepted = await service.start(f.input);
      const settled = await service.waitForCompletion(
        accepted.jobId,
        "owner",
        new AbortController().signal,
      );
      expect(settled.status).toBe("interrupted");
      expect(
        await service.findOwnedOperation("owner", f.reference),
      ).toMatchObject({ jobId: accepted.jobId, status: "interrupted" });
      now += MCP_JOB_RETENTION_MS;
      await expect(
        service.findOwnedOperation("owner", f.reference),
      ).resolves.toBeUndefined();
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      await service.close();
    }
  });
});
