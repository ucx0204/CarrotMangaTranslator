import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { exportHttpFixture } from "./mcpExportHttp.fixture";

it.each(["jpeg", "webp"] as const)(
  "delivers %s only on explicit file requests with matching headers and bytes",
  async (format) => {
    const f = await exportHttpFixture();
    try {
      const input = {
        chapterId: f.chapter.id,
        pageIds: ["p1"],
        imageExport: { format, quality: 90, omitText: false },
      };
      const preflight = await f.call("carrot_preflight_pages_export", input);
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
      const started = await f.call("carrot_export_pages_images", command);
      expect(started.result.isError).toBe(false);
      const jobId = started.result.structuredContent.jobId;
      const done = await f.finish(jobId);
      expect(done.status).toBe("completed");
      for (const name of ["carrot_get_job", "carrot_cancel_job"])
        expect(JSON.stringify(await f.call(name, { jobId }))).not.toMatch(
          /mcp-artifacts|resource_link|base64/,
        );
      const repeated = await f.call("carrot_export_pages_images", command);
      expect(repeated.result.structuredContent.jobId).toBe(jobId);
      expect(f.renderImage).toHaveBeenCalledTimes(1);
      const file = await f.call("carrot_get_job_file", { jobId, pageId: "p1" });
      expect(file.result.isError).toBe(false);
      expect(
        file.result.content.every(
          (part: { type: string }) => part.type === "text",
        ),
      ).toBe(true);
      const metadata = file.result.structuredContent;
      const extension = format === "jpeg" ? "jpg" : "webp";
      expect(metadata.mimeType).toBe(`image/${format}`);
      expect(metadata.kind).toBe("rendered-page-image");
      const path = new URL(metadata.url).pathname;
      expect(path.endsWith(`/page.${extension}`)).toBe(true);
      const head = await f.send(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(`image/${format}`);
      expect(head.headers.get("content-disposition")).toBe(
        `attachment; filename="carrot-page.${extension}"`,
      );
      expect(await head.text()).toBe("");
      const download = await f.send(path);
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        metadata.sha256,
      );
      expect(Number(download.headers.get("content-length"))).toBe(bytes.length);
      const wrong = path.replace(`page.${extension}`, "page.png");
      expect((await f.send(wrong)).status).toBe(404);
      const attached = await f.call("carrot_get_job_file", {
        jobId,
        pageId: "p1",
        includeAttachment: true,
      });
      expect(attached.result.content).toContainEqual({
        type: "resource_link",
        uri: metadata.url,
        name: `carrot-page.${extension}`,
        mimeType: `image/${format}`,
        size: bytes.length,
      });
      const noImages = f.grant("carrot.read");
      const denied = await f.call(
        "carrot_get_job_file",
        { jobId, pageId: "p1" },
        noImages,
      );
      expect(denied.result).toMatchObject({
        isError: true,
        structuredContent: { error: "not_found", retryable: false },
      });
      expect(JSON.stringify(denied)).not.toMatch(
        /mcp-artifacts|resource_link|base64/,
      );
      const foreign = f.grant("carrot.read carrot.images");
      expect(
        (await f.call("carrot_get_job_file", { jobId, pageId: "p1" }, foreign))
          .result.isError,
      ).toBe(true);
      f.revoke();
      expect((await f.send(path)).status).toBe(404);
    } finally {
      await f.close();
    }
  },
);

it("keeps the PNG endpoint narrow and rejects malformed format options before creating a job", async () => {
  const f = await exportHttpFixture();
  try {
    const target = await f.target(["p1"]);
    const wrong = await f.call("carrot_export_pages_png", {
      ...target,
      imageExport: { format: "jpeg", quality: 90 },
    });
    expect(wrong.error.code).toBe(-32602);
    expect(
      (await f.call("carrot_export_pages_images", target)).error.code,
    ).toBe(-32602);
    for (const imageExport of [
      { format: "jpeg" },
      { format: "png", quality: 90 },
      { format: "jpeg", quality: 0 },
      { format: "png", rawPath: "/tmp" },
    ]) {
      expect(
        (
          await f.call("carrot_preflight_pages_export", {
            chapterId: f.chapter.id,
            imageExport,
          })
        ).error.code,
      ).toBe(-32602);
    }
    expect(f.render).not.toHaveBeenCalled();
    expect(f.renderImage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
