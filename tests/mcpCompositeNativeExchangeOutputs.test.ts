import { randomUUID } from "node:crypto";
import { ok } from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { zeroCompositeCost } from "../src/main/application/mcpCompositeWorkflowPolicy";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import {
  compositeOutputAction,
  compositeOutputFixture,
} from "./mcpCompositeNativeOutputs.fixture";
import {
  compositeContextState,
  compositeTextReview,
  compositeWorkFileReview,
} from "./mcpCompositeNativeExchange.fixture";

let env: Awaited<ReturnType<typeof mcpAppEnvironment>>;
let costCompositeNativeOutput: typeof import("../src/main/mcp/mcpCompositeNativeOutputs").costCompositeNativeOutput;
beforeAll(async () => {
  env = await mcpAppEnvironment();
  ({ costCompositeNativeOutput } =
    await import("../src/main/mcp/mcpCompositeNativeOutputs"));
});
afterAll(async () => {
  await env?.close();
});

function expectedCost(pageAttempts: number) {
  return { ...zeroCompositeCost(), admissions: 1, pageAttempts };
}
function run(
  f: ReturnType<typeof compositeOutputFixture>,
  value: unknown,
  values = f.values,
) {
  return costCompositeNativeOutput(
    f.options,
    f.record,
    compositeOutputAction(value),
    values,
    f.guard,
  );
}

describe("native composite work and text exchange output scope", () => {
  it("requires complete work-file chapter membership and both native snapshots", async () => {
    const f = compositeOutputFixture();
    const review = compositeWorkFileReview(f);
    f.replies.set("carrot_preflight_work_file_export", review);
    const input = {
      workId: review.workId,
      chapterIds: review.chapterIds,
      snapshot: review.snapshot,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
      acknowledgeOriginalImages: true,
      acknowledgeV1Limitations: true,
    };
    await expect(run(f, { kind: "work-file-export", input })).resolves.toEqual(
      expectedCost(2),
    );
    await expect(
      run(f, { kind: "work-file-export", input }, f.values.slice(0, 1)),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      run(f, {
        kind: "work-file-export",
        input: { ...input, sourceSnapshot: "f".repeat(16) },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      run(f, {
        kind: "work-file-export",
        input: { ...input, chapterIds: [f.chapter.id, "empty-unselected"] },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("binds the exact text reading order/options and rejects empty output", async () => {
    const f = compositeOutputFixture();
    const review = compositeTextReview(f);
    f.replies.set("carrot_preflight_text_export", review);
    const input = { binding: review.binding, requestId: randomUUID() };
    await expect(run(f, { kind: "text-export", input })).resolves.toEqual(
      expectedCost(2),
    );
    await expect(
      run(f, {
        kind: "text-export",
        input: { ...input, binding: { ...input.binding, direction: "ltr" } },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      run(f, {
        kind: "text-export",
        input: {
          ...input,
          binding: {
            ...input.binding,
            pages: [...input.binding.pages].reverse(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    f.replies.set("carrot_preflight_text_export", { ...review, bytes: 0 });
    await expect(run(f, { kind: "text-export", input })).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("allows a selected guide anchor but checks actual raw memory rows against parent pages", async () => {
    const f = compositeOutputFixture();
    let state = await compositeContextState(f, env.libraryDir);
    const readContext = vi.fn((...args: Parameters<typeof state.readContext>) =>
      state.readContext(...args),
    );
    const execute = () =>
      costCompositeNativeOutput(
        { ...f.options, readContext },
        f.record,
        compositeOutputAction({
          kind: "context-export",
          input: {
            workId: f.chapter.workId,
            chapterId: f.chapter.id,
            scope: state.binding.scope,
            sourceSnapshot: state.binding.snapshot,
            requestId: randomUUID(),
          },
        }),
        f.values,
        f.guard,
      );
    await expect(execute()).resolves.toEqual(expectedCost(0));
    expect(state.verified).toHaveBeenCalledOnce();
    expect(state.bytes.toString()).not.toContain(env.libraryDir);
    expect(state.bytes.toString()).not.toContain("imagePath");
    state = await compositeContextState(f, env.libraryDir, true);
    expect(f.saved.storyMemory.pages).toHaveLength(0);
    await expect(execute()).resolves.toEqual(expectedCost(2));
    ok(state.payload.memory);
    state = await compositeContextState(
      f,
      env.libraryDir,
      true,
      "orphaned-raw-memory-page",
    );
    await expect(execute()).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it("checks context authorization after source verification and rejects foreign anchors before reading", async () => {
    const f = compositeOutputFixture();
    const state = await compositeContextState(f, env.libraryDir);
    const input = {
      workId: f.chapter.workId,
      chapterId: f.chapter.id,
      scope: "guide",
      sourceSnapshot: state.binding.snapshot,
      requestId: randomUUID(),
    };
    const readContext = state.readContext;
    let revoked = false;
    const guard = vi.fn(() => {
      if (revoked) throw new Error("authorization revoked");
    });
    state.verified.mockImplementation(async (verify) => {
      await verify();
      revoked = true;
    });
    await expect(
      costCompositeNativeOutput(
        { ...f.options, readContext },
        f.record,
        compositeOutputAction({ kind: "context-export", input }),
        f.values,
        guard,
      ),
    ).rejects.toThrow("authorization revoked");
    expect(guard).toHaveBeenLastCalledWith(["carrot.read"]);
    readContext.mockClear();
    await expect(
      costCompositeNativeOutput(
        { ...f.options, readContext },
        f.record,
        compositeOutputAction({
          kind: "context-export",
          input: { ...input, workId: "foreign" },
        }),
        f.values,
        f.guard,
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(readContext).not.toHaveBeenCalled();
  });
});
