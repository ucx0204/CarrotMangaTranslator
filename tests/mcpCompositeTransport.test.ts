import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  McpCompositeViewSchema,
  mcpCompositeWorkflowOutputs,
} from "../src/shared/mcpCompositeWorkflowOutputs";
import { compositeFingerprint } from "../src/main/application/mcpCompositeWorkflowPolicy";
import {
  compositePlan,
  guard,
  owner,
  reviewReport,
} from "./mcpCompositeWorkflow.fixture";
import { compositeTransportFixture } from "./mcpCompositeTransport.fixture";

it("registers fifteen strict operations and keeps parent/read inspection free of rendering or execution", async () => {
  const f = compositeTransportFixture();
  try {
    expect(new Set(f.tools.map((tool) => tool.name)).size).toBe(15);
    expect(f.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(mcpCompositeWorkflowOutputs).sort(),
    );
    const response = await f.invoke(
      "carrot_prepare_composite",
      compositePlan(),
    );
    const prepared = McpCompositeViewSchema.parse(response.structuredContent);
    expect(response.content.every((item) => item.type === "text")).toBe(true);
    expect(prepared).toMatchObject({
      automaticResume: false,
      crossOwnerHandoff: false,
      used: { admissions: 0 },
    });
    await f.invoke("carrot_get_composite", { id: prepared.id });
    const listed = mcpCompositeWorkflowOutputs.carrot_list_composites.parse(
      (await f.invoke("carrot_list_composites")).structuredContent,
    );
    expect(listed.items.map((item) => item.id)).toEqual([prepared.id]);
    expect(f.events).toEqual([]);
    expect(f.readEvidence).not.toHaveBeenCalled();
    await expect(
      f.invoke("carrot_get_composite", {
        id: prepared.id,
        nativeInput: "untrusted",
      }),
    ).rejects.toThrow();
    await expect(
      f.invoke(
        "carrot_get_composite",
        { id: prepared.id },
        { ...f.auth, principalId: "foreign-owner" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await f.service.close();
  }
});

it("rejects arbitrary executable import preflight variants before the native reader", async () => {
  const f = compositeTransportFixture();
  try {
    const tool = f.tools.find(
      (item) => item.name === "carrot_preflight_composite_import",
    );
    expect(tool?.readOnly).toBe(true);
    await expect(
      f.invoke("carrot_preflight_composite_import", {
        phaseId: "import",
        action: {
          kind: "shell",
          input: { command: "untrusted executable", requestId: randomUUID() },
        },
      }),
    ).rejects.toThrow();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  } finally {
    await f.service.close();
  }
});

it("does not expose native action inputs or private journal and source snapshots in status", async () => {
  const f = compositeTransportFixture();
  try {
    const prepared = await f.service.prepare(owner, compositePlan(), guard);
    const bound = await f.bind(prepared);
    const view = McpCompositeViewSchema.parse(
      (await f.invoke("carrot_get_composite", { id: bound.id }))
        .structuredContent,
    );
    const phase = view.phases[0];
    expect(phase.binding?.snapshot).toBe(bound.snapshot.fingerprint);
    expect(phase.binding).not.toHaveProperty("nativeReference");
    expect(phase.binding).not.toHaveProperty("action");
    expect(view).not.toHaveProperty("owner");
    expect(view).not.toHaveProperty("actions");
    expect(view.snapshot).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  } finally {
    await f.service.close();
  }
});

it("returns an exact issued PNG only through explicit image retrieval and denies altered bytes", async () => {
  const f = compositeTransportFixture();
  try {
    const record = await f.review();
    const metadata = await f.invoke("carrot_get_composite_review", {
      id: record.id,
      phaseId: "review-one",
    });
    expect(metadata.content.every((item) => item.type === "text")).toBe(true);
    const review =
      mcpCompositeWorkflowOutputs.carrot_get_composite_review.parse(
        metadata.structuredContent,
      );
    const evidence = review.evidence[0];
    if (!evidence) throw new Error("Fixture issued no render evidence");
    const input = {
      id: record.id,
      phaseId: "review-one",
      evidenceId: evidence.id,
    };
    const rendered = await f.invoke("carrot_get_composite_review_image", input);
    expect(rendered.content[1]).toEqual({
      type: "image",
      data: f.bytes.toString("base64"),
      mimeType: "image/png",
    });
    expect(rendered.structuredContent).toMatchObject({
      evidence: { id: evidence.id, sha256: evidence.sha256 },
      qualityVerdict: "host-assessment-required",
    });
    expect(f.events).toEqual(["rendered"]);
    const read = f.readEvidence.getMockImplementation();
    if (!read) throw new Error("Missing native read boundary");
    f.readEvidence.mockImplementationOnce(async (...args) => ({
      ...(await read(...args)),
      bytes: Buffer.from("changed"),
    }));
    await expect(
      f.invoke("carrot_get_composite_review_image", input),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.invoke("carrot_get_composite_review_image", {
        ...input,
        phaseId: "wrong-phase",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    f.grants.delete("carrot.images");
    await expect(
      f.invoke("carrot_get_composite_review_image", input),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.readEvidence).toHaveBeenCalledTimes(2);
  } finally {
    await f.service.close();
  }
});

it("rechecks current approval after a slow native preparation before persisting the parent", async () => {
  const f = compositeTransportFixture();
  const prepare = f.native.prepare;
  f.native.prepare = async (...args) => {
    const snapshot = await prepare(...args);
    f.revoke();
    return snapshot;
  };
  try {
    await expect(
      f.invoke("carrot_prepare_composite", compositePlan()),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.records.size).toBe(0);
  } finally {
    await f.service.close();
  }
});

it("keeps host verdict origin explicit and pages findings against an exact metadata snapshot", async () => {
  const f = compositeTransportFixture();
  try {
    const record = await f.review();
    const report = reviewReport(record);
    const evidenceId = report.assessments[0]?.evidenceId;
    if (!evidenceId) throw new Error("Fixture issued no render evidence");
    await f.invoke("carrot_get_composite_review_image", {
      id: record.id,
      phaseId: report.phaseId,
      evidenceId,
    });
    await f.invoke("carrot_submit_composite_review", report);
    const reviewed =
      mcpCompositeWorkflowOutputs.carrot_get_composite_review.parse(
        (
          await f.invoke("carrot_get_composite_review", {
            id: record.id,
            phaseId: "review-one",
          })
        ).structuredContent,
      );
    expect(reviewed.report).toMatchObject({
      reviewerKind: "connected-ai",
      verdictOrigin: "host-reported",
      verdict: "accepted",
    });
    expect(reviewed.observation).toContain("metadata-only");
    await expect(
      f.invoke("carrot_get_composite_review", {
        id: record.id,
        phaseId: "review-one",
        offset: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.invoke("carrot_get_composite_review", {
        id: record.id,
        phaseId: "review-one",
        snapshot: "f".repeat(16),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(
      compositeFingerprint((await f.service.get(owner, record.id, guard)).plan),
    ).toBe(record.initialFingerprint);
  } finally {
    await f.service.close();
  }
});
