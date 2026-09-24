import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { McpFileUploadStore } from "../src/main/mcp/mcpFileUploadStore";
import { McpFileUploadBeginSchema } from "../src/shared/mcpFileUploads";
import { createDeferred } from "./inpaintingSelectionJobFixtures";

const guard = () => {};
function input(bytes: Buffer, filename = "chapter.zip") {
  return {
    requestId: randomUUID(),
    filename,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
it("receives real ordered bytes, exact retries and integrity without pretending to validate importability", async () => {
  const store = new McpFileUploadStore();
  try {
    const bytes = Buffer.alloc(100_000, 127),
      request = input(bytes);
    const first = await store.begin("owner", request, null, guard);
    expect(first.validation).toBe("pending");
    expect(await store.begin("owner", request, null, guard)).toEqual(first);
    expect(() =>
      store.begin("owner", { ...request, filename: "other.zip" }, null, guard),
    ).toThrow(/different input/);
    await expect(store.finish("owner", first.uploadId, guard)).rejects.toThrow(
      /incomplete/,
    );
    for (let offset = 0; offset < bytes.length; offset += first.chunkBytes) {
      const chunk = {
        uploadId: first.uploadId,
        offset,
        data: bytes
          .subarray(offset, offset + first.chunkBytes)
          .toString("base64"),
      };
      const receipt = await store.chunk("owner", chunk, guard);
      expect(await store.chunk("owner", chunk, guard)).toEqual(receipt);
    }
    const ready = await store.finish("owner", first.uploadId, guard);
    expect(ready).toMatchObject({
      status: "ready",
      validation: "bytes-verified",
      importable: "not-yet-checked",
      receivedBytes: bytes.length,
    });
    expect(JSON.stringify(ready)).not.toMatch(/path|base64|dataUrl/);
    await expect(
      store.chunk(
        "owner",
        { uploadId: first.uploadId, offset: 0, data: "AAAA" },
        guard,
      ),
    ).rejects.toThrow(/original bytes/);
  } finally {
    await store.close();
  }
});
it("rejects bad digest, gaps, noncanonical data and overflow while keeping acknowledged bytes", async () => {
  const store = new McpFileUploadStore();
  try {
    const first = await store.begin(
      "owner",
      { ...input(Buffer.from("ABCD")), sha256: "0".repeat(64) },
      null,
      guard,
    );
    for (const chunk of [
      { offset: 1, data: "QUJDRA==" },
      { offset: 0, data: "AB==" },
      { offset: 0, data: "QUJDREU=" },
    ])
      await expect(
        store.chunk("owner", { uploadId: first.uploadId, ...chunk }, guard),
      ).rejects.toThrow();
    expect(store.inspect("owner", first.uploadId, guard).receivedBytes).toBe(0);
    await store.chunk(
      "owner",
      { uploadId: first.uploadId, offset: 0, data: "QUJDRA==" },
      guard,
    );
    await expect(store.finish("owner", first.uploadId, guard)).rejects.toThrow(
      /content changed/,
    );
    expect(store.inspect("owner", first.uploadId, guard).status).toBe(
      "receiving",
    );
  } finally {
    await store.close();
  }
});
it("isolates owners, expires without renewal and never recreates discarded reservations", async () => {
  let now = 1_000_000;
  const store = new McpFileUploadStore(() => now);
  try {
    const request = input(Buffer.from("one")),
      first = await store.begin("a", request, null, guard);
    expect(() => store.inspect("b", first.uploadId, guard)).toThrow(
      /unavailable/,
    );
    expect(() => store.discard("b", first.uploadId, guard)).toThrow(
      /unavailable/,
    );
    now += 1;
    expect(store.inspect("a", first.uploadId, guard).expiresAt).toBe(
      first.expiresAt,
    );
    now = first.expiresAt;
    expect(() => store.inspect("a", first.uploadId, guard)).toThrow(/expired/);
    await store.discard("a", first.uploadId, guard);
    expect(() => store.begin("a", request, null, guard)).toThrow(/unavailable/);
  } finally {
    await store.close();
  }
});
it("reserves declared capacity before bytes arrive and releases only owned reservations", async () => {
  const store = new McpFileUploadStore();
  try {
    const request = { ...input(Buffer.from("x")), bytes: 128 * 1024 * 1024 };
    const first = await store.begin("a", request, null, guard);
    await store.begin(
      "b",
      { ...request, requestId: randomUUID() },
      null,
      guard,
    );
    expect(() =>
      store.begin("a", input(Buffer.from("x")), null, guard),
    ).toThrow(/256 MiB/);
    await store.discard("a", first.uploadId, guard);
    await store.begin("a", input(Buffer.from("x")), null, guard);
  } finally {
    await store.close();
  }
});
it("holds a consumer lease during close and rejects expired authorization before further use", async () => {
  const store = new McpFileUploadStore(),
    entered = createDeferred<void>(),
    release = createDeferred<void>();
  let pending: Promise<void> | undefined;
  try {
    const first = await store.begin("a", input(Buffer.from("x")), null, guard);
    await store.chunk(
      "a",
      { uploadId: first.uploadId, offset: 0, data: "eA==" },
      guard,
    );
    await store.finish("a", first.uploadId, guard);
    pending = store.withFile("a", first.uploadId, guard, async (asset) => {
      entered.resolve();
      await release.promise;
      expect(() => asset.guard()).toThrow(/closed/);
    });
    await entered.promise;
    expect(() => store.discard("a", first.uploadId, guard)).toThrow(/in use/);
    const closing = store.close();
    release.resolve();
    await pending;
    await closing;
  } finally {
    release.resolve();
    await pending;
    await store.close();
  }
});
it("checks real file content again on repeated finish rather than trusting an old ready receipt", async () => {
  const store = new McpFileUploadStore();
  try {
    const first = await store.begin("a", input(Buffer.from("x")), null, guard);
    await store.chunk(
      "a",
      { uploadId: first.uploadId, offset: 0, data: "eA==" },
      guard,
    );
    await store.finish("a", first.uploadId, guard);
    await store.withFile("a", first.uploadId, guard, async (asset) => {
      await writeFile(asset.path, "y");
    });
    await expect(store.finish("a", first.uploadId, guard)).rejects.toThrow(
      /content changed/,
    );
  } finally {
    await store.close();
  }
});
it.each([
  "../book.zip",
  "C:\\private.png",
  "https://host/a.zip",
  "script.exe",
  "vector.svg",
  "work.mgt",
  "bad\nname.pdf",
])("rejects unsupported names and paths %s", (filename) => {
  expect(
    McpFileUploadBeginSchema.safeParse(input(Buffer.from("x"), filename))
      .success,
  ).toBe(false);
});
