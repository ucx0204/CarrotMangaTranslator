import { expect, it, vi } from "vitest";
import { researchBatchFixture } from "./mcpResearchBatch.fixture";

it("preserves research-plan identity, replay and transition rejection through shared metadata publication", async () => {
  const f = await researchBatchFixture(1);
  try {
    const before = await f.library.listLibrary();
    const plan = await f.prepare();
    const owner = "migration-owner";
    const record = await f.planRepository.load(owner, plan.id);
    const verify = vi.fn(async () => {});
    expect(
      await f.planRepository.create(
        owner,
        record.input,
        record.settingsFingerprint,
        () => {},
        verify,
      ),
    ).toEqual(record);
    expect(verify).not.toHaveBeenCalled();
    const different = structuredClone(record.input);
    different.works[0].researchTitle = "Different work title";
    await expect(f.planRepository.find(owner, different)).rejects.toMatchObject(
      { code: "invalid_edit" },
    );

    const { McpResearchBatchRecordSchema } =
      await import("../src/main/application/mcpResearchBatchPolicy");
    const settingsFingerprint =
      (record.settingsFingerprint[0] === "0" ? "1" : "0") +
      record.settingsFingerprint.slice(1);
    const transition = McpResearchBatchRecordSchema.parse({
      ...record,
      settingsFingerprint,
      version: record.version + 1,
    });
    await expect(
      f.planRepository.save(transition, record.version, () => {}),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(await f.planRepository.load(owner, plan.id)).toEqual(record);

    const { withLibraryMutation } = await import("../src/main/library/lock");
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    const save = (value: unknown) =>
      withLibraryMutation(() =>
        runLibraryTransaction("test-metadata-identity", (transaction) =>
          f.storage.stageRecord(transaction, plan.id, value),
        ),
      );
    const shifted = McpResearchBatchRecordSchema.parse({
      ...record,
      createdAt: record.createdAt + 1,
      expiresAt: record.expiresAt + 1,
    });
    await save(shifted);
    await expect(f.planRepository.load(owner, plan.id)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    await save(record);
    expect(await f.planRepository.load(owner, plan.id)).toEqual(record);
    await expect(
      f.planRepository.discard("other", plan.id, () => {}),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await f.storage.index()).entries).toHaveLength(1);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.research).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
