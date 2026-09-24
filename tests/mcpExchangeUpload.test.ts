import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { McpFileUploadStore } from "../src/main/mcp/mcpFileUploadStore";
import { readMcpExchangeUpload } from "../src/main/mcp/mcpExchangeUpload";
import { McpFileUploadBeginSchema } from "../src/shared/mcpFileUploads";
import { MCP_EXCHANGE_BYTES } from "../src/shared/mcpExchangeFiles";

const owner = "exchange-reader";
const guard = () => {};
async function upload(
  bytes = Buffer.from("이름,translation\r\n당근,Carrot\r\n"),
) {
  const store = new McpFileUploadStore();
  try {
    const receipt = await store.begin(
      owner,
      {
        requestId: randomUUID(),
        filename: "review.CSV",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      guard,
    );
    await store.chunk(
      owner,
      { uploadId: receipt.uploadId, offset: 0, data: bytes.toString("base64") },
      guard,
    );
    await store.finish(owner, receipt.uploadId, guard);
    return { store, receipt, bytes };
  } catch (error) {
    await store.close();
    throw error;
  }
}

it("reads exact encoded bytes inside the existing owned upload lease and keeps final verification usable", async () => {
  const f = await upload();
  try {
    await f.store.withFile(owner, f.receipt.uploadId, guard, async (asset) => {
      const result = await readMcpExchangeUpload(asset);
      expect(result.bytes.equals(f.bytes)).toBe(true);
      expect(result.filename).toBe("review.CSV");
      expect(result.sha256).toBe(f.receipt.sha256);
      expect(() => f.store.discard(owner, f.receipt.uploadId, guard)).toThrow(
        /in use/,
      );
      await result.verify();
    });
    await expect(
      f.store.discard(owner, f.receipt.uploadId, guard),
    ).resolves.toMatchObject({ discarded: true });
  } finally {
    await f.store.close();
  }
});

it("rejects changed owned bytes both before consumption and during final source verification", async () => {
  const f = await upload();
  try {
    await f.store.withFile(owner, f.receipt.uploadId, guard, async (asset) => {
      const result = await readMcpExchangeUpload(asset);
      const replacement = Buffer.from(f.bytes);
      replacement[replacement.length - 1] ^= 1;
      await writeFile(asset.path, replacement);
      await expect(result.verify()).rejects.toThrow();
      await expect(readMcpExchangeUpload(asset)).rejects.toThrow();
    });
  } finally {
    await f.store.close();
  }
});

it("requires the current owner and cancellation authority without consuming another upload", async () => {
  const f = await upload();
  try {
    expect(() =>
      f.store.withFile(
        "different-owner",
        f.receipt.uploadId,
        guard,
        readMcpExchangeUpload,
      ),
    ).toThrow(/unavailable/);
    await f.store.withFile(owner, f.receipt.uploadId, guard, async (asset) => {
      const controller = new AbortController();
      const reason = new Error("exchange read cancelled");
      controller.abort(reason);
      await expect(
        readMcpExchangeUpload(asset, controller.signal),
      ).rejects.toBe(reason);
    });
    expect(
      (await f.store.inspect(owner, f.receipt.uploadId, guard)).status,
    ).toBe("ready");
  } finally {
    await f.store.close();
  }
});

it("caps incoming exchange files at admission without reducing existing archive and artwork limits", () => {
  for (const extension of ["TXT", "csv", "tsv", "JSON"]) {
    const input = {
      requestId: randomUUID(),
      filename: `input.${extension}`,
      bytes: MCP_EXCHANGE_BYTES,
      sha256: "a".repeat(64),
    };
    expect(McpFileUploadBeginSchema.safeParse(input).success).toBe(true);
    expect(
      McpFileUploadBeginSchema.safeParse({ ...input, bytes: input.bytes + 1 })
        .success,
    ).toBe(false);
  }
  for (const extension of ["png", "zip", "mgtshare"])
    expect(
      McpFileUploadBeginSchema.safeParse({
        requestId: randomUUID(),
        filename: `input.${extension}`,
        bytes: 128 * 1024 * 1024,
        sha256: "b".repeat(64),
      }).success,
    ).toBe(true);
});
