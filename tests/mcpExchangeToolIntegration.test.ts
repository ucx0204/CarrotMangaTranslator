import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mcpJobReceiptOutput } from "../src/main/mcp/mcpJobOutputSchema";
import { McpContextImportReviewSchema } from "../src/shared/mcpContextExchange";
import { mcpFileUploadOutputs } from "../src/shared/mcpFileUploads";
import { exchangeToolIntegrationFixture } from "./mcpExchangeToolIntegration.fixture";

it("composes read-only context export, explicit job-file retrieval and encrypted reissue without implying client receipt", async () => {
  const f = await exchangeToolIntegrationFixture();
  try {
    const before = await readFile(f.chapterPath);
    const names = f.resources().tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("carrot_get_job_file");
    expect(names).toContain("carrot_export_context_json");
    expect(names).not.toContain("carrot_apply_context_import");
    expect(names).not.toContain("carrot_export_work_file");
    const { review, started, settled } = await f.startContext();
    expect(settled.status, JSON.stringify(settled.error)).toBe("completed");
    expect(JSON.stringify(settled)).not.toMatch(
      /mcp-artifacts|"url"|imagePath|sourcePath/,
    );
    const generated = await f.report({ kind: "job", jobId: started.jobId });
    expect(generated).toMatchObject({
      generation: { status: "completed", jobId: started.jobId },
      retention: {
        state: "retained",
        content: "verified",
        source: "current",
        access: "allowed",
      },
      sessionFile: { state: "available" },
      clientReceipt: "unconfirmed",
      observation: {
        state: "observed",
        capabilities: { generated: 1, reissued: 0 },
        toolResponsesPrepared: { text: 0, attachment: 0 },
      },
    });
    const ordinary = await f.jobFile(started.jobId);
    expect(ordinary.content.map((item) => item.type)).toEqual(["text"]);
    expect(ordinary.file).toMatchObject({
      kind: "exchange-file",
      filename: "carrot-context.json",
      mimeType: "application/json",
    });
    const bytes = await f.read(ordinary.file.url);
    expect(bytes.length).toBe(review.sourceBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      review.sha256,
    );
    const attached = await f.jobFile(started.jobId, true);
    expect(attached.content).toContainEqual({
      type: "resource_link",
      uri: ordinary.file.url,
      name: "carrot-context.json",
      mimeType: "application/json",
      size: bytes.length,
    });
    expect(attached.file.url).toBe(ordinary.file.url);
    const prepared = await f.report({ kind: "job", jobId: started.jobId });
    expect(prepared.observation).toMatchObject({
      state: "observed",
      capabilities: { generated: 1, reissued: 0 },
      toolResponsesPrepared: { text: 2, attachment: 1 },
      http: { getStarted: 0, getCompleted: 0 },
    });
    expect(prepared.clientReceipt).toBe("unconfirmed");
    expect(JSON.stringify(prepared)).not.toMatch(
      /mcp-artifacts|"url"|"path"|imagePath|sourcePath|snapshot|Fingerprint/,
    );
    expect(JSON.stringify(prepared)).not.toContain(f.env.root);
    const id = ordinary.file.retainedOutputId;
    if (!id) throw new Error("Actual context export must be retained");
    const issued = await f.issue(id);
    expect(issued.url).not.toBe(ordinary.file.url);
    expect((await f.read(issued.url)).equals(bytes)).toBe(true);
    expect(
      (await f.report({ kind: "retained-output", outputId: id })).observation,
    ).toMatchObject({
      state: "observed",
      capabilities: { generated: 1, reissued: 1 },
      toolResponsesPrepared: { text: 3, attachment: 1 },
    });
    const old = f.resources().artifacts;
    await f.restart();
    await expect(
      old.read(new URL(issued.url).pathname.split("/")[2]),
    ).rejects.toThrow();
    const reconstructed = await f.report({
      kind: "retained-output",
      outputId: id,
    });
    expect(reconstructed).toMatchObject({
      retention: {
        state: "retained",
        content: "verified",
        source: "current",
        access: "allowed",
      },
      observation: { state: "not_observed", historyComplete: false },
      clientReceipt: "unconfirmed",
    });
    const renewed = await f.issue(id);
    expect((await f.read(renewed.url)).equals(bytes)).toBe(true);
    expect(
      (await f.report({ kind: "retained-output", outputId: id })).observation,
    ).toMatchObject({
      state: "observed",
      capabilities: { generated: 0, reissued: 1 },
      toolResponsesPrepared: { text: 1, attachment: 0 },
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects stale reviewed context and enforces owner and whole-file selectors through the actual tools", async () => {
  const f = await exchangeToolIntegrationFixture();
  try {
    const exported = await f.startContext();
    expect(exported.settled.status).toBe("completed");
    const { file } = await f.jobFile(exported.started.jobId);
    const id = file.retainedOutputId;
    if (!id) throw new Error("Expected retained context export");
    const foreign = f.caller(["carrot.read"], "foreign-owner");
    await expect(
      f.jobFile(exported.started.jobId, false, foreign),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.report({ kind: "job", jobId: exported.started.jobId }, foreign),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.report({ kind: "retained-output", outputId: id }, foreign),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.call("carrot_get_job_file", {
        jobId: exported.started.jobId,
        pageId: "page",
      }),
    ).rejects.toThrow();
    await expect(
      f.call("carrot_get_output_delivery", {
        target: { kind: "retained-output", outputId: id, url: file.url },
      }),
    ).rejects.toThrow();
    const guide = await f.library.getWorkStyleGuide("work");
    guide.rules.honorifics =
      guide.rules.honorifics === "drop" ? "preserve" : "drop";
    await f.library.saveWorkStyleGuide(guide);
    const started = mcpJobReceiptOutput.parse(
      (
        await f.call("carrot_export_context_json", {
          ...exported.input,
          requestId: randomUUID(),
        })
      ).value,
    );
    const stale = await f.done(started.jobId);
    expect(stale).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    await expect(f.jobFile(started.jobId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(f.jobFile(exported.started.jobId)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    const diagnosis = await f.report({
      kind: "job",
      jobId: exported.started.jobId,
    });
    expect(diagnosis).toMatchObject({
      generation: { status: "completed" },
      retention: {
        state: "retained",
        content: "verified",
        source: "stale",
        access: "blocked",
      },
      sessionFile: { state: "unavailable" },
      clientReceipt: "unconfirmed",
    });
    expect((await f.storage.index()).entries).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("routes public file-upload bytes to context preview through the existing shared import store", async () => {
  const f = await exchangeToolIntegrationFixture({ editing: true });
  try {
    const exported = await f.startContext();
    expect(exported.settled.status).toBe("completed");
    const { file } = await f.jobFile(exported.started.jobId);
    const payload = JSON.parse((await f.read(file.url)).toString("utf8"));
    payload.guide.rules.honorifics =
      payload.guide.rules.honorifics === "drop" ? "preserve" : "drop";
    const bytes = Buffer.from(JSON.stringify(payload));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const before = await f.graph();
    const auth = f.all();
    const upload = mcpFileUploadOutputs.carrot_begin_file_upload.parse(
      (
        await f.call(
          "carrot_begin_file_upload",
          {
            requestId: randomUUID(),
            filename: "reviewed-context.JSON",
            bytes: bytes.length,
            sha256,
          },
          auth,
        )
      ).value,
    );
    await f.call(
      "carrot_write_file_upload",
      { uploadId: upload.uploadId, offset: 0, data: bytes.toString("base64") },
      auth,
    );
    await f.call(
      "carrot_finish_file_upload",
      { uploadId: upload.uploadId },
      auth,
    );
    const input = {
      chapterId: "chapter",
      uploadId: upload.uploadId,
      requestId: randomUUID(),
      selections: [
        { changeId: "rules", entity: "rules", fields: ["honorifics"] },
      ],
    };
    const preview = McpContextImportReviewSchema.parse(
      (await f.call("carrot_preview_context_import", input, auth)).value,
    );
    expect(preview).toMatchObject({
      uploadId: upload.uploadId,
      sourceBytes: bytes.length,
      sourceSha256: sha256,
      workId: "work",
      chapterId: "chapter",
      totalChanges: 1,
    });
    expect(await f.graph()).toEqual(before);
    await expect(
      f.call("carrot_preview_context_import", input, f.caller()),
    ).rejects.toMatchObject({ code: "access_denied" });
    await f.call(
      "carrot_discard_file_upload",
      { uploadId: upload.uploadId },
      auth,
    );
    await expect(
      f.call("carrot_preview_context_import", input, auth),
    ).rejects.toThrow();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
