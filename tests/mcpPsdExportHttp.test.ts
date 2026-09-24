import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { exportHttpFixture } from "./mcpExportHttp.fixture";
import { psdOptions } from "./mcpPsdExport.fixture";

it("delivers PSD only through explicit owned file calls and denies wrong names, scopes and revoked access", async () => {
  const f = await exportHttpFixture();
  try {
    const preflight = await f.call("carrot_preflight_pages_export", {
      chapterId: f.chapter.id,
      pageIds: ["p1"],
      imageExport: psdOptions,
    });
    expect(preflight.result.isError).toBe(false);
    const plan = preflight.result.structuredContent;
    const command = {
      chapterId: plan.chapterId,
      snapshot: plan.snapshot,
      pages: plan.pages.map(
        ({ pageId, revision }: { pageId: string; revision: string }) => ({
          pageId,
          revision,
        }),
      ),
      imageExport: plan.imageExport,
      requestId: randomUUID(),
    };
    const accepted = await f.call("carrot_export_pages_psd", command);
    expect(accepted.result.isError).toBe(false);
    const jobId = accepted.result.structuredContent.jobId;
    expect((await f.finish(jobId)).status).toBe("completed");
    expect(
      (await f.call("carrot_export_pages_psd", command)).result
        .structuredContent.jobId,
    ).toBe(jobId);
    for (const name of ["carrot_get_job", "carrot_cancel_job"])
      expect(JSON.stringify(await f.call(name, { jobId }))).not.toMatch(
        /mcp-artifacts|resource_link|base64/,
      );
    const file = await f.call("carrot_get_job_file", { jobId, pageId: "p1" });
    expect(file.result.isError).toBe(false);
    expect(file.result.content).toHaveLength(1);
    const metadata = file.result.structuredContent;
    expect(metadata.mimeType).toBe("image/vnd.adobe.photoshop");
    const path = new URL(metadata.url).pathname;
    expect(path.endsWith("/page.psd")).toBe(true);
    const head = await f.send(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(metadata.mimeType);
    expect(head.headers.get("content-disposition")).toBe(
      'attachment; filename="carrot-page.psd"',
    );
    expect(await head.text()).toBe("");
    const downloaded = await f.send(path);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      metadata.sha256,
    );
    expect((await f.send(path.replace("page.psd", "page.png"))).status).toBe(
      404,
    );
    const attached = await f.call("carrot_get_job_file", {
      jobId,
      pageId: "p1",
      includeAttachment: true,
    });
    expect(attached.result.content).toContainEqual({
      type: "resource_link",
      uri: metadata.url,
      name: "carrot-page.psd",
      mimeType: metadata.mimeType,
      size: bytes.length,
    });
    const readOnly = f.grant("carrot.read");
    expect(
      (
        await f.call(
          "carrot_export_pages_psd",
          { ...command, requestId: randomUUID() },
          readOnly,
        )
      ).error,
    ).toBeDefined();
    const other = f.grant("carrot.read carrot.images");
    expect(
      (await f.call("carrot_get_job_file", { jobId, pageId: "p1" }, other))
        .result.isError,
    ).toBe(true);
    expect(f.renderImage).toHaveBeenCalledOnce();
    f.revoke();
    expect((await f.send(path)).status).toBe(404);
  } finally {
    await f.close();
  }
});

it("does not accept PSD through raster endpoints or bypass acknowledgments with a direct request", async () => {
  const f = await exportHttpFixture();
  try {
    const target = await f.target(["p1"], psdOptions);
    for (const name of [
      "carrot_export_pages_png",
      "carrot_export_pages_images",
    ])
      expect((await f.call(name, target)).error.code).toBe(-32602);
    for (const imageExport of [
      { format: "psd" },
      { ...psdOptions, acknowledgeOriginalLayer: false },
      { ...psdOptions, acknowledgeRasterLayers: false },
      { ...psdOptions, omitText: true },
      { ...psdOptions, quality: 90 },
      { format: "png", omitText: false },
    ])
      expect(
        (await f.call("carrot_export_pages_psd", { ...target, imageExport }))
          .error.code,
      ).toBe(-32602);
    expect(f.renderImage).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
