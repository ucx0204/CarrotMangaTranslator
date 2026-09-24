import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpCompositeRenderEvidenceSchema } from "../src/shared/mcpCompositeWorkflowReview";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import {
  compositeFixture,
  compositePlan,
  deferred,
  guard,
  mutation,
  owner,
  reviewReport,
} from "./mcpCompositeWorkflow.fixture";

it("requires issued rendered page evidence and explicit host provenance before accepting review", async () => {
  const f = compositeFixture();
  const prepared = await f.service.prepare(owner, compositePlan(true), guard);
  const started = await f.service.run(owner, mutation(prepared), guard);
  const awaiting = await f.service.waitForCompletion(owner, started.id, guard);
  expect(awaiting.status).toBe("awaiting-review");
  const report = reviewReport(awaiting);
  const forged = {
    ...report,
    assessments: [{ ...report.assessments[0], evidenceId: randomUUID() }],
  };
  await expect(f.service.report(owner, forged, guard)).rejects.toThrow(
    "unissued",
  );
  const evidence = awaiting.phases[0].evidence?.[0];
  expect(
    McpCompositeRenderEvidenceSchema.safeParse({
      ...evidence,
      kind: "source-crop",
    }).success,
  ).toBe(false);
  await expect(
    f.service.report(
      owner,
      { ...report, verdictOrigin: "native-verified" },
      guard,
    ),
  ).rejects.toThrow();
  const accepted = await f.service.report(owner, report, guard);
  expect(accepted.status).toBe("completed");
  expect(accepted.phases.map((phase) => phase.status)).toEqual([
    "completed",
    "skipped",
    "skipped",
  ]);
  expect(JSON.stringify(accepted)).not.toContain('"reviewStatus"');
  expect(f.events).toEqual(["rendered"]);
});

it("stops an unchanged rendered correction cycle as no-progress without another native pass", async () => {
  const f = compositeFixture();
  let record = await f.service.prepare(owner, compositePlan(true), guard);
  await f.service.run(owner, mutation(record), guard);
  record = await f.service.waitForCompletion(owner, record.id, guard);
  record = await f.service.report(
    owner,
    reviewReport(record, "needs-correction"),
    guard,
  );
  record = await f.bind(record);
  await f.service.run(owner, mutation(record), guard);
  record = await f.service.waitForCompletion(owner, record.id, guard);
  await f.service.run(owner, mutation(record), guard);
  record = await f.service.waitForCompletion(owner, record.id, guard);
  record = await f.service.report(
    owner,
    reviewReport(record, "needs-correction"),
    guard,
  );
  expect(record).toMatchObject({
    status: "held",
    stopReason: "no-progress",
    used: { admissions: 3, pageAttempts: 3 },
  });
  await expect(f.service.run(owner, mutation(record), guard)).rejects.toThrow();
  expect(f.events.filter((event) => event === "rendered")).toHaveLength(2);
  expect(f.events.filter((event) => event === "admitted")).toHaveLength(1);
});

it("rejects host review after native source evidence changes and never silently refreshes the issued image", async () => {
  const f = compositeFixture();
  const prepared = await f.service.prepare(owner, compositePlan(true), guard);
  await f.service.run(owner, mutation(prepared), guard);
  const awaiting = await f.service.waitForCompletion(owner, prepared.id, guard);
  f.staleEvidence();
  await expect(
    f.service.report(owner, reviewReport(awaiting), guard),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect((await f.service.get(owner, prepared.id, guard)).status).toBe(
    "awaiting-review",
  );
  expect(f.events).toEqual(["rendered"]);
});

it.each(["after-load", "before-commit"] as const)(
  "holds rendered review cancelled at %s even if the cancel checkpoint loses CAS",
  async (boundary) => {
    const f = compositeFixture();
    const entered = deferred();
    const release = deferred();
    const cancelAttempted = deferred();
    const checkpointFailure = new McpEditError(
      "revision_conflict",
      "Cancel checkpoint lost a concurrent CAS",
    );
    const load = f.repository.load.bind(f.repository);
    const save = f.repository.save.bind(f.repository);
    let paused = false;
    f.repository.load = async (...args) => {
      const record = await load(...args);
      if (boundary === "after-load" && !paused && record.status === "running") {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return record;
    };
    f.repository.save = async (record, version, check) => {
      if (record.status === "cancelled") {
        cancelAttempted.resolve();
        throw checkpointFailure;
      }
      if (
        boundary === "before-commit" &&
        !paused &&
        record.status === "awaiting-review"
      ) {
        check();
        paused = true;
        entered.resolve();
        await release.promise;
      }
      // The real repository repeats this supplied guard at transaction publication.
      return save(record, version, check);
    };
    try {
      const prepared = await f.service.prepare(
        owner,
        compositePlan(true),
        guard,
      );
      const started = await f.service.run(owner, mutation(prepared), guard);
      await entered.promise;
      const done = f.service
        .waitForCompletion(owner, started.id, guard)
        .catch((error: unknown) => error);
      const cancellation = f.service
        .control(owner, mutation(started), "cancel", guard)
        .catch((error: unknown) => error);
      await cancelAttempted.promise;
      release.resolve();
      expect(await done).toMatchObject({ name: "AbortError" });
      const controlError = await cancellation;
      expect(controlError).toBeInstanceOf(AggregateError);
      if (!(controlError instanceof AggregateError))
        throw new Error("Expected the control checkpoint failure");
      expect(controlError.errors).toContain(checkpointFailure);
      const held = await f.service.get(owner, started.id, guard);
      expect(held).toMatchObject({
        status: "held",
        stopReason: "interrupted",
        used: { admissions: 1, pageAttempts: 1 },
      });
      expect(held.phases[0].status).toBe("held");
      expect(held.phases[0].evidence).toBeUndefined();
      expect(f.events).toEqual(["rendered"]);
    } finally {
      release.resolve();
      await f.service.close();
    }
  },
);
