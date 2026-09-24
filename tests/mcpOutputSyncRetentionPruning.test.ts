import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import { syncOwner, syncReview, syncRequest } from "./mcpOutputSync.fixture";

it("prunes an expired settled output receipt after reconstruction while preserving current history and native output bytes", async () => {
  const env = await mcpAppEnvironment();
  try {
    const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
    const { McpRetentionStorage } =
      await import("../src/main/mcp/mcpRetentionStorage");
    const { McpOutputSyncRepository } =
      await import("../src/main/mcp/mcpOutputSyncRepository");
    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    await mkdir(env.libraryDir, { recursive: true });
    const outputPath = join(env.root, "already-published-output.png");
    const outputBytes = Buffer.from(
      "owned native output bytes outside retained metadata",
    );
    await writeFile(outputPath, outputBytes);
    const codec = new McpSecureStore(
      env.root,
      mcpTestEncryption(),
    ).retentionCodec();
    let now = 1_700_000_000_000;
    const storage = new McpRetentionStorage(codec, () => now);
    const repository = new McpOutputSyncRepository(storage);
    const review = syncReview();
    const admit = () =>
      repository.begin(
        syncOwner,
        { request: syncRequest(review), jobId: randomUUID() },
        review,
        () => {},
      );
    const expired = await admit();
    if (!expired.session) throw new Error("Missing original receipt admission");
    await expired.session.fail("publication_failed", true);
    now += 1000;
    const current = await admit();
    if (!current.session) throw new Error("Missing current receipt admission");
    await current.session.fail("publication_failed", true);
    const currentPath = await storage.path(current.id);
    const currentBytes = await readFile(currentPath);
    const currentRecord = await storage.record(current.id);

    // A reconstructed storage has no live owner to pin a settled expired receipt.
    const restarted = new McpRetentionStorage(codec, () => now);
    now = expired.receipt.expiresAt;
    await expect(
      restarted.owned(syncOwner, expired.id, "output-sync"),
    ).rejects.toMatchObject({ code: "not_found" });
    await withLibraryMutation(() =>
      runLibraryTransaction(
        "test-settled-output-expiry",
        async (transaction) => {
          const retained = await restarted.prune(
            transaction,
            await restarted.index(),
          );
          await restarted.stageIndex(transaction, retained);
        },
      ),
    );

    expect((await restarted.index()).entries.map((entry) => entry.id)).toEqual([
      current.id,
    ]);
    await expect(
      readFile(await restarted.path(expired.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(currentPath)).toEqual(currentBytes);
    expect(await restarted.record(current.id)).toEqual(currentRecord);
    expect(await readFile(outputPath)).toEqual(outputBytes);
    await expect(
      restarted.owned(syncOwner, current.id, "output-sync"),
    ).resolves.toMatchObject({ entry: { id: current.id } });
    for (const phase of ["active", "committed"])
      expect(
        await readdir(join(env.libraryDir, ".transactions", phase)),
      ).toEqual([]);
  } finally {
    await env.close();
  }
});
