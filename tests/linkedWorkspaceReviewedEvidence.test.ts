import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const boundary = vi.hoisted(() => ({
  beforeOpen: null as (() => Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const run = boundary.beforeOpen;
      boundary.beforeOpen = null;
      await run?.();
      return actual.open(...args);
    },
  };
});
import {
  readReviewedFile,
  readReviewedJson,
} from "../src/main/linkedWorkspace/linkedWorkspaceReviewedOutputEvidence";
import { fingerprintFile } from "../src/main/linkedWorkspace/linkedWorkspaceFiles";

const roots: string[] = [];
afterEach(async () => {
  boundary.beforeOpen = null;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function target() {
  const root = await mkdtemp(join(tmpdir(), "mgt-reviewed-evidence-"));
  roots.push(root);
  return join(root, "mirror.json");
}

describe("bounded native output evidence reads", () => {
  it("fingerprints the exact bounded JSON bytes that were parsed", async () => {
    const path = await target();
    const text = '{"translated":"번역"}\n';
    await writeFile(path, text);
    expect(await readReviewedJson(path, 1024)).toEqual({
      value: { translated: "번역" },
      digest: {
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("supports bounded hashing alongside validated fingerprint reuse", async () => {
    const path = await target();
    const content = Buffer.from("bounded");
    await writeFile(path, content);
    const fingerprint = await fingerprintFile(path, content.byteLength);
    expect(fingerprint).toMatchObject({
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(await fingerprintFile(path, fingerprint)).toEqual(fingerprint);
    await expect(fingerprintFile(path, content.byteLength - 1)).rejects.toThrow(
      RangeError,
    );
  });

  it("rejects an over-limit sparse file before allocating or hashing its contents", async () => {
    const path = await target();
    const handle = await open(path, "w");
    await handle.close();
    await truncate(path, 16 * 1024 * 1024 + 1);
    await expect(
      readReviewedJson(path, 16 * 1024 * 1024),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      readReviewedFile(path, false, 16 * 1024 * 1024),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects a file that changes between its metadata check and opening the bounded handle", async () => {
    const path = await target();
    await writeFile(path, '{"before":true}');
    boundary.beforeOpen = () => writeFile(path, '{"after":"different bytes"}');
    await expect(readReviewedJson(path, 1024)).rejects.toMatchObject({
      code: "source_changed",
    });
  });
});
