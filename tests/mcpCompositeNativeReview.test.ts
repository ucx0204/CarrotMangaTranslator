import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { McpCompositeWorkflowService } from "../src/main/application/mcpCompositeWorkflowService";
import { compositeNativeReviewFixture } from "./mcpCompositeNativeReview.fixture";
import {
  compositeFixture,
  mutation,
  reviewReport,
} from "./mcpCompositeWorkflow.fixture";

it("requires each issued actual PNG retrieval before accepting visual evidence and returns exact bytes", async () => {
  const f = await compositeNativeReviewFixture();
  try {
    const evidence = await f.issue();
    await expect(
      f.review.verifyEvidence(f.record, evidence, f.guard),
    ).rejects.toThrow("Retrieve each issued actual PNG");
    for (const item of evidence) {
      const actual = await f.review.readEvidence(f.record, item.id, f.guard);
      expect(createHash("sha256").update(actual.bytes).digest("hex")).toBe(
        item.sha256,
      );
      expect(actual.evidence).toEqual(item);
      actual.bytes.fill(0);
      const repeated = await f.review.readEvidence(f.record, item.id, f.guard);
      expect(createHash("sha256").update(repeated.bytes).digest("hex")).toBe(
        item.sha256,
      );
    }
    await expect(
      f.review.verifyEvidence(f.record, evidence, f.guard),
    ).resolves.toBeUndefined();
    expect(f.render).toHaveBeenCalledTimes(f.targets.length);
  } finally {
    await f.close();
  }
});

it("blocks cached PNG delivery when redaction is enabled before or during source verification", async () => {
  const f = await compositeNativeReviewFixture();
  try {
    const [item] = await f.issue();
    await f.redaction(true);
    await expect(
      f.review.readEvidence(f.record, item.id, f.guard),
    ).rejects.toMatchObject({ code: "access_denied" });
    await f.redaction(false);
    f.fonts.mockImplementationOnce(async () => {
      await f.redaction(true);
      return "a".repeat(64);
    });
    await expect(
      f.review.readEvidence(f.record, item.id, f.guard),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.render).toHaveBeenCalledTimes(f.targets.length);
  } finally {
    await f.redaction(false);
    await f.close();
  }
});

it("rejects another owner, a renamed sibling page and revoked image scope without rerendering", async () => {
  const f = await compositeNativeReviewFixture();
  try {
    const [item] = await f.issue();
    await expect(
      f.review.readEvidence(
        { ...f.record, owner: "another-owner" },
        item.id,
        f.guard,
      ),
    ).rejects.toThrow();
    const denied = () => {
      throw new Error("scope revoked");
    };
    await expect(
      f.review.readEvidence(f.record, item.id, denied),
    ).rejects.toThrow("scope revoked");
    await f.mutateChapter((chapter) => {
      chapter.pages[1].name = "Renamed sibling";
    });
    await expect(
      f.review.readEvidence(f.record, item.id, f.guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.render).toHaveBeenCalledTimes(f.targets.length);
  } finally {
    await f.close();
  }
});

it("does not deliver a cached PNG when the native session closes during verification", async () => {
  const f = await compositeNativeReviewFixture();
  try {
    const [item] = await f.issue();
    f.fonts.mockImplementationOnce(async () => {
      f.review.close();
      return "a".repeat(64);
    });
    await expect(
      f.review.readEvidence(f.record, item.id, f.guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  } finally {
    await f.close();
  }
});

it.each(["evidence", "report"] as const)(
  "does not accept a host report when issued PNGs expire during %s verification",
  async (boundary) => {
    let now = Date.now();
    const f = await compositeNativeReviewFixture(() => now);
    const controller = compositeFixture();
    const service = new McpCompositeWorkflowService(controller.repository, {
      ...controller.native,
      prepare: async () => (await f.read()).snapshot,
      renderEvidence: f.review.renderEvidence,
      verifyEvidence: f.review.verifyEvidence,
      verifyReviewReport: f.review.verifyReviewReport,
    });
    try {
      const prepared = await service.prepare(f.owner, f.plan, f.guard);
      await service.run(f.owner, mutation(prepared), f.guard);
      const awaiting = await service.waitForCompletion(
        f.owner,
        prepared.id,
        f.guard,
      );
      for (const item of awaiting.phases[0].evidence ?? [])
        await f.review.readEvidence(awaiting, item.id, f.guard);
      if (boundary === "report")
        f.fonts.mockImplementationOnce(async () => "a".repeat(64));
      f.fonts.mockImplementationOnce(async () => {
        now += 10 * 60_000;
        return "a".repeat(64);
      });
      await expect(
        service.report(f.owner, reviewReport(awaiting), f.guard),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      const unchanged = await service.get(f.owner, prepared.id, f.guard);
      expect(unchanged.status).toBe("awaiting-review");
      expect(unchanged.version).toBe(awaiting.version);
      expect(unchanged.phases[0].report).toBeUndefined();
      expect(f.render).toHaveBeenCalledTimes(f.targets.length);
    } finally {
      await service.close();
      await f.close();
    }
  },
);
