import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { typographyBatchAppFixture } from "./mcpTypographyBatchApp.fixture";

async function fixture() {
  const f = await typographyBatchAppFixture("size");
  const input = await f.analyze();
  const { McpTypographyAnalysisObservationSchema } =
    await import("../src/shared/mcpTypographyAnalysis");
  const { verifyMcpTypographySourceEvidence } =
    await import("../src/main/mcp/mcpTypographySourceEvidence");
  const saved = await f.library.readWorkContextForEdit("chapter");
  const observation = McpTypographyAnalysisObservationSchema.parse(
    f.operations.status(input.analysisJobId, f.owner).result
      ?.typographyAnalysis,
  );
  const dependencies = observation.pages.map(({ pageId, revision }) => ({
    pageId,
    revision,
  }));
  return {
    ...f,
    saved,
    observation,
    dependencies,
    verify: verifyMcpTypographySourceEvidence,
  };
}

it.each(["catalog", "environment", "expiry", "scope"])(
  "rejects invalid %s evidence without a page save",
  async (kind) => {
    const f = await fixture();
    try {
      const before = await readFile(f.chapterPath);
      if (kind === "catalog") f.observation.catalogSnapshot = "0".repeat(16);
      if (kind === "environment")
        f.observation.environmentSnapshot = "0".repeat(16);
      if (kind === "expiry") f.observation.expiresAt = 0;
      if (kind === "scope") f.dependencies.pop();
      await expect(
        f.verify(f.saved, f.observation, f.dependencies, f.guard),
      ).rejects.toThrow();
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(f.editing.notifySaved).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("does not return evidence that expires while original files are being checked", async () => {
  const f = await fixture();
  try {
    const now = vi
      .fn()
      .mockReturnValueOnce(f.observation.expiresAt - 1)
      .mockReturnValue(f.observation.expiresAt);
    await expect(
      f.verify(f.saved, f.observation, f.dependencies, f.guard, now),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(now).toHaveBeenCalledTimes(2);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects changed original dimensions rather than trusting only the saved page metadata", async () => {
  const f = await fixture();
  try {
    const image = new PNG({ width: 99, height: 100 });
    image.data.fill(255);
    await writeFile(f.chapter.pages[0].imagePath, PNG.sync.write(image));
    await expect(
      f.verify(f.saved, f.observation, f.dependencies, f.guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  } finally {
    await f.close();
  }
});

it("propagates revocation during evidence checks and closes read streams", async () => {
  const f = await fixture();
  try {
    const revoked = new Error("fixture connection revoked");
    let calls = 0;
    const guard = () => {
      if (++calls >= 7) throw revoked;
    };
    await expect(
      f.verify(f.saved, f.observation, f.dependencies, guard),
    ).rejects.toBe(revoked);
    await writeFile(f.chapter.pages[0].imagePath, f.bytes);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each([true, false])(
  "registers typography application only with editing and processing enabled: %s",
  async (enabled) => {
    const f = await typographyBatchAppFixture("size");
    const { createMcpPageOperationSession } =
      await import("../src/main/mcp/mcpPageOperationSession");
    const { mcpToolOutputSchema } =
      await import("../src/main/mcp/mcpOutputSchemas");
    const session = createMcpPageOperationSession({
      origin: "https://typography-registration.test",
      app: f.app,
      editing: { ...f.editing, assertClean: vi.fn(async () => {}) },
      preferences: {
        allowImages: false,
        allowEditing: enabled,
        allowProcessing: enabled,
        autoStart: false,
      },
      reportError: (error) => f.errors.push(error),
    });
    try {
      const tools = session.tools.filter((tool) =>
        tool.name.endsWith("_typography_batch"),
      );
      expect(tools).toHaveLength(enabled ? 6 : 0);
      for (const tool of tools)
        expect(mcpToolOutputSchema(tool.name)).toBeDefined();
      session.stop();
      if (enabled) {
        const tool = tools.find(
          (item) => item.name === "carrot_get_typography_batch",
        );
        if (!tool) throw new Error("Typography inspect tool missing");
        await expect(
          tool.invoke(
            { batchId: "00000000-0000-4000-8000-000000000000" },
            f.auth,
          ),
        ).rejects.toMatchObject({ code: "access_denied" });
      }
    } finally {
      await session.close();
      await f.close();
    }
  },
);
