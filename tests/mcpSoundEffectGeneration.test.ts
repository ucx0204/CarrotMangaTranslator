import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { validGlyphShapes } from "./generatedGlyphReview.fixture";
import { soundEffectFixture } from "./mcpSoundEffect.fixture";
import { captureSoundEffectPage } from "../src/shared/soundEffectPageSnapshot";
import type { McpSoundEffectPrepare } from "../src/shared/mcpSoundEffects";

function command(
  f: Awaited<ReturnType<typeof soundEffectFixture>>,
  blockIds: string[],
): McpSoundEffectPrepare["command"] {
  return {
    kind: "generate",
    blockIds,
    expectedProvider: "codex",
    expectedModel: f.settings.codex.imageModel,
    allowExternalProcessing: true,
    replaceExisting: false,
    allowRenderAdjustment: true,
    invertColors: false,
    attemptsPerCall: 4,
  };
}
it("retains a provider refusal and refuses further generation for the same region", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath);
    const block = (await f.snapshot()).pages[0].blocks[0];
    f.turn.mockRejectedValueOnce(
      Object.assign(new Error("Image provider refused"), {
        imageGenerationDiagnostics: {
          processError: {
            code: "moderation_blocked",
            moderationDetails: { categories: ["sexual"] },
          },
        },
      }),
    );
    const first = await f.preview(command(f, [block.id]));
    const stored = f.service.readOwnedPlan(f.owner, first.batchId, () => {});
    expect(stored.generationCalls).toBe(1);
    expect(stored.after.blocks[0].imageGenerationBlocked).toBeDefined();
    const { McpSoundEffectCandidates } =
      await import("../src/main/mcp/mcpSoundEffectCandidates");
    const candidates = await new McpSoundEffectCandidates(f.env.root).list(
      "chapter",
      (await f.snapshot()).pages[0].id,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("refused");
    const second = await f.preview(command(f, [block.id]));
    expect(
      f.service.readOwnedPlan(f.owner, second.batchId, () => {})
        .generationCalls,
    ).toBe(0);
    expect(f.turn).toHaveBeenCalledOnce();
    expect(f.readerTurn).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects an unavailable glyph-guide font before spending a generation attempt", async () => {
  const f = await soundEffectFixture();
  try {
    const block = (await f.snapshot()).pages[0].blocks[0];
    const request = command(f, [block.id]);
    if (request.kind !== "generate") throw Error("Expected generation");
    request.directions = {
      [block.id]: {
        creativeBrief: "Heavy ink lettering, preserve the approved text.",
        glyphGuideFontId: "unavailable-font",
      },
    };
    const plan = await f.preview(request);
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(0);
    expect(stored.failedItems).toBe(1);
    expect(stored.pages[0].changes[0].excludedReason).toMatch(
      /available registered font/,
    );
    expect(f.turn).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("blindly reads generated pixels, retries malformed Hangul and publishes only the corrected candidate", async () => {
  const f = await soundEffectFixture();
  try {
    const block = (await f.snapshot()).pages[0].blocks[0];
    f.readerTurn.mockResolvedValueOnce({
      itemId: "read",
      threadId: "read",
      turnId: "read",
      text: JSON.stringify({ regions: [{ regionId: block.id, text: "쿠□" }] }),
    });
    const plan = await f.preview(command(f, [block.id]));
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(2);
    expect(stored.failedItems).toBe(0);
    expect(f.readerTurn).toHaveBeenCalledTimes(4);
    const request = f.readerTurn.mock.calls[0][0];
    expect(JSON.stringify(request)).not.toContain(block.translatedText);
    expect(request.input.filter((item) => item.type === "image")).toHaveLength(
      2,
    );
    expect(JSON.stringify(f.turn.mock.calls[1][0])).toContain("쿠□");
    expect(f.startReader.mock.calls[0][4]).toBe("isolated");
    expect(f.readerDispose).toHaveBeenCalledOnce();
    const { McpSoundEffectCandidates } =
      await import("../src/main/mcp/mcpSoundEffectCandidates");
    const candidates = await new McpSoundEffectCandidates(f.env.root).list(
      "chapter",
      (await f.snapshot()).pages[0].id,
    );
    expect(candidates.map((item) => item.readback)).toMatchObject([
      { readText: "쿠□", expectedText: block.translatedText, passed: false },
      {
        readText: block.translatedText,
        expectedText: block.translatedText,
        passed: true,
      },
    ]);
    expect(
      (await f.snapshot()).pages[0].blocks[0].generatedLettering,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
it("fails closed after four misspellings and preserves saved content on unreadable or failed inspection", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath);
    const block = (await f.snapshot()).pages[0].blocks[0];
    f.readerTurn.mockImplementation(async (request) => ({
      itemId: "read",
      threadId: "read",
      turnId: "read",
      text: JSON.stringify(
        JSON.stringify(request.outputSchema).includes('"shape"')
          ? validGlyphShapes([block.id])
          : { regions: [{ regionId: block.id, text: "□" }] },
      ),
    }));
    const plan = await f.preview(command(f, [block.id]));
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(4);
    expect(stored.failedItems).toBe(1);
    expect(stored.after.blocks[0].generatedLettering).toBeUndefined();
    expect(await readFile(f.chapterPath)).toEqual(before);
    f.readerTurn.mockRejectedValue(new Error("reader unavailable"));
    const unavailable = await f.preview(command(f, [block.id]));
    expect(
      f.service.readOwnedPlan(f.owner, unavailable.batchId, () => {})
        .failedItems,
    ).toBe(1);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
it("uses native foreground generation without erasure, stores only the reviewed layer and replays exact history without another model", async () => {
  const f = await soundEffectFixture();
  try {
    const before = (await f.snapshot()).pages[0],
      original = await readFile(before.imagePath);
    const plan = await f.preview(command(f, [before.blocks[0].id]));
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(1);
    expect(stored.failedItems).toBe(0);
    expect(stored.after.blocks[0].generatedLettering?.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    expect(after.blocks[0].sourceText).toBe(before.blocks[0].sourceText);
    expect(after.blocks[0].translatedText).toBe(
      before.blocks[0].translatedText,
    );
    expect(after.blocks[0].bbox).toEqual(before.blocks[0].bbox);
    expect(after.blocks.slice(1)).toEqual(before.blocks.slice(1));
    expect(after.inpaintedImagePath).toBe(before.inpaintedImagePath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect(captureSoundEffectPage((await f.snapshot()).pages[0])).toEqual(
      captureSoundEffectPage(before),
    );
    expect((await f.action(plan.batchId, "redo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks).toEqual(after.blocks);
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await readFile(before.imagePath)).toEqual(original);
  } finally {
    await f.close();
  }
});
it("reports Claude verification independently from the Codex image generator", async () => {
  const f = await soundEffectFixture();
  try {
    await writeFile(
      f.app.appPaths.settingsPath,
      JSON.stringify({
        codex: f.settings.codex,
        imageReview: {
          provider: "claude",
          claude: { model: "sonnet", effort: "high" },
        },
      }),
    );
    const result = await f.query();
    expect(result.verification).toEqual({
      provider: "claude",
      configuredModel: "sonnet",
      runtimeChecked: false,
    });
    expect(result.generation.provider).toBe("codex");
    expect(f.startClient).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it.each(["auto", "gpt-image-2.6-sunburst"] as const)(
  "passes the configured %s backend with a supported newer controller",
  async (imageGenerationModel) => {
    const f = await soundEffectFixture();
    try {
      f.settings.codex.imageModel = "gpt-6-sol";
      f.settings.codex.imageGenerationModel = imageGenerationModel;
      await writeFile(
        f.app.appPaths.settingsPath,
        JSON.stringify({ codex: f.settings.codex }),
      );
      const before = await readFile(f.app.appPaths.settingsPath);
      const page = (await f.snapshot()).pages[0];
      const plan = await f.preview(command(f, [page.blocks[0].id]));
      expect(f.startClient).toHaveBeenCalledOnce();
      expect(f.startClient.mock.calls[0][1].codex).toEqual(f.settings.codex);
      expect(
        f.service.readOwnedPlan(f.owner, plan.batchId, () => {})
          .generationCalls,
      ).toBe(1);
      expect(await readFile(f.app.appPaths.settingsPath)).toEqual(before);
    } finally {
      await f.close();
    }
  },
);
it.each([
  ["gpt-image-2.5-flare", "gpt-image-2.6-flare"],
  ["gpt-image-2.5-sunburst", "gpt-image-2.6-sunburst"],
])(
  "reads legacy %s for MCP generation without writing settings",
  async (legacy, current) => {
    const f = await soundEffectFixture();
    try {
      await writeFile(
        f.app.appPaths.settingsPath,
        JSON.stringify({
          codex: { ...f.settings.codex, imageGenerationModel: legacy },
        }),
      );
      const before = await readFile(f.app.appPaths.settingsPath);
      const page = (await f.snapshot()).pages[0];
      await f.preview(command(f, [page.blocks[0].id]));
      expect(f.startClient.mock.calls[0][1].codex.imageGenerationModel).toBe(
        current,
      );
      expect(await readFile(f.app.appPaths.settingsPath)).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("requires external consent and the exact supported configured controller before starting a client", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    const input = command(f, [page.blocks[0].id]);
    if (input.kind !== "generate")
      throw new Error("Expected generation test input");
    await expect(
      f.preview({ ...input, allowExternalProcessing: false }),
    ).rejects.toThrow("allowExternalProcessing");
    await expect(
      f.preview({ ...input, expectedModel: "different-controller" }),
    ).rejects.toThrow("match");
    await expect(
      f.preview({ ...input, blockIds: [page.blocks[1].id] }),
    ).rejects.toThrow("not dialogue");
    const redaction = await import("../src/main/imageRedactionStore");
    await redaction.setImageRedactionEnabled(true, f.env.root);
    await expect(f.preview(input)).rejects.toThrow("redaction");
    expect(f.startClient).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
it.each([false, true])(
  "preserves excluded targets and generates only eligible ones (mixed=%s)",
  async (includeEligible) => {
    const f = await soundEffectFixture();
    try {
      const raw = JSON.parse(await readFile(f.chapterPath, "utf8"));
      const page = raw.pages[0],
        block = page.blocks[0];
      const image = await readFile(page.imagePath);
      page.blocks = [
        { ...block, id: "blocked", imageGenerationBlocked: "sexual" },
        { ...block, id: "blank-source", sourceText: " " },
        { ...block, id: "blank-translation", translatedText: " " },
        {
          ...block,
          id: "existing",
          generatedLettering: {
            version: 1,
            dataUrl: "data:image/png;base64," + image.toString("base64"),
            sourceText: block.sourceText,
            translatedText: block.translatedText,
          },
        },
        ...(includeEligible ? [{ ...block, id: "eligible" }] : []),
      ];
      page.blockOrder = [
        "blocked",
        "blank-source",
        "blank-translation",
        "existing",
        ...(includeEligible ? ["eligible"] : []),
      ];
      await writeFile(f.chapterPath, JSON.stringify(raw));
      const stored = await readFile(f.chapterPath);
      const before = (await f.snapshot()).pages[0];
      const plan = await f.preview(
        command(
          f,
          before.blocks.map((item) => item.id),
        ),
      );
      const evidence = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
      expect(evidence.generationCalls).toBe(includeEligible ? 1 : 0);
      expect(evidence.failedItems).toBe(0);
      expect(
        evidence.changes.filter((item) => item.excludedReason),
      ).toMatchObject([
        { id: "blocked", excludedReason: "image_generation_blocked" },
        { id: "blank-source", excludedReason: "approved_text_required" },
        { id: "blank-translation", excludedReason: "approved_text_required" },
        {
          id: "existing",
          excludedReason: "existing_image_requires_explicit_replacement",
        },
      ]);
      expect(f.startClient).toHaveBeenCalledTimes(includeEligible ? 1 : 0);
      expect(f.turn).toHaveBeenCalledTimes(includeEligible ? 1 : 0);
      expect(await readFile(f.chapterPath)).toEqual(stored);
      if (includeEligible) await f.action(plan.batchId, "apply");
      else
        await expect(f.action(plan.batchId, "apply")).rejects.toThrow(
          "No eligible pages",
        );
      const after = (await f.snapshot()).pages[0];
      expect(after.blocks.slice(0, 4)).toEqual(before.blocks.slice(0, 4));
      if (includeEligible) {
        expect(after.blocks[4].generatedLettering).toBeDefined();
      } else {
        expect(captureSoundEffectPage(after)).toEqual(
          captureSoundEffectPage(before),
        );
        expect(await readFile(f.chapterPath)).toEqual(stored);
        expect(f.editing.notifySaved).not.toHaveBeenCalled();
      }
    } finally {
      await f.close();
    }
  },
);
it("keeps successful generation separate from failed blocks and never parallelizes selected native calls", async () => {
  const f = await soundEffectFixture();
  try {
    const raw = JSON.parse(await readFile(f.chapterPath, "utf8"));
    raw.pages[0].blocks[1].textRole = "sound";
    raw.pages[0].blocks[1].sourceText = "BOOM";
    raw.pages[0].blocks[1].translatedText = "BANG";
    await writeFile(f.chapterPath, JSON.stringify(raw));
    const before = (await f.snapshot()).pages[0];
    f.turn.mockRejectedValueOnce(new Error("synthetic provider failure"));
    const plan = await f.preview(
      command(
        f,
        before.blocks.map((block) => block.id),
      ),
    );
    const evidence = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(evidence.generationCalls).toBe(2);
    expect(evidence.failedItems).toBe(1);
    expect(evidence.after.blocks[0].generatedLettering).toBeUndefined();
    expect(evidence.after.blocks[1].generatedLettering).toBeDefined();
    expect(f.startClient).toHaveBeenCalledTimes(1);
    expect(f.turn).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks[0]).toEqual(before.blocks[0]);
  } finally {
    await f.close();
  }
});
it("does not publish a candidate after source mutation during the remote call", async () => {
  const f = await soundEffectFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    f.turn.mockImplementationOnce(async () => {
      await writeFile(page.imagePath, Buffer.from("changed-original"));
      throw new Error("synthetic failure after source changed");
    });
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "changed",
    );
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("waits for the active call and cleanup on cancellation without saving or publishing a plan", async () => {
  const f = await soundEffectFixture();
  let release: (() => void) | undefined;
  try {
    const page = (await f.snapshot()).pages[0],
      original = await readFile(f.chapterPath);
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.turn.mockImplementationOnce(async () => {
      entered?.();
      await hold;
      throw new Error("call stopped after cancellation");
    });
    const execution = f.preview(command(f, [page.blocks[0].id]));
    const assertion = expect(execution).rejects.toThrow();
    await started;
    f.lifetime.abort();
    expect(f.dispose).not.toHaveBeenCalled();
    if (!release) throw new Error("Expected a pending model transport");
    release();
    await assertion;
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    release?.();
    await f.close();
  }
});
it("blocks further generation in this session after client cleanup failure", async () => {
  const f = await soundEffectFixture();
  try {
    const page = (await f.snapshot()).pages[0],
      original = await readFile(f.chapterPath);
    f.dispose.mockRejectedValueOnce(
      new Error("synthetic client cleanup failure"),
    );
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "cleanup failed",
    );
    await expect(f.preview(command(f, [page.blocks[0].id]))).rejects.toThrow(
      "previous image client",
    );
    expect(f.startClient).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally {
    await f.close();
  }
});

it("counts host attempts against app internal generation retries", async () => {
  const f = await soundEffectFixture();
  try {
    const block = (await f.snapshot()).pages[0].blocks[0];
    f.readerTurn.mockImplementation(async (input) => ({
      itemId: "read",
      threadId: "read",
      turnId: "read",
      text: JSON.stringify(
        JSON.stringify(input.outputSchema).includes('"shape"')
          ? validGlyphShapes([block.id])
          : { regions: [{ regionId: block.id, text: "□" }] },
      ),
    }));
    const request = command(f, [block.id]);
    if (request.kind !== "generate") throw new Error("Expected generation");
    request.priorGenerationAttempts = { [block.id]: 3 };
    const plan = await f.preview(request);
    const stored = f.service.readOwnedPlan(f.owner, plan.batchId, () => {});
    expect(stored.generationCalls).toBe(1);
    expect(stored.failedItems).toBe(1);
    expect(
      (await f.snapshot()).pages[0].blocks[0].generatedLettering,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
