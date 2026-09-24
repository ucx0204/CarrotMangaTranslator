import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { workflowHttp } from "./mcpWorkflowHttp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

type Fixture = Awaited<ReturnType<typeof workflowHttp>>;
async function receivingConnection(f: Fixture) {
  const token = createMcpTestGrant("https://workflow.test", "s".repeat(43))(
    f.provider,
    "carrot.read carrot.edit carrot.process carrot.images",
  );
  const response = await f.call(
    "carrot_get_workflow_handoff_identity",
    {},
    token,
  );
  expect(response.result.isError).toBe(false);
  return {
    token,
    id: response.result.structuredContent.connectionId as string,
  };
}
async function offerOverHttp(
  f: Fixture,
  id: string,
  version: number,
  targetConnectionId: string,
) {
  const reply = await f.call("carrot_offer_workflow_handoff", {
    id,
    version,
    requestId: randomUUID(),
    targetConnectionId,
  });
  expect(reply.result.isError).toBe(false);
  return {
    id,
    version,
    offerId: reply.result.structuredContent.offerId as string,
    requestId: randomUUID(),
  };
}

it("uses actual approved recipient identity, enforces scopes and resumes only after explicit acceptance", async () => {
  const f = await workflowHttp();
  try {
    const plan = await f.prepareHttp();
    const receiver = await receivingConnection(f);
    expect(
      (await f.call("carrot_get_workflow_handoff_identity", {}, f.read)).error
        .message,
    ).toBe("Unknown tool");
    const limited = await f.call(
      "carrot_get_workflow_handoff_identity",
      {},
      f.limited,
    );
    const wrongScope = await offerOverHttp(
      f,
      plan.id,
      plan.version,
      limited.result.structuredContent.connectionId,
    );
    const denied = await f.call(
      "carrot_accept_workflow_handoff",
      wrongScope,
      f.limited,
    );
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true);
    expect(
      (await f.call("carrot_get_workflow", { id: plan.id })).result
        .structuredContent.status,
    ).toBe("prepared");
    const acceptance = await offerOverHttp(
      f,
      plan.id,
      plan.version,
      receiver.id,
    );
    expect(
      (
        await f.call(
          "carrot_accept_workflow_handoff",
          { ...acceptance, snapshot: {} },
          receiver.token,
        )
      ).error.code,
    ).toBe(-32602);
    const accepted = await f.call(
      "carrot_accept_workflow_handoff",
      acceptance,
      receiver.token,
    );
    expect(accepted.result.isError).toBe(false);
    expect(accepted.result.structuredContent).toMatchObject({
      status: "transferred",
      historyTransferred: false,
      workflow: { status: "paused" },
    });
    expect(
      (await f.call("carrot_get_workflow", { id: plan.id })).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(f.render).not.toHaveBeenCalled();
    expect(
      (
        await f.call(
          "carrot_accept_workflow_handoff",
          acceptance,
          receiver.token,
        )
      ).result.structuredContent.status,
    ).toBe("already_transferred");
    const record = accepted.result.structuredContent.workflow;
    await f.call(
      "carrot_resume_workflow",
      { id: plan.id, version: record.version, requestId: randomUUID() },
      receiver.token,
    );
    await vi.waitFor(
      async () => {
        const result = await f.call(
          "carrot_get_workflow",
          { id: plan.id },
          receiver.token,
        );
        expect(result.result.structuredContent.status).toBe("completed");
        expect(JSON.stringify(result)).not.toMatch(
          /imagePath|dataUrl|settingsFingerprint|sourceText/,
        );
      },
      { timeout: 20000 },
    );
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rechecks donor approval after its HTTP reply and encrypted staging, before publishing recipient ownership", async () => {
  const f = await workflowHttp();
  const seal = f.codec.seal;
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const plan = await f.prepareHttp();
    const receiver = await receivingConnection(f);
    const donorId = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!donorId) throw new Error("Missing approved donor identity");
    const acceptance = await offerOverHttp(
      f,
      plan.id,
      plan.version,
      receiver.id,
    );
    let revoked = false;
    hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const sealed = await seal(value);
      if (
        !revoked &&
        typeof value === "object" &&
        value !== null &&
        "owner" in value &&
        value.owner === receiver.id
      ) {
        revoked = true;
        f.provider.revokeConnection(donorId);
      }
      return sealed;
    });
    const refused = await f.call(
      "carrot_accept_workflow_handoff",
      acceptance,
      receiver.token,
    );
    expect(revoked).toBe(true);
    expect(refused.result?.isError ?? Boolean(refused.error)).toBe(true);
    await f.storage.owned(donorId, plan.id, "workflow");
    await expect(
      f.storage.owned(receiver.id, plan.id, "workflow"),
    ).rejects.toThrow();
    expect(await f.storage.record(plan.id)).toMatchObject({
      owner: donorId,
      version: plan.version,
    });
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    hook?.mockRestore();
    await f.close();
  }
});
