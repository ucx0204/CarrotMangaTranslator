import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  PageDeletionRecordSchema,
  pageDeletionExpected,
} from "../src/main/application/mcpPageDeletionState";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it("rejects page-recovery history replaced between verified inspection and disposal admission", async () => {
  const f = await pageDeletionFixture();
  try {
    const saved = await f.applyPage(await f.commandPage());
    await f.recoverPage(saved.id, "undo");
    const original = PageDeletionRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const changed = structuredClone(original);
    for (const direction of ["redo", "undo"] as const) {
      const input = {
        id: saved.id,
        snapshot: pageDeletionExpected(changed, direction === "undo"),
        requestId: randomUUID(),
        confirm: true,
      };
      changed.actions.push({
        requestId: input.requestId,
        direction,
        signature: hashStableValue({ input, direction }),
      });
    }
    PageDeletionRecordSchema.parse(changed);
    const path = await f.storage.path(saved.id);
    const encoded = JSON.stringify(await f.codec.seal(changed));
    const decode = f.codec.open.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "open").mockImplementation(async (value) => {
      const decoded = await decode(value);
      if (!injected && PageDeletionRecordSchema.safeParse(decoded).success) {
        injected = true;
        // An out-of-process file replacement at the codec boundary, not a repository/lock mock.
        await writeFile(path, encoded);
      }
      return decoded;
    });
    await expect(
      f.call("carrot_discard_page_deletion", { id: saved.id, confirm: true }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(await f.storage.record(saved.id)).toEqual(changed);
    await f.assertPageOriginal();
    await writeFile(path, JSON.stringify(await f.codec.seal(original)));
    await f.restart();
    expect(
      await f.call("carrot_discard_page_deletion", {
        id: saved.id,
        confirm: true,
      }),
    ).toMatchObject({ status: "discarded", pageChanges: 0 });
    await f.assertPageOriginal();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
