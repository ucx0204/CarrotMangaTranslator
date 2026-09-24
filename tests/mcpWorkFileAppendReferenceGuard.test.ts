import { expect, it } from "vitest";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";

it("refuses an ineligible but otherwise current append review before native image preparation", async () => {
  const f = await workFileAppendFixture();
  try {
    const before = await f.capture();
    const { review, command } = await f.prepareAppend({
      workId: "work",
      contextPolicy: "preserve-destination",
      references: [
        { kind: "character", sourceId: "unused", targetId: "absent" },
      ],
    });
    expect(review.eligible).toBe(false);
    expect(review.referenceIssues[0].reason).toBe("unused-mapping");
    const done = await f.settle(
      await f.invoke("carrot_import_work_file", command),
    );
    expect(done.status).toBe("failed");
    expect(f.validateShare).not.toHaveBeenCalled();
    expect(await f.capture()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});
