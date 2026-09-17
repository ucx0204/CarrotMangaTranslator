import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { contextHttpFixture } from "./mcpContextHttp.fixture";
import { contextResearchChanges } from "../src/main/application/mcpContextResearchPolicy";
import { createWorkContextResearchFingerprint } from "../src/shared/workContextResearchProposal";

it("validates app research additions, updates and disabling against the exact guide", async () => {
  const f = await contextHttpFixture();
  try {
    const snapshot = await f.library.readWorkContextForEdit("chapter");
    const result = await f.research({ ...f.target, runId: randomUUID(), guideSnapshot: snapshot.styleGuide });
    const op = result.operations[0];
    if (op.entity !== "glossary") throw new Error("Expected glossary fixture");
    const existing = { ...op.after, origin: "manual" as const, aliases: ["Keep alias"], note: "Keep note" };
    const guide = { ...snapshot.styleGuide, glossary: [existing] };
    for (const action of ["update", "disable"] as const) {
      const changed = { ...result, baseFingerprint: createWorkContextResearchFingerprint(guide), operations: [{ ...op, action, before: existing, after: { ...existing, target: "Revised", enabled: action !== "disable" } }] };
      const proposal = contextResearchChanges(guide, changed, f.target);
      expect(proposal?.input.changes[0]).toMatchObject({ entryId: existing.id, values: { target: "Revised", enabled: action !== "disable" } });
      expect(proposal?.input.changes[0].values).not.toHaveProperty("origin");
      expect(guide.glossary[0]).toEqual(existing);
      const forged = structuredClone(changed);
      forged.operations[0].before.target = "Unreviewed previous value";
      expect(() => contextResearchChanges(guide, forged, f.target)).toThrow();
    }
    expect(() => contextResearchChanges(guide, { ...result, baseFingerprint: createWorkContextResearchFingerprint(guide) }, f.target)).toThrow(/collides/);
  } finally { await f.close(); }
});

it("rejects malformed, duplicate and unbounded research evidence without changing the library", async () => {
  const f = await contextHttpFixture();
  try {
    const snapshot = await f.library.readWorkContextForEdit("chapter");
    const result = await f.research({ ...f.target, runId: randomUUID(), guideSnapshot: snapshot.styleGuide });
    const mutations = [
      (value: typeof result) => { value.baseFingerprint = "wrong"; },
      (value: typeof result) => { value.operations.push(structuredClone(value.operations[0])); },
      (value: typeof result) => { value.operations = Array.from({ length: 101 }, () => structuredClone(value.operations[0])); },
      (value: typeof result) => { Reflect.set(value.operations[0].after, "source", ""); },
      (value: typeof result) => { Reflect.set(value.operations[0], "action", "delete"); },
      (value: typeof result) => { value.operations[0].action = "update"; },
      (value: typeof result) => { value.operations[0].sources = []; },
      (value: typeof result) => { value.operations[0].reason = "x".repeat(2001); },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(result);
      mutate(value);
      expect(() => contextResearchChanges(snapshot.styleGuide, value, f.target)).toThrow();
    }
    expect(contextResearchChanges(snapshot.styleGuide, { ...result, operations: [] }, f.target)).toBeNull();
  } finally { await f.close(); }
});

it.each(["empty", "warnings"] as const)("finishes %s app research without publishing or applying unwanted context", async (kind) => {
  const f = await contextHttpFixture();
  try {
    const before = await f.snapshot();
    const snapshot = await f.library.readWorkContextForEdit("chapter");
    const result = await f.research({ ...f.target, runId: randomUUID(), guideSnapshot: snapshot.styleGuide });
    f.research.mockResolvedValueOnce(kind === "empty" ? { ...result, operations: [] } : { ...result, warnings: ["x".repeat(2001)] });
    const start = await f.call("carrot_run_context_research", f.target);
    const job = await f.settle(start.result.structuredContent.jobId);
    if (kind === "empty") {
      expect(job.status).toBe("completed");
      expect(job.result.status).toBe("no_changes");
    } else {
      expect(job.status).toBe("failed");
      expect(job.error.code).toBe("invalid_edit");
    }
    expect(job.result?.contextResearch).toBeUndefined();
    expect(f.jobs.gate.activities).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  } finally { await f.close(); }
});
