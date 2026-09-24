import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeroCompositeCost } from "../src/main/application/mcpCompositeWorkflowPolicy";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import {
  compositeOutputAction,
  compositeOutputFixture,
  sourceFormatReview,
  staleOutputRevision,
} from "./mcpCompositeNativeOutputs.fixture";

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

describe("native composite output binding and costs", () => {
  it("binds mixed source formats with exact native options and no edit/model cost", async () => {
    const f = compositeOutputFixture();
    const input = sourceFormatReview(f);
    expect(f.values.every((value) => value.target.blockIds.length > 0)).toBe(
      true,
    );
    await expect(run(f, { kind: "images-export", input })).resolves.toEqual(
      expectedCost(2),
    );
    expect(f.inspect).toHaveBeenCalledWith(
      "carrot_preflight_pages_export",
      {
        chapterId: input.chapterId,
        pageIds: input.pages.map((page) => page.pageId),
        imageExport: input.imageExport,
      },
      f.record.owner,
    );
    await expect(
      run(f, {
        kind: "images-export",
        input: {
          ...input,
          imageExport: { ...input.imageExport, jpegQuality: 84 },
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.operations.exportSource).not.toHaveBeenCalled();
  });

  it("rejects extra, reordered or changed pages rather than expanding the parent selection", async () => {
    const f = compositeOutputFixture();
    const action = { kind: "images-export", input: f.input };
    await expect(run(f, action, f.values.slice(0, 1))).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.inspect).not.toHaveBeenCalled();
    await expect(
      run(f, {
        ...action,
        input: { ...f.input, pages: [...f.input.pages].reverse() },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(staleOutputRevision(f)).not.toBe(f.input.pages[0].revision);
    await expect(run(f, action)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("inspects exact owned ZIP source receipts without requiring session URLs or borrowing bytes", async () => {
    const f = compositeOutputFixture();
    const input = {
      sourceJobId: f.sourceJobId,
      requestId: randomUUID(),
      allowPartial: false,
    };
    await expect(run(f, { kind: "zip-export", input })).resolves.toEqual(
      expectedCost(2),
    );
    expect(f.operations.exportSource).toHaveBeenCalledWith(
      f.sourceJobId,
      f.record.owner,
    );
    expect(f.operations.outputMetadata.mock.calls).toEqual(
      f.input.pages.map((page) => [f.sourceJobId, f.record.owner, page.pageId]),
    );
    expect(JSON.stringify(f.entry)).not.toContain('"url"');
    await expect(
      run(f, {
        kind: "zip-export",
        input: { ...input, sourceJobId: randomUUID() },
      }),
    ).rejects.toThrow("owned source unavailable");
  });

  it("requires explicit partial ZIP consent and charges only actually exported pages", async () => {
    const f = compositeOutputFixture();
    f.entry.status = "partial";
    f.entry.result.exportPages.completed = 1;
    f.entry.result.exportPages.pages[1].status = "failed";
    const input = {
      sourceJobId: f.sourceJobId,
      requestId: randomUUID(),
      allowPartial: false,
    };
    await expect(run(f, { kind: "zip-export", input })).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.inspect).not.toHaveBeenCalled();
    await expect(
      run(f, { kind: "zip-export", input: { ...input, allowPartial: true } }),
    ).resolves.toEqual(expectedCost(1));
    expect(f.operations.outputMetadata).toHaveBeenCalledTimes(1);
    await expect(
      run(
        f,
        { kind: "zip-export", input: { ...input, allowPartial: true } },
        f.values.slice(0, 1),
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("rejects altered ZIP names or receipt digests and unavailable output metadata", async () => {
    const f = compositeOutputFixture();
    const action = {
      kind: "zip-export",
      input: {
        sourceJobId: f.sourceJobId,
        requestId: randomUUID(),
        allowPartial: false,
      },
    };
    const page = f.entry.result.exportPages.pages[0];
    const filename = page.filename;
    page.filename = "9999.png";
    await expect(run(f, action)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    page.filename = filename;
    f.operations.outputMetadata.mockReturnValueOnce({
      artifact: {
        mimeType: "image/png",
        bytes: page.bytes,
        sha256: "c".repeat(64),
        retainedOutputId: page.retainedOutputId,
      },
    });
    await expect(run(f, action)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    f.operations.outputMetadata.mockReturnValueOnce(undefined);
    await expect(run(f, action)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });
});
