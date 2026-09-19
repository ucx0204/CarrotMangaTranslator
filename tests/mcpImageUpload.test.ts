import { randomUUID, createHash } from "node:crypto";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { McpImageUploadStore } from "../src/main/mcp/mcpImageUploadStore";
import { decodeMcpUploadPng } from "../src/main/mcp/mcpImageUploadPng";
import {
  McpImageUploadBeginSchema,
  McpImageUploadChunkSchema,
} from "../src/shared/mcpImageUploads";

const guard = () => {};
function fixture(purpose: "image" | "mask" = "image") {
  const png = new PNG({ width: 12, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.fill(i % 8 ? 255 : 0, i, i + 3);
    png.data[i + 3] = 255;
  }
  const bytes = PNG.sync.write(png);
  const input = McpImageUploadBeginSchema.parse({
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:0000000000000000",
    contextRevision: "0".repeat(16),
    requestId: randomUUID(),
    purpose,
    mimeType: "image/png",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: png.width,
    height: png.height,
  });
  return { bytes, input, png };
}
async function upload(
  store: McpImageUploadStore,
  purpose: "image" | "mask" = "image",
) {
  const f = fixture(purpose);
  const receipt = await store.begin("owner", f.input, [], guard);
  await store.chunk(
    "owner",
    { uploadId: receipt.uploadId, offset: 0, data: f.bytes.toString("base64") },
    guard,
  );
  return { ...f, uploadId: receipt.uploadId };
}
it("receives exact byte chunks, resumes, rejects changed retries and validates before ready", async () => {
  const store = new McpImageUploadStore();
  try {
    const f = fixture(),
      first = await store.begin("owner", f.input, [], guard);
    expect(await store.begin("owner", f.input, [], guard)).toEqual(first);
    expect(() =>
      store.begin("owner", { ...f.input, width: 13 }, [], guard),
    ).toThrow("different input");
    const chunk = {
      uploadId: first.uploadId,
      offset: 0,
      data: f.bytes.subarray(0, 12).toString("base64"),
    };
    const part = await store.chunk("owner", chunk, guard);
    expect(part.receivedBytes).toBe(12);
    expect(await store.chunk("owner", chunk, guard)).toEqual(part);
    await expect(
      store.chunk(
        "owner",
        { ...chunk, data: Buffer.alloc(12).toString("base64") },
        guard,
      ),
    ).rejects.toThrow("original bytes");
    await expect(store.finish("owner", first.uploadId, guard)).rejects.toThrow(
      "incomplete",
    );
    await expect(
      store.chunk("owner", { ...chunk, offset: 13 }, guard),
    ).rejects.toThrow("without gaps");
    await store.chunk(
      "owner",
      { ...chunk, offset: 12, data: f.bytes.subarray(12).toString("base64") },
      guard,
    );
    const ready = await store.finish("owner", first.uploadId, guard);
    expect(ready.status).toBe("ready");
    expect(ready.hasTransparency).toBe(false);
    await store.use("owner", first.uploadId, guard, async (asset) =>
      expect(asset.bytes).toEqual(f.bytes),
    );
    expect(JSON.stringify(ready)).not.toMatch(/path|base64|dataUrl/);
  } finally {
    await store.close();
  }
});
it("requires exact file digest, declared dimensions and complete CRC-valid PNG data", async () => {
  const store = new McpImageUploadStore();
  try {
    const f = fixture();
    const receipt = await store.begin(
      "owner",
      { ...f.input, sha256: "0".repeat(64) },
      [],
      guard,
    );
    await store.chunk(
      "owner",
      {
        uploadId: receipt.uploadId,
        offset: 0,
        data: f.bytes.toString("base64"),
      },
      guard,
    );
    await expect(
      store.finish("owner", receipt.uploadId, guard),
    ).rejects.toThrow("content changed");
    expect(() =>
      decodeMcpUploadPng(f.bytes, { ...f.input, width: 13 }),
    ).toThrow("declared dimensions");
    expect(() =>
      decodeMcpUploadPng(
        Buffer.concat([f.bytes, Buffer.from("extra")]),
        f.input,
      ),
    ).toThrow("trailing content");
    const bad = Buffer.from(f.bytes);
    bad[bad.length - 1] ^= 1;
    expect(() => decodeMcpUploadPng(bad, f.input)).toThrow();
    expect(() => decodeMcpUploadPng(Buffer.from("<svg/>"), f.input)).toThrow();
  } finally {
    await store.close();
  }
});
it("accepts opaque binary masks and rejects grayscale or transparent selection ambiguity", () => {
  const f = fixture("mask");
  expect(decodeMcpUploadPng(f.bytes, f.input).selectedPixels).toBe(48);
  f.png.data[0] = 128;
  expect(() => decodeMcpUploadPng(PNG.sync.write(f.png), f.input)).toThrow(
    "binary PNG",
  );
  f.png.data.fill(0, 0, 4);
  expect(() => decodeMcpUploadPng(PNG.sync.write(f.png), f.input)).toThrow(
    "binary PNG",
  );
});
it("does not expose foreign uploads and fixes expiry independently from repeated reads", async () => {
  let now = 1_000_000;
  const store = new McpImageUploadStore(() => now);
  try {
    const f = await upload(store);
    const receipt = await store.finish("owner", f.uploadId, guard);
    expect(() => store.inspect("other", f.uploadId, guard)).toThrow(
      "Owned image upload",
    );
    now += 60_000;
    expect(store.inspect("owner", f.uploadId, guard).expiresAt).toBe(
      receipt.expiresAt,
    );
    now = receipt.expiresAt;
    expect(() => store.inspect("owner", f.uploadId, guard)).toThrow("expired");
    expect(await store.discard("owner", f.uploadId, guard)).toEqual({
      uploadId: f.uploadId,
      discarded: true,
    });
    expect(() => store.begin("owner", f.input, [], guard)).toThrow(
      "unavailable",
    );
  } finally {
    await store.close();
  }
});
it("retains in-use uploads, rechecks authorization and waits for consumers on close", async () => {
  const store = new McpImageUploadStore();
  try {
    const f = await upload(store);
    await store.finish("owner", f.uploadId, guard);
    let entered!: () => void, leave!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const use = store.use("owner", f.uploadId, guard, async (asset) => {
      entered();
      await pending;
      expect(() => asset.guard()).toThrow("closed");
    });
    await active;
    expect(() => store.discard("owner", f.uploadId, guard)).toThrow("in use");
    const close = store.close();
    expect(() => store.inspect("owner", f.uploadId, guard)).toThrow("closed");
    leave();
    await use;
    await close;
  } finally {
    await store.close();
  }
});
it("bounds raster size, body-sized chunks and rejects arbitrary file fields", () => {
  const f = fixture();
  expect(
    McpImageUploadBeginSchema.safeParse({
      ...f.input,
      width: 16000000,
      height: 2,
    }).success,
  ).toBe(false);
  expect(
    McpImageUploadBeginSchema.safeParse({ ...f.input, path: "C:/private.png" })
      .success,
  ).toBe(false);
  for (const data of [
    "file://a",
    "data:image/png;base64,AAAA",
    "AB==",
    "A",
    "AAAA\n",
  ])
    expect(() => {
      const parsed = McpImageUploadChunkSchema.parse({
        uploadId: randomUUID(),
        offset: 0,
        data,
      });
      if (Buffer.from(parsed.data, "base64").toString("base64") !== data)
        throw new Error("noncanonical");
    }).toThrow();
});

it("rejects incomplete, animated, repeated-header and overflowing PNG containers before decoding", () => {
  const f = fixture();
  const end = f.bytes.subarray(f.bytes.length - 12);
  const withoutEnd = f.bytes.subarray(0, f.bytes.length - 12);
  expect(() => decodeMcpUploadPng(withoutEnd, f.input)).toThrow(
    "complete 8-bit PNG",
  );
  const animation = Buffer.alloc(12);
  animation.write("acTL", 4, "ascii");
  expect(() =>
    decodeMcpUploadPng(Buffer.concat([withoutEnd, animation, end]), f.input),
  ).toThrow("Animated PNG");
  const header = f.bytes.subarray(8, 33);
  expect(() =>
    decodeMcpUploadPng(
      Buffer.concat([f.bytes.subarray(0, 33), header, f.bytes.subarray(33)]),
      f.input,
    ),
  ).toThrow("complete 8-bit PNG");
  const oversized = Buffer.from(f.bytes);
  oversized.writeUInt32BE(0xffffffff, 33);
  expect(() => decodeMcpUploadPng(oversized, f.input)).toThrow(
    "complete 8-bit PNG",
  );
  const missingData = Buffer.concat([f.bytes.subarray(0, 33), end]);
  expect(() => decodeMcpUploadPng(missingData, f.input)).toThrow(
    "complete 8-bit PNG",
  );
});
