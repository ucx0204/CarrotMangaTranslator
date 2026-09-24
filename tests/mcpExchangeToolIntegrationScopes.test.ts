import { expect, it } from "vitest";
import { exchangeToolIntegrationFixture } from "./mcpExchangeToolIntegration.fixture";

it("keeps actual PNG and native work-file jobs behind image preference, scope and redaction during retrieval", async () => {
  const f = await exchangeToolIntegrationFixture({ images: true });
  try {
    const png = await f.startPng();
    expect(png.settled.status, JSON.stringify(png.settled.error)).toBe(
      "completed",
    );
    const work = await f.startWorkFile();
    expect(work.settled.status, JSON.stringify(work.settled.error)).toBe(
      "completed",
    );
    for (const job of [png, work]) {
      await expect(f.jobFile(job.started.jobId)).rejects.toMatchObject({
        code: "access_denied",
      });
      await expect(
        f.jobFileWithImagesDisabled(job.started.jobId),
      ).rejects.toMatchObject({ code: "access_denied" });
      const denied = await f.report({ kind: "job", jobId: job.started.jobId });
      expect(denied).toMatchObject({
        generation: { status: "completed" },
        retention: {
          state: "retained",
          content: "verified",
          source: "current",
          access: "blocked",
        },
        sessionFile: { state: "unavailable" },
        clientReceipt: "unconfirmed",
      });
      expect(denied.observation).toMatchObject({
        state: "observed",
        toolResponsesPrepared: { text: 0, attachment: 0 },
      });
      expect(JSON.stringify(denied)).not.toMatch(
        /mcp-artifacts|"url"|imagePath|sourcePath/,
      );
    }
    const imageFile = await f.jobFile(png.started.jobId, false, f.all());
    expect(imageFile.file.mimeType).toBe("image/png");
    expect((await f.read(imageFile.file.url)).equals(f.rendered)).toBe(true);
    const workFile = await f.jobFile(work.started.jobId, true, f.all());
    expect(workFile.file).toMatchObject({
      kind: "native-work-file",
      mimeType: "application/vnd.carrot.mgtshare",
    });
    expect(
      workFile.content.some(
        (item) =>
          item.type === "resource_link" && item.name === "carrot-work.mgtshare",
      ),
    ).toBe(true);
    expect(
      (await f.read(workFile.file.url))
        .subarray(0, 4)
        .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    ).toBe(true);
    await f.redaction(true);
    for (const job of [png, work]) {
      await expect(
        f.jobFile(job.started.jobId, false, f.all()),
      ).rejects.toMatchObject({ code: "access_denied" });
      const blocked = await f.report(
        { kind: "job", jobId: job.started.jobId },
        f.all(),
      );
      expect(blocked.retention.access).toBe("blocked");
      expect(blocked.sessionFile?.state).toBe("unavailable");
      expect(blocked.clientReceipt).toBe("unconfirmed");
    }
    const context = await f.startContext();
    expect(context.settled.status).toBe("completed");
    expect((await f.jobFile(context.started.jobId)).file.mimeType).toBe(
      "application/json",
    );
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("requires an actual read-scope verifier for job-file lookup and refuses unknown output-sync targets", async () => {
  const f = await exchangeToolIntegrationFixture();
  try {
    const context = await f.startContext();
    expect(context.settled.status).toBe("completed");
    await expect(
      f.jobFile(context.started.jobId, false, {
        principalId: f.owner,
        assertAuthorized: () => {},
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
    const before = await f.report({
      kind: "job",
      jobId: context.started.jobId,
    });
    expect(before.observation).toMatchObject({
      state: "observed",
      toolResponsesPrepared: { text: 0, attachment: 0 },
    });
    await expect(
      f.report({ kind: "output-sync", receiptId: context.started.jobId }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await f.report({ kind: "job", jobId: context.started.jobId }))
        .observation,
    ).toMatchObject({
      state: "observed",
      toolResponsesPrepared: { text: 0, attachment: 0 },
    });
  } finally {
    await f.close();
  }
});
