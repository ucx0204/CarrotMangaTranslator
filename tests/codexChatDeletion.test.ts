import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { codexChatProtocolFixture } from "./helpers/codexChatProtocolFixture";

it.each(["normal", "missing"])(
  "deletes one unloaded native thread (%s) without starting a turn or authenticating",
  async (mode) => {
    const f = await codexChatProtocolFixture(mode);
    try {
      const threadId = randomUUID();
      await f.deleteThread(threadId);
      const audit = await f.audit();
      expect(audit.filter((m) => m.method === "thread/delete")).toEqual([
        expect.objectContaining({ params: { threadId } }),
      ]);
      expect(
        audit.some((m) =>
          [
            "account/read",
            "thread/start",
            "thread/resume",
            "turn/start",
          ].includes(m.method),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("propagates native deletion failures so app records remain retryable", async () => {
  const f = await codexChatProtocolFixture("delete-failure");
  try {
    await expect(f.deleteThread(randomUUID())).rejects.toThrow(
      "disk permission denied",
    );
  } finally {
    await f.close();
  }
});

it("rejects invalid native IDs before asking the provider to delete anything", async () => {
  const f = await codexChatProtocolFixture();
  try {
    await expect(f.deleteThread("../library")).rejects.toThrow();
    expect((await f.audit()).some((m) => m.method === "thread/delete")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});
