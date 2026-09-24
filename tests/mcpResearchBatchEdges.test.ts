import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { researchBatchFixture } from "./mcpResearchBatch.fixture";
import { mcpResearchBatchOutputs } from "../src/shared/mcpResearchBatch";

it("retains no-change completion without inventing a proposal or repeating the researcher", async () => {
  const f = await researchBatchFixture(1);
  try {
    const native = f.research.getMockImplementation();
    if (!native) throw new Error("Missing provider boundary");
    f.research.mockImplementation(async (...args) => ({
      ...(await native(...args)),
      operations: [],
    }));
    const prepared = await f.prepare();
    await f.run(prepared.id);
    const done = await f.settle(prepared.id);
    expect(done.works[0]).toMatchObject({
      status: "no_changes",
      attempts: [{ proposalId: null }],
    });
    expect((await f.storage.index()).entries).toHaveLength(1);
    const record = await f.planRepository.load("migration-owner", prepared.id);
    const version = record.version;
    record.version++;
    record.status = "running";
    record.works[0].status = "running";
    Object.assign(record.works[0].attempts[0], {
      status: "running",
      usage: null,
    });
    await f.planRepository.save(record, version, () => {});
    await f.restartBatch();
    await f.run(prepared.id);
    expect((await f.settle(prepared.id)).works[0].status).toBe("no_changes");
    expect(f.research).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("requires explicit retry for an interrupted attempt with no retained result and preserves unknown usage", async () => {
  const f = await researchBatchFixture(1);
  try {
    const prepared = await f.prepare();
    const record = await f.planRepository.load("migration-owner", prepared.id);
    const version = record.version;
    record.version++;
    record.status = "running";
    record.works[0].status = "running";
    record.works[0].attempts.push({
      requestId: randomUUID(),
      jobId: null,
      status: "running",
      proposalId: null,
      usage: null,
      errorCode: null,
    });
    await f.planRepository.save(record, version, () => {});
    await f.restartBatch();
    await f.run(prepared.id);
    const held = await f.settle(prepared.id);
    expect(held).toMatchObject({ status: "partial", unknownUsageAttempts: 1 });
    expect(held.works[0].status).toBe("interrupted");
    expect(f.research).not.toHaveBeenCalled();
    await f.run(prepared.id, true);
    const completed = await f.settle(prepared.id);
    expect(completed).toMatchObject({
      status: "completed",
      attemptsUsed: 2,
      unknownUsageAttempts: 1,
    });
    expect(f.research).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("rejects changed settings before model execution and reports the cause without exposing secrets", async () => {
  const f = await researchBatchFixture(1);
  const settings = await import("../src/main/settingsStore");
  try {
    const prepared = await f.prepare();
    const previous = await settings.getAppSettings(f.app.appPaths);
    const language =
      previous.translation?.targetLanguage === "en" ? "ko" : "en";
    await settings.updateAppSettings(
      (current) => ({
        ...current,
        translation: {
          sourceLanguage: previous.translation?.sourceLanguage ?? "ja",
          targetLanguage: language,
        },
      }),
      f.app.appPaths,
    );
    expect(
      (await settings.getAppSettings(f.app.appPaths)).translation
        ?.targetLanguage,
    ).toBe(language);
    await f.run(prepared.id);
    const result = await f.settle(prepared.id);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "revision_conflict",
      attemptsUsed: 0,
    });
    expect(f.research).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /apiKey|settingsPath|settingsFingerprint/,
    );
  } finally {
    await f.close();
  }
});

it("requires local asset permission without substituting another research engine", async () => {
  const f = await researchBatchFixture(1);
  try {
    const prepared = await f.prepare();
    await f.invoke("carrot_run_research_batch", {
      id: prepared.id,
      version: prepared.version,
      requestId: randomUUID(),
      allowExternal: true,
    });
    const result = await f.settle(prepared.id);
    expect(result.works[0].attempts[0]).toMatchObject({
      status: "failed",
      errorCode: "access_denied",
      jobId: null,
    });
    expect(f.research).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("uses private snapshot pagination and discards only the plan, not completed reviews", async () => {
  const f = await researchBatchFixture(1);
  const list = async (args = {}) =>
    mcpResearchBatchOutputs.carrot_list_research_batches.parse(
      await f.invoke("carrot_list_research_batches", args),
    );
  try {
    const first = await f.prepare();
    const second = await f.prepare();
    const page = await list({ limit: 1 });
    expect(page).toMatchObject({ total: 2, nextOffset: 1 });
    expect(
      (await list({ offset: 1, limit: 1, snapshot: page.snapshot })).items,
    ).toHaveLength(1);
    expect(
      await f.invoke("carrot_list_research_batches", {}, f.auth("another")),
    ).toMatchObject({ total: 0 });
    await expect(list({ offset: 1 })).rejects.toThrow();
    await f.run(first.id);
    const done = await f.settle(first.id);
    await expect(
      list({ offset: 1, snapshot: page.snapshot }),
    ).rejects.toThrow();
    await f.invoke("carrot_discard_research_batch", {
      id: first.id,
      confirm: true,
    });
    await expect(f.get(first.id)).rejects.toThrow();
    expect((await list()).items.map((item) => item.id)).toEqual([second.id]);
    const proposalId = done.works[0].attempts[0].proposalId;
    expect(
      await f.nativeInvoke("carrot_get_context_proposal", { proposalId }),
    ).toMatchObject({ retention: "seven-days" });
    expect(JSON.stringify(await list())).not.toMatch(
      /Batch term|example.com|imagePath/,
    );
  } finally {
    await f.close();
  }
});

it("rejects malformed or expanded selections and an anchor from another work before publishing a plan", async () => {
  const f = await researchBatchFixture(2);
  try {
    const input = await f.input();
    for (const value of [
      { ...input, works: [] },
      { ...input, works: [input.works[0], input.works[0]] },
      { ...input, maxAttempts: 31 },
      { ...input, rawSettings: {} },
      { ...input, works: [{ ...input.works[0], chapterId: "../private" }] },
      {
        ...input,
        works: [{ ...input.works[0], workId: input.works[1].workId }],
      },
    ])
      await expect(
        f.invoke("carrot_prepare_research_batch", value),
      ).rejects.toThrow();
    expect(f.research).not.toHaveBeenCalled();
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});
