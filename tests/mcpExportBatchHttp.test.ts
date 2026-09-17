import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { exportHttpFixture } from "./mcpExportHttp.fixture";
import { readExportZip } from "./mcpExportBatch.fixture";
import {
  mcpToolOutputSchema,
  mcpOutputSchemas,
} from "../src/main/mcp/mcpOutputSchemas";

async function exportPages(f: Awaited<ReturnType<typeof exportHttpFixture>>) {
  const response = await f.call("carrot_preflight_pages_export", {
    chapterId: "chapter",
  });
  expect(response.result.isError).toBe(false);
  const plan = response.result.structuredContent;
  const target = {
    chapterId: plan.chapterId,
    snapshot: plan.snapshot,
    pages: plan.pages.map((page: { pageId: string; revision: string }) => ({
      pageId: page.pageId,
      revision: page.revision,
    })),
    requestId: randomUUID(),
  };
  const started = await f.call("carrot_export_pages_png", target);
  expect(started.result.isError).toBe(false);
  expect(started.result.structuredContent.target).toEqual(target);
  const jobId = started.result.structuredContent.jobId as string;
  return { jobId, target, result: await f.finish(jobId) };
}

it("serves explicitly selected PNG and ZIP files while every job receipt remains metadata-only", async () => {
  const f = await exportHttpFixture();
  try {
    const before = structuredClone(f.chapter);
    for (const name of [
      "carrot_preflight_pages_export",
      "carrot_export_pages_png",
      "carrot_create_export_zip",
    ])
      expect(mcpToolOutputSchema(name)).toBeDefined();
    const { jobId, target, result } = await exportPages(f);
    expect(result.status).toBe("completed");
    expect(result.result.exportPages.completed).toBe(3);
    expect(
      (await f.call("carrot_export_pages_png", target)).result.structuredContent
        .jobId,
    ).toBe(jobId);
    expect(
      (await f.call("carrot_get_job_file", { jobId })).result.isError,
    ).toBe(true);
    const png = (await f.call("carrot_get_job_file", { jobId, pageId: "p1" }))
      .result;
    expect(png.isError).toBe(false);
    expect(png.content).toHaveLength(1);
    const pngPath = new URL(png.structuredContent.url).pathname;
    expect(await (await f.send(pngPath)).text()).toBe("PNG fixture p1");
    const request = { sourceJobId: jobId, requestId: randomUUID() };
    const started = await f.call("carrot_create_export_zip", request);
    expect(started.result.isError).toBe(false);
    const zipId = started.result.structuredContent.jobId;
    expect((await f.finish(zipId)).status).toBe("completed");
    const link = (await f.call("carrot_get_job_file", { jobId: zipId })).result;
    expect(link.isError).toBe(false);
    expect(link.content).toHaveLength(1);
    const file = link.structuredContent;
    const attached = (
      await f.call("carrot_get_job_file", {
        jobId: zipId,
        includeAttachment: true,
      })
    ).result;
    expect(attached.structuredContent).toEqual(file);
    expect(attached.content[1]).toMatchObject({
      type: "resource_link",
      mimeType: "application/zip",
      name: "carrot-pages.zip",
      size: file.bytes,
    });
    const path = new URL(file.url).pathname;
    const head = await f.send(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/zip");
    expect(head.headers.get("content-length")).toBe(String(file.bytes));
    expect(await head.text()).toBe("");
    const download = await f.send(path);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    const entries = readExportZip(Buffer.from(await download.arrayBuffer()));
    expect(Object.keys(entries)).toEqual([
      "0001.png",
      "0002.png",
      "0003.png",
      "manifest.json",
    ]);
    expect(entries["0001.png"]).toEqual(Buffer.from("PNG fixture p1"));
    expect(entries["0002.png"]).toEqual(Buffer.from("PNG fixture p2"));
    expect(entries["0003.png"]).toEqual(Buffer.from("PNG fixture p3"));
    expect(entries["manifest.json"].toString()).not.toMatch(
      /mcp-artifacts|sourceText|translatedText|"url"/,
    );
    for (const [name, args] of [
      ["carrot_get_job", { jobId }],
      ["carrot_get_job", { jobId: zipId }],
      ["carrot_list_jobs", {}],
      ["carrot_create_export_zip", request],
    ] as const) {
      const receipt = await f.call(name, args);
      expect(receipt.result.isError).toBe(false);
      expect(JSON.stringify(receipt)).not.toMatch(
        /mcp-artifacts|resource_link|"url"/,
      );
    }
    expect(
      mcpOutputSchemas.carrot_get_job_file.safeParse({
        ...file,
        mimeType: "image/png",
      }).success,
    ).toBe(false);
    expect(f.render).toHaveBeenCalledTimes(3);
    expect(f.chapter).toEqual(before);
  } finally {
    await f.close();
  }
});

it("requires explicit partial ZIP approval and never includes failed or unprocessed pages", async () => {
  const f = await exportHttpFixture();
  try {
    f.render.mockImplementation(async (page) => {
      if (page.id === "p2") throw new Error("synthetic renderer failure");
      return Buffer.from(`PNG fixture ${page.id}`);
    });
    const { jobId, result } = await exportPages(f);
    expect(result.status).toBe("partial");
    for (const pageId of ["p2", "p3", "absent"])
      expect(
        (await f.call("carrot_get_job_file", { jobId, pageId })).result.isError,
      ).toBe(true);
    expect(
      (await f.call("carrot_get_job_file", { jobId, pageId: "p1" })).result
        .isError,
    ).toBe(false);
    const denied = await f.call("carrot_create_export_zip", {
      sourceJobId: jobId,
      requestId: randomUUID(),
    });
    expect((await f.finish(denied.result.structuredContent.jobId)).status).toBe(
      "failed",
    );
    const started = await f.call("carrot_create_export_zip", {
      sourceJobId: jobId,
      requestId: randomUUID(),
      allowPartial: true,
    });
    const zipId = started.result.structuredContent.jobId;
    expect((await f.finish(zipId)).status).toBe("completed");
    const file = (await f.call("carrot_get_job_file", { jobId: zipId })).result
      .structuredContent;
    expect(file.partialOutput).toBe(true);
    expect(file.pageCount).toBe(1);
    const entries = readExportZip(
      Buffer.from(
        await (await f.send(new URL(file.url).pathname)).arrayBuffer(),
      ),
    );
    expect(Object.keys(entries)).toEqual(["0001.png", "manifest.json"]);
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("enforces scopes, ownership, strict arguments, matching suffixes and HTTP policy", async () => {
  const f = await exportHttpFixture();
  try {
    const read = f.grant("carrot.read");
    const other = f.grant("carrot.read carrot.images");
    expect(
      (
        await f.call(
          "carrot_preflight_pages_export",
          { chapterId: "chapter" },
          read,
        )
      ).result.isError,
    ).toBe(false);
    expect((await f.call("carrot_export_pages_png", {}, read)).error.code).toBe(
      -32602,
    );
    const { jobId } = await exportPages(f);
    for (const caller of [read, other]) {
      const response = await f.call(
        "carrot_get_job_file",
        { jobId, pageId: "p1" },
        caller,
      );
      expect(Boolean(response.error || response.result?.isError)).toBe(true);
    }
    for (const args of [
      { jobId, pageId: "../private" },
      { jobId, pageId: null },
      { jobId, pageId: 1 },
      { jobId, pageId: "p1", path: "C:/private" },
      { jobId, pageId: "p1", includeAttachment: "true" },
    ])
      expect((await f.call("carrot_get_job_file", args)).error.code).toBe(
        -32602,
      );
    const png = (await f.call("carrot_get_job_file", { jobId, pageId: "p1" }))
      .result.structuredContent;
    const pngPath = new URL(png.url).pathname;
    expect(
      (await f.send(pngPath.replace("page.png", "pages.zip"))).status,
    ).toBe(404);
    const started = await f.call("carrot_create_export_zip", {
      sourceJobId: jobId,
      requestId: randomUUID(),
    });
    const zipId = started.result.structuredContent.jobId;
    await f.finish(zipId);
    const file = (await f.call("carrot_get_job_file", { jobId: zipId })).result
      .structuredContent;
    expect(
      (await f.call("carrot_get_job_file", { jobId: zipId, pageId: "p1" }))
        .result.isError,
    ).toBe(true);
    const path = new URL(file.url).pathname;
    for (const invalid of [
      path.replace("pages.zip", "page.png"),
      path + "?extra=1",
      "/mcp-artifacts/invalid/pages.zip",
    ])
      expect((await f.send(invalid)).status).toBe(404);
    expect((await f.send(path, { method: "POST" })).status).toBe(405);
    expect(
      (await f.send(path, { headers: { Origin: "https://other.test" } }))
        .status,
    ).toBe(403);
    const owner = f.provider.connectionIdFor(`Bearer ${f.token}`);
    if (!owner) throw new Error("Missing fixture grant");
    await f.session.run(() => f.provider.revokeConnection(owner));
    expect((await f.send(path)).status).toBe(404);
    expect((await f.send(pngPath)).status).toBe(404);
  } finally {
    await f.close();
  }
});

it.each(["expiry", "revision", "order", "redaction-equivalent denial", "stop"])(
  "blocks both ZIP link modes and downloads after %s",
  async (change) => {
    const f = await exportHttpFixture();
    try {
      const { jobId } = await exportPages(f);
      const started = await f.call("carrot_create_export_zip", {
        sourceJobId: jobId,
        requestId: randomUUID(),
      });
      const zipId = started.result.structuredContent.jobId;
      await f.finish(zipId);
      const link = (await f.call("carrot_get_job_file", { jobId: zipId }))
        .result.structuredContent;
      if (change === "expiry") f.expire();
      if (change === "revision")
        f.chapter.pages[0].blocks[0].translatedText = "changed";
      if (change === "order") f.chapter.pageOrder.reverse();
      if (change === "redaction-equivalent denial") f.revoke();
      if (change === "stop") f.store.stop();
      for (const includeAttachment of [false, true])
        expect(
          (
            await f.call("carrot_get_job_file", {
              jobId: zipId,
              includeAttachment,
            })
          ).result.isError,
        ).toBe(true);
      expect((await f.send(new URL(link.url).pathname)).status).toBe(404);
      expect(f.render).toHaveBeenCalledTimes(3);
    } finally {
      await f.close();
    }
  },
);
