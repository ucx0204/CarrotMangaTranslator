import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { contextHttpFixture } from "./mcpContextHttp.fixture";

it.each(["translate", "note"] as const)("finishes queued context application without retaining research leases (%s)", async (sfxMode) => {
  const f = await contextHttpFixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = f.research.getMockImplementation();
  if (!original) throw new Error("Missing research fixture");
  f.research.mockImplementationOnce(async (...args) => { enter(); await blocked; return original(...args); });
  const cancel = new AbortController();
  let waiting: Promise<unknown> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const before = await f.snapshot();
    const preview = await f.call("carrot_preview_context_edit", { chapterId: "chapter", revision: f.target.revision, requestId: randomUUID(), changes: [{ changeId: "rule", entity: "rules", values: { sfxMode } }] });
    expect(preview.result.isError).toBe(false);
    const research = await f.call("carrot_run_context_research", f.target);
    const jobId = research.result.structuredContent.jobId;
    await entered;
    timeout = setTimeout(() => cancel.abort(new Error("Context application remained blocked after the research engine finished")), 2000);
    const applying = f.call("carrot_apply_context_proposal", { proposalId: preview.result.structuredContent.proposalId, requestId: randomUUID(), selectedChangeIds: ["rule"] }, f.full, cancel.signal);
    waiting = applying;
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const applied = await applying;
    expect(applied.result.isError).toBe(false);
    const job = await f.settle(jobId);
    if (sfxMode === "translate") {
      expect(job.status).toBe("completed");
      expect(job.result.contextResearch.source).toBe("app-research");
    } else {
      expect(job.status).toBe("failed");
      expect(job.error.code).toBe("revision_conflict");
      expect(job.result?.contextResearch).toBeUndefined();
    }
    expect(f.research).toHaveBeenCalledOnce();
    expect(f.jobs.gate.activities).toEqual([]);
    expect((await f.library.readWorkContextForEdit("chapter")).styleGuide.rules.sfxMode).toBe(sfxMode);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    release(); cancel.abort(); clearTimeout(timeout);
    if (waiting) await Promise.allSettled([waiting]);
    await f.close();
  }
});
