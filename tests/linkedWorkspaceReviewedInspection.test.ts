import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  reviewedWorkspace,
  reviewedExecution,
  reviewedTarget,
  type ReviewedFixture,
} from "./linkedWorkspaceReviewedOutput.fixture";

vi.mock("electron", () => ({
  app: { getVersion: () => "native-parity" },
  shell: { openPath: vi.fn() },
}));
const fixtures: ReviewedFixture[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function setup() {
  const fixture = await reviewedWorkspace([1]);
  fixtures.push(fixture);
  return fixture;
}

describe("native output receipt evidence inspection", () => {
  it("hashes current files without replaying rendering, registry publication or automatic work", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result.status).toBe("completed");
    const registry = await readFile(join(f.dataRoot, "linked-workspaces.json"));
    const queue = await f.queue();
    const evidence = await f.service.reviewedOutput.inspectReceiptEvidence(
      {
        selection: f.selection,
        destinationSnapshot: review.destinationSnapshot,
        targets: execution.intents,
      },
      () => undefined,
    );
    expect(evidence).toMatchObject({
      destination: "matched",
      extent: "current-destination-files-only",
      sourceChecked: false,
    });
    expect(
      evidence.files.find((file) => file.fileId.startsWith("result:"))
        ?.currentState,
    ).toBe("matches_planned");
    expect(
      evidence.files.find((file) => file.fileId === "registry:1:publish")
        ?.currentState,
    ).toBe("matches_planned");
    expect(JSON.stringify(evidence)).not.toContain(f.output);
    expect(JSON.stringify(evidence)).not.toContain("relativePath");
    expect(f.renderPage).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.dataRoot, "linked-workspaces.json"))).toEqual(
      registry,
    );
    expect(await f.queue()).toBe(queue);
  });

  it("does not turn matching current bytes into a confirmed historical publication", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution({
      onEffect: async () => {
        throw new Error("receipt effect failed");
      },
    });
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    const evidence = await f.service.reviewedOutput.inspectReceiptEvidence(
      {
        selection: f.selection,
        destinationSnapshot: review.destinationSnapshot,
        targets: execution.intents,
      },
      () => undefined,
    );
    expect(result.files[0]?.state).toBe("publication_unconfirmed");
    expect(evidence.files[0]?.currentState).toBe("matches_planned");
    expect(result.files[0]?.state).toBe("publication_unconfirmed");
    expect(f.renderPage).toHaveBeenCalledTimes(1);
  });

  it("distinguishes changed and missing files and stops inspecting a removed connection", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    const target = execution.intents.find((intent) => intent.role === "result");
    if (!target?.relativePath) throw new Error("fixture result intent missing");
    const request = {
      selection: f.selection,
      destinationSnapshot: review.destinationSnapshot,
      targets: [target],
    };
    const path = join(f.output, target.relativePath);
    await writeFile(path, "external modification");
    expect(
      (
        await f.service.reviewedOutput.inspectReceiptEvidence(
          request,
          () => undefined,
        )
      ).files[0]?.currentState,
    ).toBe("changed");
    await unlink(path);
    expect(
      (
        await f.service.reviewedOutput.inspectReceiptEvidence(
          request,
          () => undefined,
        )
      ).files[0]?.currentState,
    ).toBe("missing");
    await f.service.disconnect(f.selection.connectionId);
    const registry = await readFile(join(f.dataRoot, "linked-workspaces.json"));
    expect(
      await f.service.reviewedOutput.inspectReceiptEvidence(
        request,
        () => undefined,
      ),
    ).toMatchObject({
      destination: "unavailable",
      files: [{ fileId: target.fileId, currentState: "unavailable" }],
    });
    expect(await readFile(join(f.dataRoot, "linked-workspaces.json"))).toEqual(
      registry,
    );
    expect(f.renderPage).toHaveBeenCalledTimes(1);
  });

  it("identifies previous bytes when cancellation stops a second admitted replacement", async () => {
    const f = await setup();
    const first = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    await f.service.reviewedOutput.execute(
      reviewedTarget(first),
      reviewedExecution().context,
    );
    f.renderPage.mockResolvedValueOnce(Buffer.from("second render"));
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const persist = execution.context.onIntent;
    execution.context.onIntent = async (intent) => {
      await persist(intent);
      execution.controller.abort();
    };
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result.status).toBe("cancelled");
    const evidence = await f.service.reviewedOutput.inspectReceiptEvidence(
      {
        selection: f.selection,
        destinationSnapshot: review.destinationSnapshot,
        targets: execution.intents,
      },
      () => undefined,
    );
    expect(evidence.files[0]?.currentState).toBe("matches_previous");
  });
});
