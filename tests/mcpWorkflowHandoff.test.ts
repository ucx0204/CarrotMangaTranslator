import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowHandoffFixture } from "./mcpWorkflowHandoff.fixture";
import { mcpWorkflowHandoffOutputs } from "../src/shared/mcpWorkflowHandoff";
import { createPageRevision } from "../src/shared/pageRevision";

it("registers four strict handoff tools and transfers only after addressed acceptance, without executing", async () => {
  const f = await workflowHandoffFixture();
  try {
    const names = Object.keys(mcpWorkflowHandoffOutputs);
    expect(
      f.current().tools.filter((tool) => names.includes(tool.name)),
    ).toHaveLength(4);
    expect(
      await f.invoke("carrot_get_workflow_handoff_identity", {}, f.recipient),
    ).toEqual({
      connectionId: f.recipient.principalId,
      grantsAccess: false,
    });
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([
      { kind: "await-external", purpose: "translation" },
    ]);
    const offer = await f.offer(plan.id);
    expect(
      await f.invoke("carrot_offer_workflow_handoff", offer.input, f.donor),
    ).toEqual(offer.receipt);
    await expect(
      f.accept(offer.acceptance, f.auth("unaddressed")),
    ).rejects.toThrow();
    expect((await f.get(plan.id)).status).toBe("prepared");
    const accepted = await f.accept(offer.acceptance);
    expect(accepted).toMatchObject({
      status: "transferred",
      historyTransferred: false,
    });
    expect(accepted.workflow).toMatchObject({
      status: "paused",
      completedSteps: 0,
      pageAttemptsUsed: 0,
    });
    expect(accepted.workflow.expiresAt).toBe(plan.expiresAt);
    await expect(f.get(plan.id)).rejects.toThrow();
    expect(
      (await f.storage.owned(f.recipient.principalId, plan.id)).entry.requestId,
    ).toBeNull();
    await f.restart();
    expect((await f.inspect(plan.id, f.recipient)).status).toBe("paused");
    expect((await f.accept(offer.acceptance)).status).toBe(
      "already_transferred",
    );
    const current = await f.inspect(plan.id, f.recipient);
    await f.invoke(
      "carrot_resume_workflow",
      {
        id: plan.id,
        version: current.version,
        requestId: randomUUID(),
      },
      f.recipient,
    );
    await vi.waitFor(
      async () => {
        expect((await f.inspect(plan.id, f.recipient)).status).toBe(
          "waiting_external",
        );
      },
      { timeout: 10000 },
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps completed steps but does not transfer existing native job, change or output ownership", async () => {
  const f = await workflowHandoffFixture();
  try {
    const plan = await f.prepare([
      { kind: "export-png" },
      { kind: "await-external", purpose: "image" },
    ]);
    await f.run(plan.id);
    const waiting = await f.done(plan.id);
    expect(waiting.status).toBe("waiting_external");
    const outputIds = waiting.steps.flatMap((step) =>
      step.outputId ? [step.outputId] : [],
    );
    expect(outputIds).toHaveLength(2);
    const offer = await f.offer(plan.id);
    const accepted = await f.accept(offer.acceptance);
    expect(accepted.workflow.completedSteps).toBe(waiting.completedSteps);
    expect(accepted.workflow.pageAttemptsUsed).toBe(waiting.pageAttemptsUsed);
    expect(
      accepted.workflow.steps.every(
        (step) => !step.jobId && !step.changeId && !step.outputId,
      ),
    ).toBe(true);
    for (const id of outputIds) {
      await f.storage.owned(f.owner, id, "output");
      await expect(
        f.storage.owned(f.recipient.principalId, id, "output"),
      ).rejects.toThrow();
    }
    await f.restart();
    expect((await f.inspect(plan.id, f.recipient)).completedSteps).toBe(2);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects same-owner offers, changed request replay, revoked offers and offers lost at restart", async () => {
  const f = await workflowHandoffFixture();
  try {
    const plan = await f.prepare([
      { kind: "await-external", purpose: "translation" },
    ]);
    await expect(f.offer(plan.id, f.owner)).rejects.toThrow(
      "same approved connection",
    );
    const first = await f.offer(plan.id);
    await expect(
      f.invoke(
        "carrot_offer_workflow_handoff",
        {
          ...first.input,
          targetConnectionId: "another-recipient",
        },
        f.donor,
      ),
    ).rejects.toThrow("requestId");
    await expect(
      f.invoke(
        "carrot_revoke_workflow_handoff",
        {
          id: plan.id,
          offerId: first.receipt.offerId,
        },
        f.recipient,
      ),
    ).rejects.toThrow();
    await f.invoke(
      "carrot_revoke_workflow_handoff",
      {
        id: plan.id,
        offerId: first.receipt.offerId,
      },
      f.donor,
    );
    await expect(f.accept(first.acceptance)).rejects.toThrow();
    const pending = await f.offer(plan.id);
    await f.restart();
    await expect(f.accept(pending.acceptance)).rejects.toThrow();
    expect((await f.get(plan.id)).status).toBe("prepared");
    await expect(
      f.invoke("carrot_get_workflow_handoff_identity", { owner: f.owner }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires live donor approval and receiver permission for every stage", async () => {
  const f = await workflowHandoffFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const offered = await f.offer(plan.id);
    f.recipient.assertJobAuthorized.mockImplementation((scopes: string[]) => {
      if (scopes.includes("carrot.images"))
        throw new Error("Receiver lacks image permission");
    });
    await expect(f.accept(offered.acceptance)).rejects.toThrow(
      "image permission",
    );
    f.recipient.assertJobAuthorized.mockReset();
    f.donor.assertJobAuthorized.mockImplementation(() => {
      throw new Error("Donor approval revoked");
    });
    await expect(f.accept(offered.acceptance)).rejects.toThrow(
      "Donor approval revoked",
    );
    await f.storage.owned(f.owner, plan.id, "workflow");
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects changed execution settings and saved page evidence before ownership publication", async () => {
  const f = await workflowHandoffFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const offered = await f.offer(plan.id);
    const tokens = f.settings.maxTokens;
    f.settings.maxTokens++;
    await expect(f.accept(offered.acceptance)).rejects.toThrow(
      "settings changed",
    );
    f.settings.maxTokens = tokens;
    const chapter = await f.library.openChapter("chapter");
    const page = chapter.pages[0];
    await f.invoke("carrot_update_page_blocks", {
      chapterId: chapter.id,
      pageId: page.id,
      revision: createPageRevision(page),
      edits: [
        {
          blockId: page.blocks[0].id,
          fields: { translatedText: "Later user edit" },
        },
      ],
    });
    await expect(f.accept(offered.acceptance)).rejects.toThrow("page changed");
    await f.storage.owned(f.owner, plan.id, "workflow");
    expect(
      (await f.library.openChapter("chapter")).pages[0].blocks[0]
        .translatedText,
    ).toBe("Later user edit");
  } finally {
    await f.close();
  }
});

it("expires pending consent without extending durable workflow retention", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await workflowHandoffFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const offered = await f.offer(plan.id);
    expect(offered.receipt.expiresAt).toBeLessThan(plan.expiresAt);
    now += 11 * 60_000;
    await expect(f.accept(offered.acceptance)).rejects.toThrow("expired");
    expect((await f.get(plan.id)).expiresAt).toBe(plan.expiresAt);
    const next = await f.offer(plan.id);
    expect((await f.accept(next.acceptance)).workflow.expiresAt).toBe(
      plan.expiresAt,
    );
  } finally {
    await f.close();
    clock.mockRestore();
  }
});

it("keeps fallback scope validation and missing-identity rejection on real registered handoff tools", async () => {
  const f = await workflowHandoffFixture();
  const { authorizeMcpWorkflow } =
    await import("../src/main/mcp/mcpWorkflowAuthorization");
  const { McpWorkflowRecordSchema } =
    await import("../src/main/application/mcpWorkflowPolicy");
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(plan.id),
    );
    const context = {
      principalId: f.owner,
      assertAuthorized: vi.fn(),
      assertScopes: vi.fn(),
    };
    authorizeMcpWorkflow(context, record);
    expect(context.assertAuthorized).toHaveBeenCalledTimes(1);
    expect(context.assertScopes).toHaveBeenCalledWith(
      expect.arrayContaining([
        "carrot.images",
        "carrot.edit",
        "carrot.process",
      ]),
    );
    expect(() =>
      authorizeMcpWorkflow(
        { principalId: f.owner, assertAuthorized: vi.fn() },
        record,
      ),
    ).toThrow("Scope verification");
    const tool = f
      .current()
      .tools.find((item) => item.name === "carrot_accept_workflow_handoff");
    if (!tool) throw new Error("Missing registered acceptance tool");
    await expect(tool.invoke({})).rejects.toThrow(
      "approved receiving connection",
    );
  } finally {
    await f.close();
  }
});
