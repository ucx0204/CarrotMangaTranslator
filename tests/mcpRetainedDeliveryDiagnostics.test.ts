import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { McpOutputDeliveryMetadataSchema } from "../src/shared/mcpOutputDelivery";
import { exchangeRetentionFixture } from "./mcpExchangeRetention.fixture";

it("reports owned byte mismatch and inaccessible metadata without exposing private evidence or issuing a URL", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const output = await f.publish("text");
    const catalog = f.session(false).catalog;
    const capability = vi.spyOn(f.operations().artifacts, "issueRetained");
    const inspect = () => catalog.diagnoseOutput(f.owner, output.id, () => {});
    const initial = McpOutputDeliveryMetadataSchema.parse(await inspect());
    expect(initial.retention).toMatchObject({
      state: "retained",
      content: "verified",
      source: "current",
      access: "allowed",
    });
    expect(initial.artifact).toEqual({
      mimeType: output.mimeType,
      bytes: output.bytes,
      sha256: output.sha256,
      retainedOutputId: output.id,
    });
    expect(JSON.stringify(initial)).not.toMatch(
      /url|snapshot|Fingerprint|imagePath|sourcePath/,
    );
    expect(JSON.stringify(initial)).not.toContain(f.env.root);
    const path = await f.storage.path(output.id, output.sha256);
    const corrupted = Buffer.from(await readFile(path));
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(path, corrupted);
    expect((await inspect()).retention).toMatchObject({
      state: "retained",
      content: "mismatch",
      source: "current",
      access: "blocked",
    });
    await writeFile(
      await f.storage.path(output.id),
      "not an encrypted metadata envelope",
    );
    const invalid = await inspect();
    expect(invalid.retention).toMatchObject({
      state: "unavailable",
      content: "not_checked",
      source: "not_checked",
      access: "blocked",
    });
    expect(invalid.artifact).toBeUndefined();
    expect(capability).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("checks owner before evidence and reports owned expiry without opening expired records", async () => {
  const f = await exchangeRetentionFixture();
  try {
    const output = await f.publish("context");
    const { McpRetentionStorage } =
      await import("../src/main/mcp/mcpRetentionStorage");
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    const { entry } = await f.storage.owned(f.owner, output.id, "output");
    const catalog = f.session(false).catalog;
    const record = vi.spyOn(f.storage, "record");
    for (const [owner, id] of [
      ["another-owner", output.id],
      [f.owner, randomUUID()],
    ])
      await expect(
        catalog.diagnoseOutput(owner, id, () => {}),
      ).rejects.toMatchObject({ code: "not_found" });
    expect(record).not.toHaveBeenCalled();
    const storage = new McpRetentionStorage(f.codec, () => entry.expiresAt);
    const expiredRecord = vi.spyOn(storage, "record");
    const expired = new McpRetentionCatalog(
      storage,
      new AbortController().signal,
      false,
    );
    expect(
      (await expired.diagnoseOutput(f.owner, output.id, () => {})).retention,
    ).toMatchObject({
      state: "expired",
      content: "not_checked",
      source: "not_checked",
      access: "blocked",
      expiresAt: entry.expiresAt,
    });
    expect(expiredRecord).not.toHaveBeenCalled();
    await expect(
      storage.owned(f.owner, output.id, "output"),
    ).rejects.toMatchObject({ code: "not_found" });
    const denied = new Error("read authorization revoked");
    await expect(
      catalog.diagnoseOutput(f.owner, output.id, () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
  } finally {
    await f.close();
  }
});
