import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { researchBatchFixture } from "./mcpResearchBatch.fixture";

it("researches fixed works sequentially, retains independent reviews and replays across restart without another model call", async () => {
  const f = await researchBatchFixture();
  try {
    const before = (await f.graph()).styleGuide;
    const original = await readFile(f.chapterPath);
    const input = await f.input();
    const prepared = await f.prepare(input);
    expect(f.research).not.toHaveBeenCalled();
    expect(await f.prepare(input)).toEqual(prepared);
    const command = {
      id: prepared.id,
      version: prepared.version,
      requestId: randomUUID(),
      allowExternal: true,
      allowAssetDownloads: true,
    };
    await f.invoke("carrot_run_research_batch", command);
    const completed = await f.settle(prepared.id);
    expect(completed.status, JSON.stringify(f.errors)).toBe("completed");
    expect(completed.works.map((work) => work.status)).toEqual([
      "proposed",
      "proposed",
      "proposed",
    ]);
    expect(
      f.research.mock.calls.map(([request]) => request.researchTitle),
    ).toEqual(input.works.map((work) => work.researchTitle));
    expect(completed).toMatchObject({
      attemptsUsed: 3,
      unknownUsageAttempts: 0,
      usage: { queryCount: 6, sourceCount: 3, tavilyCreditsUsed: 3 },
    });
    for (const work of completed.works) {
      const proposalId = work.attempts[0].proposalId;
      if (!proposalId) throw new Error("Missing native proposal");
      expect(
        await f.nativeInvoke("carrot_get_context_proposal", { proposalId }),
      ).toMatchObject({ retention: "seven-days" });
    }
    await f.restartBatch();
    expect(await f.get(prepared.id)).toEqual(completed);
    expect(await f.invoke("carrot_run_research_batch", command)).toEqual(
      completed,
    );
    expect(f.research).toHaveBeenCalledTimes(3);
    await expect(f.run(prepared.id)).rejects.toThrow("complete");
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("holds unconfirmed titles and spoiler-limited works while processing the remaining fixed work", async () => {
  const f = await researchBatchFixture();
  try {
    const input = await f.input();
    input.works[0].titleConfirmed = false;
    input.works[1].allowSpoilers = false;
    const prepared = await f.prepare(input);
    await f.run(prepared.id);
    let result = await f.settle(prepared.id);
    expect(result.status).toBe("partial");
    expect(result.works.map((work) => work.status)).toEqual([
      "held",
      "held",
      "proposed",
    ]);
    expect(f.research).toHaveBeenCalledTimes(1);
    const resolve = {
      id: result.id,
      version: result.version,
      requestId: randomUUID(),
      workId: input.works[0].workId,
      researchTitle: "Explicitly disambiguated title",
      titleConfirmed: true,
      allowSpoilers: true,
    };
    await f.invoke("carrot_resolve_research_hold", resolve);
    expect(f.research).toHaveBeenCalledTimes(1);
    await f.run(prepared.id);
    result = await f.settle(prepared.id);
    expect(result.works.map((work) => work.status)).toEqual([
      "proposed",
      "held",
      "proposed",
    ]);
    expect(f.research).toHaveBeenCalledTimes(2);
    expect(await f.invoke("carrot_resolve_research_hold", resolve)).toEqual(
      result,
    );
    await expect(
      f.invoke("carrot_resolve_research_hold", {
        ...resolve,
        requestId: randomUUID(),
        version: result.version,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("preserves successes around a failed work and retries only that work after explicit permission", async () => {
  const f = await researchBatchFixture();
  try {
    const original = f.research.getMockImplementation();
    if (!original) throw new Error("Missing provider boundary");
    let failed = false;
    f.research.mockImplementation(async (...args) => {
      if (!failed && args[0].researchTitle === "Explicit work 1") {
        failed = true;
        throw new Error("Synthetic provider failure");
      }
      return original(...args);
    });
    const prepared = await f.prepare();
    await f.run(prepared.id);
    const partial = await f.settle(prepared.id);
    expect(partial.status, JSON.stringify(f.errors)).toBe("partial");
    expect(partial.works.map((work) => work.status)).toEqual([
      "proposed",
      "failed",
      "proposed",
    ]);
    expect(partial.unknownUsageAttempts).toBe(1);
    await f.restartBatch();
    await f.run(prepared.id);
    await f.settle(prepared.id);
    expect(f.research).toHaveBeenCalledTimes(3);
    await f.run(prepared.id, true);
    const completed = await f.settle(prepared.id);
    expect(completed.status).toBe("completed");
    expect(completed.attemptsUsed).toBe(4);
    expect(completed.works[0].attempts).toEqual(partial.works[0].attempts);
    expect(completed.works[2].attempts).toEqual(partial.works[2].attempts);
    expect(f.research).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

it("reconciles a review saved before the parent checkpoint instead of researching again", async () => {
  const f = await researchBatchFixture(1);
  try {
    const prepared = await f.prepare();
    await f.run(prepared.id);
    const completed = await f.settle(prepared.id);
    const record = await f.planRepository.load("migration-owner", prepared.id);
    const version = record.version;
    record.version++;
    record.status = "running";
    record.works[0].status = "running";
    Object.assign(record.works[0].attempts[0], {
      status: "running",
      proposalId: null,
      usage: null,
    });
    await f.planRepository.save(record, version, () => {});
    await f.restartBatch();
    expect((await f.get(prepared.id)).status).toBe("interrupted");
    await f.run(prepared.id);
    const restored = await f.settle(prepared.id);
    expect(restored.status).toBe("completed");
    expect(restored.works[0].attempts[0].proposalId).toBe(
      completed.works[0].attempts[0].proposalId,
    );
    expect(f.research).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("rejects changed fixed-work evidence, preserves that manual edit and continues other works", async () => {
  const f = await researchBatchFixture();
  try {
    const prepared = await f.prepare();
    const changed = JSON.parse(await readFile(f.secondPath, "utf8"));
    changed.pages[0].blocks[0].sourceText = "Changed outside the anchor";
    const bytes = JSON.stringify(changed);
    await writeFile(f.secondPath, bytes);
    await f.run(prepared.id);
    const result = await f.settle(prepared.id);
    expect(result.status).toBe("partial");
    expect(result.works[0].attempts[0]).toMatchObject({
      status: "failed",
      errorCode: "revision_conflict",
      jobId: null,
      usage: { queryCount: 0, sourceCount: 0, tavilyCreditsUsed: 0 },
    });
    expect(f.research).toHaveBeenCalledTimes(2);
    expect(await readFile(f.secondPath, "utf8")).toBe(bytes);
  } finally {
    await f.close();
  }
});
