import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const token = (url: string) => new URL(url).pathname.split("/")[2];

it("removes each expired output once when concurrent writes reclaim its budget", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  let now = 0;
  const store = new McpArtifactStore("https://retention.test", () => now);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending: Promise<Awaited<ReturnType<typeof store.put>>[]> | undefined;
  try {
    const expired = await store.put(Buffer.from("expired"), async () => {});
    now = expired.expiresAt;
    vi.mocked(rm).mockClear();
    vi.mocked(rm).mockImplementation(async (...args) => {
      await gate;
      return actual.rm(...args);
    });
    pending = Promise.all([
      store.put(Buffer.from("first"), async () => {}),
      store.put(Buffer.from("second"), async () => {}),
    ]);
    await vi.waitFor(() => expect(rm).toHaveBeenCalled());
    release();
    const outputs = await pending;
    expect(rm).toHaveBeenCalledTimes(1);
    expect(await store.read(token(outputs[0].url))).toEqual(Buffer.from("first"));
    expect(await store.read(token(outputs[1].url))).toEqual(Buffer.from("second"));
    await expect(store.read(token(expired.url))).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    release();
    if (pending) await Promise.allSettled([pending]);
    vi.mocked(rm).mockImplementation(actual.rm);
    await store.close();
  }
});

it("shares a failed cleanup without admitting another write and permits an explicit retry", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  let now = 0;
  const store = new McpArtifactStore("https://retention.test", () => now);
  try {
    const expired = await store.put(Buffer.from("expired"), async () => {});
    now = expired.expiresAt;
    const failure = Object.assign(new Error("synthetic cleanup failure"), {
      code: "EACCES",
    });
    vi.mocked(rm).mockClear();
    vi.mocked(rm).mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      store.put(Buffer.from("first"), async () => {}),
      store.put(Buffer.from("second"), async () => {}),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(rm).toHaveBeenCalledTimes(1);
    const retried = await store.put(Buffer.from("retry"), async () => {});
    expect(await store.read(token(retried.url))).toEqual(Buffer.from("retry"));
    expect(rm).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
    await store.close();
  }
});
